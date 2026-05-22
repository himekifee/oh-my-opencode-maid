import { afterEach, describe, expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import MaidPlugin from "./index"
import { MAIN_AGENT_MODEL } from "./config"
import { DISPLAY_ONLY_FALLBACK } from "./fallback"
import { PROVIDER_REWRITE_HEADER, resetPublicStreamGate } from "./patch"
import { createResponseStore, responseDatabasePath, type ResponseStore } from "./responses"
import { FAILURE, HANDOFF, handoffSystemPrompt } from "./rewrite"

type Hooks = Awaited<ReturnType<typeof MaidPlugin>>
type Model = Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0]["model"]
type MessagesOutput = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]
type ChatMessageInput = Parameters<NonNullable<Hooks["chat.message"]>>[0]
type ChatMessageOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1]
type CommandOutput = Parameters<NonNullable<Hooks["command.execute.before"]>>[1]
type ToastCall = {
  body: {
    title?: string
    message: string
    variant?: "info" | "success" | "warning" | "error"
    duration?: number
  }
}

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function model(providerID = "openai", id = "gpt-5.5", variant?: string): Model {
  return { id, providerID, ...(variant ? { variant } : {}) } as unknown as Model
}

function carry(text: string) {
  return `${text}\n\n\`\`\`${HANDOFF}\n${JSON.stringify({
    audience: "user",
    tone_goal: "configured style",
    must_preserve: ["SECRET_TOKEN"],
    reply_constraints: [],
    exact_reply_mode: "rewrite",
  })}\n\`\`\``
}

function providerBody(text = "hi") {
  return JSON.stringify({ messages: [{ role: "system", content: handoffSystemPrompt() }, { role: "user", content: text }] })
}

function plainProviderBody(text = "hi") {
  return JSON.stringify({ messages: [{ role: "user", content: text }] })
}

async function providerHeaders(hooks: Hooks, sessionID = "user-session", activeModel = model()) {
  const output = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]?.({
    sessionID,
    agent: "build",
    model: activeModel,
    provider: { source: "config", info: {} as never, options: {} },
    message: {} as never,
  }, output)
  return output.headers
}

function ctx(session: unknown, dir: string, toasts: ToastCall[] = []): PluginInput {
  return {
    directory: dir,
    worktree: dir,
    serverUrl: new URL("http://localhost:4096"),
    project: {} as PluginInput["project"],
    experimental_workspace: { register() {} },
    $: {} as PluginInput["$"],
    client: {
      session,
      tui: {
        showToast(input: ToastCall) {
          toasts.push(input)
          return Promise.resolve({ data: true })
        },
      },
    } as unknown as PluginInput["client"],
  }
}

function commandOutput(text = "toggle") {
  return {
    parts: [{ id: "cmd-part", sessionID: "user-session", messageID: "cmd-message", type: "text", text, time: { start: 1 } }],
  } as unknown as CommandOutput
}

