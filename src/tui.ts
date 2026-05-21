import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { DISPLAY_ONLY_FALLBACK } from "./fallback"
import { createResponseStore, type ResponseKey, type ResponseStore } from "./responses"

type TuiDialog = {
  replace(render: () => unknown, onClose?: () => void): void
  clear(): void
  setSize(size: "medium" | "large" | "xlarge"): void
}

type TuiCommand = {
  title: string
  value: string
  description?: string
  category?: string
  keybind?: string
  suggested?: boolean
  hidden?: boolean
  enabled?: boolean
  slash?: {
    name: string
    aliases?: string[]
  }
  onSelect?: () => void | Promise<void>
}

type TuiApi = {
  event: {
    on(type: string, handler: (event: unknown) => void): () => void
  }
  state: {
    path: {
      directory: string
    }
    session: {
      messages(sessionID: string): ReadonlyArray<unknown>
    }
    part(messageID: string): ReadonlyArray<unknown>
  }
  route: {
    readonly current: {
      name: string
      params?: Record<string, unknown>
    }
  }
  ui: {
    DialogAlert(props: { title: string; message: string; onConfirm?: () => void }): unknown
    dialog: TuiDialog
  }
  command?: {
    register(cb: () => TuiCommand[]): () => void
  }
  lifecycle?: {
    onDispose(fn: () => void | Promise<void>): () => void
  }
}

type HostDecorationHook = {
  decorateTextPart?(messageID: string, partID: string, decoration: {
    type: "collapsed-thought"
    label: string
    content: string
    style: "dark"
    collapsed: true
  }): void | (() => void)
}

type ActiveDecoration = {
  visibleText: string
  dispose?: () => void
}

type TuiPluginMeta = {
  id: string
}

type FallbackRef = ResponseKey & {
  visibleText: string
}

const MAX_DISPLAY_CHARS = 20_000
const DEBUG_ENV = "OH_MY_OPENCODE_MAID_TUI_DEBUG"

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function stringField(input: unknown, field: string) {
  if (!record(input)) return undefined
  const value = input[field]
  return typeof value === "string" ? value : undefined
}

function debugFile() {
  const value = process.env[DEBUG_ENV]
  if (!value) return undefined
  if (value !== "1" && value !== "true") return path.resolve(value)
  const base = process.env.XDG_STATE_HOME ? path.resolve(process.env.XDG_STATE_HOME) : process.env.HOME ? path.join(process.env.HOME, ".local", "state") : undefined
  return base ? path.join(base, "opencode", "oh-my-opencode-maid", "tui-debug.log") : undefined
}

function debugTui(event: string, data: Record<string, unknown> = {}) {
  const file = debugFile()
  if (!file) return
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const entry: Record<string, unknown> = { time: new Date().toISOString(), event }
    for (const [key, value] of Object.entries(data)) entry[key === "event" ? "payload" : key] = value
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  } catch (error) {
    if (process.env.OH_MY_OPENCODE_MAID_TUI_DEBUG_STDERR) console.error("[oh-my-opencode-maid:tui-debug]", error)
  }
}

function fallbackRefFromPart(directory: string, part: unknown): FallbackRef | undefined {
  if (!record(part)) return undefined
  if (part.type !== "text") return undefined
  if (part.text !== DISPLAY_ONLY_FALLBACK) return undefined
  if (!record(part.time) || typeof part.time.end !== "number") return undefined
  const sessionID = stringField(part, "sessionID")
  const messageID = stringField(part, "messageID")
  const partID = stringField(part, "id") ?? stringField(part, "partID")
  if (!sessionID || !messageID || !partID) return undefined
  return { directory, sessionID, messageID, partID, visibleText: DISPLAY_ONLY_FALLBACK }
}

function fallbackRefFromEvent(directory: string, event: unknown): FallbackRef | undefined {
  if (!record(event) || event.type !== "message.part.updated") return undefined
  const properties = record(event.properties) ? event.properties : undefined
  return fallbackRefFromPart(directory, properties?.part)
}

function successfulRewriteRefFromPart(directory: string, part: unknown): FallbackRef | undefined {
  if (!record(part)) return undefined
  if (part.type !== "text") return undefined
  const text = typeof part.text === "string" ? part.text : undefined
  if (text === undefined || text === DISPLAY_ONLY_FALLBACK) return undefined
  if (!record(part.time) || typeof part.time.end !== "number") return undefined
  const sessionID = stringField(part, "sessionID")
  const messageID = stringField(part, "messageID")
  const partID = stringField(part, "id") ?? stringField(part, "partID")
  if (!sessionID || !messageID || !partID) return undefined
  return { directory, sessionID, messageID, partID, visibleText: text }
}

function successfulRewriteRefFromEvent(directory: string, event: unknown): FallbackRef | undefined {
  if (!record(event) || event.type !== "message.part.updated") return undefined
  const properties = record(event.properties) ? event.properties : undefined
  return successfulRewriteRefFromPart(directory, properties?.part)
}

function getHostDecorationHook(api: TuiApi): HostDecorationHook | undefined {
  const ui = api.ui as unknown as HostDecorationHook
  if (typeof ui.decorateTextPart === "function") {
    return ui
  }
  return undefined
}

function decorationKey(ref: ResponseKey) {
  return `${ref.messageID}\0${ref.partID}`
}

function originalFor(store: ResponseStore | undefined, ref: FallbackRef) {
  if (!store) return undefined
  try {
    return store.getOriginal(ref, ref.visibleText)
  } catch {
    return undefined
  }
}

function hasOriginal(store: ResponseStore | undefined, ref: FallbackRef) {
  return originalFor(store, ref) !== undefined
}

