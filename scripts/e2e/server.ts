// A minimal OpenAI-compatible provider used only by the e2e. It never calls a
// real model: it classifies each /v1/chat/completions request as the *main*
// agent turn or the hidden *rewrite* agent turn (by the markers src/rewrite.ts
// injects) and returns a fixed, distinguishable body for each. Every request is
// recorded so the orchestrator can assert which model/variant/prompt the plugin
// routed the rewrite through.

import {
  RAW_DRAFT,
  REWRITE_AGENT_SYSTEM_MARKER,
  REWRITE_USER_MARKER,
  REWRITTEN_TEXT,
  ROLEPLAY_SENTINEL,
  USER_TASK,
  VARIANT_WIRE_SENTINEL,
} from "./constants"

export type RecordedRequest = {
  kind: "main" | "rewrite" | "other"
  model: string
  hasRoleplaySentinel: boolean
  hasVariantSentinel: boolean
  hasUserTask: boolean
  body: unknown
  rawBody: string
}

export type FakeProvider = {
  url: string
  requests: RecordedRequest[]
  rewriteRequests: () => RecordedRequest[]
  mainRequests: () => RecordedRequest[]
  stop: () => Promise<void>
}

function flatten(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  const out: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const content = (message as { content?: unknown }).content
    if (typeof content === "string") {
      out.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          out.push((part as { text: string }).text)
        }
      }
    }
  }
  return out.join("\n")
}

function classify(text: string): RecordedRequest["kind"] {
  if (text.includes(REWRITE_AGENT_SYSTEM_MARKER) || text.includes(REWRITE_USER_MARKER)) return "rewrite"
  if (text.includes(USER_TASK)) return "main"
  return "other"
}

function sse(content: string): Response {
  const id = `chatcmpl-e2e-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "e2e",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const enc = new TextEncoder()
      ctrl.enqueue(enc.encode(chunk({ role: "assistant", content: "" })))
      ctrl.enqueue(enc.encode(chunk({ content })))
      ctrl.enqueue(enc.encode(chunk({}, "stop")))
      ctrl.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: "e2e",
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\n`,
        ),
      )
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"))
      ctrl.close()
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

function json(content: string): Response {
  return Response.json({
    id: `chatcmpl-e2e-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "e2e",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

export function startFakeProvider(): FakeProvider {
  const requests: RecordedRequest[] = []

  const server = Bun.serve({
    port: Number(process.env.E2E_PORT ?? 0),
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url)

      if (!url.pathname.endsWith("/chat/completions") || req.method !== "POST") {
        // Be tolerant of any capability/model probing opencode or the SDK does.
        return Response.json({ object: "list", data: [] })
      }

      const rawBody = await req.text()
      let body: unknown
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = undefined
      }
      const model = typeof (body as { model?: unknown })?.model === "string" ? (body as { model: string }).model : ""
      const messagesText = flatten((body as { messages?: unknown })?.messages)
      const kind = classify(messagesText)

      requests.push({
        kind,
        model,
        hasRoleplaySentinel: rawBody.includes(ROLEPLAY_SENTINEL),
        hasVariantSentinel: rawBody.includes(VARIANT_WIRE_SENTINEL),
        hasUserTask: messagesText.includes(USER_TASK),
        body,
        rawBody,
      })

      const content = kind === "rewrite" ? REWRITTEN_TEXT : RAW_DRAFT
      const wantsStream = (body as { stream?: unknown })?.stream === true
      return wantsStream ? sse(content) : json(content)
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    rewriteRequests: () => requests.filter((r) => r.kind === "rewrite"),
    mainRequests: () => requests.filter((r) => r.kind === "main"),
    async stop() {
      await server.stop(true)
    },
  }
}