function commandRequest(command: string, sessionID = "user-session") {
  return fetch(`http://localhost:4096/session/${sessionID}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, arguments: "" }),
  })
}

async function executeToggle(hooks: Hooks, output = commandOutput()) {
  let thrown: unknown
  try {
    await hooks["command.execute.before"]?.({ command: "maid-rewrite-toggle", sessionID: "user-session", arguments: "" }, output)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe("OMO_MAID_REWRITE_TOGGLE_HANDLED")
  return output
}

function messages(input: { info: Record<string, unknown>; parts: Record<string, unknown>[] }[]): MessagesOutput {
  return { messages: input } as unknown as MessagesOutput
}

function chatMessage(sessionID: string, text: string): [ChatMessageInput, ChatMessageOutput] {
  return [
    { sessionID, model: model() } as unknown as ChatMessageInput,
    { message: { role: "user" }, parts: [{ type: "text", text }] } as unknown as ChatMessageOutput,
  ]
}

function hiddenPrompt(input: unknown) {
  if (!record(input) || !Array.isArray(input.parts)) return ""
  const part = input.parts[0]
  if (!record(part) || part.type !== "text" || typeof part.text !== "string") return ""
  return part.text
}

function resetPluginGlobals() {
  resetPublicStreamGate()
  globalThis.__ohMyOpencodeMaidResponses?.close()
  delete globalThis.__ohMyOpencodeMaidHidden
  delete globalThis.__ohMyOpencodeMaidCompleted
  delete globalThis.__ohMyOpencodeMaidPending
  delete globalThis.__ohMyOpencodeMaidPassthrough
  delete globalThis.__ohMyOpencodeMaidProviderTokens
  delete globalThis.__ohMyOpencodeMaidMainModels
  delete globalThis.__ohMyOpencodeMaidUserPrompts
  delete globalThis.__ohMyOpencodeMaidRewriteHistory
  delete globalThis.__ohMyOpencodeMaidDeleted
  delete globalThis.__ohMyOpencodeMaidRoots
  delete globalThis.__ohMyOpencodeMaidRewriteGuards
  for (const timer of globalThis.__ohMyOpencodeMaidCompacting?.values() ?? []) clearTimeout(timer)
  delete globalThis.__ohMyOpencodeMaidCompacting
  delete globalThis.__ohMyOpencodeMaidProviderOriginals
  delete globalThis.__ohMyOpencodeMaidResponses
  delete globalThis.__ohMyOpencodeMaidRewriteScope
  delete globalThis.__ohMyOpencodeMaidEnabled
}

function fakeResponseStore(overrides: Partial<ResponseStore>): ResponseStore {
  return {
    putOriginal() {},
    putDisplayOriginal() {},
    hasOriginal() {
      return false
    },
    getOriginal() {
      return undefined
    },
    getContextOriginal() {
      return undefined
    },
    deleteOriginal() {},
    deleteSession() {},
    putPendingProviderOriginal() {},
    consumePendingProviderOriginal() {
      return undefined
    },
    getSessionOriginals() {
      return []
    },
    close() {},
    ...overrides,
  }
}

async function isolated<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "omo-maid-plugin-"))
  const xdg = process.env.XDG_CONFIG_HOME
  const state = process.env.XDG_STATE_HOME
  const home = process.env.HOME
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg")
  process.env.XDG_STATE_HOME = path.join(dir, "state")
  process.env.HOME = path.join(dir, "home")
  try {
    return await fn(dir)
  } finally {
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = xdg
    if (state === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = state
    if (home === undefined) delete process.env.HOME
    else process.env.HOME = home
    await rm(dir, { recursive: true, force: true })
  }
}

function userConfigFile() {
  return path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "oh-my-opencode-maid.jsonc")
}

describe("plugin hooks", () => {
  afterEach(resetPluginGlobals)

  test("injects hidden rewrite agent and handoff system transform", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({}, dir))
      const cfg: Config = { provider: { fake: { options: {} } } } as unknown as Config
      const output = { system: [] as string[] }

      await hooks.config?.(cfg)
      await hooks["experimental.chat.system.transform"]?.({ sessionID: "user-session", model: model() }, output)

      const agent = cfg.agent?.roleplay_rewrite as unknown as Record<string, unknown>
      expect(agent.hidden).toBe(true)
      expect(agent.model).toBe("openai/gpt-5.5")
      expect(agent.model).not.toBe(MAIN_AGENT_MODEL)
      expect(agent.steps).toBeUndefined()
      expect(agent.maxSteps).toBeUndefined()
      expect(agent.tools).toEqual({
        agent: false,
        bash: false,
        browser: false,
        codesearch: false,
        edit: false,
        glob: false,
        grep: false,
        list: false,
        mcp: false,
        patch: false,
        question: false,
        read: false,
        skill: false,
        task: false,
        todowrite: false,
        webfetch: false,
        websearch: false,
        write: false,
      })
      expect(typeof (cfg.provider?.fake as unknown as { options?: { fetch?: unknown } }).options?.fetch).toBe("function")
      expect(output.system.join("\n")).toContain(HANDOFF)
    })
  })

  test("registers the server-side rewrite toggle command even when disabled", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ enabled: false }))
      const hooks = await MaidPlugin(ctx({}, dir))
      const cfg: Config = { provider: { fake: { options: {} } } } as unknown as Config

      await hooks.config?.(cfg)

      const command = (cfg as unknown as { command?: Record<string, { template: string; description?: string }> }).command?.["maid-rewrite-toggle"]
      const agent = cfg.agent?.roleplay_rewrite as unknown as Record<string, unknown>
      expect(command).toEqual({
        template: "Toggle oh-my-opencode-maid rewrites on or off immediately.",
        description: "Toggle oh-my-opencode-maid rewrites immediately and persist the enabled config.",
      })
      expect(agent.hidden).toBe(true)
      expect(typeof (cfg.provider?.fake as unknown as { options?: { fetch?: unknown } }).options?.fetch).toBe("function")
    })
  })

  test("intercepts the rewrite toggle command before the prompt command path", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      let beforeCalls = 0
      const toasts: ToastCall[] = []
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir, toasts))
      hooks["command.execute.before"] = async () => {
        beforeCalls += 1
      }
      const before = { text: "Raw SECRET_TOKEN" }
      const after = { text: "Second raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m1", partID: "p1" }, before)
      const response = await commandRequest("maid-rewrite-toggle")
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m2", partID: "p2" }, after)

      expect(response.status).toBe(200)
      expect(before.text).toBe("Maid 1 SECRET_TOKEN")
      expect(after.text).toBe("Second raw SECRET_TOKEN")
      expect(prompts).toBe(1)
      expect(beforeCalls).toBe(0)
      expect(JSON.parse(await Bun.file(userConfigFile()).text()).enabled).toBe(false)
      expect(toasts).toEqual([{ body: { variant: "success", title: "Rewrite disabled", message: "Maid rewrites are now disabled.", duration: 5000 } }])
    })
  })

  test("intercepted rewrite toggle returns raw command endpoint data", async () => {
    await isolated(async (dir) => {
      await MaidPlugin(ctx({}, dir))

      const response = await commandRequest("maid-rewrite-toggle", "session-with-spaces")
      const body = await response.json() as unknown

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("application/json")
      expect(record(body)).toBe(true)
      if (!record(body)) throw new Error("response body is not an object")
      expect(record(body.info)).toBe(true)
      expect(Array.isArray(body.parts)).toBe(true)
      expect(body).not.toHaveProperty("data")
      expect(body.info).toMatchObject({ sessionID: "session-with-spaces", role: "assistant", providerID: "oh-my-opencode-maid", modelID: "oh-my-opencode-maid" })
      expect(body.parts).toEqual([expect.objectContaining({ sessionID: "session-with-spaces", type: "text", text: "Maid rewrites are now disabled.", synthetic: true })])
    })
  })

  test("passes non-toggle local command requests through", async () => {
    await isolated(async (dir) => {
      let upstreamCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        upstreamCalls += 1
        return new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } })
      }) as typeof fetch
      try {
        await MaidPlugin(ctx({}, dir))

        const response = await commandRequest("other-command")
        const body = await response.json() as unknown

        expect(response.status).toBe(202)
        expect(body).toEqual({ ok: true })
        expect(upstreamCalls).toBe(1)
        expect(JSON.parse(await Bun.file(userConfigFile()).text()).enabled).toBe(true)
      } finally {
        resetPublicStreamGate()
        globalThis.fetch = originalFetch
      }
    })
  })

  test("passes external command-shaped requests through", async () => {
    await isolated(async (dir) => {
      let upstreamCalls = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        upstreamCalls += 1
        return new Response("external", { status: 203 })
      }) as typeof fetch
      try {
        await MaidPlugin(ctx({}, dir))

        const response = await fetch("https://provider.example/session/user-session/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "maid-rewrite-toggle", arguments: "" }),
        })

        expect(response.status).toBe(203)
        expect(await response.text()).toBe("external")
        expect(upstreamCalls).toBe(1)
        expect(JSON.parse(await Bun.file(userConfigFile()).text()).enabled).toBe(true)
      } finally {
        resetPublicStreamGate()
        globalThis.fetch = originalFetch
      }
    })
  })

  test("server rewrite toggle persists config and disables rewrites immediately", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const toasts: ToastCall[] = []
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir, toasts))
      const before = { text: "Raw SECRET_TOKEN" }
      const output = commandOutput()
      const after = { text: "Second raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m1", partID: "p1" }, before)
      await executeToggle(hooks, output)
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m2", partID: "p2" }, after)

      expect(before.text).toBe("Maid 1 SECRET_TOKEN")
      expect(after.text).toBe("Second raw SECRET_TOKEN")
      expect(prompts).toBe(1)
      expect(JSON.parse(await Bun.file(userConfigFile()).text()).enabled).toBe(false)
      expect(output.parts[0]).toMatchObject({ type: "text", text: "Maid rewrites are now disabled.", synthetic: true })
      expect(toasts).toEqual([{ body: { variant: "success", title: "Rewrite disabled", message: "Maid rewrites are now disabled.", duration: 5000 } }])
    })
  })

  test("server rewrite toggle gates reused pending rewrites after disabling", async () => {
    await isolated(async (dir) => {
      let release: (() => void) | undefined
      let promptStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        promptStarted = resolve
      })
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          promptStarted?.()
          return new Promise((resolve) => {
            release = () => resolve({ data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } })
          })
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }
      const first = { text: "Raw SECRET_TOKEN" }
      const second = { text: "Raw SECRET_TOKEN" }

      const firstWork = hooks["experimental.text.complete"]?.(input, first)
      await started
      const secondWork = hooks["experimental.text.complete"]?.(input, second)
      await executeToggle(hooks)
      release?.()
      await Promise.all([firstWork, secondWork])

      expect(first.text).toBe("Raw SECRET_TOKEN")
      expect(second.text).toBe("Raw SECRET_TOKEN")
    })
  })

  test("server rewrite toggle enables rewrites immediately from startup disabled", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ enabled: false }))
      let prompts = 0
      const toasts: ToastCall[] = []
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir, toasts))
      const before = { text: "Raw SECRET_TOKEN" }
      const output = commandOutput()
      const after = { text: "Second raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m1", partID: "p1" }, before)
      await executeToggle(hooks, output)
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m2", partID: "p2" }, after)

      expect(before.text).toBe("Raw SECRET_TOKEN")
      expect(after.text).toBe("Maid 1 SECRET_TOKEN")
      expect(JSON.parse(await Bun.file(userConfigFile()).text()).enabled).toBe(true)
      expect(output.parts[0]).toMatchObject({ type: "text", text: "Maid rewrites are now enabled.", synthetic: true })
      expect(toasts).toEqual([{ body: { variant: "success", title: "Rewrite enabled", message: "Maid rewrites are now enabled.", duration: 5000 } }])
    })
  })

  test("server rewrite toggle immediately controls provider headers and stale provider tokens", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = { provider: { fake: { options: { fetch: providerResponseFetch() } } } } as unknown as Config
      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      const staleHeaders = await providerHeaders(hooks)
      const output = commandOutput()

      await executeToggle(hooks, output)
      const disabledHeaders = await providerHeaders(hooks)
      const staleResponse = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: staleHeaders,
        body: providerBody(),
      }).then((res) => res.text())

      expect(typeof staleHeaders[PROVIDER_REWRITE_HEADER]).toBe("string")
      expect(disabledHeaders[PROVIDER_REWRITE_HEADER]).toBeUndefined()
      expect(staleResponse).toContain("Raw SECRET_TOKEN")
      expect(staleResponse).not.toContain("Maid 1 SECRET_TOKEN")
      expect(prompts).toBe(0)
    })
  })

  test("server rewrite toggle enables configured provider rewrites without restart", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ enabled: false }))
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = { provider: { fake: { options: { fetch: providerResponseFetch() } } } } as unknown as Config
      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      expect((await providerHeaders(hooks))[PROVIDER_REWRITE_HEADER]).toBeUndefined()
      await executeToggle(hooks)

      const response = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody(),
      }).then((res) => res.text())

      expect(response).toContain("Maid 1 SECRET_TOKEN")
      expect(prompts).toBe(1)
    })
  })

  test("server rewrite toggle reports persistence failures and keeps live state", async () => {
    await isolated(async (dir) => {
      const toasts: ToastCall[] = []
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir, toasts))
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), "{ invalid")
      const output = commandOutput()
      const after = { text: "Raw SECRET_TOKEN" }

      await executeToggle(hooks, output)
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, after)

      expect(output.parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("Maid rewrite toggle failed: Invalid JSONC"), synthetic: true })
      expect(toasts).toEqual([{ body: { variant: "error", title: "Rewrite toggle failed", message: expect.stringContaining("Invalid JSONC"), duration: 5000 } }])
      expect(after.text).toBe("Maid 1 SECRET_TOKEN")
    })
  })

  test("keeps injected hidden agent config concrete while the maid default is the sentinel", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({}, dir))
      const cfg: Config = {
        agent: {
          build: {
            model: "anthropic/claude-sonnet-4-5",
            variant: "thinking",
          },
        },
        provider: { fake: { options: {} } },
      } as unknown as Config

      await hooks.config?.(cfg)

      const agent = cfg.agent?.roleplay_rewrite as unknown as Record<string, unknown>
      expect(agent.model).toBe("openai/gpt-5.5")
      expect(agent.model).not.toBe(MAIN_AGENT_MODEL)
      expect(agent.variant).toBeUndefined()
    })
  })

  test("uses captured main model and variant for text-complete sentinel rewrites", async () => {
    await isolated(async (dir) => {
      const calls: { method: string; input: unknown }[] = []
      const hooks = await MaidPlugin(ctx({
        async create(input: unknown) {
          calls.push({ method: "create", input })
          return { data: { id: "maid-session" } }
        },
        async prompt(input: unknown) {
          calls.push({ method: "prompt", input })
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete(input: unknown) {
          calls.push({ method: "delete", input })
          return { data: true }
        },
      }, dir))
      const system = { system: [] as string[] }
      const output = { text: "Raw SECRET_TOKEN" }
      const activeInput = {
        sessionID: "user-session",
        model: model("anthropic", "claude-sonnet-4-5"),
        variant: "thinking",
      } as unknown as Parameters<NonNullable<Hooks["experimental.chat.system.transform"]>>[0]

      await hooks["experimental.chat.system.transform"]?.(activeInput, system)
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)

      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(JSON.stringify(calls)).not.toContain(MAIN_AGENT_MODEL)
      expect(calls[0]).toEqual({
        method: "create",
        input: expect.objectContaining({
          model: { id: "claude-sonnet-4-5", providerID: "anthropic", variant: "thinking" },
        }),
      })
      expect(calls[1]).toEqual({
        method: "prompt",
        input: expect.objectContaining({
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "thinking",
        }),
      })
    })
  })

  test("explicit concrete maid model ignores captured main model and keeps cfg variant", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ model: "openai/gpt-5.5", variant: "fast" }))
      const calls: { method: string; input: unknown }[] = []
      const hooks = await MaidPlugin(ctx({
        async create(input: unknown) {
          calls.push({ method: "create", input })
          return { data: { id: "maid-session" } }
        },
        async prompt(input: unknown) {
          calls.push({ method: "prompt", input })
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete(input: unknown) {
          calls.push({ method: "delete", input })
          return { data: true }
        },
      }, dir))
      const system = { system: [] as string[] }
      const output = { text: "Raw SECRET_TOKEN" }

      await hooks["experimental.chat.system.transform"]?.({ sessionID: "user-session", model: model("anthropic", "claude-sonnet-4-5", "thinking") }, system)
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)

      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(calls[0]).toEqual({
        method: "create",
        input: expect.objectContaining({
          model: { id: "gpt-5.5", providerID: "openai", variant: "fast" },
        }),
      })
      expect(calls[1]).toEqual({
        method: "prompt",
        input: expect.objectContaining({
          model: { providerID: "openai", modelID: "gpt-5.5" },
          variant: "fast",
        }),
      })
    })
  })

  test("provider rewrites use captured main model and variant from chat headers", async () => {
    await isolated(async (dir) => {
      const calls: { method: string; input: unknown }[] = []
      const hooks = await MaidPlugin(ctx({
        async create(input: unknown) {
          calls.push({ method: "create", input })
          return { data: { id: "maid-session" } }
        },
        async prompt(input: unknown) {
          calls.push({ method: "prompt", input })
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete(input: unknown) {
          calls.push({ method: "delete", input })
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw SECRET_TOKEN") } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      const response = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks, "user-session", model("anthropic", "claude-sonnet-4-5", "thinking")),
        body: providerBody(),
      }).then((res) => res.text())

      expect(response).toContain("Maid SECRET_TOKEN")
      expect(JSON.stringify(calls)).not.toContain(MAIN_AGENT_MODEL)
      expect(calls[0]).toEqual({
        method: "create",
        input: expect.objectContaining({
          model: { id: "claude-sonnet-4-5", providerID: "anthropic", variant: "thinking" },
        }),
      })
      expect(calls[1]).toEqual({
        method: "prompt",
        input: expect.objectContaining({
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "thinking",
        }),
      })
    })
  })

  test("includes prior successful provider rewrites when rewrite_context_size is greater than one", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ rewrite_context_size: 3 }))
      const prompts: string[] = []
      const drafts = [carry("First provider raw SECRET_TOKEN"), carry("Second provider raw SECRET_TOKEN")]
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts.length}` } }
        },
        async prompt(input: unknown) {
          prompts.push(hiddenPrompt(input))
          return { data: { parts: [{ type: "text", text: `Provider maid ${prompts.length} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: drafts.shift() } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      await hooks["chat.message"]?.(...chatMessage("user-session", "First provider request"))
      await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody("first"),
      })
      await hooks["chat.message"]?.(...chatMessage("user-session", "Second provider request"))
      await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody("second"),
      })

      expect(prompts[1]).toContain("Previous context, reference only")
      expect(prompts[1]).not.toContain("First provider request")
      expect(prompts[1]).not.toContain("First provider raw SECRET_TOKEN")
      expect(prompts[1]).toContain("Provider maid 1 SECRET_TOKEN")
      expect(prompts[1]).toContain("Current user prompt")
      expect(prompts[1]).toContain("Second provider request")
      expect(prompts[1]).toContain("This-time rewrite target")
      expect(prompts[1]).toContain("Second provider raw SECRET_TOKEN")
    })
  })

  test("provider history includes only prior rewritten text", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ rewrite_context_size: 3 }))
      const prompts: string[] = []
      const drafts = [carry("First provider raw SECRET_TOKEN"), carry("Second provider raw SECRET_TOKEN")]
      let releaseFirst: (() => void) | undefined
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts.length}` } }
        },
        async prompt(input: unknown) {
          prompts.push(hiddenPrompt(input))
          if (prompts.length === 1) {
            return new Promise((resolve) => {
              releaseFirst = () => resolve({ data: { parts: [{ type: "text", text: "First provider maid SECRET_TOKEN" }] } })
            })
          }
          return { data: { parts: [{ type: "text", text: "Second provider maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: drafts.shift() } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      await hooks["chat.message"]?.(...chatMessage("user-session", "Provider prompt at rewrite start"))
      const firstWork = fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody("first"),
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await hooks["chat.message"]?.(...chatMessage("user-session", "Provider prompt changed before completion"))
      releaseFirst?.()
      await firstWork
      await hooks["chat.message"]?.(...chatMessage("user-session", "Second provider prompt"))
      await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody("second"),
      })

      expect(prompts[1]).toContain("Previous context, reference only")
      expect(prompts[1]).not.toContain("Provider prompt at rewrite start")
      expect(prompts[1]).not.toContain("Provider prompt changed before completion")
      expect(prompts[1]).not.toContain("First provider raw SECRET_TOKEN")
      expect(prompts[1]).toContain("First provider maid SECRET_TOKEN")
      expect(prompts[1]).toContain("Current user prompt")
      expect(prompts[1]).toContain("Second provider prompt")
    })
  })


  test("does not inject handoff metadata into title generation", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({}, dir))
      const titleSystem = { system: ["You are a title generator. You output ONLY a thread title. Nothing else."] }
      const generatedSystem = { system: ["Create an agent configuration based on this request."] }

      await hooks["experimental.chat.system.transform"]?.({ sessionID: "user-session", model: model() }, titleSystem)
      await hooks["experimental.chat.system.transform"]?.({ model: model() }, generatedSystem)

      expect(titleSystem.system.join("\n")).not.toContain(HANDOFF)
      expect(generatedSystem.system.join("\n")).not.toContain(HANDOFF)
    })
  })

  test("does not inject duplicate handoff metadata across duplicate plugin instances", async () => {
    await isolated(async (dir) => {
      const first = await MaidPlugin(ctx({}, dir))
      const second = await MaidPlugin(ctx({}, dir))
      const output = { system: [] as string[] }

      await first["experimental.chat.system.transform"]?.({ sessionID: "user-session", model: model() }, output)
      await second["experimental.chat.system.transform"]?.({ sessionID: "user-session", model: model() }, output)

      expect(output.system.join("\n").match(new RegExp(HANDOFF, "g"))?.length).toBe(1)
    })
  })

  test("rewrites text through hidden agent and skips nested transforms while rewrite is active", async () => {
    await isolated(async (dir) => {
      let hooks: Hooks | undefined
      const session = {
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          const nested = { text: "internal draft" }
          const untracked = { text: carry("untracked internal draft SECRET_TOKEN") }
          const hiddenSystem = { system: ["base", "foreign steering"] as string[] }
          const activeSystem = { system: [] as string[] }
          await hooks?.["experimental.text.complete"]?.({ sessionID: "maid-session", messageID: "m", partID: "p" }, nested)
          await hooks?.["experimental.chat.system.transform"]?.({ sessionID: "maid-session", model: model() }, hiddenSystem)
          await hooks?.["experimental.text.complete"]?.({ sessionID: "untracked-session", messageID: "m", partID: "p" }, untracked)
          await hooks?.["experimental.chat.system.transform"]?.({ sessionID: "untracked-session", model: model() }, activeSystem)
          expect(nested.text).toBe("internal draft")
          expect(untracked.text).toBe(FAILURE)
          expect(hiddenSystem.system).toEqual([expect.stringContaining("hidden rewrite-only OpenCode agent")])
          expect(activeSystem.system).toEqual([])
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }
      hooks = await MaidPlugin(ctx(session, dir))
      const output = { text: carry("Raw SECRET_TOKEN") }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)

      expect(output.text).toBe("Maid SECRET_TOKEN")
    })
  })

  test("strips foreign system additions from hidden rewrite sessions", async () => {
    await isolated(async (dir) => {
      let hooks: Hooks | undefined
      const session = {
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          const system = { system: ["base", "foreign steering"] as string[] }
          await hooks?.["experimental.chat.system.transform"]?.({ sessionID: "maid-session", model: model() }, system)
          expect(system.system).toEqual([expect.stringContaining("hidden rewrite-only OpenCode agent")])
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }
      hooks = await MaidPlugin(ctx(session, dir))

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, { text: "Raw SECRET_TOKEN" })

      const hiddenSystem = { system: ["base", "foreign steering"] as string[] }
      await hooks["experimental.chat.system.transform"]?.({ sessionID: "maid-session", model: model() }, hiddenSystem)
      expect(hiddenSystem.system).toEqual([expect.stringContaining("hidden rewrite-only OpenCode agent")])
    })
  })

  test("rewrites ordinary completed text so handoff compliance is not required", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "Plain draft SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)

      expect(output.text).toBe("Maid SECRET_TOKEN")
    })
  })

  test("keeps default rewrite context current-target-only", async () => {
    await isolated(async (dir) => {
      const prompts: string[] = []
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts.length}` } }
        },
        async prompt(input: unknown) {
          prompts.push(hiddenPrompt(input))
          return { data: { parts: [{ type: "text", text: `Maid ${prompts.length} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const first = { text: "First raw SECRET_TOKEN" }
      const second = { text: "Second raw SECRET_TOKEN" }

      await hooks["chat.message"]?.(...chatMessage("user-session", "First user request"))
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m1", partID: "p1" }, first)
      await hooks["chat.message"]?.(...chatMessage("user-session", "Second user request"))
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m2", partID: "p2" }, second)

      expect(first.text).toBe("Maid 1 SECRET_TOKEN")
      expect(second.text).toBe("Maid 2 SECRET_TOKEN")
      expect(prompts[1]).not.toContain("Current user prompt")
      expect(prompts[1]).not.toContain("Second user request")
      expect(prompts[1]).toContain("This-time rewrite target")
      expect(prompts[1]).toContain("Second raw SECRET_TOKEN")
      expect(prompts[1]).not.toContain("Previous context, reference only")
      expect(prompts[1]).not.toContain("First raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidUserPrompts?.size ?? 0).toBe(0)
      expect(globalThis.__ohMyOpencodeMaidRewriteHistory?.size ?? 0).toBe(0)
    })
  })

  test("includes prior successful text-complete rewrites when rewrite_context_size is greater than one", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ rewrite_context_size: 3 }))
      const prompts: string[] = []
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts.length}` } }
        },
        async prompt(input: unknown) {
          prompts.push(hiddenPrompt(input))
          return { data: { parts: [{ type: "text", text: `Maid ${prompts.length} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const first = { text: "First raw SECRET_TOKEN" }
      const second = { text: "Second raw SECRET_TOKEN" }

      await hooks["chat.message"]?.(...chatMessage("user-session", "First user request"))
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m1", partID: "p1" }, first)
      await hooks["chat.message"]?.(...chatMessage("user-session", "Second user request"))
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m2", partID: "p2" }, second)

      expect(prompts[1]).toContain("Previous context, reference only")
      expect(prompts[1]).not.toContain("First user request")
      expect(prompts[1]).not.toContain("First raw SECRET_TOKEN")
      expect(prompts[1]).toContain("Maid 1 SECRET_TOKEN")
      expect(prompts[1]).toContain("Current user prompt")
      expect(prompts[1]).toContain("Second user request")
      expect(prompts[1]).toContain("This-time rewrite target")
      expect(prompts[1]).toContain("Second raw SECRET_TOKEN")
      expect(prompts[1].indexOf("Previous context, reference only")).toBeLessThan(prompts[1].indexOf("Current user prompt"))
    })
  })

  test("text-complete history includes only prior rewritten text", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ rewrite_context_size: 3 }))
      const prompts: string[] = []
      let releaseFirst: (() => void) | undefined
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts.length}` } }
        },
        async prompt(input: unknown) {
          prompts.push(hiddenPrompt(input))
          if (prompts.length === 1) {
            return new Promise((resolve) => {
              releaseFirst = () => resolve({ data: { parts: [{ type: "text", text: "First maid SECRET_TOKEN" }] } })
            })
          }
          return { data: { parts: [{ type: "text", text: "Second maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const first = { text: "First raw SECRET_TOKEN" }
      const second = { text: "Second raw SECRET_TOKEN" }

      await hooks["chat.message"]?.(...chatMessage("user-session", "Prompt at rewrite start"))
      const firstWork = hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m1", partID: "p1" }, first)
      await new Promise((resolve) => setTimeout(resolve, 0))
      await hooks["chat.message"]?.(...chatMessage("user-session", "Prompt changed before completion"))
      releaseFirst?.()
      await firstWork
      await hooks["chat.message"]?.(...chatMessage("user-session", "Second prompt"))
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m2", partID: "p2" }, second)

      expect(prompts[1]).toContain("Previous context, reference only")
      expect(prompts[1]).not.toContain("Prompt at rewrite start")
      expect(prompts[1]).not.toContain("Prompt changed before completion")
      expect(prompts[1]).toContain("First maid SECRET_TOKEN")
      expect(prompts[1]).toContain("Current user prompt")
      expect(prompts[1]).toContain("Second prompt")
    })
  })

  test("bypasses rewrite hooks for child sessions learned from events", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "child-session", messageID: "m", partID: "p" }, "Junior visible SECRET_TOKEN", "Stale parent raw SECRET_TOKEN")
      store.close()
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          prompts += 1
          throw new Error("unexpected rewrite")
        },
      }, dir))
      await hooks.event?.({
        event: {
          type: "session.created",
          properties: {
            sessionID: "child-session",
            info: { id: "child-session", parentID: "root-session", title: "Sisyphus-Junior", agent: "Sisyphus-Junior" },
          },
        },
      })
      const system = { system: [] as string[] }
      const output = { text: "Junior raw SECRET_TOKEN" }
      const part = { type: "text", id: "p", text: "Junior visible SECRET_TOKEN" }

      await hooks["experimental.chat.system.transform"]?.({ sessionID: "child-session", model: model() }, system)
      await hooks["experimental.text.complete"]?.({ sessionID: "child-session", messageID: "m", partID: "p" }, output)
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "child-session", id: "m" }, parts: [part] }]))

      expect(system.system.join("\n")).not.toContain(HANDOFF)
      expect(output.text).toBe("Junior raw SECRET_TOKEN")
      expect(part.text).toBe("Junior visible SECRET_TOKEN")
      expect(prompts).toBe(0)
    })
  })

  test("bypasses rewrite hooks for child sessions found through session.get", async () => {
    await isolated(async (dir) => {
      let gets = 0
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async get(input: unknown) {
          gets += 1
          expect(input).toEqual({ sessionID: "fallback-child", directory: dir })
          return { data: { id: "fallback-child", parentID: "root-session", title: "Sisyphus-Junior", agent: "Sisyphus-Junior" } }
        },
        async create() {
          prompts += 1
          throw new Error("unexpected rewrite")
        },
      }, dir))
      const system = { system: [] as string[] }
      const output = { text: "Fallback child raw SECRET_TOKEN" }

      await hooks["experimental.chat.system.transform"]?.({ sessionID: "fallback-child", model: model() }, system)
      await hooks["experimental.text.complete"]?.({ sessionID: "fallback-child", messageID: "m", partID: "p" }, output)

      expect(system.system.join("\n")).not.toContain(HANDOFF)
      expect(output.text).toBe("Fallback child raw SECRET_TOKEN")
      expect(gets).toBe(1)
      expect(prompts).toBe(0)
    })
  })

  test("guards rewrite sessions discovered through session.get", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({
        async get(input: unknown) {
          expect(input).toEqual({ sessionID: "maid-session", directory: dir })
          return { data: { id: "maid-session", title: "Roleplay rewrite", agent: "roleplay_rewrite" } }
        },
        async create() {
          throw new Error("unexpected rewrite")
        },
      }, dir))
      const system = { system: ["base", "foreign steering"] as string[] }
      const output = { text: "Hidden raw SECRET_TOKEN" }
      const event = { type: "message.part.delta", properties: { sessionID: "maid-session", messageID: "m", partID: "p", field: "text", delta: "Hidden raw SECRET_TOKEN" } }

      await hooks["experimental.chat.system.transform"]?.({ sessionID: "maid-session", model: model() }, system)
      await hooks.event?.({ event })
      await hooks["experimental.text.complete"]?.({ sessionID: "maid-session", messageID: "m", partID: "p" }, output)

      expect(system.system).toEqual([expect.stringContaining("hidden rewrite-only OpenCode agent")])
      expect(event.properties.delta).toBe("")
      expect(output.text).toBe(FAILURE)
    })
  })

  test("keeps text-complete originals out of future message serialization", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "Plain draft SECRET_TOKEN" }
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }

      await hooks["experimental.text.complete"]?.(input, output)
      const part = { type: "text", id: "p", text: output.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))

      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(part.text).toBe("Maid SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid SECRET_TOKEN")).toBe("Plain draft SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid SECRET_TOKEN")).toBeUndefined()
    })
  })

  test("does not restore raw handoff drafts into future message serialization", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: carry("Raw SECRET_TOKEN") }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)
      const part = { type: "text", id: "p", text: output.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))

      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(part.text).toBe("Maid SECRET_TOKEN")
      expect(part.text).not.toContain("Raw SECRET_TOKEN")
      expect(part.text).not.toContain(HANDOFF)
    })
  })

  test("does not rewrite provider output again in text-complete", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw SECRET_TOKEN") } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      const response = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody(),
      }).then((res) => res.text())

      const output = { text: "Maid SECRET_TOKEN" }
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "other" }, output)
      const part = { type: "text", id: "other", text: output.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))

      expect(response).toContain("Maid SECRET_TOKEN")
      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(part.text).toBe("Maid SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "other" }, "Maid SECRET_TOKEN")).toBe("Raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "other" }, "Maid SECRET_TOKEN")).toBeUndefined()
      expect(prompts).toBe(1)
    })
  })

  test("durable provider originals survive plugin re-instantiation before text-complete", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const first = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw SECRET_TOKEN") } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await first.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      const response = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(first),
        body: providerBody(),
      }).then((res) => res.text())
      resetPluginGlobals()
      const second = await MaidPlugin(ctx({
        async create() {
          throw new Error("unexpected rewrite")
        },
      }, dir))
      const output = { text: "Maid SECRET_TOKEN" }
      const part = { type: "text", id: "p", text: output.text }

      await second["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)
      await second["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))

      expect(response).toContain("Maid SECRET_TOKEN")
      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(part.text).toBe("Maid SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid SECRET_TOKEN")).toBe("Raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid SECRET_TOKEN")).toBeUndefined()
      expect(prompts).toBe(1)
    })
  })

  test("expired durable provider originals are not consumed", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putPendingProviderOriginal(dir, "user-session", "Maid SECRET_TOKEN", "Expired raw SECRET_TOKEN")
      const db = new Database(responseDatabasePath())
      db.run("UPDATE pending_provider_originals SET created_at = unixepoch() - 3600")
      db.close()

      const original = store.consumePendingProviderOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid SECRET_TOKEN")

      expect(original).toBeUndefined()
      store.close()
    })
  })

  test("does not rewrite provider responses without a trusted header token", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          prompts += 1
          throw new Error("unexpected rewrite")
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw SECRET_TOKEN") } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      const response = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        body: plainProviderBody(),
      }).then((res) => res.text())

      expect(response).toContain("Raw SECRET_TOKEN")
      expect(response).not.toContain("Maid SECRET_TOKEN")
      expect(prompts).toBe(0)
    })
  })

  test("keeps duplicate provider originals display-only with the same visible text", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const drafts = [carry("First raw SECRET_TOKEN"), carry("Second raw SECRET_TOKEN")]
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: drafts.shift() } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")

      await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody("first"),
      })
      await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody("second"),
      })
      const first = { text: "Maid SECRET_TOKEN" }
      const second = { text: "Maid SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m1", partID: "p1" }, first)
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m2", partID: "p2" }, second)
      const firstPart = { type: "text", id: "p1", text: first.text }
      const secondPart = { type: "text", id: "p2", text: second.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([
        { info: { role: "assistant", sessionID: "user-session", id: "m1" }, parts: [firstPart] },
        { info: { role: "assistant", sessionID: "user-session", id: "m2" }, parts: [secondPart] },
      ]))

      expect(first.text).toBe("Maid SECRET_TOKEN")
      expect(second.text).toBe("Maid SECRET_TOKEN")
      expect(firstPart.text).toBe("Maid SECRET_TOKEN")
      expect(secondPart.text).toBe("Maid SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m1", partID: "p1" }, "Maid SECRET_TOKEN")).toBe("First raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m1", partID: "p1" }, "Maid SECRET_TOKEN")).toBeUndefined()
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m2", partID: "p2" }, "Maid SECRET_TOKEN")).toBe("Second raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m2", partID: "p2" }, "Maid SECRET_TOKEN")).toBeUndefined()
      expect(prompts).toBe(2)
    })
  })

  test("scopes duplicate provider visible text by session", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const drafts = [carry("Session A raw SECRET_TOKEN"), carry("Session B raw SECRET_TOKEN")]
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: drafts.shift() } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")

      await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks, "session-a"),
        body: providerBody("a"),
      })
      await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks, "session-b"),
        body: providerBody("b"),
      })
      const b = { text: "Maid SECRET_TOKEN" }
      const a = { text: "Maid SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "session-b", messageID: "mb", partID: "pb" }, b)
      await hooks["experimental.text.complete"]?.({ sessionID: "session-a", messageID: "ma", partID: "pa" }, a)
      const bPart = { type: "text", id: "pb", text: b.text }
      const aPart = { type: "text", id: "pa", text: a.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([
        { info: { role: "assistant", sessionID: "session-b", id: "mb" }, parts: [bPart] },
        { info: { role: "assistant", sessionID: "session-a", id: "ma" }, parts: [aPart] },
      ]))

      expect(bPart.text).toBe("Maid SECRET_TOKEN")
      expect(aPart.text).toBe("Maid SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "session-b", messageID: "mb", partID: "pb" }, "Maid SECRET_TOKEN")).toBe("Session B raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "session-b", messageID: "mb", partID: "pb" }, "Maid SECRET_TOKEN")).toBeUndefined()
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "session-a", messageID: "ma", partID: "pa" }, "Maid SECRET_TOKEN")).toBe("Session A raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "session-a", messageID: "ma", partID: "pa" }, "Maid SECRET_TOKEN")).toBeUndefined()
      expect(prompts).toBe(2)
    })
  })

  test("does not rewrite the same completed part twice", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }
      const first = { text: "Raw SECRET_TOKEN" }
      const second = { text: "Raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.(input, first)
      await hooks["experimental.text.complete"]?.(input, second)

      expect(first.text).toBe("Maid SECRET_TOKEN")
      expect(second.text).toBe("Maid SECRET_TOKEN")
      expect(prompts).toBe(1)
    })
  })

  test("same message IDs with different text do not replay stale content and update originals", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }
      const first = { text: "First raw SECRET_TOKEN" }
      const second = { text: "Second raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.(input, first)
      await hooks["experimental.text.complete"]?.(input, second)
      const firstPart = { type: "text", id: "p", text: first.text }
      const secondPart = { type: "text", id: "p", text: second.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([
        { info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [firstPart] },
        { info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [secondPart] },
      ]))

      expect(first.text).toBe("Maid 1 SECRET_TOKEN")
      expect(second.text).toBe("Maid 2 SECRET_TOKEN")
      expect(firstPart.text).toBe("Maid 1 SECRET_TOKEN")
      expect(secondPart.text).toBe("Maid 2 SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid 2 SECRET_TOKEN")).toBe("Second raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid 2 SECRET_TOKEN")).toBeUndefined()
      expect(prompts).toBe(2)
    })
  })

  test("stale concurrent same-key rewrites do not overwrite newer originals", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      let releaseFirst: (() => void) | undefined
      let releaseSecond: (() => void) | undefined
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          const current = prompts
          return new Promise((resolve) => {
            const release = () => resolve({ data: { parts: [{ type: "text", text: `Maid ${current} SECRET_TOKEN` }] } })
            if (current === 1) releaseFirst = release
            else releaseSecond = release
          })
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }
      const first = { text: "First raw SECRET_TOKEN" }
      const second = { text: "Second raw SECRET_TOKEN" }
      const firstWork = hooks["experimental.text.complete"]?.(input, first)
      const secondWork = hooks["experimental.text.complete"]?.(input, second)

      await new Promise((resolve) => setTimeout(resolve, 0))
      releaseSecond?.()
      await secondWork
      releaseFirst?.()
      await firstWork
      const part = { type: "text", id: "p", text: second.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))

      expect(first.text).toBe("Maid 1 SECRET_TOKEN")
      expect(second.text).toBe("Maid 2 SECRET_TOKEN")
      expect(part.text).toBe("Maid 2 SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid 2 SECRET_TOKEN")).toBe("Second raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid 2 SECRET_TOKEN")).toBeUndefined()
    })
  })

  test("does not cache failed rewrites as completed", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          if (prompts === 1) throw new Error("rewrite failed")
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }
      const first = { text: "Raw SECRET_TOKEN" }
      const second = { text: "Raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.(input, first)
      const firstPart = { type: "text", id: "p", text: first.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [firstPart] }]))
      await hooks["experimental.text.complete"]?.(input, second)

      expect(first.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(firstPart.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(second.text).toBe("Maid SECRET_TOKEN")
      expect(prompts).toBe(2)
    })
  })

  test("failed rewrites show fallback text while preserving display-only sidecar originals", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          throw new Error("rewrite failed")
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }
      const first = { text: "Raw SECRET_TOKEN" }
      const repeated = { text: DISPLAY_ONLY_FALLBACK }
      const part = { type: "text", id: "p", text: DISPLAY_ONLY_FALLBACK }
      const compacted = { context: [] as string[] }

      await hooks["experimental.text.complete"]?.(input, first)
      await hooks["experimental.text.complete"]?.(input, repeated)
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))
      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compacted)

      expect(first.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(repeated.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(part.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK)).toBe("Raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK)).toBeUndefined()
      expect(compacted.context.join("\n")).not.toContain("Raw SECRET_TOKEN")
      expect(prompts).toBe(1)
    })
  })

  test("legacy fallback rows migrate to display-only originals", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(responseDatabasePath()), { recursive: true })
      const db = new Database(responseDatabasePath(), { create: true })
      db.exec(`
        CREATE TABLE responses (
          directory TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          part_id TEXT NOT NULL,
          visible_text TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (directory, session_id, message_id, part_id)
        ) WITHOUT ROWID
      `)
      db.query(`
        INSERT INTO responses (directory, session_id, message_id, part_id, visible_text, text)
        VALUES ($directory, $session_id, $message_id, $part_id, $visible_text, $text)
      `).run({
        $directory: dir,
        $session_id: "user-session",
        $message_id: "m",
        $part_id: "p",
        $visible_text: DISPLAY_ONLY_FALLBACK,
        $text: "Legacy raw SECRET_TOKEN",
      })
      db.close()

      const store = await createResponseStore()
      expect(store.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK)).toBe("Legacy raw SECRET_TOKEN")
      expect(store.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK)).toBeUndefined()
      store.close()
      const hooks = await MaidPlugin(ctx({}, dir))
      const part = { type: "text", id: "p", text: DISPLAY_ONLY_FALLBACK }
      const compacted = { context: [] as string[] }

      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))
      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compacted)

      expect(part.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(compacted.context.join("\n")).not.toContain("Legacy raw SECRET_TOKEN")
    })
  })

  test("legacy pending provider fallback rows migrate to display-only originals", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(responseDatabasePath()), { recursive: true })
      const db = new Database(responseDatabasePath(), { create: true })
      db.exec(`
        CREATE TABLE pending_provider_originals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          directory TEXT NOT NULL,
          session_id TEXT NOT NULL DEFAULT '',
          visible_text TEXT NOT NULL,
          original_text TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `)
      db.query(`
        INSERT INTO pending_provider_originals (directory, session_id, visible_text, original_text)
        VALUES ($directory, $session_id, $visible_text, $original_text)
      `).run({
        $directory: dir,
        $session_id: "user-session",
        $visible_text: DISPLAY_ONLY_FALLBACK,
        $original_text: "Legacy provider raw SECRET_TOKEN",
      })
      db.close()

      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }
      const legacy = { text: DISPLAY_ONLY_FALLBACK }
      const retry = { text: "Legacy provider raw SECRET_TOKEN" }
      const compacted = { context: [] as string[] }

      await hooks["experimental.text.complete"]?.(input, legacy)
      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compacted)

      expect(legacy.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK)).toBe("Legacy provider raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK)).toBeUndefined()
      expect(compacted.context.join("\n")).not.toContain("Legacy provider raw SECRET_TOKEN")
      await hooks["experimental.compaction.autocontinue"]?.({
        sessionID: "user-session",
        agent: "build",
        model: model(),
        provider: { source: "config", info: {} as never, options: {} },
        message: {} as never,
        overflow: true,
      }, { enabled: true })
      await hooks["experimental.text.complete"]?.(input, retry)
      expect(retry.text).toBe("Maid SECRET_TOKEN")
      expect(prompts).toBe(1)
    })
  })

  test("failed same-key rewrites remove stale originals from compaction", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Old visible SECRET_TOKEN", "Old raw SECRET_TOKEN")
      store.close()
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          throw new Error("rewrite failed")
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "New raw SECRET_TOKEN" }
      const compacted = { context: [] as string[] }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)
      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compacted)

      expect(output.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(compacted.context.join("\n")).not.toContain("Old raw SECRET_TOKEN")
      expect(compacted.context.join("\n")).not.toContain("New raw SECRET_TOKEN")
    })
  })

  test("falls back to provider originals for failed rewrites", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          throw new Error("rewrite failed")
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw SECRET_TOKEN") } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      const response = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody(),
      }).then((res) => res.text())
      const output = { text: DISPLAY_ONLY_FALLBACK }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)
      const part = { type: "text", id: "p", text: output.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))

      expect(response).toContain(DISPLAY_ONLY_FALLBACK)
      expect(response).not.toContain("Raw SECRET_TOKEN")
      expect(output.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(part.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK)).toBe("Raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK)).toBeUndefined()
      expect(prompts).toBe(1)
    })
  })

  test("provider failed rewrites are not cached as completed replays", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          if (prompts === 1) throw new Error("rewrite failed")
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw SECRET_TOKEN") } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await hooks.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(hooks),
        body: providerBody(),
      })
      const providerOutput = { text: DISPLAY_ONLY_FALLBACK }
      const retryOutput = { text: "Raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, providerOutput)
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, retryOutput)

      expect(providerOutput.text).toBe(DISPLAY_ONLY_FALLBACK)
      expect(retryOutput.text).toBe("Maid SECRET_TOKEN")
      expect(prompts).toBe(2)
    })
  })

  test("persistence write failures fail closed without original drafts", async () => {
    await isolated(async (dir) => {
      let directPrompts = 0
      globalThis.__ohMyOpencodeMaidResponses = fakeResponseStore({
        putDisplayOriginal() {
          throw new Error("write failed")
        },
      })
      const direct = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session-direct" } }
        },
        async prompt() {
          directPrompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const directOutput = { text: "Raw SECRET_TOKEN" }

      await direct["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, directOutput)
      resetPluginGlobals()

      let providerPrompts = 0
      globalThis.__ohMyOpencodeMaidResponses = fakeResponseStore({
        putPendingProviderOriginal() {
          throw new Error("pending write failed")
        },
      })
      const provider = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session-provider" } }
        },
        async prompt() {
          providerPrompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const cfg: Config = {
        provider: {
          fake: {
            options: {
              fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw provider SECRET_TOKEN") } }] }), {
                headers: { "content-type": "application/json" },
              }),
            },
          },
        },
      } as unknown as Config

      await provider.config?.(cfg)
      const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
      if (!fetcher) throw new Error("provider fetch was not installed")
      const providerOutput = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: await providerHeaders(provider),
        body: providerBody(),
      }).then((res) => res.text())

      expect(directOutput.text).toBe(FAILURE)
      expect(providerOutput).toContain(DISPLAY_ONLY_FALLBACK)
      expect(providerOutput).not.toContain("Raw provider SECRET_TOKEN")
      expect(providerOutput).not.toContain("Maid SECRET_TOKEN")
      expect(directPrompts).toBe(1)
      expect(providerPrompts).toBe(1)
    })
  })

  test("display-only persistence failures fail closed without original drafts", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      globalThis.__ohMyOpencodeMaidResponses = fakeResponseStore({
        putDisplayOriginal() {
          throw new Error("display write failed")
        },
      })
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          prompts += 1
          throw new Error("rewrite failed")
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "Raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)

      expect(output.text).toBe(FAILURE)
      expect(prompts).toBe(1)
    })
  })

  test("persistence read and delete failures fail closed without original drafts", async () => {
    await isolated(async (dir) => {
      let consumePrompts = 0
      globalThis.__ohMyOpencodeMaidResponses = fakeResponseStore({
        consumePendingProviderOriginal() {
          throw new Error("consume failed")
        },
      })
      const consume = await MaidPlugin(ctx({
        async create() {
          consumePrompts += 1
          throw new Error("unexpected rewrite")
        },
      }, dir))
      const consumeOutput = { text: "Raw consume SECRET_TOKEN" }

      await consume["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, consumeOutput)
      resetPluginGlobals()

      let deletePrompts = 0
      globalThis.__ohMyOpencodeMaidResponses = fakeResponseStore({
        deleteOriginal() {
          throw new Error("delete failed")
        },
      })
      const deletion = await MaidPlugin(ctx({
        async create() {
          deletePrompts += 1
          throw new Error("unexpected rewrite")
        },
      }, dir))
      const deleteOutput = { text: "Raw delete SECRET_TOKEN" }

      await deletion["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, deleteOutput)

      expect(consumeOutput.text).toBe(FAILURE)
      expect(deleteOutput.text).toBe(FAILURE)
      expect(consumePrompts).toBe(0)
      expect(deletePrompts).toBe(0)
    })
  })

  test("response store initialization failures fail closed", async () => {
    await isolated(async (dir) => {
      await writeFile(path.join(dir, "state"), "not a directory")
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "Raw SECRET_TOKEN" }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)

      expect(output.text).toBe(FAILURE)
      expect(prompts).toBe(1)
    })
  })

  test("shares rewrite and hidden-session state across duplicate plugin instances", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      let first: Hooks | undefined
      let second: Hooks | undefined
      const session = {
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          prompts += 1
          const hiddenSystem = { system: ["base", "foreign steering"] as string[] }
          await second?.["experimental.chat.system.transform"]?.({ sessionID: "maid-session", model: model() }, hiddenSystem)
          expect(hiddenSystem.system).toEqual([expect.stringContaining("hidden rewrite-only OpenCode agent")])
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }
      first = await MaidPlugin(ctx(session, dir))
      second = await MaidPlugin(ctx(session, dir))
      const input = { sessionID: "user-session", messageID: "m", partID: "p" }
      const firstOutput = { text: "Raw SECRET_TOKEN" }
      const secondOutput = { text: "Maid SECRET_TOKEN" }

      await first["experimental.text.complete"]?.(input, firstOutput)
      await second["experimental.text.complete"]?.(input, secondOutput)

      expect(firstOutput.text).toBe("Maid SECRET_TOKEN")
      expect(secondOutput.text).toBe("Maid SECRET_TOKEN")
      expect(prompts).toBe(1)
    })
  })

  test("persists originals as display-only across plugin re-instantiation", async () => {
    await isolated(async (dir) => {
      const first = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))

      const output = { text: "Raw SECRET_TOKEN" }
      await first["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)
      resetPluginGlobals()
      const second = await MaidPlugin(ctx({}, dir))
      const part = { type: "text", id: "p", text: output.text }

      await second["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))

      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(part.text).toBe("Maid SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid SECRET_TOKEN")).toBe("Raw SECRET_TOKEN")
      expect(globalThis.__ohMyOpencodeMaidResponses?.getContextOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid SECRET_TOKEN")).toBeUndefined()
    })
  })

  test("compaction context excludes persisted originals", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "Raw SECRET_TOKEN" }
      const compacted = { context: [] as string[] }

      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)
      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compacted)

      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(compacted.context.join("\n")).not.toContain("Raw SECRET_TOKEN")
      expect(compacted.context.join("\n")).not.toContain("Maid SECRET_TOKEN")
    })
  })

  test("does not hydrate rewrite context from persisted originals after plugin restart", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ rewrite_context_size: 3 }))
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m1", partID: "p1" }, "Persisted maid SECRET_TOKEN", "Persisted raw SECRET_TOKEN")
      store.close()
      resetPluginGlobals()
      const prompts: string[] = []
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt(input: unknown) {
          prompts.push(hiddenPrompt(input))
          return { data: { parts: [{ type: "text", text: prompts.length === 1 ? "Current maid SECRET_TOKEN" : "Next maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "Current raw SECRET_TOKEN" }
      const nextOutput = { text: "Next raw SECRET_TOKEN" }

      await hooks["chat.message"]?.(...chatMessage("user-session", "Current request"))
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m2", partID: "p2" }, output)
      await hooks["chat.message"]?.(...chatMessage("user-session", "Next request"))
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m3", partID: "p3" }, nextOutput)

      expect(output.text).toBe("Current maid SECRET_TOKEN")
      expect(prompts[0]).not.toContain("Previous context, reference only")
      expect(prompts[0]).not.toContain("Persisted raw SECRET_TOKEN")
      expect(prompts[0]).not.toContain("Persisted maid SECRET_TOKEN")
      expect(prompts[0]).toContain("Current request")
      expect(nextOutput.text).toBe("Next maid SECRET_TOKEN")
      expect(prompts[1]).toContain("Previous context, reference only")
      expect(prompts[1]).not.toContain("Persisted raw SECRET_TOKEN")
      expect(prompts[1]).not.toContain("Current raw SECRET_TOKEN")
      expect(prompts[1]).not.toContain("Persisted maid SECRET_TOKEN")
      expect(prompts[1]).toContain("Current maid SECRET_TOKEN")
      expect(prompts[1]).not.toContain("Current request")
      expect(prompts[1]).toContain("Next request")
    })
  })

  test("does not rewrite compaction provider headers or completed text", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const hooks = await MaidPlugin(ctx({
        async create() {
          prompts += 1
          throw new Error("unexpected rewrite")
        },
      }, dir))
      const compacted = { context: [] as string[] }
      const compactionOutput = { text: "Professional compaction summary SECRET_TOKEN" }

      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compacted)
      const compactingHeaders = await providerHeaders(hooks)
      await hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "compact" }, compactionOutput)

      expect(compactingHeaders[PROVIDER_REWRITE_HEADER]).toBeUndefined()
      expect(compactionOutput.text).toBe("Professional compaction summary SECRET_TOKEN")
      expect(prompts).toBe(0)

      await hooks["experimental.compaction.autocontinue"]?.({
        sessionID: "user-session",
        agent: "build",
        model: model(),
        provider: { source: "config", info: {} as never, options: {} },
        message: {} as never,
        overflow: true,
      }, { enabled: true })

      const normalHeaders = await providerHeaders(hooks)
      expect(typeof normalHeaders[PROVIDER_REWRITE_HEADER]).toBe("string")
    })
  })

  test("pending same-message rewrites do not restore stale originals into messages or compaction", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Old visible SECRET_TOKEN", "Old raw SECRET_TOKEN")
      store.close()
      let release: (() => void) | undefined
      let promptStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        promptStarted = resolve
      })
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          promptStarted?.()
          return new Promise((resolve) => {
            release = () => resolve({ data: { parts: [{ type: "text", text: "New visible SECRET_TOKEN" }] } })
          })
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "New raw SECRET_TOKEN" }
      const work = hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)
      const part = { type: "text", id: "p", text: "New visible SECRET_TOKEN" }
      const compactedDuring = { context: [] as string[] }
      const compactedAfter = { context: [] as string[] }

      await started
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [part] }]))
      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compactedDuring)
      release?.()
      await work
      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compactedAfter)

      expect(part.text).toBe("New visible SECRET_TOKEN")
      expect(compactedDuring.context.join("\n")).not.toContain("Old raw SECRET_TOKEN")
      expect(output.text).toBe("New visible SECRET_TOKEN")
      expect(compactedAfter.context.join("\n")).not.toContain("New raw SECRET_TOKEN")
      expect(compactedAfter.context.join("\n")).not.toContain("Old raw SECRET_TOKEN")
    })
  })

  test("leaves user, non-text, hidden, missing-id, and legacy rows untouched during message serialization", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Maid assistant", "Raw assistant")
      store.putOriginal({ directory: dir, sessionID: "hidden-session", messageID: "m", partID: "p" }, "Hidden visible", "Hidden raw")
      store.close()
      const hooks = await MaidPlugin(ctx({}, dir))
      globalThis.__ohMyOpencodeMaidHidden?.add("hidden-session")
      const assistantPart = { type: "text", id: "p", text: "Maid assistant" }
      const userPart = { type: "text", id: "p", text: "User visible" }
      const nonTextPart = { type: "tool", id: "p", text: "Tool visible" }
      const hiddenPart = { type: "text", id: "p", text: "Hidden visible" }
      const missingPartID = { type: "text", text: "Missing part id" }
      const missingMessageID = { type: "text", id: "p", text: "Missing message id" }
      const missingSessionID = { type: "text", id: "p", text: "Missing session id" }
      const compacted = { context: [] as string[] }

      await hooks["experimental.chat.messages.transform"]?.({}, messages([
        { info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [assistantPart] },
        { info: { role: "user", sessionID: "user-session", id: "m" }, parts: [userPart] },
        { info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [nonTextPart] },
        { info: { role: "assistant", sessionID: "hidden-session", id: "m" }, parts: [hiddenPart] },
        { info: { role: "assistant", sessionID: "user-session", id: "m" }, parts: [missingPartID] },
        { info: { role: "assistant", sessionID: "user-session" }, parts: [missingMessageID] },
        { info: { role: "assistant", id: "m" }, parts: [missingSessionID] },
      ]))
      await hooks["experimental.session.compacting"]?.({ sessionID: "user-session" }, compacted)

      expect(assistantPart.text).toBe("Maid assistant")
      expect(userPart.text).toBe("User visible")
      expect(nonTextPart.text).toBe("Tool visible")
      expect(hiddenPart.text).toBe("Hidden visible")
      expect(missingPartID.text).toBe("Missing part id")
      expect(missingMessageID.text).toBe("Missing message id")
      expect(missingSessionID.text).toBe("Missing session id")
      expect(compacted.context.join("\n")).not.toContain("Raw assistant")
    })
  })

  test("session deletion clears in-memory user prompt and rewrite history context", async () => {
    await isolated(async (dir) => {
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ rewrite_context_size: 3 }))
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const key = `${dir}/deleted-session`
      const output = { text: "Raw SECRET_TOKEN" }

      await hooks["chat.message"]?.(...chatMessage("deleted-session", "Delete this session request"))
      await hooks["experimental.text.complete"]?.({ sessionID: "deleted-session", messageID: "m", partID: "p" }, output)

      expect(globalThis.__ohMyOpencodeMaidUserPrompts?.has(key)).toBe(true)
      expect(globalThis.__ohMyOpencodeMaidRewriteHistory?.has(key)).toBe(true)
      await hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { sessionID: "deleted-session" },
        },
      })
      expect(globalThis.__ohMyOpencodeMaidUserPrompts?.has(key)).toBe(false)
      expect(globalThis.__ohMyOpencodeMaidRewriteHistory?.has(key)).toBe(false)
    })
  })

  test("session deletion purges persisted originals", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "deleted-session", messageID: "m", partID: "p" }, "Maid SECRET_TOKEN", "Raw SECRET_TOKEN")
      store.close()
      const hooks = await MaidPlugin(ctx({}, dir))
      const part = { type: "text", id: "p", text: "Maid SECRET_TOKEN" }

      await hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { sessionID: "deleted-session" },
        },
      })
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "deleted-session", id: "m" }, parts: [part] }]))

      expect(part.text).toBe("Maid SECRET_TOKEN")
    })
  })

  test("session deletion purges persisted originals while rewrites are disabled", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      const ref = { directory: dir, sessionID: "deleted-session", messageID: "m", partID: "p" }
      store.putOriginal(ref, "Maid SECRET_TOKEN", "Raw SECRET_TOKEN")
      store.close()
      await mkdir(path.dirname(userConfigFile()), { recursive: true })
      await writeFile(userConfigFile(), JSON.stringify({ enabled: false }))
      const hooks = await MaidPlugin(ctx({}, dir))

      await hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { sessionID: "deleted-session" },
        },
      })

      expect(globalThis.__ohMyOpencodeMaidResponses?.getOriginal(ref, "Maid SECRET_TOKEN")).toBeUndefined()
    })
  })

  test("response store checks original existence without returning text", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      const ref = { directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }

      expect(store.hasOriginal(ref, "Maid SECRET_TOKEN")).toBe(false)
      store.putDisplayOriginal(ref, "Maid SECRET_TOKEN", "Raw SECRET_TOKEN")

      expect(store.hasOriginal(ref, "Maid SECRET_TOKEN")).toBe(true)
      expect(store.hasOriginal(ref, "Other visible")).toBe(false)
      store.close()
    })
  })

  test("session deletion tombstones captured main model context", async () => {
    await isolated(async (dir) => {
      const calls: { method: string; input: unknown }[] = []
      const hooks = await MaidPlugin(ctx({
        async create(input: unknown) {
          calls.push({ method: "create", input })
          return { data: { id: "maid-session" } }
        },
        async prompt(input: unknown) {
          calls.push({ method: "prompt", input })
          return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
        },
        async delete(input: unknown) {
          calls.push({ method: "delete", input })
          return { data: true }
        },
      }, dir))
      const system = { system: [] as string[] }
      const output = { text: "Raw SECRET_TOKEN" }

      await hooks["experimental.chat.system.transform"]?.({ sessionID: "deleted-session", model: model("anthropic", "claude-sonnet-4-5", "thinking") }, system)
      await hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { sessionID: "deleted-session" },
        },
      })
      await hooks["experimental.text.complete"]?.({ sessionID: "deleted-session", messageID: "m", partID: "p" }, output)

      expect(output.text).toBe("Raw SECRET_TOKEN")
      expect(calls).toEqual([])
    })
  })


  test("session deletion prevents pending rewrite persistence", async () => {
    await isolated(async (dir) => {
      let release: (() => void) | undefined
      let promptStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        promptStarted = resolve
      })
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          promptStarted?.()
          return new Promise((resolve) => {
            release = () => resolve({ data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } })
          })
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const input = { sessionID: "deleted-session", messageID: "m", partID: "p" }
      const output = { text: "Raw SECRET_TOKEN" }

      const work = hooks["experimental.text.complete"]?.(input, output)
      await started
      await hooks.event?.({
        event: {
          type: "session.deleted",
          properties: { sessionID: "deleted-session" },
        },
      })
      release?.()
      await work

      const part = { type: "text", id: "p", text: output.text }
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "deleted-session", id: "m" }, parts: [part] }]))

      expect(output.text).toBe("Maid SECRET_TOKEN")
      expect(part.text).toBe("Maid SECRET_TOKEN")
    })
  })

  test("does not restore unrelated legacy messages while a rewrite is still pending", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "other-session", messageID: "m2", partID: "p2" }, "Other visible SECRET_TOKEN", "Other raw SECRET_TOKEN")
      store.close()
      let release: (() => void) | undefined
      let promptStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        promptStarted = resolve
      })
      const hooks = await MaidPlugin(ctx({
        async create() {
          return { data: { id: "maid-session" } }
        },
        async prompt() {
          promptStarted?.()
          return new Promise((resolve) => {
            release = () => resolve({ data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } })
          })
        },
        async delete() {
          return { data: true }
        },
      }, dir))
      const output = { text: "Raw SECRET_TOKEN" }
      const work = hooks["experimental.text.complete"]?.({ sessionID: "user-session", messageID: "m", partID: "p" }, output)
      const part = { type: "text", id: "p2", text: "Other visible SECRET_TOKEN" }

      await started
      await hooks["experimental.chat.messages.transform"]?.({}, messages([{ info: { role: "assistant", sessionID: "other-session", id: "m2" }, parts: [part] }]))
      release?.()
      await work

      expect(part.text).toBe("Other visible SECRET_TOKEN")
      expect(output.text).toBe("Maid SECRET_TOKEN")
    })
  })

  test("always installs configured provider fetch wrapping", async () => {
    await isolated(async (dir) => {
      const hooks = await MaidPlugin(ctx({}, dir))
      const cfg: Config = { provider: { fake: { options: {} } } } as unknown as Config

      await hooks.config?.(cfg)

      expect(typeof (cfg.provider?.fake as unknown as { options?: { fetch?: unknown } }).options?.fetch).toBe("function")
    })
  })

  test("uses the pre-patch fetch when wrapping configured providers", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = providerResponseFetch()
      let fetcher: typeof fetch | undefined
      try {
        fetcher = await providerFetchForPlugin(dir, () => prompts, (next) => {
          prompts = next
        })
      } finally {
        resetPublicStreamGate()
        globalThis.fetch = originalFetch
      }
      if (!fetcher) throw new Error("provider fetch was not installed")

      const response = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        body: providerBody(),
      }).then((res) => res.text())

      expect(response).toContain("Maid 1 SECRET_TOKEN")
      expect(response).not.toContain("Maid 2 SECRET_TOKEN")
      expect(prompts).toBe(1)
    })
  })

  test("uses the original fetch when a duplicate plugin instance wraps configured providers", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = providerResponseFetch()
      let fetcher: typeof fetch | undefined
      try {
        await providerFetchForPlugin(dir, () => prompts, (next) => {
          prompts = next
        })
        fetcher = await providerFetchForPlugin(dir, () => prompts, (next) => {
          prompts = next
        })
      } finally {
        resetPublicStreamGate()
        globalThis.fetch = originalFetch
      }
      if (!fetcher) throw new Error("provider fetch was not installed")

      const response = await fetcher("https://provider.example/v1/chat/completions", {
        method: "POST",
        body: providerBody(),
      }).then((res) => res.text())

      expect(response).toContain("Maid 1 SECRET_TOKEN")
      expect(response).not.toContain("Maid 2 SECRET_TOKEN")
      expect(prompts).toBe(1)
    })
  })

  test("disables stale global provider rewrite handlers on reload", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      let fetches = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async () => {
        fetches += 1
        return new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw SECRET_TOKEN") } }] }), {
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch
      const session = {
        async create() {
          return { data: { id: `maid-session-${prompts}` } }
        },
        async prompt() {
          prompts += 1
          return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
        },
        async delete() {
          return { data: true }
        },
      }
      try {
        const hooks = await MaidPlugin(ctx(session, dir))
        const rewritten = await globalThis.fetch("https://provider.example/v1/chat/completions", {
          method: "POST",
          headers: await providerHeaders(hooks),
          body: providerBody(),
        }).then((res) => res.text())
        await mkdir(path.dirname(userConfigFile()), { recursive: true })
        await writeFile(userConfigFile(), JSON.stringify({ enabled: false }))
        await MaidPlugin(ctx(session, dir))
        const raw = await globalThis.fetch("https://provider.example/v1/chat/completions", {
          method: "POST",
          body: providerBody(),
        }).then((res) => res.text())

        expect(rewritten).toContain("Maid 1 SECRET_TOKEN")
        expect(raw).toContain("Raw SECRET_TOKEN")
        expect(raw).not.toContain("Maid 2 SECRET_TOKEN")
        expect(prompts).toBe(1)
        expect(fetches).toBe(2)
      } finally {
        resetPublicStreamGate()
        globalThis.fetch = originalFetch
      }
    })
  })

  test("does not wrap the same configured provider fetch twice", async () => {
    await isolated(async (dir) => {
      let prompts = 0
      const originalFetch = globalThis.fetch
      globalThis.fetch = providerResponseFetch()
      try {
        const hooks = await MaidPlugin(ctx({
          async create() {
            return { data: { id: `maid-session-${prompts}` } }
          },
          async prompt() {
            prompts += 1
            return { data: { parts: [{ type: "text", text: `Maid ${prompts} SECRET_TOKEN` }] } }
          },
          async delete() {
            return { data: true }
          },
        }, dir))
        const cfg: Config = { provider: { fake: { options: {} } } } as unknown as Config

        await hooks.config?.(cfg)
        await hooks.config?.(cfg)
        const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
        if (!fetcher) throw new Error("provider fetch was not installed")
        const response = await fetcher("https://provider.example/v1/chat/completions", {
          method: "POST",
          headers: await providerHeaders(hooks),
          body: providerBody(),
        }).then((res) => res.text())

        expect(response).toContain("Maid 1 SECRET_TOKEN")
        expect(response).not.toContain("Maid 2 SECRET_TOKEN")
        expect(prompts).toBe(1)
      } finally {
        resetPublicStreamGate()
        globalThis.fetch = originalFetch
      }
    })
  })
})

function providerResponseFetch() {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content: carry("Raw SECRET_TOKEN") } }] }), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch
}

async function providerFetchForPlugin(dir: string, prompts: () => number, setPrompts: (prompts: number) => void) {
  const hooks = await MaidPlugin(ctx({
    async create() {
      return { data: { id: `maid-session-${prompts()}` } }
    },
    async prompt() {
      const next = prompts() + 1
      setPrompts(next)
      return { data: { parts: [{ type: "text", text: `Maid ${next} SECRET_TOKEN` }] } }
    },
    async delete() {
      return { data: true }
    },
  }, dir))
  const cfg: Config = { provider: { fake: { options: {} } } } as unknown as Config

  await hooks.config?.(cfg)
  const fetcher = (cfg.provider?.fake as unknown as { options?: { fetch?: typeof fetch } }).options?.fetch
  if (!fetcher) return undefined
  return (async (input, init) => fetcher(input, {
    ...init,
    headers: { ...(init?.headers && Object.fromEntries(new Headers(init.headers))), ...(await providerHeaders(hooks)) },
  })) as typeof fetch
}
