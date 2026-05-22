import type { Plugin } from "@opencode-ai/plugin"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { MAIN_AGENT_MODEL, REWRITE_CONTEXT_MAX, applyMainConfig, loadConfig, toggleRewriteEnabled } from "./config"
import { FAILURE, finalResult, HANDOFF, handoffSystemPrompt, maidAgentPrompt, split, type FinalTextResult, type RewriteContextEntry } from "./rewrite"
import { REWRITE_AGENT, SESSION_META_LOOKUP_FAILED, createDeltaSuppressor, disabledTools, formatModel, getSessionMeta, resolveModel, runMaid, type ModelSpec, type SessionMeta } from "./opencode"
import { PROVIDER_REWRITE_HEADER, createProviderFetch, installCommandInterceptor, installProviderRewrite, installPublicStreamGate, uninstallProviderRewrite, uninstallPublicStreamGate } from "./patch"
import { createResponseStore, type PendingProviderOriginal, type ResponseKey, type ResponseStore } from "./responses"
import { DISPLAY_ONLY_FALLBACK } from "./fallback"

type MutableConfig = {
  agent?: Record<string, unknown>
  command?: Record<string, {
    template: string
    description?: string
    agent?: string
    model?: string
    subtask?: boolean
  }>
  provider?: Record<string, unknown>
}

type ServerToast = {
  variant: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  duration?: number
}

type RewritePartKey = {
  sessionID: string
  messageID: string
  partID: string
}

declare global {
  var __ohMyOpencodeMaidHidden: Set<string> | undefined
  var __ohMyOpencodeMaidCompleted: Map<string, CompletedReplay> | undefined
  var __ohMyOpencodeMaidPending: Map<string, PendingRewrite> | undefined
  var __ohMyOpencodeMaidPassthrough: Set<string> | undefined
  var __ohMyOpencodeMaidProviderTokens: Map<string, ProviderToken> | undefined
  var __ohMyOpencodeMaidMainModels: Map<string, ModelSpec> | undefined
  var __ohMyOpencodeMaidUserPrompts: Map<string, string> | undefined
  var __ohMyOpencodeMaidRewriteHistory: Map<string, RewriteContextEntry[]> | undefined
  var __ohMyOpencodeMaidDeleted: Set<string> | undefined
  var __ohMyOpencodeMaidRoots: Set<string> | undefined
  var __ohMyOpencodeMaidRewriteGuards: Set<string> | undefined
  var __ohMyOpencodeMaidCompacting: Map<string, ReturnType<typeof setTimeout>> | undefined
  var __ohMyOpencodeMaidResponses: ResponseStore | undefined
  var __ohMyOpencodeMaidRewriteScope: AsyncLocalStorage<boolean> | undefined
  var __ohMyOpencodeMaidEnabled: Map<string, boolean> | undefined
}

type CompletedReplay = {
  originalText: string
  visibleText: string
}

type PendingRewrite = {
  originalText: string
  promise: Promise<FinalTextResult>
}

type ProviderToken = {
  directory: string
  sessionID: string
}

const permission = {
  "*": "deny",
  bash: "deny",
  codesearch: "deny",
  edit: "deny",
  external_directory: "deny",
  mcp: "deny",
  skill: "deny",
  task: "deny",
  webfetch: "deny",
  websearch: "deny",
} as const

const MAX_DRAFT = 200_000
const PROVIDER_TOKEN_TTL = 10 * 60 * 1000
const TOGGLE_COMMAND = "maid-rewrite-toggle"
const TOGGLE_HANDLED = "OMO_MAID_REWRITE_TOGGLE_HANDLED"

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function auxiliarySystem(system: string[]) {
  return system.some((item) => item.includes("You are a title generator."))
}

function appendHandoffSystemPrompt(system: string[]) {
  const prompt = handoffSystemPrompt()
  if (system.length === 0) {
    system.push(prompt)
    return
  }
  system[0] = system[0] ? `${system[0]}\n\n${prompt}` : prompt
}