function findLastOriginalRef(api: TuiApi, store: ResponseStore | undefined): FallbackRef | undefined {
  const current = api.route.current
  const sessionID = current.name === "session" ? stringField(current.params, "sessionID") : undefined
  if (!sessionID) return undefined
  const messages = api.state.session.messages(sessionID)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!record(message) || message.role !== "assistant") continue
    const messageID = stringField(message, "id") ?? stringField(message, "messageID")
    if (!messageID) continue
    const parts = api.state.part(messageID)
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const fallback = fallbackRefFromPart(api.state.path.directory, parts[partIndex])
      if (fallback && hasOriginal(store, fallback)) return fallback
      const successful = successfulRewriteRefFromPart(api.state.path.directory, parts[partIndex])
      if (successful && hasOriginal(store, successful)) return successful
    }
  }
  return undefined
}

function displayText(original: string) {
  if (original.length <= MAX_DISPLAY_CHARS) return original
  return `${original.slice(0, MAX_DISPLAY_CHARS)}\n\n[truncated for local TUI display]`
}

async function openOriginal(api: TuiApi, store: ResponseStore | undefined, ref: FallbackRef | undefined) {
  if (!ref) return
  const original = originalFor(store, ref)
  if (original === undefined) return
  api.ui.dialog.setSize("xlarge")
  api.ui.dialog.replace(() => api.ui.DialogAlert({
    title: "Original rewrite",
    message: displayText(original),
    onConfirm: () => api.ui.dialog.clear(),
  }))
}

async function tui(api: TuiApi, _options: unknown, _meta: TuiPluginMeta) {
  const store = await createResponseStore().catch(() => undefined)
  let lastOriginalRef: FallbackRef | undefined
  const activeDecorations = new Map<string, ActiveDecoration>()

  const disposeActiveDecoration = (key: string) => {
    try {
      activeDecorations.get(key)?.dispose?.()
    } catch (error) {
      debugTui("host.decoration.dispose.failed", { error: error instanceof Error ? error.message : String(error) })
    }
    activeDecorations.delete(key)
  }

  const tryHostDecoration = (ref: FallbackRef, original: string): boolean => {
    const key = decorationKey(ref)
    const active = activeDecorations.get(key)
    if (active?.visibleText === ref.visibleText) return true
    const hook = getHostDecorationHook(api)
    if (!hook?.decorateTextPart) return false
    try {
      disposeActiveDecoration(key)
      const disposeDecoration = hook.decorateTextPart(ref.messageID, ref.partID, {
        type: "collapsed-thought",
        label: "Original",
        content: displayText(original),
        style: "dark",
        collapsed: true,
      })
      activeDecorations.set(key, {
        visibleText: ref.visibleText,
        dispose: typeof disposeDecoration === "function" ? disposeDecoration : undefined,
      })
      return true
    } catch (error) {
      debugTui("host.decoration.failed", { messageID: ref.messageID, partID: ref.partID, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  const unsubscribeEvent = api.event.on("message.part.updated", (event) => {
    debugTui("event.message.part.updated", { event })
    const fallbackRef = fallbackRefFromEvent(api.state.path.directory, event)
    if (fallbackRef) {
      if (hasOriginal(store, fallbackRef)) lastOriginalRef = fallbackRef
      void openOriginal(api, store, fallbackRef)
      return
    }

    const rewriteRef = successfulRewriteRefFromEvent(api.state.path.directory, event)
    if (rewriteRef && store) {
      const key = decorationKey(rewriteRef)
      const active = activeDecorations.get(key)
      if (active?.visibleText === rewriteRef.visibleText) return
      const original = originalFor(store, rewriteRef)
      if (original !== undefined) {
        debugTui("original.found", { messageID: rewriteRef.messageID, partID: rewriteRef.partID, visibleLength: rewriteRef.visibleText.length })
        lastOriginalRef = rewriteRef
        if (!tryHostDecoration(rewriteRef, original)) debugTui("host.decoration.unavailable", { messageID: rewriteRef.messageID, partID: rewriteRef.partID })
      } else {
        debugTui("original.missing", { messageID: rewriteRef.messageID, partID: rewriteRef.partID, visibleLength: rewriteRef.visibleText.length })
      }
    }
  })

  const debugUnsubscribers = [
    api.event.on("session.next.text.ended", (event) => debugTui("event.session.next.text.ended", { event, route: api.route.current })),
    api.event.on("session.next.step.ended", (event) => debugTui("event.session.next.step.ended", { event, route: api.route.current })),
  ]

  debugTui("tui.init", {
    directory: api.state.path.directory,
    route: api.route.current,
    hasCommand: Boolean(api.command),
    hasHostDecoration: Boolean(getHostDecorationHook(api)?.decorateTextPart),
  })

  const unregisterCommand = api.command?.register(() => [{
    title: "Show original rewrite",
    value: "maid.original",
    description: "Open the sidecar-stored original for the latest rewrite.",
    category: "oh-my-opencode-maid",
    slash: {
      name: "maid-original",
    },
    onSelect: () => openOriginal(api, store, lastOriginalRef ?? findLastOriginalRef(api, store)),
  }])

  api.lifecycle?.onDispose(() => {
    unsubscribeEvent()
    for (const unsubscribe of debugUnsubscribers) unsubscribe()
    unregisterCommand?.()
    for (const decoration of activeDecorations.values()) {
      try {
        decoration.dispose?.()
      } catch (error) {
        debugTui("host.decoration.dispose.failed", { error: error instanceof Error ? error.message : String(error) })
        continue
      }
    }
    activeDecorations.clear()
    store?.close()
  })
}

export default { id: "oh-my-opencode-maid", tui }
