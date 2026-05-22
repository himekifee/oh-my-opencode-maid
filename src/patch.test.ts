import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PROVIDER_REWRITE_HEADER, installCommandInterceptor, installProviderRewrite, installPublicStreamGate, resetPublicStreamGate, uninstallCommandInterceptor, uninstallPublicStreamGate } from "./patch"

const enc = new TextEncoder()
const upstream = `http://127.0.0.1:48765/v1/${"chat"}/${"completions"}`

function start(id = "text-1") {
  return { type: "message.part.updated", properties: { part: { id, sessionID: "s", messageID: "m", type: "text", text: "", time: { start: 1 } } } }
}

function delta(id = "text-1", text = "raw draft") {
  return { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: id, field: "text", delta: text } }
}

function done(id = "text-1") {
  return { type: "message.part.updated", properties: { part: { id, sessionID: "s", messageID: "m", type: "text", text: "maid", time: { start: 1, end: 2 } } } }
}

async function text(body: string) {
  const res = new Response(
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode(body))
        ctrl.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  return res.text()
}

function frame(input: unknown) {
  return `data: ${JSON.stringify(input)}\n\n`
}

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function chunk(value: string, finish: string | null = null) {
  return frame({ choices: [{ delta: value ? { content: value } : {}, finish_reason: finish }] })
}

