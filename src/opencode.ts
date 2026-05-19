import type { PluginInput } from "@opencode-ai/plugin"
import { OpencodeClient as OpencodeClientV2 } from "@opencode-ai/sdk/v2/client"
import type { Client as ClientV2 } from "@opencode-ai/sdk/v2/gen/client"
import { FALLBACK_MODEL, MAIN_AGENT_MODEL, type MaidConfig } from "./config"
import type { HandoffNote } from "./rewrite"
import { maidUserPrompt } from "./rewrite"

export const REWRITE_AGENT = "roleplay_rewrite"

export type ModelSpec = {
  providerID: string
  modelID: string
  id: string
  variant?: string
}

type SessionMethodOptions = {
  signal?: AbortSignal
}

type Method = (input?: unknown, options?: SessionMethodOptions) => Promise<unknown>

type SessionApi = {
  create?: Method
  prompt?: Method
  delete?: Method
  get?: Method
}

type Client = {
  session?: SessionApi
  client?: ClientV2
  _client?: ClientV2
}

type TextPart = {
  type: "text"
  text: string
}

export type SessionMeta = {
  id?: string
  sessionID?: string
  parentID?: string
  agent?: string
  title?: string
}

const disabled = {
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
}

const REWRITE_TIMEOUT_MS = 120_000
const HIDDEN_CLEANUP_TTL_MS = 10 * 60 * 1000

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function data(input: unknown) {
  if (!record(input)) return input
  return "data" in input ? input.data : input
}

function text(input: unknown): input is TextPart {
  return record(input) && input.type === "text" && typeof input.text === "string"
}

function session(ctx: PluginInput): SessionApi {
  const client = ctx.client as unknown as Client
  const raw = client.client ?? client._client
  if (raw) return new OpencodeClientV2({ client: raw }).session as unknown as SessionApi
  if (client.session) return client.session
  throw new Error("OpenCode client does not expose session APIs")
}

function sid(input: unknown) {
  const item = data(input)
  if (record(item) && typeof item.id === "string") return item.id
  if (record(item) && typeof item.sessionID === "string") return item.sessionID
  throw new Error("OpenCode session.create response missing session id")
}

function content(input: unknown) {
  const item = data(input)
  if (!record(item) || !Array.isArray(item.parts)) throw new Error("OpenCode session.prompt response missing parts")
  const out = item.parts.filter(text).map((part) => part.text).join("\n").trimEnd()
  if (!out) throw new Error("OpenCode rewrite response did not contain text")
  return out
}

