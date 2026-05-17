import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { MAIN_AGENT_MODEL, type MaidConfig } from "./config"
import { maidUserPrompt } from "./rewrite"
import { REWRITE_AGENT, createDeltaSuppressor, disabledTools, parseModel, resolveModel, runMaid } from "./opencode"

const cfg: MaidConfig = {
  enabled: true,
  model: "openai/gpt-5.5",
  variant: "fast",
  roleplay_prompt: "configured voice",
}

const sentinelCfg: MaidConfig = {
  enabled: true,
  model: MAIN_AGENT_MODEL,
  roleplay_prompt: "configured voice",
}

const note = {
  audience: "user",
  tone_goal: "configured style",
  must_preserve: ["SECRET_TOKEN"],
  reply_constraints: [],
  exact_reply_mode: "rewrite",
}

function ctx(session: unknown): PluginInput {
  return {
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost:4096"),
    project: {} as PluginInput["project"],
    experimental_workspace: { register() {} },
    $: {} as PluginInput["$"],
    client: { session } as unknown as PluginInput["client"],
  }
}

describe("opencode rewrite helpers", () => {
  test("parses provider/model strings with optional variants", () => {
    expect(parseModel("openai/gpt-5.5", "fast")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      id: "gpt-5.5",
      variant: "fast",
    })
    expect(parseModel("anthropic/claude/sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude/sonnet",
      id: "claude/sonnet",
    })
    expect(() => parseModel("gpt-5.5")).toThrow("provider/model")
  })

  test("resolves main-agent sentinel to active model or previous default fallback", () => {
    expect(resolveModel(sentinelCfg, {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      id: "claude-sonnet-4-5",
      variant: "thinking",
    })).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      id: "claude-sonnet-4-5",
      variant: "thinking",
    })
    expect(resolveModel(sentinelCfg)).toEqual({
      providerID: "openai",
      modelID: "gpt-5.5",
      id: "gpt-5.5",
    })
  })

  test("creates a hidden rewrite session and prompts it through OpenCode session API parameters", async () => {
    const calls: unknown[] = []
    const hidden = new Set<string>()
    const session = {
      async create(input: unknown) {
        calls.push({ method: "create", input })
        return { data: { id: "maid-session" } }
      },
      async prompt(input: unknown) {
        calls.push({ method: "prompt", input, hidden: hidden.has("maid-session") })
        return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
      },
      async delete(input: unknown) {
        calls.push({ method: "delete", input })
        return { data: true }
      },
    }

    await expect(runMaid({ ctx: ctx(session), cfg, text: "Raw SECRET_TOKEN", note, parentID: "user-session", hidden })).resolves.toBe("Maid SECRET_TOKEN")

    expect(hidden.has("maid-session")).toBe(true)
    expect(calls).toEqual([
      {
        method: "create",
        input: {
          agent: REWRITE_AGENT,
          directory: "/tmp/project",
          parentID: "user-session",
          title: "Roleplay rewrite",
          model: { id: "gpt-5.5", providerID: "openai", variant: "fast" },
        },
      },
      {
        method: "prompt",
        hidden: true,
        input: {
          sessionID: "maid-session",
          directory: "/tmp/project",
          agent: REWRITE_AGENT,
          model: { providerID: "openai", modelID: "gpt-5.5" },
          variant: "fast",
          tools: disabledTools(),
          parts: [{ type: "text", text: maidUserPrompt({ cfg, text: "Raw SECRET_TOKEN", note }) }],
        },
      },
      {
        method: "delete",
        input: { sessionID: "maid-session", directory: "/tmp/project" },
      },
    ])
  })

  test("uses active main model for sentinel rewrite sessions without passing the sentinel", async () => {
    const calls: unknown[] = []
    const hidden = new Set<string>()
    const session = {
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
    }

    await expect(runMaid({
      ctx: ctx(session),
      cfg: sentinelCfg,
      text: "Raw SECRET_TOKEN",
      hidden,
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        id: "claude-sonnet-4-5",
        variant: "thinking",
      },
    })).resolves.toBe("Maid SECRET_TOKEN")

    expect(JSON.stringify(calls)).not.toContain(MAIN_AGENT_MODEL)
    expect(calls).toEqual([
      {
        method: "create",
        input: {
          agent: REWRITE_AGENT,
          directory: "/tmp/project",
          title: "Roleplay rewrite",
          model: { id: "claude-sonnet-4-5", providerID: "anthropic", variant: "thinking" },
        },
      },
      {
        method: "prompt",
        input: {
          sessionID: "maid-session",
          directory: "/tmp/project",
          agent: REWRITE_AGENT,
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          variant: "thinking",
          tools: disabledTools(),
          parts: [{ type: "text", text: maidUserPrompt({ cfg: sentinelCfg, text: "Raw SECRET_TOKEN" }) }],
        },
      },
      {
        method: "delete",
        input: { sessionID: "maid-session", directory: "/tmp/project" },
      },
    ])
  })


  test("preserves session API receiver binding for SDK-style methods", async () => {
    const calls: string[] = []
    const hidden = new Set<string>()
    const session = {
      marker: "bound-session-api",
      async create(this: { marker: string }) {
        calls.push(`create:${this.marker}`)
        return { data: { id: "maid-session" } }
      },
      async prompt(this: { marker: string }) {
        calls.push(`prompt:${this.marker}`)
        return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
      },
      async delete(this: { marker: string }) {
        calls.push(`delete:${this.marker}`)
        return { data: true }
      },
    }

    await expect(runMaid({ ctx: ctx(session), cfg, text: "Raw SECRET_TOKEN", hidden })).resolves.toBe("Maid SECRET_TOKEN")

    expect(calls).toEqual([
      "create:bound-session-api",
      "prompt:bound-session-api",
      "delete:bound-session-api",
    ])
  })

  test("keeps the rewrite and hidden guard when deletion fails", async () => {
    const hidden = new Set<string>()
    const session = {
      async create() {
        return { data: { id: "maid-session" } }
      },
      async prompt() {
        return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
      },
      async delete() {
        throw new Error("delete failed")
      },
    }

    await expect(runMaid({ ctx: ctx(session), cfg, text: "Raw SECRET_TOKEN", note, parentID: "user-session", hidden })).resolves.toBe("Maid SECRET_TOKEN")
    await Promise.resolve()
    expect(hidden.has("maid-session")).toBe(true)
  })

  test("does not block the rewrite on hidden session deletion", async () => {
    const hidden = new Set<string>()
    let deleteStarted = false
    const session = {
      async create() {
        return { data: { id: "maid-session" } }
      },
      async prompt() {
        return { data: { parts: [{ type: "text", text: "Maid SECRET_TOKEN" }] } }
      },
      async delete() {
        deleteStarted = true
        return new Promise(() => {})
      },
    }

    await expect(Promise.race([
      runMaid({ ctx: ctx(session), cfg, text: "Raw SECRET_TOKEN", note, hidden }),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 25)),
    ])).resolves.toBe("Maid SECRET_TOKEN")
    expect(deleteStarted).toBe(true)
    expect(hidden.has("maid-session")).toBe(true)
  })

  test("times out hung rewrite prompts and clears hidden session state", async () => {
    const hidden = new Set<string>()
    let deleteStarted = false
    const session = {
      async create() {
        return { data: { id: "maid-session" } }
      },
      async prompt() {
        return new Promise(() => {})
      },
      async delete() {
        deleteStarted = true
        return { data: true }
      },
    }

    await expect(runMaid({ ctx: ctx(session), cfg, text: "Raw SECRET_TOKEN", note, hidden, timeoutMs: 5 })).rejects.toThrow("timed out")
    expect(deleteStarted).toBe(true)
    await Promise.resolve()
    expect(hidden.has("maid-session")).toBe(false)
  })

  test("keeps timed-out hidden sessions guarded until deletion or TTL cleanup", async () => {
    const hidden = new Set<string>()
    let releaseDelete: (() => void) | undefined
    const session = {
      async create() {
        return { data: { id: "maid-session" } }
      },
      async prompt() {
        return new Promise(() => {})
      },
      async delete() {
        return new Promise<void>((resolve) => {
          releaseDelete = resolve
        })
      },
    }

    await expect(runMaid({ ctx: ctx(session), cfg, text: "Raw SECRET_TOKEN", note, hidden, timeoutMs: 5, hiddenTtlMs: 50 })).rejects.toThrow("timed out")
    expect(hidden.has("maid-session")).toBe(true)
    releaseDelete?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hidden.has("maid-session")).toBe(false)

    const ttlHidden = new Set<string>()
    const ttlSession = {
      async create() {
        return { data: { id: "ttl-maid-session" } }
      },
      async prompt() {
        throw new Error("interrupted")
      },
      async delete() {
        throw new Error("delete failed")
      },
    }

    await expect(runMaid({ ctx: ctx(ttlSession), cfg, text: "Raw SECRET_TOKEN", note, hidden: ttlHidden, hiddenTtlMs: 5 })).rejects.toThrow("interrupted")
    expect(ttlHidden.has("ttl-maid-session")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(ttlHidden.has("ttl-maid-session")).toBe(false)
  })

  test("suppresses public text deltas and allows the final update", () => {
    const suppress = createDeltaSuppressor(new Set())
    const start = {
      type: "message.part.updated",
      properties: { part: { id: "text-1", sessionID: "s", messageID: "m", type: "text", text: "", time: { start: 1 } } },
    }
    const delta = {
      type: "message.part.delta",
      properties: { sessionID: "s", messageID: "m", partID: "text-1", field: "text", delta: "raw draft" },
    }
    const untracked = {
      type: "message.part.delta",
      properties: { sessionID: "s", messageID: "m", partID: "other-1", field: "text", delta: "untracked" },
    }
    const patch = {
      type: "message.part.delta",
      properties: { sessionID: "s", messageID: "m", partID: "text-1", field: "files", delta: "diff" },
    }
    const done = {
      type: "message.part.updated",
      properties: { part: { id: "text-1", sessionID: "s", messageID: "m", type: "text", text: "maid", time: { start: 1, end: 2 } } },
    }
    const later = {
      type: "message.part.delta",
      properties: { sessionID: "s", messageID: "m", partID: "text-1", field: "text", delta: "late" },
    }

    suppress(start)
    suppress(delta)
    suppress(untracked)
    suppress(patch)
    suppress(done)
    suppress(later)

    expect(delta.properties.delta).toBe("")
    expect(untracked.properties.delta).toBe("")
    expect(patch.properties.delta).toBe("diff")
    expect(later.properties.delta).toBe("")
  })

  test("skips hidden internal sessions in the delta bridge", () => {
    const suppress = createDeltaSuppressor(new Set(["maid-session"]))
    const start = {
      type: "message.part.updated",
      properties: { part: { id: "text-1", sessionID: "maid-session", messageID: "m", type: "text", text: "", time: { start: 1 } } },
    }
    const delta = {
      type: "message.part.delta",
      properties: { sessionID: "maid-session", messageID: "m", partID: "text-1", field: "text", delta: "internal" },
    }

    suppress(start)
    suppress(delta)

    expect(delta.properties.delta).toBe("internal")
  })

  test("skips visible child sessions in the delta bridge", () => {
    const suppress = createDeltaSuppressor(new Set(), new Set(["child-session"]))
    const start = {
      type: "message.part.updated",
      properties: { part: { id: "text-1", sessionID: "child-session", messageID: "m", type: "text", text: "", time: { start: 1 } } },
    }
    const delta = {
      type: "message.part.delta",
      properties: { sessionID: "child-session", messageID: "m", partID: "text-1", field: "text", delta: "junior raw" },
    }

    suppress(start)
    suppress(delta)

    expect(delta.properties.delta).toBe("junior raw")
  })
})
