import type { Plugin } from "@opencode-ai/plugin"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { MAIN_AGENT_MODEL, applyMainConfig, loadConfig } from "./config"
import { FAILURE, finalResult, HANDOFF, handoffSystemPrompt, maidAgentPrompt, split, type FinalTextResult } from "./rewrite"
import { REWRITE_AGENT, SESSION_META_LOOKUP_FAILED, createDeltaSuppressor, disabledTools, formatModel, getSessionMeta, resolveModel, runMaid, type ModelSpec, type SessionMeta } from "./opencode"
import { PROVIDER_REWRITE_HEADER, createProviderFetch, installProviderRewrite, installPublicStreamGate, uninstallProviderRewrite, uninstallPublicStreamGate } from "./patch"
import { createResponseStore, type PendingProviderOriginal, type ResponseKey, type ResponseStore, type SessionOriginal } from "./responses"
import { DISPLAY_ONLY_FALLBACK } from "./fallback"

type MutableConfig = {
  agent?: Record<string, unknown>
  provider?: Record<string, unknown>
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
  var __ohMyOpencodeMaidProviderTokens: Map<string, string> | undefined
  var __ohMyOpencodeMaidMainModels: Map<string, ModelSpec> | undefined
  var __ohMyOpencodeMaidDeleted: Set<string> | undefined
  var __ohMyOpencodeMaidRoots: Set<string> | undefined
  var __ohMyOpencodeMaidRewriteGuards: Set<string> | undefined
  var __ohMyOpencodeMaidResponses: ResponseStore | undefined
  var __ohMyOpencodeMaidRewriteScope: AsyncLocalStorage<boolean> | undefined
}

type CompletedReplay = {
  originalText: string
  visibleText: string
}