function sessionMeta(input: unknown): SessionMeta | undefined {
  const item = data(input)
  if (!record(item)) return undefined
  return {
    ...(typeof item.id === "string" ? { id: item.id } : {}),
    ...(typeof item.sessionID === "string" ? { sessionID: item.sessionID } : {}),
    ...(typeof item.parentID === "string" ? { parentID: item.parentID } : {}),
    ...(typeof item.agent === "string" ? { agent: item.agent } : {}),
    ...(typeof item.title === "string" ? { title: item.title } : {}),
  }
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const running = work(controller.signal)
  void running.catch(() => undefined)
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`OpenCode rewrite timed out after ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([running, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function cleanupHiddenOnTimer(hidden: Set<string>, sessionID: string, ttl: number) {
  const timer = setTimeout(() => hidden.delete(sessionID), ttl)
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref()
  return timer
}

function guardHiddenUntilDeleteOrTtl(hidden: Set<string>, sessionID: string, deletion: Promise<unknown> | undefined, ttl: number) {
  const timer = cleanupHiddenOnTimer(hidden, sessionID, ttl)
  if (!deletion) return
  void deletion.then(
    () => {
      clearTimeout(timer)
      hidden.delete(sessionID)
    },
    () => undefined,
  )
}

export function parseModel(model: string, variant?: string): ModelSpec {
  const index = model.indexOf("/")
  if (index <= 0 || index === model.length - 1) throw new Error(`Invalid model ${JSON.stringify(model)}; expected provider/model`)
  const modelID = model.slice(index + 1)
  return {
    providerID: model.slice(0, index),
    modelID,
    id: modelID,
    ...(variant ? { variant } : {}),
  }
}

export function resolveModel(cfg: MaidConfig, mainModel?: ModelSpec): ModelSpec {
  if (cfg.model === MAIN_AGENT_MODEL) return mainModel ?? parseModel(FALLBACK_MODEL)
  return parseModel(cfg.model, cfg.variant)
}

export function formatModel(model: ModelSpec) {
  return `${model.providerID}/${model.modelID}`
}

export function disabledTools() {
  return { ...disabled }
}

// Returned when a session lookup was attempted but failed (the client threw, or
// the client shape is unexpected). Distinct from `undefined`, which means the
// client stably exposes no `session.get` at all. Callers must fail closed on
// this so a transiently-unresolvable session is never assumed to be a rewritable
// root and thus risk contaminating a subagent transcript.
export const SESSION_META_LOOKUP_FAILED = Symbol("oh-my-opencode-maid:session-meta-lookup-failed")

export type SessionMetaResult = SessionMeta | undefined | typeof SESSION_META_LOOKUP_FAILED

export async function getSessionMeta(ctx: PluginInput, sessionID: string): Promise<SessionMetaResult> {
  let api: SessionApi
  try {
    api = session(ctx)
  } catch {
    return SESSION_META_LOOKUP_FAILED
  }
  if (!api.get) return undefined
  try {
    return sessionMeta(await api.get({ sessionID, directory: ctx.directory }))
  } catch {
    return SESSION_META_LOOKUP_FAILED
  }
}

export async function runMaid(input: {
  ctx: PluginInput
  cfg: MaidConfig
  text: string
  note?: HandoffNote
  parentID?: string
  hidden: Set<string>
  model?: ModelSpec
  timeoutMs?: number
  hiddenTtlMs?: number
}) {
  const api = session(input.ctx)
  const create = api.create
  const prompt = api.prompt
  if (!create || !prompt) throw new Error("OpenCode client does not expose session.create/session.prompt")
  const model = resolveModel(input.cfg, input.model)
  const made = await create.call(api, {
    agent: REWRITE_AGENT,
    directory: input.ctx.directory,
    ...(input.parentID ? { parentID: input.parentID } : {}),
    title: "Roleplay rewrite",
    model: {
      id: model.id,
      providerID: model.providerID,
      ...(model.variant ? { variant: model.variant } : {}),
    },
  })
  const sessionID = sid(made)
  input.hidden.add(sessionID)
  let completed = false
  try {
    const out = content(
      await withTimeout(
        (signal) => prompt.call(api, {
            sessionID,
            directory: input.ctx.directory,
            agent: REWRITE_AGENT,
            model: {
              providerID: model.providerID,
              modelID: model.modelID,
            },
            ...(model.variant ? { variant: model.variant } : {}),
            tools: disabledTools(),
            parts: [
              {
                type: "text",
                text: maidUserPrompt(input),
              },
            ],
          },
          { signal },
        ),
        input.timeoutMs ?? REWRITE_TIMEOUT_MS,
      ),
    )
    completed = true
    return out
  } finally {
    const deletion = api.delete?.call(api, { sessionID, directory: input.ctx.directory })
    if (completed) {
      cleanupHiddenOnTimer(input.hidden, sessionID, input.hiddenTtlMs ?? HIDDEN_CLEANUP_TTL_MS)
      void deletion?.catch(() => undefined)
    } else {
      guardHiddenUntilDeleteOrTtl(input.hidden, sessionID, deletion, input.hiddenTtlMs ?? HIDDEN_CLEANUP_TTL_MS)
    }
  }
}

export function createDeltaSuppressor(hidden: ReadonlySet<string>, passthrough: ReadonlySet<string> = new Set()) {
  const parts = new Set<string>()
  return (event: unknown) => {
    if (!record(event) || typeof event.type !== "string" || !record(event.properties)) return
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (!record(part) || part.type !== "text" || typeof part.id !== "string" || typeof part.sessionID !== "string") return
      if (hidden.has(part.sessionID) || passthrough.has(part.sessionID)) return
      if (record(part.time) && typeof part.time.end === "number") {
        parts.delete(part.id)
        return
      }
      parts.add(part.id)
      return
    }
    if (event.type !== "message.part.delta") return
    if (typeof event.properties.partID !== "string") return
    if (typeof event.properties.sessionID === "string" && (hidden.has(event.properties.sessionID) || passthrough.has(event.properties.sessionID))) return
    if (event.properties.field !== "text") return
    event.properties.delta = ""
  }
}
