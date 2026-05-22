import { EventEmitter } from "node:events"

type State = {
  response: typeof Response
  emit: typeof EventEmitter.prototype.emit
  fetch: typeof fetch
  post?: typeof globalThis.postMessage
  open: Set<string>
  streamOwners: Set<string>
  hidden: ReadonlySet<string>
  passthrough: ReadonlySet<string>
  provider?: ProviderHook
  command?: CommandHook
}

type ProviderHook = {
  owner: string
  active: () => boolean
  server: string
  consumeRewriteToken?: (headers: Headers) => string | undefined
  rewrite: (text: string, sessionID?: string) => Promise<string>
}

type CommandRequest = {
  sessionID: string
  messageID?: string
  arguments: string
}

type CommandHook = {
  owner: string
  server: string
  command: string
  handle: (input: CommandRequest) => Promise<unknown>
}

type ProviderEvent = {
  data: string
  json?: Record<string, unknown>
  text?: string
  tool: boolean
}

const key = "__ohMyOpencodeMaidStreamGate"
export const PROVIDER_REWRITE_HEADER = "x-oh-my-opencode-maid-rewrite"
const TITLE_GENERATOR_MARKER = "You are a title generator."
const SAFE_TITLE = "New session"
const enc = new TextEncoder()
const dec = new TextDecoder()
const providerFetches = new WeakSet<typeof fetch>()

function root() {
  return globalThis as typeof globalThis & { __ohMyOpencodeMaidStreamGate?: State }
}

function restoreFetchIfIdle(state: State) {
  if (state.provider || state.command) return
  globalThis.fetch = state.fetch
  if (state.streamOwners.size === 0) delete root()[key]
}

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function headers(input?: HeadersInit) {
  return new Headers(input).get("content-type") ?? ""
}

function payload(input: unknown) {
  if (!record(input)) return undefined
  if (record(input.payload)) return input.payload
  if (typeof input.type === "string") return input
  return undefined
}

function bypass(event: Record<string, unknown>, state: State) {
  const props = event.properties
  if (!record(props)) return false
  if (typeof props.sessionID === "string") return state.hidden.has(props.sessionID) || state.passthrough.has(props.sessionID)
  const part = props.part
  if (record(part) && typeof part.sessionID === "string") return state.hidden.has(part.sessionID) || state.passthrough.has(part.sessionID)
  return false
}

function id(event: Record<string, unknown>) {
  const props = event.properties
  if (!record(props)) return undefined
  if (typeof props.partID === "string") return props.partID
  const part = props.part
  if (record(part) && typeof part.id === "string") return part.id
  return undefined
}

function wrap(input: unknown, event: unknown) {
  if (record(input) && record(input.payload)) return { ...input, payload: event }
  return event
}

function cleanseMany(input: unknown, state: State): unknown[] | undefined {
  const event = payload(input)
  if (!event) return [input]
  if (event.type === "message.part.updated") {
    const props = event.properties
    const part = record(props) ? props.part : undefined
    if (!record(part) || part.type !== "text" || typeof part.id !== "string") return [input]
    if (bypass(event, state)) return [input]
    if (record(part.time) && typeof part.time.end === "number") state.open.delete(part.id)
    else state.open.add(part.id)
    return [input]
  }
  if (event.type !== "message.part.delta") return [input]
  if (bypass(event, state)) return [input]
  const props = event.properties
  if (!record(props) || props.field !== "text") return [input]
  return undefined
}

function likelyPublicRawTextDelta(data: string) {
  return data.includes("message.part.delta") && /"field"\s*:\s*"text"/.test(data) && /"delta"\s*:/.test(data)
}

function frame(block: string, state: State) {
  const lines = block.split(/\r?\n/)
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data) return `${block}\n\n`
  try {
    const parsed = JSON.parse(data) as unknown
    const clean = cleanseMany(parsed, state)
    if (clean === undefined) return ""
    return clean.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")
  } catch {
    if (likelyPublicRawTextDelta(data)) return ""
    return `${block}\n\n`
  }
}