function stringField(input: unknown, field: string) {
  if (!record(input)) return undefined
  const value = input[field]
  return typeof value === "string" ? value : undefined
}

function cleanPromptText(text: string | undefined) {
  const out = text?.trim()
  return out ? out : undefined
}

function promptFromParts(parts: unknown) {
  if (!Array.isArray(parts)) return undefined
  const texts: string[] = []
  for (const part of parts) {
    if (!record(part) || part.type !== "text" || typeof part.text !== "string") continue
    const text = cleanPromptText(part.text)
    if (text) texts.push(text)
  }
  return cleanPromptText(texts.join("\n"))
}

function promptFromMessage(message: unknown) {
  if (!record(message)) return undefined
  return promptFromParts(message.parts)
    ?? cleanPromptText(stringField(message, "text"))
    ?? cleanPromptText(stringField(message, "content"))
    ?? cleanPromptText(stringField(message, "prompt"))
}

function modelFromInput(model: unknown, variant?: unknown): ModelSpec | undefined {
  if (!record(model)) return undefined
  const providerID = stringField(model, "providerID")
  const modelID = stringField(model, "modelID") ?? stringField(model, "id")
  if (!providerID || !modelID) return undefined
  const selectedVariant = typeof variant === "string" ? variant : stringField(model, "variant")
  return { providerID, modelID, id: modelID, ...(selectedVariant ? { variant: selectedVariant } : {}) }
}

function eventPayload(input: unknown) {
  if (!record(input)) return undefined
  if (record(input.payload)) return input.payload
  if (typeof input.type === "string") return input
  return undefined
}

function metaFromRecord(input: Record<string, unknown>, fallbackSessionID?: string): SessionMeta {
  return {
    ...(typeof input.id === "string" ? { id: input.id } : {}),
    ...(typeof input.sessionID === "string" ? { sessionID: input.sessionID } : fallbackSessionID ? { sessionID: fallbackSessionID } : {}),
    ...(typeof input.parentID === "string" ? { parentID: input.parentID } : {}),
    ...(typeof input.agent === "string" ? { agent: input.agent } : {}),
    ...(typeof input.title === "string" ? { title: input.title } : {}),
  }
}

function eventSession(input: unknown) {
  const event = eventPayload(input)
  if (!record(event)) return undefined
  const type = stringField(event, "type")
  const name = stringField(event, "name")
  const deleted = type === "session.deleted" || (type === "sync" && name === "session.deleted.1")
  const sessionEvent = deleted
    || type === "session.created"
    || type === "session.updated"
    || (type === "sync" && (name === "session.created.1" || name === "session.updated.1"))
  if (!sessionEvent) return undefined
  const properties = record(event.properties) ? event.properties : undefined
  const data = record(event.data) ? event.data : undefined
  const source = properties ?? data
  if (!source) return undefined
  const info = record(source.info) ? source.info : undefined
  const sessionID = stringField(source, "sessionID") ?? stringField(source, "id") ?? stringField(info, "id") ?? stringField(info, "sessionID")
  if (!sessionID) return undefined
  return {
    deleted,
    sessionID,
    meta: info ? metaFromRecord(info, sessionID) : { sessionID },
  }
}

function compactionStartedSessionID(input: unknown) {
  const event = eventPayload(input)
  if (!record(event)) return undefined
  const type = stringField(event, "type")
  const name = stringField(event, "name")
  const started = type === "session.next.compaction.started" || (type === "sync" && name === "session.next.compaction.started.1")
  if (!started) return undefined
  const source = record(event.properties) ? event.properties : record(event.data) ? event.data : undefined
  return stringField(source, "sessionID")
}

function completedStore() {
  const existing = globalThis.__ohMyOpencodeMaidCompleted
  if (existing instanceof Map) return existing
  const next = new Map<string, CompletedReplay>()
  globalThis.__ohMyOpencodeMaidCompleted = next
  return next
}