type PendingRewrite = {
  originalText: string
  promise: Promise<FinalTextResult>
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
const MAX_COMPACTION_ORIGINALS = 50
const MAX_COMPACTION_ORIGINAL_CHARS = 8_000
const PROVIDER_TOKEN_TTL = 10 * 60 * 1000

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function auxiliarySystem(system: string[]) {
  return system.some((item) => item.includes("You are a title generator."))
}

function stringField(input: unknown, field: string) {
  if (!record(input)) return undefined
  const value = input[field]
  return typeof value === "string" ? value : undefined
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

function completedStore() {
  const existing = globalThis.__ohMyOpencodeMaidCompleted
  if (existing instanceof Map) return existing
  const next = new Map<string, CompletedReplay>()
  globalThis.__ohMyOpencodeMaidCompleted = next
  return next
}

function truncateOriginal(text: string) {
  if (text.length <= MAX_COMPACTION_ORIGINAL_CHARS) return text
  return `${text.slice(0, MAX_COMPACTION_ORIGINAL_CHARS)}\n[truncated]`
}

function compactionContext(originals: SessionOriginal[]) {
  const selected = originals.slice(-MAX_COMPACTION_ORIGINALS)
  const blocks = selected.map((item) => [
    `Message ${item.messageID}, part ${item.partID}:`,
    truncateOriginal(item.originalText),
  ].join("\n"))
  return [
    "oh-my-opencode-maid original assistant text before visible roleplay rewrites. Use this for factual compaction context instead of the rewritten visible style.",
    ...blocks,
  ].join("\n\n")
}

const MaidPlugin: Plugin = async (ctx) => {
  const cfg = await loadConfig(ctx.directory)
  const responses = cfg.enabled ? (globalThis.__ohMyOpencodeMaidResponses ??= await createResponseStore().catch(() => undefined)) : undefined
  const hidden = globalThis.__ohMyOpencodeMaidHidden ??= new Set<string>()
  const completed = completedStore()
  const pending = globalThis.__ohMyOpencodeMaidPending ??= new Map<string, PendingRewrite>()
  const passthrough = globalThis.__ohMyOpencodeMaidPassthrough ??= new Set<string>()
  const providerTokens = globalThis.__ohMyOpencodeMaidProviderTokens ??= new Map<string, string>()
  const mainModels = globalThis.__ohMyOpencodeMaidMainModels ??= new Map<string, ModelSpec>()
  const deleted = globalThis.__ohMyOpencodeMaidDeleted ??= new Set<string>()
  const roots = globalThis.__ohMyOpencodeMaidRoots ??= new Set<string>()
  const rewriteGuards = globalThis.__ohMyOpencodeMaidRewriteGuards ??= new Set<string>()
  const rewriteScope = globalThis.__ohMyOpencodeMaidRewriteScope ??= new AsyncLocalStorage<boolean>()
  const suppress = createDeltaSuppressor(hidden, passthrough)
  let baseFetch = globalThis.fetch
  if (!cfg.enabled) {
    uninstallProviderRewrite(ctx.directory)
    uninstallPublicStreamGate(ctx.directory)
  }
  const sessionKey = (sessionID: string) => `${ctx.directory}/${sessionID}`
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
  const rememberSession = (meta: SessionMeta | undefined, fallback?: string, removed = false) => {
    const id = meta ? sessionID(meta, fallback) : fallback
    if (!id) return
    if (removed) {
      hidden.delete(id)
      rewriteGuards.delete(id)
      passthrough.delete(id)
      roots.delete(id)
      deleted.add(sessionKey(id))
      deleteCompletedForSession(id)
      deletePendingForSession(id)
      mainModels.delete(sessionKey(id))
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
    providerTokens.set(token, sessionID)
    const timer = setTimeout(() => providerTokens.delete(token), PROVIDER_TOKEN_TTL)
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref()
    return token
  }
  const consumeProviderToken = (headers: Headers) => {
    const token = headers.get(PROVIDER_REWRITE_HEADER)
    if (!token) return undefined
    const sessionID = providerTokens.get(token)
    providerTokens.delete(token)
    return sessionID
  }
  const storeOriginal = (input: RewritePartKey, visibleText: string, originalText: string) => {
    if (!responses) throw new Error("response store is unavailable")
    if (!originalText) return
    responses.putOriginal(responseKey(input), visibleText, originalText)
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
  const rememberProviderOriginal = (sessionID: string | undefined, visible: string, original: string, displayOnly = false) => {
    if (!responses) throw new Error("response store is unavailable")
    if (!sessionID || isDeletedSession(sessionID) || !original) return
    responses.putPendingProviderOriginal(ctx.directory, sessionID, visible, original, displayOnly)
  }
  const consumeProviderOriginal = (input: RewritePartKey, visible: string) => responses?.consumePendingProviderOriginal(responseKey(input), visible)
  const pendingPrefix = (id: string) => `${ctx.directory}/${id}/`
  const deletePendingForSession = (id: string) => {
    const prefix = pendingPrefix(id)
    for (const current of pending.keys()) if (current.startsWith(prefix)) pending.delete(current)
  }
  const hasPendingForSession = (id: string) => {
    const prefix = pendingPrefix(id)
    for (const current of pending.keys()) if (current.startsWith(prefix)) return true
    return false
  }
  const replayMatches = (replay: CompletedReplay, text: string) => replay.originalText === text || replay.visibleText === text
  const rewrite = async (draft: string, parentID?: string) => {
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
    const result = await rewrite(draft, sessionID)
    const visible = result.rewritten ? result.text : original
    try {
      rememberProviderOriginal(sessionID, visible, original, !result.rewritten)
    } catch {
      return DISPLAY_ONLY_FALLBACK
    }
    return visible
  }
  const hook = {
    owner: ctx.directory,
    active: () => rewriteScope.getStore() === true,
    server: ctx.serverUrl.origin,
    consumeRewriteToken: consumeProviderToken,
    rewrite: providerRewrite,
  }
  if (cfg.enabled) {
    installPublicStreamGate(hidden, passthrough, ctx.directory)
    baseFetch = installProviderRewrite(hook)
  }

  return {
    config: async (input) => {
      applyMainConfig(cfg, input)
      if (!cfg.enabled) return
      const out = input as unknown as MutableConfig
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
      if (!cfg.enabled) return
      learnSession(input.event)
      suppress(input.event)
    },

    "chat.message": async (input) => {
      if (!cfg.enabled) return
      if (await skipSession(input.sessionID)) return
      rememberMainModel(input.sessionID, input.model, input.variant)
    },

    "chat.params": async (input) => {
      if (!cfg.enabled) return
      if (await skipSession(input.sessionID)) return
      rememberMainModel(input.sessionID, input.model, stringField(input, "variant"))
    },

    "chat.headers": async (input, output) => {
      if (!cfg.enabled) return
      if (await skipSession(input.sessionID)) return
      if (isGuardedRewrite(input.sessionID)) return
      if (rewriteScope.getStore() === true) return
      rememberMainModel(input.sessionID, input.model, stringField(input, "variant"))
      output.headers[PROVIDER_REWRITE_HEADER] = issueProviderToken(input.sessionID)
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!cfg.enabled) return
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
      output.system.push(handoffSystemPrompt())
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!cfg.enabled || !responses) return
      for (const message of output.messages) {
        const info = message.info
        if (stringField(info, "role") !== "assistant") continue
        const infoSessionID = stringField(info, "sessionID")
        if (infoSessionID && isGuardedRewrite(infoSessionID)) continue
        if (infoSessionID && await isPassthrough(infoSessionID)) continue
        if (infoSessionID && isDeletedSession(infoSessionID)) continue
        if (infoSessionID && isGuardedRewrite(infoSessionID)) continue
        const messageID = stringField(info, "id") ?? stringField(info, "messageID")
        for (const part of message.parts) {
          if (!record(part)) continue
          if (part.type !== "text" || typeof part.text !== "string") continue
          const sessionID = infoSessionID ?? stringField(part, "sessionID")
          if (!sessionID || await skipSession(sessionID) || isGuardedRewrite(sessionID)) continue
          const partMessageID = messageID ?? stringField(part, "messageID")
          const partID = stringField(part, "id") ?? stringField(part, "partID")
          if (!partMessageID || !partID) continue
          let original: string | undefined
          try {
            original = responses.getContextOriginal({
              directory: ctx.directory,
              sessionID,
              messageID: partMessageID,
              partID,
            }, part.text)
          } catch {
            continue
          }
          if (original !== undefined) part.text = original
        }
      }
    },

    "experimental.session.compacting": async (input, output) => {
      if (!cfg.enabled || !responses) return
      if (await skipSession(input.sessionID)) return
      if (isGuardedRewrite(input.sessionID)) return
      if (hasPendingForSession(input.sessionID)) return
      try {
        const originals = responses.getSessionOriginals(ctx.directory, input.sessionID, MAX_COMPACTION_ORIGINALS)
        if (originals.length === 0) return
        output.context.push(compactionContext(originals))
      } catch {
        return
      }
    },

    "experimental.text.complete": async (input, output) => {
      if (!cfg.enabled) return
      if (isDeletedSession(input.sessionID)) return
      if (hidden.has(input.sessionID)) return
      if (await isPassthrough(input.sessionID)) return
      if (isDeletedSession(input.sessionID)) return
      if (hidden.has(input.sessionID)) return
      if (rewriteGuards.has(input.sessionID)) {
        output.text = FAILURE
        return
      }
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
        output.text = (await existing.promise).text
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
        if (!providerOriginal.displayOnly) completed.set(done, { originalText: providerOriginal.originalText, visibleText: item.text })
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
      const work = rewrite(output.text, input.sessionID)
        .then((result) => {
          if (!entry || pending.get(done) !== entry) return result
          if (result.rewritten) {
            try {
              storeOriginal(input, result.text, item.text)
            } catch {
              return { text: FAILURE, rewritten: false }
            }
            completed.set(done, { originalText: item.text, visibleText: result.text })
          } else {
            try {
              storeDisplayOriginal(input, item.text, item.text)
            } catch {
              return { text: FAILURE, rewritten: false }
            }
            return { text: item.text, rewritten: false }
          }
          return result
        })
        .finally(() => {
          if (entry && pending.get(done) === entry) pending.delete(done)
        })
      entry = { originalText: item.text, promise: work }
      pending.set(done, entry)
      output.text = (await work).text
    },
  }
}

export default MaidPlugin