function rpc(message: unknown, state: State) {
  if (typeof message !== "string") return message
  try {
    const parsed = JSON.parse(message) as unknown
    if (!record(parsed) || parsed.type !== "rpc.event" || parsed.event !== "event") return message
    const clean = cleanseMany(parsed.data, state)
    if (clean === undefined) return undefined
    const next = clean.map((item) => JSON.stringify({ ...parsed, data: item }))
    return next.length === 1 ? next[0] : next
  } catch {
    if (likelyPublicRawTextDelta(message)) return undefined
    return message
  }
}

function stream(body: ReadableStream<Uint8Array>, state: State) {
  const reader = body.getReader()
  let buf = ""
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await reader.read()
      if (part.done) {
        if (buf) ctrl.enqueue(enc.encode(frame(buf, state)))
        ctrl.close()
        return
      }
      buf += dec.decode(part.value, { stream: true })
      const out: string[] = []
      for (;;) {
        const hit = /\r?\n\r?\n/.exec(buf)
        if (!hit || hit.index === undefined) break
        out.push(frame(buf.slice(0, hit.index), state))
        buf = buf.slice(hit.index + hit[0].length)
      }
      if (out.length) ctrl.enqueue(enc.encode(out.join("")))
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

function gated(input: BodyInit | null | undefined, init: ResponseInit | undefined, state: State) {
  if (!input) return input
  if (!headers(init?.headers).includes("text/event-stream")) return input
  if (!(input instanceof ReadableStream)) return input
  return stream(input, state)
}

function req(init?: RequestInit) {
  if (typeof init?.body === "string") return init.body
  if (init?.body instanceof Uint8Array) return dec.decode(init.body)
  if (init?.body instanceof ArrayBuffer) return dec.decode(init.body)
  return undefined
}

async function reqText(input: RequestInfo | URL, init?: RequestInit) {
  const body = req(init)
  if (body !== undefined) return body
  if (input instanceof Request) return input.clone().text()
  return undefined
}

function reqHeaders(input: RequestInfo | URL, init?: RequestInit) {
  const out = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) for (const [key, value] of new Headers(init.headers)) out.set(key, value)
  return out
}

function cleanRequest(input: RequestInfo | URL, init?: RequestInit): [RequestInfo | URL, RequestInit | undefined] {
  const hasInputHeader = input instanceof Request && input.headers.has(PROVIDER_REWRITE_HEADER)
  const hasInitHeader = init?.headers ? new Headers(init.headers).has(PROVIDER_REWRITE_HEADER) : false
  if (!hasInputHeader && !hasInitHeader) return [input, init]
  const nextInit = { ...(init ?? {}) }
  const nextHeaders = reqHeaders(input, init)
  nextHeaders.delete(PROVIDER_REWRITE_HEADER)
  nextInit.headers = nextHeaders
  if (input instanceof Request && hasInputHeader) return [new Request(input, nextInit), nextInit]
  return [input, nextInit]
}

function external(input: RequestInfo | URL, hook: ProviderHook) {
  const url = typeof input === "string" || input instanceof URL ? input : input.url
  try {
    return new URL(url).origin !== hook.server
  } catch {
    // Unparseable URL: treat as external so it is never mistaken for the local server.
    return true
  }
}