describe("public stream gate", () => {
  afterEach(() => {
    resetPublicStreamGate()
  })

  test("drops text delta frames and allows completed text updates", async () => {
    installPublicStreamGate(new Set())

    const out = await text([start(), delta(), done(), delta("other-1", "late")].map(frame).join(""))

    expect(out).toContain("message.part.updated")
    expect(out).toContain("maid")
    expect(out).not.toContain("raw draft")
    expect(out).not.toContain("late")
  })

  test("drops text deltas even when start event was missed", async () => {
    installPublicStreamGate(new Set())

    const out = await text(frame(delta()))

    expect(out).not.toContain("raw draft")
  })

  test("fails closed for malformed public text delta SSE frames", async () => {
    installPublicStreamGate(new Set())

    const out = await text('data: {"type":"message.part.delta","properties":{"sessionID":"s","messageID":"m","partID":"text-1","field":"text","delta":"raw draft"}\n\n')

    expect(out).not.toContain("raw draft")
    expect(out).not.toContain("message.part.delta")
  })

  test("passes through malformed provider-shaped SSE frames", async () => {
    installPublicStreamGate(new Set())

    const out = await text('data: {"choices":[{"delta":{"content":"Original QA_TOKEN"}}]\n\n')

    expect(out).toContain("Original QA_TOKEN")
  })

  test("handles global event wrappers", async () => {
    installPublicStreamGate(new Set())

    const out = await text(
      [
        { directory: "/tmp/project", payload: start() },
        { directory: "/tmp/project", payload: delta() },
        { directory: "/tmp/project", payload: done() },
      ]
        .map(frame)
        .join(""),
    )

    expect(out).not.toContain("raw draft")
    expect(out).toContain("maid")
  })

  test("keeps public stream gate installed while another owner remains", async () => {
    installPublicStreamGate(new Set(), new Set(), "first")
    installPublicStreamGate(new Set(), new Set(), "second")

    uninstallPublicStreamGate("first")
    expect(await text(frame(delta()))).not.toContain("raw draft")

    uninstallPublicStreamGate("second")
    expect(await text(frame(delta()))).toContain("raw draft")
  })

  test("does not drop hidden maid session deltas", async () => {
    installPublicStreamGate(new Set(["maid-session"]))

    const out = await text(
      [
        { type: "message.part.updated", properties: { part: { id: "text-1", sessionID: "maid-session", messageID: "m", type: "text", text: "", time: { start: 1 } } } },
        { type: "message.part.delta", properties: { sessionID: "maid-session", messageID: "m", partID: "text-1", field: "text", delta: "internal" } },
      ]
        .map(frame)
        .join(""),
    )

    expect(out).toContain("internal")
  })

  test("does not drop visible child session deltas", async () => {
    installPublicStreamGate(new Set(), new Set(["child-session"]))

    const out = await text(
      [
        { type: "message.part.updated", properties: { part: { id: "text-1", sessionID: "child-session", messageID: "m", type: "text", text: "", time: { start: 1 } } } },
        { type: "message.part.delta", properties: { sessionID: "child-session", messageID: "m", partID: "text-1", field: "text", delta: "junior raw" } },
      ]
        .map(frame)
        .join(""),
    )

    expect(out).toContain("junior raw")
  })

  test("drops global bus text deltas before listeners receive them", () => {
    installPublicStreamGate(new Set())
    const bus = new EventEmitter()
    const seen: unknown[] = []
    bus.on("event", (event) => seen.push(event))

    bus.emit("event", { directory: "/tmp/project", payload: start() })
    bus.emit("event", { directory: "/tmp/project", payload: delta() })
    bus.emit("event", { directory: "/tmp/project", payload: done() })

    expect(seen).toEqual([{ directory: "/tmp/project", payload: start() }, { directory: "/tmp/project", payload: done() }])
  })

  test("drops worker RPC text delta events before the TUI receives them", () => {
    const sent: unknown[] = []
    globalThis.postMessage = (message: unknown) => {
      sent.push(message)
    }
    installPublicStreamGate(new Set())

    postMessage(JSON.stringify({ type: "rpc.event", event: "event", data: start() }))
    postMessage(JSON.stringify({ type: "rpc.event", event: "event", data: delta() }))
    postMessage(JSON.stringify({ type: "rpc.event", event: "event", data: done() }))

    expect(sent).toEqual([
      JSON.stringify({ type: "rpc.event", event: "event", data: start() }),
      JSON.stringify({ type: "rpc.event", event: "event", data: done() }),
    ])
  })

  test("does not synthesize original drafts into SSE text completions", async () => {
    installPublicStreamGate(new Set(), new Set(), "default")

    const out = await text([start(), done()].map(frame).join(""))

    expect(out).toContain("maid")
    expect(out).not.toContain('"type":"reasoning"')
    expect(out).not.toContain("Original draft")
    expect(out).not.toContain("oh-my-opencode-maid-original-text-1")
  })

  test("does not synthesize original drafts into global events", () => {
    installPublicStreamGate(new Set(), new Set(), "default")
    const bus = new EventEmitter()
    const seen: unknown[] = []
    bus.on("event", (event) => seen.push(event))

    bus.emit("event", done())

    expect(seen).toEqual([done()])
  })

  test("does not synthesize original drafts into worker RPC events", () => {
    const sent: unknown[] = []
    globalThis.postMessage = (message: unknown) => {
      sent.push(message)
    }
    installPublicStreamGate(new Set(), new Set(), "default")

    postMessage(JSON.stringify({ type: "rpc.event", event: "event", data: done() }))

    expect(sent).toEqual([JSON.stringify({ type: "rpc.event", event: "event", data: done() })])
  })

  test("leaves provider streams for the text-complete rewrite path", async () => {
    globalThis.fetch = async () =>
      new Response(`${chunk("Original ")}${chunk("QA_TOKEN")}${chunk("", "stop")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    installProviderRewrite({
      owner: "/tmp/project",
      active: () => false,
      server: "http://opencode.internal",
      rewrite: async () => {
        throw new Error("unexpected rewrite")
      },
    })

    const out = await fetch(upstream, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
    }).then((res) => res.text())

    expect(out).toContain("Original ")
    expect(out).toContain("QA_TOKEN")
    expect(out).not.toContain("Maid QA_TOKEN")
  })

  test("does not rewrite provider streams while hidden maid rewrite is active", async () => {
    globalThis.fetch = async () =>
      new Response(`${chunk("Maid internal QA_TOKEN")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    installProviderRewrite({
      owner: "/tmp/project",
      active: () => true,
      server: "http://opencode.internal",
      rewrite: async () => {
        throw new Error("unexpected rewrite")
      },
    })

    const out = await fetch(upstream, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
    }).then((res) => res.text())

    expect(out).toContain("Maid internal QA_TOKEN")
  })

  test("rewrites provider JSON only when request carries a trusted token", async () => {
    const tokens = new Set(["trusted-token"])
    const upstreamHeaders: Headers[] = []
    globalThis.fetch = async (_input, init) => {
      upstreamHeaders.push(new Headers(init?.headers))
      return new Response(JSON.stringify({ choices: [{ message: { content: "Original QA_TOKEN" } }, { message: { content: "Second Original QA_TOKEN" } }] }), {
        headers: { "content-type": "application/json" },
      })
    }
    installProviderRewrite({
      owner: "/tmp/project",
      active: () => false,
      server: "http://opencode.internal",
      consumeRewriteToken: (headers) => {
        const token = headers.get(PROVIDER_REWRITE_HEADER)
        if (!token || !tokens.delete(token)) return undefined
        return "user-session"
      },
      rewrite: async (draft) => `Maid ${draft}`,
    })

    const rewritten = await fetch(upstream, {
      method: "POST",
      headers: { [PROVIDER_REWRITE_HEADER]: "trusted-token" },
      body: JSON.stringify({ messages: [{ role: "system", content: "rewrite-marker" }] }),
    }).then((res) => res.text())
    const raw = await fetch(upstream, {
      method: "POST",
      headers: { [PROVIDER_REWRITE_HEADER]: "trusted-token" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }).then((res) => res.text())

    expect(rewritten).toContain("Maid Original QA_TOKEN")
    expect(rewritten).not.toContain("Second Original QA_TOKEN")
    expect(raw).toContain("Original QA_TOKEN")
    expect(raw).not.toContain("Maid Original QA_TOKEN")
    expect(upstreamHeaders.every((headers) => !headers.has(PROVIDER_REWRITE_HEADER))).toBe(true)
  })

  test("uninstalls the command interceptor without disturbing stream gates", async () => {
    let upstreamCalls = 0
    globalThis.fetch = (async () => {
      upstreamCalls += 1
      return new Response("upstream")
    }) as typeof fetch
    installPublicStreamGate(new Set(), new Set(), "stream-owner")
    installCommandInterceptor({
      owner: "command-owner",
      server: "http://opencode.internal",
      command: "maid-rewrite-toggle",
      handle: async (input) => ({ info: { sessionID: input.sessionID }, parts: [] }),
    })

    const intercepted = await fetch("http://opencode.internal/session/user-session/command", {
      method: "POST",
      body: JSON.stringify({ command: "maid-rewrite-toggle", arguments: "" }),
    }).then((res) => res.json()) as unknown
    uninstallCommandInterceptor("command-owner")
    const passed = await fetch("http://opencode.internal/session/user-session/command", {
      method: "POST",
      body: JSON.stringify({ command: "maid-rewrite-toggle", arguments: "" }),
    }).then((res) => res.text())

    expect(record(intercepted) && record(intercepted.info) ? intercepted.info.sessionID : undefined).toBe("user-session")
    expect(passed).toBe("upstream")
    expect(upstreamCalls).toBe(1)
    expect(await text(frame(delta()))).not.toContain("raw draft")
  })
})
