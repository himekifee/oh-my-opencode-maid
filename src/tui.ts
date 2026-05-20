import { DISPLAY_ONLY_FALLBACK } from "./fallback"
import { createResponseStore, type ResponseKey, type ResponseStore } from "./responses"

type TuiToast = {
  variant?: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  duration?: number
}

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
    toast(input: TuiToast): void
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

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function stringField(input: unknown, field: string) {
  if (!record(input)) return undefined
  const value = input[field]
  return typeof value === "string" ? value : undefined
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

function findLastFallbackRef(api: TuiApi): FallbackRef | undefined {
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
      const ref = fallbackRefFromPart(api.state.path.directory, parts[partIndex])
      if (ref) return ref
    }
  }
  return undefined
}

function displayText(original: string) {
  if (original.length <= MAX_DISPLAY_CHARS) return original
  return `${original.slice(0, MAX_DISPLAY_CHARS)}\n\n[truncated for local TUI display]`
}

function showUnavailable(api: TuiApi) {
  api.ui.toast({
    variant: "warning",
    title: "Original unavailable",
    message: "No sidecar original was found for the rewrite fallback.",
    duration: 5000,
  })
}

async function openOriginal(api: TuiApi, store: ResponseStore | undefined, ref: FallbackRef | undefined) {
  if (!ref) return showUnavailable(api)
  if (!store) return showUnavailable(api)
  let original: string | undefined
  try {
    original = store.getOriginal(ref, ref.visibleText)
  } catch {
    return showUnavailable(api)
  }
  if (!original) return showUnavailable(api)
  api.ui.dialog.setSize("xlarge")
  api.ui.dialog.replace(() => api.ui.DialogAlert({
    title: "Original rewrite fallback",
    message: displayText(original),
    onConfirm: () => api.ui.dialog.clear(),
  }))
}

async function tui(api: TuiApi, _options: unknown, _meta: TuiPluginMeta) {
  const store = await createResponseStore().catch(() => undefined)
  let lastFallback: FallbackRef | undefined
  const activeDecorations = new Map<string, ActiveDecoration>()

  const unsubscribeEvent = api.event.on("message.part.updated", (event) => {
    const fallbackRef = fallbackRefFromEvent(api.state.path.directory, event)
    if (fallbackRef) {
      lastFallback = fallbackRef
      void openOriginal(api, store, fallbackRef)
      return
    }

    const rewriteRef = successfulRewriteRefFromEvent(api.state.path.directory, event)
    const hook = getHostDecorationHook(api)
    if (rewriteRef && store && hook?.decorateTextPart) {
      const key = decorationKey(rewriteRef)
      if (activeDecorations.get(key)?.visibleText === rewriteRef.visibleText) return
      let original: string | undefined
      try {
        original = store.getContextOriginal(rewriteRef, rewriteRef.visibleText)
      } catch {
        return
      }
      if (original) {
        try {
          activeDecorations.get(key)?.dispose?.()
          const disposeDecoration = hook.decorateTextPart(rewriteRef.messageID, rewriteRef.partID, {
            type: "collapsed-thought",
            label: "Original",
            content: displayText(original),
            style: "dark",
            collapsed: true,
          })
          activeDecorations.set(key, {
            visibleText: rewriteRef.visibleText,
            dispose: typeof disposeDecoration === "function" ? disposeDecoration : undefined,
          })
        } catch {
          return
        }
      }
    }
  })

  const unregisterCommand = api.command?.register(() => [{
    title: "Show original rewrite fallback",
    value: "maid.original_fallback",
    description: "Open the sidecar-stored original for the latest rewrite fallback.",
    category: "oh-my-opencode-maid",
    slash: {
      name: "maid-original",
      aliases: ["maid-fallback-original"],
    },
    onSelect: () => openOriginal(api, store, lastFallback ?? findLastFallbackRef(api)),
  }])

  api.lifecycle?.onDispose(() => {
    unsubscribeEvent()
    unregisterCommand?.()
    for (const decoration of activeDecorations.values()) {
      try {
        decoration.dispose?.()
      } catch {
        continue
      }
    }
    activeDecorations.clear()
    store?.close()
  })
}

export default { id: "oh-my-opencode-maid", tui }