function localUrl(input: RequestInfo | URL, server: string) {
  const url = typeof input === "string" || input instanceof URL ? input : input.url
  try {
    const parsed = new URL(url, server)
    return parsed.origin === server ? parsed : undefined
  } catch {
    return undefined
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
}

function commandSession(pathname: string) {
  const match = /^\/session\/([^/]+)\/command$/.exec(pathname)
  return match?.[1] ? decodeURIComponent(match[1]) : undefined
}

function text(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

async function commandBody(input: RequestInfo | URL, init: RequestInit | undefined) {
  const body = await reqText(input, init)
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as unknown
    return record(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function chandle(input: RequestInfo | URL, init: RequestInit | undefined, hook: CommandHook) {
  if (requestMethod(input, init) !== "POST") return undefined
  const url = localUrl(input, hook.server)
  if (!url) return undefined
  const sessionID = commandSession(url.pathname)
  if (!sessionID) return undefined
  const body = await commandBody(input, init)
  if (body?.command !== hook.command) return undefined
  return new Response(JSON.stringify(await hook.handle({
    sessionID,
    messageID: text(body, "messageID"),
    arguments: text(body, "arguments") ?? "",
  })), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function model(text?: string) {
  if (!text) return false
  return text.includes('"messages"') || text.includes('"input"') || text.includes('"prompt"')
}

function contentText(input: unknown) {
  if (typeof input === "string") return input
  if (!Array.isArray(input)) return ""
  const out: string[] = []
  for (const item of input) {
    if (record(item) && typeof item.text === "string") out.push(item.text)
  }
  return out.join("\n")
}

function titleGenerator(text?: string) {
  if (!text) return false
  try {
    const parsed = JSON.parse(text) as unknown
    if (!record(parsed) || !Array.isArray(parsed.messages)) return false
    return parsed.messages.some((message) => record(message)
      && message.role === "system"
      && contentText(message.content).includes(TITLE_GENERATOR_MARKER))
  } catch {
    return false
  }
}

function chat(input: Record<string, unknown>) {
  const choices = input.choices
  if (!Array.isArray(choices)) return undefined
  const first = choices[0]
  if (!record(first) || !record(first.delta)) return undefined
  return typeof first.delta.content === "string" ? first.delta.content : undefined
}

function output(input: Record<string, unknown>) {
  if (input.type !== "response.output_text.delta") return undefined
  return typeof input.delta === "string" ? input.delta : undefined
}

function anthropic(input: Record<string, unknown>) {
  if (input.type !== "content_block_delta") return undefined
  const delta = input.delta
  if (!record(delta) || delta.type !== "text_delta") return undefined
  return typeof delta.text === "string" ? delta.text : undefined
}

function ptext(input: Record<string, unknown>) {
  return chat(input) ?? output(input) ?? anthropic(input)
}

function ptool(input: Record<string, unknown>) {
  const choices = input.choices
  const choice = Array.isArray(choices) && record(choices[0]) ? choices[0] : undefined
  const delta = choice && record(choice.delta) ? choice.delta : undefined
  if (delta && ("tool_calls" in delta || "function_call" in delta)) return true
  if (typeof input.type === "string" && input.type.includes("function_call")) return true
  if (input.type === "content_block_start" && record(input.content_block) && input.content_block.type === "tool_use") return true
  return false
}

function pevent(block: string): ProviderEvent | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return { data, tool: false }
  try {
    const json = JSON.parse(data) as unknown
    if (!record(json)) return { data, tool: false }
    return { data, json, text: ptext(json), tool: ptool(json) }
  } catch {
    return { data, tool: false }
  }
}

function pchat(input: Record<string, unknown>, value: string) {
  const choices = input.choices
  if (!Array.isArray(choices)) return input
  const first = choices[0]
  if (!record(first) || !record(first.delta) || typeof first.delta.content !== "string") return input
  return { ...input, choices: [{ ...first, delta: { ...first.delta, content: value } }, ...choices.slice(1)] }
}

function pmessage(choice: unknown, value: string) {
  if (!record(choice) || !record(choice.message) || typeof choice.message.content !== "string") return choice
  return { ...choice, message: { ...choice.message, content: value } }
}

function presponse(input: Record<string, unknown>, value: string) {
  if (input.type !== "response.output_text.delta" || typeof input.delta !== "string") return input
  return { ...input, delta: value }
}

function panthropic(input: Record<string, unknown>, value: string) {
  if (input.type !== "content_block_delta" || !record(input.delta) || input.delta.type !== "text_delta") return input
  return { ...input, delta: { ...input.delta, text: value } }
}

function pmutate(input: Record<string, unknown>, value: string) {
  return panthropic(presponse(pchat(input, value), value), value)
}

function clone(res: Response, text: string) {
  const header = new Headers(res.headers)
  header.delete("content-length")
  header.delete("content-encoding")
  return new Response(text, { status: res.status, statusText: res.statusText, headers: header })
}

async function pstream(res: Response, hook: ProviderHook, sessionID?: string) {
  const raw = await res.text()
  const blocks = raw.split(/\n\n/)
  const events = blocks.map(pevent).filter((item): item is ProviderEvent => Boolean(item))
  const draft = events.map((item) => item.text ?? "").join("")
  if (!draft || events.some((item) => item.tool)) return clone(res, raw)
  const visible = await hook.rewrite(draft, sessionID)
  let used = false
  return clone(
    res,
    blocks
      .map((block) => {
        const event = pevent(block)
        if (!event?.json || event.text === undefined) return block
        const value = used ? "" : visible
        used = true
        return block.replace(event.data, JSON.stringify(pmutate(event.json, value)))
      })
      .join("\n\n"),
  )
}

async function ptitleStream(res: Response) {
  const raw = await res.text()
  const blocks = raw.split(/\n\n/)
  let used = false
  return clone(
    res,
    blocks
      .map((block) => {
        const event = pevent(block)
        if (!event?.json || event.text === undefined) return block
        const value = used ? "" : SAFE_TITLE
        used = true
        return block.replace(event.data, JSON.stringify(pmutate(event.json, value)))
      })
      .join("\n\n"),
  )
}

async function pjson(res: Response, hook: ProviderHook, sessionID?: string) {
  const raw = await res.text()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!record(parsed)) return clone(res, raw)
    const choices = parsed.choices
    if (Array.isArray(choices) && record(choices[0]) && record(choices[0].message) && typeof choices[0].message.content === "string") {
      const visible = await hook.rewrite(choices[0].message.content, sessionID)
      return clone(res, JSON.stringify({ ...parsed, choices: choices.map((choice, index) => pmessage(choice, index === 0 ? visible : "")) }))
    }
    return clone(res, raw)
  } catch {
    return clone(res, raw)
  }
}

async function ptitleJson(res: Response) {
  const raw = await res.text()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!record(parsed)) return clone(res, raw)
    const choices = parsed.choices
    if (Array.isArray(choices) && record(choices[0]) && record(choices[0].message) && typeof choices[0].message.content === "string") {
      return clone(res, JSON.stringify({ ...parsed, choices: choices.map((choice, index) => pmessage(choice, index === 0 ? SAFE_TITLE : "")) }))
    }
    return clone(res, raw)
  } catch {
    return clone(res, raw)
  }
}

async function phandle(input: RequestInfo | URL, init: RequestInit | undefined, hook: ProviderHook, fetcher: typeof fetch) {
  const body = await reqText(input, init)
  const rewriteSessionID = hook.consumeRewriteToken?.(reqHeaders(input, init))
  const shouldRewrite = rewriteSessionID !== undefined
  const shouldSanitizeTitle = titleGenerator(body)
  const [cleanInput, cleanInit] = cleanRequest(input, init)
  const res = await fetcher(cleanInput, cleanInit)
  if (!external(input, hook)) return res
  if (!model(body)) return res
  const type = res.headers.get("content-type") ?? ""
  if (shouldSanitizeTitle) {
    if (type.includes("text/event-stream")) return ptitleStream(res)
    if (type.includes("application/json")) return ptitleJson(res)
    return res
  }
  if (hook.active()) return res
  if (!shouldRewrite) return res
  if (type.includes("text/event-stream")) return res
  if (type.includes("application/json")) return pjson(res, hook, rewriteSessionID)
  return res
}

function installFetchPatch(state: State) {
  if (globalThis.fetch !== state.fetch) return
  const base = state.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const state = root()[key]
    if (!state) return base(input, init)
    const intercepted = state.command ? await chandle(input, init, state.command) : undefined
    if (intercepted) return intercepted
    if (state.provider) return phandle(input, init, state.provider, state.fetch)
    return base(input, init)
  }) as typeof fetch
}