const MaidPlugin: Plugin = async (ctx) => {
  const cfg = await loadConfig(ctx.directory)
  let responses = cfg.enabled ? (globalThis.__ohMyOpencodeMaidResponses ??= await createResponseStore().catch(() => undefined)) : undefined
  const hidden = globalThis.__ohMyOpencodeMaidHidden ??= new Set<string>()
  const completed = completedStore()
  const pending = globalThis.__ohMyOpencodeMaidPending ??= new Map<string, PendingRewrite>()
  const passthrough = globalThis.__ohMyOpencodeMaidPassthrough ??= new Set<string>()
  const providerTokens = globalThis.__ohMyOpencodeMaidProviderTokens ??= new Map<string, ProviderToken>()
  const mainModels = globalThis.__ohMyOpencodeMaidMainModels ??= new Map<string, ModelSpec>()
  const userPrompts = globalThis.__ohMyOpencodeMaidUserPrompts ??= new Map<string, string>()
  const rewriteHistory = globalThis.__ohMyOpencodeMaidRewriteHistory ??= new Map<string, RewriteContextEntry[]>()
  const deleted = globalThis.__ohMyOpencodeMaidDeleted ??= new Set<string>()
  const roots = globalThis.__ohMyOpencodeMaidRoots ??= new Set<string>()
  const rewriteGuards = globalThis.__ohMyOpencodeMaidRewriteGuards ??= new Set<string>()
  const compacting = globalThis.__ohMyOpencodeMaidCompacting ??= new Map<string, ReturnType<typeof setTimeout>>()
  const rewriteScope = globalThis.__ohMyOpencodeMaidRewriteScope ??= new AsyncLocalStorage<boolean>()
  const enabled = globalThis.__ohMyOpencodeMaidEnabled ??= new Map<string, boolean>()
  enabled.set(ctx.directory, cfg.enabled)
  const suppress = createDeltaSuppressor(hidden, passthrough)
  let baseFetch = globalThis.fetch
  const isEnabled = () => enabled.get(ctx.directory) ?? cfg.enabled
  const ensureResponses = async () => {
    if (!responses) {
      const store = globalThis.__ohMyOpencodeMaidResponses ?? await createResponseStore().catch(() => undefined)
      if (store) globalThis.__ohMyOpencodeMaidResponses = store
      responses = store
    }
    return responses
  }
  const sessionKey = (sessionID: string) => `${ctx.directory}/${sessionID}`
  const clearCompacting = (sessionID: string) => {
    const compactingSession = sessionKey(sessionID)
    const timer = compacting.get(compactingSession)
    if (timer) clearTimeout(timer)
    compacting.delete(compactingSession)
  }
  const markCompacting = (sessionID: string) => {
    const compactingSession = sessionKey(sessionID)
    clearCompacting(sessionID)
    const timer = setTimeout(() => compacting.delete(compactingSession), PROVIDER_TOKEN_TTL)
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref()
    compacting.set(compactingSession, timer)
  }
  const isCompacting = (sessionID: string) => compacting.has(sessionKey(sessionID))
  const isDeletedSession = (id: string) => deleted.has(sessionKey(id))
  const key = (input: RewritePartKey) => `${ctx.directory}/${input.sessionID}/${input.messageID}/${input.partID}`
  const responseKey = (input: RewritePartKey): ResponseKey => ({
    directory: ctx.directory,
    sessionID: input.sessionID,
    messageID: input.messageID,
    partID: input.partID,
  })
  const sessionID = (meta: SessionMeta, fallback?: string) => meta.sessionID ?? meta.id ?? fallback
  const isGuardedRewrite = (id: string) => hidden.has(id) || rewriteGuards.has(id)
  const isRewriteSession = (id: string, meta: SessionMeta) => hidden.has(id) || (meta.agent === REWRITE_AGENT && meta.title === "Roleplay rewrite")
  const clearPromptContextForSession = (id: string) => {
    userPrompts.delete(sessionKey(id))
    rewriteHistory.delete(sessionKey(id))
  }
  const rememberUserPrompt = (id: string | undefined, ...sources: unknown[]) => {
    if (cfg.rewrite_context_size <= 1 || !id || isDeletedSession(id) || isGuardedRewrite(id) || passthrough.has(id) || isCompacting(id)) return
    for (const source of sources) {
      const text = promptFromParts(source) ?? promptFromMessage(source)
      if (text) {
        userPrompts.set(sessionKey(id), text)
        return
      }
    }
  }
  const previousRewriteContext = (id: string | undefined) => {
    if (!id || cfg.rewrite_context_size <= 1 || isDeletedSession(id) || isGuardedRewrite(id) || passthrough.has(id) || isCompacting(id)) return undefined
    const limit = cfg.rewrite_context_size - 1
    const history = rewriteHistory.get(sessionKey(id))
    const remembered = history?.slice(-limit)
    const entries: RewriteContextEntry[] = []
    const pushEntry = (entry: RewriteContextEntry) => {
      const index = entries.findIndex((item) => item.originalText === entry.originalText && item.visibleText === entry.visibleText)
      if (index >= 0) entries.splice(index, 1)
      entries.push(entry)
    }
    for (const entry of remembered ?? []) pushEntry(entry)
    const out = entries.slice(-limit)
    return out.length ? out : undefined
  }
  const currentPromptContext = (id: string | undefined) => {
    if (cfg.rewrite_context_size <= 1 || !id || isDeletedSession(id) || isGuardedRewrite(id) || passthrough.has(id) || isCompacting(id)) return undefined
    return userPrompts.get(sessionKey(id))
  }
  const rememberSuccessfulRewrite = (id: string | undefined, visibleText: string, userPrompt?: string) => {
    if (cfg.rewrite_context_size <= 1 || !id || isDeletedSession(id) || isGuardedRewrite(id) || passthrough.has(id) || isCompacting(id)) return
    const entry: RewriteContextEntry = {
      ...(userPrompt ? { userPrompt } : {}),
      originalText: visibleText,
      visibleText,
    }
    rewriteHistory.set(sessionKey(id), [...(rewriteHistory.get(sessionKey(id)) ?? []), entry].slice(-(REWRITE_CONTEXT_MAX - 1)))
  }
  const rememberSession = (meta: SessionMeta | undefined, fallback?: string, removed = false) => {
    const id = meta ? sessionID(meta, fallback) : fallback
    if (!id) return
    if (removed) {
      hidden.delete(id)
      rewriteGuards.delete(id)
      passthrough.delete(id)
      roots.delete(id)
      deleted.add(sessionKey(id))
      clearCompacting(id)
      deleteCompletedForSession(id)
      deletePendingForSession(id)
      mainModels.delete(sessionKey(id))
      clearPromptContextForSession(id)
      try {
        responses?.deleteSession(ctx.directory, id)
      } catch {
        return
      }
      return
    }
    if (isDeletedSession(id)) return
    if (!meta) return
    if (isRewriteSession(id, meta)) {
      if (!hidden.has(id)) rewriteGuards.add(id)
      passthrough.delete(id)
      roots.delete(id)
      return
    }
    if (meta.parentID) {
      passthrough.add(id)
      roots.delete(id)
      return
    }
    passthrough.delete(id)
    roots.add(id)
  }
  const learnSession = (event: unknown) => {
    const learned = eventSession(event)
    if (!learned) return
    rememberSession(learned.meta, learned.sessionID, learned.deleted)
  }
  const forgetDeletedSession = async (event: unknown) => {
    const learned = eventSession(event)
    if (!learned?.deleted) return false
    await ensureResponses()
    rememberSession(learned.meta, learned.sessionID, true)
    return true
  }
  const isPassthrough = async (id: string) => {
    if (isGuardedRewrite(id)) return false
    if (passthrough.has(id)) return true
    if (roots.has(id)) return false
    const meta = await getSessionMeta(ctx, id)
    if (isDeletedSession(id)) return false
    // Fail closed: if the lookup failed we cannot prove this is a rewritable
    // root, so treat it as passthrough for this turn rather than risk rewriting
    // (and persisting into) a subagent transcript. Left uncached so the next
    // turn re-attempts classification once the transient failure clears.
    if (meta === SESSION_META_LOOKUP_FAILED) return true
    rememberSession(meta, id)
    return passthrough.has(id)
  }
  // Canonical "should this handler ignore the session" gate. The trailing
  // isDeletedSession recheck is deliberate: isPassthrough awaits a session
  // lookup, during which the session may be deleted, so the post-await state
  // must be re-read. Handlers needing extra guards (rewrite-scope, pending
  // rewrites) add them after this call.
  const skipSession = async (id: string) =>
    isDeletedSession(id) || isGuardedRewrite(id) || (await isPassthrough(id)) || isDeletedSession(id)
  const rememberMainModel = (sessionID: string | undefined, model: unknown, variant?: unknown) => {
    if (!sessionID || isGuardedRewrite(sessionID) || isDeletedSession(sessionID)) return
    const spec = modelFromInput(model, variant)
    if (spec) mainModels.set(sessionKey(sessionID), spec)
  }
  const rewriteModel = (sessionID?: string) => cfg.model === MAIN_AGENT_MODEL ? resolveModel(cfg, sessionID ? mainModels.get(sessionKey(sessionID)) : undefined) : resolveModel(cfg)
  const issueProviderToken = (sessionID: string) => {
    const token = randomUUID()
    providerTokens.set(token, { directory: ctx.directory, sessionID })
    const timer = setTimeout(() => providerTokens.delete(token), PROVIDER_TOKEN_TTL)
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref()
    return token
  }
  const consumeProviderToken = (headers: Headers) => {
    const token = headers.get(PROVIDER_REWRITE_HEADER)
    if (!token) return undefined
    const item = providerTokens.get(token)
    providerTokens.delete(token)
    return item?.directory === ctx.directory ? item.sessionID : undefined
  }
  const storeDisplayOriginal = (input: RewritePartKey, visibleText: string, originalText: string) => {
    if (!responses) throw new Error("response store is unavailable")
    if (!originalText) return
    responses.putDisplayOriginal(responseKey(input), visibleText, originalText)
  }
  const deleteCompletedForSession = (sessionID: string) => {
    const prefix = `${ctx.directory}/${sessionID}/`
    for (const current of completed.keys()) if (current.startsWith(prefix)) completed.delete(current)
  }
  const rememberProviderOriginal = (sessionID: string | undefined, visible: string, original: string) => {
    if (!responses) throw new Error("response store is unavailable")
    if (!sessionID || isDeletedSession(sessionID) || !original) return
    responses.putPendingProviderOriginal(ctx.directory, sessionID, visible, original)
  }
  const consumeProviderOriginal = (input: RewritePartKey, visible: string) => responses?.consumePendingProviderOriginal(responseKey(input), visible)
  const pendingPrefix = (id: string) => `${ctx.directory}/${id}/`
  const deletePendingForSession = (id: string) => {
    const prefix = pendingPrefix(id)
    for (const current of pending.keys()) if (current.startsWith(prefix)) pending.delete(current)
  }
  const replayMatches = (replay: CompletedReplay, text: string) => replay.originalText === text || replay.visibleText === text
  const rewrite = async (draft: string, parentID?: string, capturedUserPrompt = currentPromptContext(parentID)) => {
    if (!isEnabled()) return { text: split(draft).text, rewritten: false }
    const item = split(draft)
    if (!item.text) return { text: item.text, rewritten: false }
    if (item.text.length > MAX_DRAFT) return { text: item.text, rewritten: false }
    try {
      return await rewriteScope.run(
        true,
        async () => finalResult(
          draft,
          await runMaid({
            ctx,
            cfg,
            text: item.text,
            note: item.note,
            currentUserPrompt: capturedUserPrompt,
            previousContext: previousRewriteContext(parentID),
            parentID,
            hidden,
            model: rewriteModel(parentID),
          }),
        ),
      )
    } catch {
      return { text: item.text, rewritten: false }
    }
  }
  const providerRewrite = async (draft: string, sessionID?: string) => {
    const original = split(draft).text
    if (!isEnabled()) return original
    if (!sessionID || isDeletedSession(sessionID) || isGuardedRewrite(sessionID) || isCompacting(sessionID) || await isPassthrough(sessionID) || isDeletedSession(sessionID)) return original
    const capturedUserPrompt = currentPromptContext(sessionID)
    const result = await rewrite(draft, sessionID, capturedUserPrompt)
    if (!isEnabled()) return original
    const visible = result.rewritten ? result.text : DISPLAY_ONLY_FALLBACK
    try {
      rememberProviderOriginal(sessionID, visible, original)
    } catch {
      return DISPLAY_ONLY_FALLBACK
    }
    if (result.rewritten) rememberSuccessfulRewrite(sessionID, visible, capturedUserPrompt)
    return visible
  }
  const hook = {
    owner: ctx.directory,
    active: () => rewriteScope.getStore() === true,
    server: ctx.serverUrl.origin,
    consumeRewriteToken: consumeProviderToken,
    rewrite: providerRewrite,
  }
  const setRuntimeEnabled = async (next: boolean) => {
    cfg.enabled = next
    enabled.set(ctx.directory, next)
    if (next) {
      await ensureResponses()
      installPublicStreamGate(hidden, passthrough, ctx.directory)
      baseFetch = installProviderRewrite(hook)
      return
    }
    for (const [token, item] of providerTokens) if (item.directory === ctx.directory) providerTokens.delete(token)
    uninstallProviderRewrite(ctx.directory)
    uninstallPublicStreamGate(ctx.directory)
  }
  await setRuntimeEnabled(cfg.enabled)

  const toast = async (input: ServerToast) => {
    await ctx.client.tui.showToast({ body: input }).catch(() => undefined)
  }

  const setCommandOutput = (parts: Array<{ type: string; text?: string; synthetic?: boolean }>, text: string) => {
    for (const part of parts) {
      if (part.type !== "text") continue
      part.text = text
      part.synthetic = true
    }
  }

  const commandMessage = (sessionID: string, text: string) => {
    const now = Date.now()
    const messageID = `msg_maid_rewrite_toggle_${randomUUID()}`
    const partID = `prt_maid_rewrite_toggle_${randomUUID()}`
    return {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        time: { created: now, completed: now },
        parentID: sessionID,
        modelID: "oh-my-opencode-maid",
        providerID: "oh-my-opencode-maid",
        mode: "command",
        agent: "command",
        path: { cwd: ctx.directory, root: ctx.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [{ id: partID, sessionID, messageID, type: "text", text, synthetic: true, time: { start: now, end: now } }],
    }
  }

  const toggleCommand = async ({ sessionID }: { sessionID: string; messageID?: string; arguments: string }) => {
    const previous = isEnabled()
    try {
      const result = await toggleRewriteEnabled()
      await setRuntimeEnabled(result.enabled)
      const label = result.enabled ? "enabled" : "disabled"
      const message = `Maid rewrites are now ${label}.`
      await toast({
        variant: "success",
        title: result.enabled ? "Rewrite enabled" : "Rewrite disabled",
        message,
        duration: 5000,
      })
      return commandMessage(sessionID, message)
    } catch (error) {
      await setRuntimeEnabled(previous)
      const message = error instanceof Error ? error.message : "Unknown rewrite toggle error"
      await toast({
        variant: "error",
        title: "Rewrite toggle failed",
        message,
        duration: 5000,
      })
      return commandMessage(sessionID, `Maid rewrite toggle failed: ${message}`)
    }
  }

  installCommandInterceptor({
    owner: ctx.directory,
    server: ctx.serverUrl.origin,
    command: TOGGLE_COMMAND,
    handle: toggleCommand,
  })

  return {
    config: async (input) => {
      applyMainConfig(cfg, input)
      const out = input as unknown as MutableConfig
      out.command = {
        ...out.command,
        [TOGGLE_COMMAND]: {
          template: "Toggle oh-my-opencode-maid rewrites on or off immediately.",
          description: "Toggle oh-my-opencode-maid rewrites immediately and persist the enabled config.",
        },
      }
      const configuredModel = resolveModel(cfg)
      out.agent = {
        ...out.agent,
        [REWRITE_AGENT]: {
          mode: "primary",
          hidden: true,
          description: "Hidden rewrite-only agent used by the roleplay rewrite plugin.",
          model: formatModel(configuredModel),
          ...(configuredModel.variant ? { variant: configuredModel.variant } : {}),
          prompt: maidAgentPrompt(cfg),
          tools: disabledTools(),
          permission,
        },
      }
      if (!record(out.provider)) return
      for (const provider of Object.values(out.provider)) {
        if (!record(provider)) continue
        const opts = record(provider.options) ? provider.options : {}
        const base = typeof opts.fetch === "function" ? (opts.fetch as typeof fetch) : baseFetch
        provider.options = {
          ...opts,
          fetch: createProviderFetch(hook, base),
        }
      }
    },

    event: async (input) => {
      if (await forgetDeletedSession(input.event)) return
      if (!isEnabled()) return
      learnSession(input.event)
      const compactionSessionID = compactionStartedSessionID(input.event)
      if (compactionSessionID) markCompacting(compactionSessionID)
      suppress(input.event)
    },

    "chat.message": async (input, output) => {
      if (!isEnabled()) return
      if (await skipSession(input.sessionID)) return
      rememberUserPrompt(input.sessionID, output?.parts, output?.message, input)
      rememberMainModel(input.sessionID, input.model, input.variant)
    },

    "chat.params": async (input) => {
      if (!isEnabled()) return
      if (await skipSession(input.sessionID)) return
      rememberUserPrompt(input.sessionID, input.message)
      rememberMainModel(input.sessionID, input.model, stringField(input, "variant"))
    },

    "chat.headers": async (input, output) => {
      if (!isEnabled()) return
      if (await skipSession(input.sessionID)) return
      if (isGuardedRewrite(input.sessionID)) return
      if (isCompacting(input.sessionID)) return
      if (rewriteScope.getStore() === true) return
      rememberUserPrompt(input.sessionID, input.message)
      rememberMainModel(input.sessionID, input.model, stringField(input, "variant"))
      output.headers[PROVIDER_REWRITE_HEADER] = issueProviderToken(input.sessionID)
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!isEnabled()) return
      if (input.sessionID && isGuardedRewrite(input.sessionID)) {
        if (output.system.length > 0) output.system.splice(0, output.system.length, maidAgentPrompt(cfg))
        return
      }
      if (!input.sessionID) return
      if (isDeletedSession(input.sessionID)) return
      if (auxiliarySystem(output.system)) return
      if (await isPassthrough(input.sessionID)) return
      if (isDeletedSession(input.sessionID)) return
      if (isGuardedRewrite(input.sessionID)) {
        if (output.system.length > 0) output.system.splice(0, output.system.length, maidAgentPrompt(cfg))
        return
      }
      if (rewriteScope.getStore() === true) return
      rememberMainModel(input.sessionID, input.model, stringField(input, "variant"))
      if (output.system.some((item) => item.includes(HANDOFF))) return
      appendHandoffSystemPrompt(output.system)
    },

    "experimental.chat.messages.transform": async () => {
      return
    },

    "experimental.session.compacting": async (input) => {
      if (!isEnabled()) return
      if (await skipSession(input.sessionID)) return
      if (isGuardedRewrite(input.sessionID)) return
      markCompacting(input.sessionID)
    },

    "experimental.compaction.autocontinue": async (input) => {
      if (!isEnabled()) return
      clearCompacting(input.sessionID)
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== TOGGLE_COMMAND) return
      const response = await toggleCommand({ sessionID: input.sessionID, arguments: input.arguments })
      const part = response.parts.find((part) => part.type === "text")
      setCommandOutput(output.parts, part?.text ?? "Maid rewrite toggle completed.")
      throw new Error(TOGGLE_HANDLED)
    },

    "experimental.text.complete": async (input, output) => {
      if (!isEnabled()) return
      if (isDeletedSession(input.sessionID)) return
      if (hidden.has(input.sessionID)) return
      if (await isPassthrough(input.sessionID)) return
      if (isDeletedSession(input.sessionID)) return
      if (hidden.has(input.sessionID)) return
      if (rewriteGuards.has(input.sessionID)) {
        output.text = FAILURE
        return
      }
      if (isCompacting(input.sessionID)) return
      if (rewriteScope.getStore() === true) {
        output.text = FAILURE
        return
      }
      const item = split(output.text)
      if (item.text === FAILURE) {
        output.text = FAILURE
        return
      }
      const done = key(input)
      const replay = completed.get(done)
      if (replay !== undefined && replayMatches(replay, item.text)) {
        output.text = replay.visibleText
        return
      }
      const existing = pending.get(done)
      if (existing && existing.originalText === item.text) {
        const result = await existing.promise
        output.text = isEnabled() ? result.text : item.text
        return
      }
      let providerOriginal: PendingProviderOriginal | undefined
      try {
        providerOriginal = consumeProviderOriginal(input, item.text)
      } catch {
        output.text = FAILURE
        return
      }
      if (providerOriginal !== undefined) {
        if (providerOriginal.originalText !== item.text) completed.set(done, { originalText: item.text, visibleText: item.text })
        output.text = item.text
        return
      }
      if (item.text === DISPLAY_ONLY_FALLBACK) {
        output.text = DISPLAY_ONLY_FALLBACK
        return
      }
      if (!item.text) {
        output.text = item.text
        return
      }
      try {
        responses?.deleteOriginal(responseKey(input))
      } catch {
        output.text = FAILURE
        return
      }
      let entry: PendingRewrite | undefined
      const capturedUserPrompt = currentPromptContext(input.sessionID)
      const work = rewrite(output.text, input.sessionID, capturedUserPrompt)
        .then((result) => {
          if (!entry || pending.get(done) !== entry) return result
          if (!isEnabled()) return { text: item.text, rewritten: false }
          if (result.rewritten) {
            try {
              storeDisplayOriginal(input, result.text, item.text)
            } catch {
              return { text: FAILURE, rewritten: false }
            }
            rememberSuccessfulRewrite(input.sessionID, result.text, capturedUserPrompt)
            completed.set(done, { originalText: item.text, visibleText: result.text })
          } else {
            try {
              storeDisplayOriginal(input, DISPLAY_ONLY_FALLBACK, item.text)
            } catch {
              return { text: FAILURE, rewritten: false }
            }
            return { text: DISPLAY_ONLY_FALLBACK, rewritten: false }
          }
          return result
        })
        .finally(() => {
          if (entry && pending.get(done) === entry) pending.delete(done)
        })
      entry = { originalText: item.text, promise: work }
      pending.set(done, entry)
      const result = await work
      output.text = isEnabled() ? result.text : item.text
    },
  }
}

export default MaidPlugin