export function installPublicStreamGate(hidden: ReadonlySet<string>, passthrough: ReadonlySet<string> = new Set(), owner = "default") {
  const box = root()
  box[key] = box[key] ?? {
    response: globalThis.Response,
    emit: EventEmitter.prototype.emit,
    fetch: globalThis.fetch,
    post: typeof globalThis.postMessage === "function" ? globalThis.postMessage : undefined,
    open: new Set<string>(),
    streamOwners: new Set<string>(),
    hidden,
    passthrough,
  }
  const state = box[key]
  state.streamOwners.add(owner)
  state.hidden = hidden
  state.passthrough = passthrough
  if (globalThis.Response === state.response) {
    const Original = state.response
    globalThis.Response = class extends Original {
      constructor(input?: BodyInit | null, init?: ResponseInit) {
        super(gated(input, init, state), init)
      }
    }
  }
  if (EventEmitter.prototype.emit === state.emit) {
    const emit = state.emit
    EventEmitter.prototype.emit = function (name: string | symbol, ...args: unknown[]) {
      const state = root()[key]
      if (name === "event" && state && args.length > 0) {
        const clean = cleanseMany(args[0], state)
        if (clean === undefined) return false
        let emitted = false
        for (const item of clean) emitted = emit.call(this, name, item, ...args.slice(1)) || emitted
        return emitted
      }
      return emit.call(this, name, ...args)
    }
  }
  if (state.post && globalThis.postMessage === state.post) {
    const post = state.post
    globalThis.postMessage = ((message: unknown, transfer?: Transferable[]) => {
      const state = root()[key]
      const next = state ? rpc(message, state) : message
      if (next === undefined) return
      if (Array.isArray(next)) {
        for (const item of next) Reflect.apply(post, globalThis, [item])
        return
      }
      return Reflect.apply(post, globalThis, transfer ? [next, transfer] : [next])
    }) as typeof globalThis.postMessage
  }
}

export function installProviderRewrite(hook: ProviderHook) {
  const box = root()
  box[key] = box[key] ?? {
    response: globalThis.Response,
    emit: EventEmitter.prototype.emit,
    fetch: globalThis.fetch,
    post: typeof globalThis.postMessage === "function" ? globalThis.postMessage : undefined,
    open: new Set<string>(),
    streamOwners: new Set<string>(),
    hidden: new Set<string>(),
    passthrough: new Set<string>(),
  }
  const state = box[key]
  state.provider = hook
  installFetchPatch(state)
  return state.fetch
}

export function installCommandInterceptor(hook: CommandHook) {
  const box = root()
  box[key] = box[key] ?? {
    response: globalThis.Response,
    emit: EventEmitter.prototype.emit,
    fetch: globalThis.fetch,
    post: typeof globalThis.postMessage === "function" ? globalThis.postMessage : undefined,
    open: new Set<string>(),
    streamOwners: new Set<string>(),
    hidden: new Set<string>(),
    passthrough: new Set<string>(),
  }
  const state = box[key]
  state.command = hook
  installFetchPatch(state)
  return state.fetch
}

export function uninstallProviderRewrite(owner: string) {
  const state = root()[key]
  if (state?.provider?.owner !== owner) return
  state.provider = undefined
  restoreFetchIfIdle(state)
}

export function uninstallCommandInterceptor(owner: string) {
  const state = root()[key]
  if (state?.command?.owner !== owner) return
  state.command = undefined
  restoreFetchIfIdle(state)
}

export function uninstallPublicStreamGate(owner = "default") {
  const state = root()[key]
  if (!state) return
  state.streamOwners.delete(owner)
  if (state.streamOwners.size > 0) return
  globalThis.Response = state.response
  EventEmitter.prototype.emit = state.emit
  if (state.post) globalThis.postMessage = state.post as typeof globalThis.postMessage
  restoreFetchIfIdle(state)
}

export function createProviderFetch(hook: ProviderHook, fetcher: typeof fetch = fetch) {
  if (providerFetches.has(fetcher)) return fetcher
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => phandle(input, init, hook, fetcher)) as typeof fetch
  providerFetches.add(wrapped)
  return wrapped
}

// Test seam: hard-restores every patched global in one call so tests start from
// a clean process. Not used by the runtime, which unwinds patches per-owner via
// uninstallProviderRewrite / uninstallPublicStreamGate instead.
export function resetPublicStreamGate() {
  const box = root()
  if (!box[key]) return
  globalThis.Response = box[key].response
  EventEmitter.prototype.emit = box[key].emit
  globalThis.fetch = box[key].fetch
  if (box[key].post) globalThis.postMessage = box[key].post as typeof globalThis.postMessage
  delete box[key]
}
