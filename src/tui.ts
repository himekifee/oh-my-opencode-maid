import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { DISPLAY_ONLY_FALLBACK } from "./fallback"
import { createResponseStore, type ResponseKey, type ResponseStore } from "./responses"

type TuiDialog = {
  replace(render: () => unknown, onClose?: () => void): void
  clear(): void
  setSize(size: "medium" | "large" | "xlarge"): void
}

type TuiApi = {
  event: {
    on(type: string, handler: (event: unknown) => void): () => void
  }
  state: {
    path: {
      directory: string
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
  renderer?: HostRenderer
  lifecycle?: {
    onDispose(fn: () => void | Promise<void>): () => void
  }
}

type HostRenderer = {
  root?: unknown
  requestRender?(): void
  addPostProcessFn?(processFn: (buffer: HostBuffer, deltaTime: number) => void): void
  removePostProcessFn?(processFn: (buffer: HostBuffer, deltaTime: number) => void): void
}

type HostColor = {
  buffer: Uint16Array
}

type HostBuffer = {
  width: number
  height: number
  drawText?(text: string, x: number, y: number, fg: HostColor, bg?: HostColor, attributes?: number): void
  fillRect?(x: number, y: number, width: number, height: number, bg: HostColor): void
}

type HostRenderable = {
  id: string
  parent?: HostRenderable | null
  ctx?: unknown
  content?: unknown
  plainText?: unknown
  textLength?: unknown
  selectable?: boolean
  x?: number
  y?: number
  screenX?: number
  screenY?: number
  width?: number
  height?: number
  add?(obj: unknown, index?: number): number
  insertBefore?(obj: unknown, anchor?: unknown): number
  remove?(id: string): void
  destroy?(): void
  destroyRecursively?(): void
  getChildren?(): ReadonlyArray<unknown>
  findDescendantById?(id: string): unknown
  getSelectedText?(): string
  hasSelection?(): boolean
  shouldStartSelection?(x: number, y: number): boolean
  onSelectionChanged?(selection: unknown): boolean
  requestRender?(): void
}

type HostRenderableConstructor = new (ctx: unknown, options: Record<string, unknown>) => HostRenderable

type ActiveDecoration = {
  visibleText: string
  dispose?: () => void
}

type PendingRendererDecoration = {
  attempts: number
  timeout?: ReturnType<typeof setTimeout>
}

type TuiPluginMeta = {
  id: string
}

type FallbackRef = ResponseKey & {
  visibleText: string
}

const MAX_DISPLAY_CHARS = 20_000
const DEBUG_ENV = "OH_MY_OPENCODE_MAID_TUI_DEBUG"
const RENDERER_RETRY_MS = 50
const RENDERER_RETRY_LIMIT = 30
const RENDERER_TREE_LIMIT = 80
const INLINE_DRAFT_COLLAPSED = "+ Original Draft Content"
const INLINE_DRAFT_EXPANDED = "- Original Draft Content"
const OVERLAY_FG = colorFromInts(139, 148, 158)
const OVERLAY_BG = colorFromInts(13, 17, 23)

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function stringField(input: unknown, field: string) {
  if (!record(input)) return undefined
  const value = input[field]
  return typeof value === "string" ? value : undefined
}

function colorFromInts(r: number, g: number, b: number, a = 255): HostColor {
  return { buffer: new Uint16Array([r, g, b, a]) }
}

function finiteNumber(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function hostRenderable(input: unknown): input is HostRenderable {
  return record(input) && typeof input.id === "string"
}

function hostChildren(input: HostRenderable) {
  if (typeof input.getChildren !== "function") return []
  return input.getChildren().filter(hostRenderable)
}

function hostConstructor(input: HostRenderable): HostRenderableConstructor | undefined {
  const prototype = Object.getPrototypeOf(input) as { constructor?: unknown } | null
  const ctor = prototype?.constructor
  return typeof ctor === "function" ? ctor as HostRenderableConstructor : undefined
}

function hostConstructorName(input: HostRenderable) {
  const prototype = Object.getPrototypeOf(input) as { constructor?: { name?: unknown } } | null
  const name = prototype?.constructor?.name
  return typeof name === "string" ? name : undefined
}

function isTextLikeRenderable(input: HostRenderable) {
  const name = hostConstructorName(input) ?? ""
  return /(?:^|\b)(Text|TextBuffer|Code)Renderable$/.test(name)
    || typeof input.plainText === "string"
    || typeof input.textLength === "number"
}

function findHostTextConstructor(root: unknown, preferred: HostRenderable): HostRenderableConstructor | undefined {
  const preferredCtor = isTextLikeRenderable(preferred) ? hostConstructor(preferred) : undefined
  if (preferredCtor) return preferredCtor
  const found = walkRenderables(root, 500).find(isTextLikeRenderable)
  return found ? hostConstructor(found) : undefined
}

function isScrollContentRenderable(input: HostRenderable) {
  return /^scroll-box-content(?:-|$)/.test(input.id) || (hostConstructor(input)?.length ?? 0) > 2
}

function findHostBoxConstructor(parent: HostRenderable, target: HostRenderable): HostRenderableConstructor | undefined {
  const usable = (input: HostRenderable) => {
    const ctor = hostConstructor(input)
    return ctor && !isTextLikeRenderable(input) && !isScrollContentRenderable(input) && ctor.length <= 2 ? ctor : undefined
  }
  if (!isTextLikeRenderable(target)) {
    const targetCtor = usable(target)
    if (targetCtor) return targetCtor
  }
  let current: HostRenderable | undefined = parent
  while (current) {
    const ctor = usable(current)
    if (ctor) return ctor
    current = hostRenderable(current.parent) ? current.parent : undefined
  }
  return undefined
}

function walkRenderables(root: unknown, limit = RENDERER_TREE_LIMIT) {
  if (!hostRenderable(root)) return []
  const out: HostRenderable[] = []
  const queue = [root]
  const seen = new Set<HostRenderable>()
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift()
    if (!current || seen.has(current)) continue
    seen.add(current)
    out.push(current)
    queue.push(...hostChildren(current))
  }
  return out
}

function rendererTreeSummary(root: unknown) {
  return walkRenderables(root).map((item) => {
    const parent = hostRenderable(item.parent) ? item.parent : undefined
    return {
      id: item.id,
      ctor: hostConstructorName(item),
      parentID: parent?.id,
      parentCtor: parent ? hostConstructorName(parent) : undefined,
      hasAdd: typeof item.add === "function",
      hasRemove: typeof item.remove === "function",
      hasInsertBefore: typeof item.insertBefore === "function",
      childCount: hostChildren(item).length,
    }
  })
}

function findRenderableByID(root: unknown, id: string) {
  if (!hostRenderable(root)) return undefined
  const direct = typeof root.findDescendantById === "function" ? root.findDescendantById(id) : undefined
  if (hostRenderable(direct)) return direct
  return walkRenderables(root, 500).find((item) => item.id === id)
}

function findTextTarget(root: unknown, ref: FallbackRef) {
  for (const id of [`text-${ref.partID}`, ref.partID, `part-${ref.partID}`]) {
    const found = findRenderableByID(root, id)
    if (found) return found
  }
  const candidates = walkRenderables(root, 500)
  return candidates.find((item) => item.id.startsWith("text-") && item.id.includes(ref.partID))
    ?? candidates.find((item) => item.id === ref.messageID || item.id === `message-${ref.messageID}`)
}

function rendererDecorationID(ref: ResponseKey) {
  return `oh-my-opencode-maid-original-${ref.messageID}-${ref.partID}`
}

function rendererDecorationBodyID(ref: ResponseKey) {
  return `${rendererDecorationID(ref)}-body`
}

function refDebug(ref: FallbackRef) {
  return { sessionID: ref.sessionID, messageID: ref.messageID, partID: ref.partID, visibleLength: ref.visibleText.length }
}

function eventDebug(input: unknown) {
  if (!record(input)) return { type: typeof input }
  const properties = record(input.properties) ? input.properties : undefined
  const part = record(properties?.part) ? properties.part : undefined
  return {
    type: typeof input.type === "string" ? input.type : undefined,
    sessionID: stringField(part, "sessionID"),
    messageID: stringField(part, "messageID"),
    partID: stringField(part, "id") ?? stringField(part, "partID"),
    partType: typeof part?.type === "string" ? part.type : undefined,
    textLength: typeof part?.text === "string" ? part.text.length : undefined,
    completed: record(part?.time) && typeof part.time.end === "number",
  }
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

function successfulRewriteRefFromEvent(api: TuiApi, event: unknown): FallbackRef | undefined {
  if (!record(event) || event.type !== "message.part.updated") return undefined
  const properties = record(event.properties) ? event.properties : undefined
  const direct = successfulRewriteRefFromPart(api.state.path.directory, properties?.part)
  if (direct) return direct
  const part = record(properties?.part) ? properties.part : undefined
  const sessionID = stringField(part, "sessionID")
  const messageID = stringField(part, "messageID")
  const partID = stringField(part, "id") ?? stringField(part, "partID")
  if (!sessionID || !messageID || !partID) return undefined
  for (const candidate of api.state.part(messageID)) {
    const ref = successfulRewriteRefFromPart(api.state.path.directory, candidate)
    if (ref?.sessionID === sessionID && ref.messageID === messageID && ref.partID === partID) return ref
  }
  return undefined
}

function decorationKey(ref: ResponseKey) {
  return `${ref.messageID}\0${ref.partID}`
}

function currentSessionID(api: TuiApi) {
  const current = api.route.current
  return current.name === "session" ? stringField(current.params, "sessionID") : undefined
}

function currentRouteDebug(api: TuiApi) {
  return { name: api.route.current.name, sessionID: currentSessionID(api) }
}

function isCurrentSessionRef(api: TuiApi, ref: ResponseKey) {
  return ref.sessionID === currentSessionID(api)
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
  if (!store) return false
  try {
    return store.hasOriginal(ref, ref.visibleText)
  } catch {
    return false
  }
}

function displayText(original: string) {
  if (original.length <= MAX_DISPLAY_CHARS) return original
  return `${original.slice(0, MAX_DISPLAY_CHARS)}\n\n[truncated for local TUI display]`
}

function callEventMethod(event: unknown, method: string) {
  if (!record(event)) return
  const handler = event[method]
  if (typeof handler !== "function") return
  const fn = handler as (this: unknown) => void
  fn.call(event)
}

function consumeMouseEvent(event: unknown) {
  callEventMethod(event, "preventDefault")
  callEventMethod(event, "stopPropagation")
}

function mouseY(event: unknown) {
  return record(event) ? finiteNumber(event.y) : undefined
}

function isMouseEventTarget(event: unknown, target: HostRenderable | undefined) {
  if (!target || !record(event)) return false
  const eventTarget = event.target
  return eventTarget === target || hostRenderable(eventTarget) && eventTarget.id === target.id
}

function isBodyRelativeY(relativeY: number, height: number | undefined) {
  const y = Math.floor(relativeY)
  if (height === undefined) return y > 1
  return y > 1 && y < Math.floor(height - 1)
}

function isExpandedDraftBodyClick(row: HostRenderable, event: unknown, expandedText: string | undefined, body?: HostRenderable) {
  if (expandedText === undefined) return false
  if (isMouseEventTarget(event, body)) return true
  const y = mouseY(event)
  if (y === undefined) return false
  const height = finiteNumber(row.height)
  if (isBodyRelativeY(y, height)) return true
  const rowY = finiteNumber(row.screenY) ?? finiteNumber(row.y)
  return rowY === undefined ? false : isBodyRelativeY(y - Math.floor(rowY), height)
}

function inlineDraftText(expandedText: string | undefined) {
  return expandedText === undefined ? INLINE_DRAFT_COLLAPSED : INLINE_DRAFT_EXPANDED
}

function wrappedLines(input: string, width: number) {
  const maxWidth = Math.max(1, Math.floor(width))
  const out: string[] = []
  for (const line of input.split(/\r?\n/)) {
    if (!line) {
      out.push("")
      continue
    }
    for (let offset = 0; offset < line.length; offset += maxWidth) out.push(line.slice(offset, offset + maxWidth))
  }
  return out
}

function inlineDraftHeight(expandedText: string | undefined, width: number | undefined) {
  if (expandedText === undefined) return 3
  const innerWidth = Math.max(1, (width ?? 80) - 4)
  return Math.max(4, wrappedLines(expandedText, innerWidth).length + 3)
}

function updateInlineDraftRow(row: HostRenderable, expandedText: string | undefined) {
  const height = inlineDraftHeight(expandedText, finiteNumber(row.width))
  const safeOptions = {
    height,
    minHeight: height,
    content: expandedText === undefined ? INLINE_DRAFT_COLLAPSED : INLINE_DRAFT_EXPANDED,
    bottomTitle: expandedText === undefined ? "click to expand" : "click to collapse",
  }
  const rowRecord = row as HostRenderable & Record<string, unknown>
  Object.assign(rowRecord, safeOptions)
  if (record(rowRecord.options)) Object.assign(rowRecord.options, safeOptions)
  row.requestRender?.()
}

function updateInlineDraftBody(body: HostRenderable, expandedText: string, width: number | undefined) {
  const innerWidth = Math.max(1, (width ?? 80) - 4)
  const height = Math.max(1, wrappedLines(expandedText, innerWidth).length)
  const safeOptions = {
    content: expandedText,
    selectable: true,
    position: "absolute",
    left: 2,
    top: 1,
    width: innerWidth,
    height,
    minHeight: height,
    flexGrow: 0,
    flexShrink: 0,
    wrapMode: "char",
  }
  const bodyRecord = body as HostRenderable & Record<string, unknown>
  Object.assign(bodyRecord, safeOptions)
  if (record(bodyRecord.options)) Object.assign(bodyRecord.options, safeOptions)
  body.requestRender?.()
}

function drawInlineDraftRow(row: HostRenderable, buffer: HostBuffer, expandedText: string | undefined) {
  if (typeof buffer.drawText !== "function") return
  const x = finiteNumber(row.screenX) ?? finiteNumber(row.x) ?? 0
  const y = finiteNumber(row.screenY) ?? finiteNumber(row.y) ?? 0
  const width = finiteNumber(row.width) ?? 80
  const innerWidth = Math.max(1, Math.floor(width) - 4)
  const lines = wrappedLines(inlineDraftText(expandedText), innerWidth)
  for (let index = 0; index < lines.length; index += 1) {
    const drawY = Math.floor(y) + 1 + index
    if (drawY < 0 || drawY >= buffer.height) continue
    buffer.drawText(lines[index].slice(0, innerWidth), Math.floor(x) + 2, drawY, OVERLAY_FG, OVERLAY_BG)
  }
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
  const activeDecorations = new Map<string, ActiveDecoration>()
  const pendingRendererDecorations = new Map<string, PendingRendererDecoration>()

  const disposeActiveDecoration = (key: string) => {
    try {
      activeDecorations.get(key)?.dispose?.()
    } catch (error) {
      debugTui("decoration.dispose.failed", { error: error instanceof Error ? error.message : String(error) })
    }
    activeDecorations.delete(key)
  }

  const rendererRoot = () => api.renderer?.root

  const destroyRendererRow = (ref: FallbackRef, row: HostRenderable) => {
    try {
      if (typeof row.destroyRecursively === "function") row.destroyRecursively()
      else row.destroy?.()
    } catch (error) {
      debugTui("renderer.dispose.failed", { ...refDebug(ref), error: error instanceof Error ? error.message : String(error) })
    }
  }

  const disposeRendererDecoration = (ref: FallbackRef, parent: HostRenderable, row: HostRenderable) => {
    try {
      parent.remove?.(row.id)
    } catch (error) {
      debugTui("renderer.dispose.failed", { messageID: ref.messageID, partID: ref.partID, error: error instanceof Error ? error.message : String(error) })
    }
    destroyRendererRow(ref, row)
    parent.requestRender?.()
    api.renderer?.requestRender?.()
  }

  const attachRendererDecoration = (ref: FallbackRef, logFailure = true): boolean => {
    const key = decorationKey(ref)
    const active = activeDecorations.get(key)
    if (active?.visibleText === ref.visibleText) return true
    const root = rendererRoot()
    if (!root) {
      if (logFailure) debugTui("renderer.unavailable", { messageID: ref.messageID, partID: ref.partID })
      return false
    }

    const target = findTextTarget(root, ref)
    if (!target) {
      if (logFailure) debugTui("renderer.target.missing", { messageID: ref.messageID, partID: ref.partID, tree: rendererTreeSummary(root) })
      return false
    }

    const parent = hostRenderable(target.parent) ? target.parent : undefined
    if (!parent || typeof parent.add !== "function") {
      if (logFailure) debugTui("renderer.parent.missing", { messageID: ref.messageID, partID: ref.partID, targetID: target.id, targetCtor: hostConstructorName(target), tree: rendererTreeSummary(root) })
      return false
    }

    const Box = findHostBoxConstructor(parent, target)
    const Text = findHostTextConstructor(root, target)
    const ctx = parent.ctx ?? target.ctx
    if (!Box || !Text || ctx === undefined) {
      if (logFailure) debugTui("renderer.constructors.missing", { messageID: ref.messageID, partID: ref.partID, targetID: target.id, targetCtor: hostConstructorName(target), tree: rendererTreeSummary(root) })
      return false
    }

    const existing = findRenderableByID(root, rendererDecorationID(ref))
    if (existing) {
      const existingParent = hostRenderable(existing.parent) ? existing.parent : parent
      activeDecorations.set(key, {
        visibleText: ref.visibleText,
        dispose: () => disposeRendererDecoration(ref, existingParent, existing),
      })
      return true
    }

    let row: HostRenderable | undefined
    let body: HostRenderable | undefined
    let expandedText: string | undefined
    const destroyBody = () => {
      if (!body) return
      try {
        row?.remove?.(body.id)
      } catch (error) {
        debugTui("renderer.body.remove.failed", { ...refDebug(ref), error: error instanceof Error ? error.message : String(error) })
      }
      destroyRendererRow(ref, body)
      body = undefined
    }
    const syncBody = () => {
      if (!row) return
      if (expandedText === undefined) {
        destroyBody()
        return
      }
      if (!body) {
        if (typeof row.add !== "function") return
        try {
          body = new Text(ctx, {
            id: rendererDecorationBodyID(ref),
            content: expandedText,
            selectable: true,
            position: "absolute",
            left: 2,
            top: 1,
            flexGrow: 0,
            flexShrink: 0,
            fg: "#8b949e",
            bg: "#0d1117",
            wrapMode: "char",
          })
        } catch (error) {
          debugTui("renderer.body.constructor.failed", { ...refDebug(ref), error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (!body) return
        const inserted = row.add(body)
        if (body.parent !== row && !hostChildren(row).includes(body)) {
          debugTui("renderer.body.attach.unverified", { ...refDebug(ref), rowID: row.id, bodyID: body.id, inserted })
          destroyRendererRow(ref, body)
          body = undefined
          return
        }
      }
      updateInlineDraftBody(body, expandedText, finiteNumber(row.width))
    }
    const toggleExpanded = () => {
      if (!row) return
      if (expandedText === undefined) {
        const original = originalFor(store, ref)
        if (original === undefined) return
        expandedText = displayText(original)
        updateInlineDraftRow(row, expandedText)
        syncBody()
        debugTui("renderer.expanded", refDebug(ref))
      } else {
        expandedText = undefined
        destroyBody()
        updateInlineDraftRow(row, expandedText)
        debugTui("renderer.collapsed", refDebug(ref))
      }
      parent.requestRender?.()
      api.renderer?.requestRender?.()
    }
    try {
      disposeActiveDecoration(key)
      row = new Box(ctx, {
        id: rendererDecorationID(ref),
        flexDirection: "column",
        flexGrow: 0,
        flexShrink: 0,
        height: 3,
        minHeight: 3,
        marginTop: 1,
        paddingX: 1,
        border: true,
        borderStyle: "single",
        borderColor: "#30363d",
        backgroundColor: "#0d1117",
        bottomTitle: "click to expand",
        bottomTitleAlignment: "right",
        content: INLINE_DRAFT_COLLAPSED,
        focusable: true,
        renderAfter: (buffer: HostBuffer) => {
          if (!row) return
          drawInlineDraftRow(row, buffer, expandedText)
        },
        onMouseDown: (event: unknown) => {
          if (row && isExpandedDraftBodyClick(row, event, expandedText, body)) return
          consumeMouseEvent(event)
          toggleExpanded()
        },
      })
      updateInlineDraftRow(row, expandedText)
      const siblings = hostChildren(parent)
      const index = siblings.indexOf(target)
      const inserted = index >= 0 && typeof parent.insertBefore === "function"
        ? parent.insertBefore(row, target)
        : parent.add(row, index >= 0 ? index : undefined)
      if (row.parent !== parent && !hostChildren(parent).includes(row)) {
        debugTui("renderer.attach.unverified", { messageID: ref.messageID, partID: ref.partID, targetID: target.id, rowID: row.id, parentID: parent.id, inserted })
        destroyRendererRow(ref, row)
        return false
      }
      const attachedRow = row
      activeDecorations.set(key, {
        visibleText: ref.visibleText,
        dispose: () => {
          expandedText = undefined
          destroyBody()
          disposeRendererDecoration(ref, parent, attachedRow)
        },
      })
      parent.requestRender?.()
      api.renderer?.requestRender?.()
      debugTui("renderer.attached", { messageID: ref.messageID, partID: ref.partID, targetID: target.id, targetCtor: hostConstructorName(target), parentID: parent.id, parentCtor: hostConstructorName(parent), rowID: row.id })
      return true
    } catch (error) {
      if (row) destroyRendererRow(ref, row)
      debugTui("renderer.attach.failed", { messageID: ref.messageID, partID: ref.partID, targetID: target.id, targetCtor: hostConstructorName(target), parentID: parent.id, parentCtor: hostConstructorName(parent), error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  const clearRendererRetry = (key: string) => {
    const pending = pendingRendererDecorations.get(key)
    if (pending?.timeout) clearTimeout(pending.timeout)
    pendingRendererDecorations.delete(key)
  }

  const scheduleRendererRetry = (ref: FallbackRef) => {
    const key = decorationKey(ref)
    if (pendingRendererDecorations.has(key)) return
    const pending: PendingRendererDecoration = { attempts: 0 }
    const retry = () => {
      pending.attempts += 1
      const lastAttempt = pending.attempts >= RENDERER_RETRY_LIMIT
      if (attachRendererDecoration(ref, lastAttempt)) {
        pendingRendererDecorations.delete(key)
        return
      }
      if (lastAttempt) {
        pendingRendererDecorations.delete(key)
        debugTui("renderer.retry.exhausted", { messageID: ref.messageID, partID: ref.partID, attempts: pending.attempts })
        return
      }
      pending.timeout = setTimeout(retry, RENDERER_RETRY_MS)
    }
    pendingRendererDecorations.set(key, pending)
    pending.timeout = setTimeout(retry, RENDERER_RETRY_MS)
    debugTui("renderer.retry.scheduled", { messageID: ref.messageID, partID: ref.partID, attempts: RENDERER_RETRY_LIMIT })
  }

  const unsubscribeEvent = api.event.on("message.part.updated", (event) => {
    debugTui("event.message.part.updated", eventDebug(event))
    const fallbackRef = fallbackRefFromEvent(api.state.path.directory, event)
    if (fallbackRef) {
      if (hasOriginal(store, fallbackRef) && isCurrentSessionRef(api, fallbackRef)) {
        void openOriginal(api, store, fallbackRef)
      }
      return
    }

    const rewriteRef = successfulRewriteRefFromEvent(api, event)
    if (rewriteRef && store) {
      const key = decorationKey(rewriteRef)
      const active = activeDecorations.get(key)
      if (active?.visibleText === rewriteRef.visibleText) return
      if (hasOriginal(store, rewriteRef)) {
        debugTui("original.found", refDebug(rewriteRef))
        if (!attachRendererDecoration(rewriteRef)) {
          scheduleRendererRetry(rewriteRef)
          debugTui("renderer.decoration.unavailable", { messageID: rewriteRef.messageID, partID: rewriteRef.partID })
        }
      } else {
        debugTui("original.missing", refDebug(rewriteRef))
      }
    }
  })

  const debugUnsubscribers = [
    api.event.on("session.next.text.ended", (event) => debugTui("event.session.next.text.ended", { ...eventDebug(event), route: currentRouteDebug(api) })),
    api.event.on("session.next.step.ended", (event) => debugTui("event.session.next.step.ended", { ...eventDebug(event), route: currentRouteDebug(api) })),
  ]

  debugTui("tui.init", {
    directory: api.state.path.directory,
    route: currentRouteDebug(api),
    hasRenderer: Boolean(rendererRoot()),
  })

  api.lifecycle?.onDispose(() => {
    unsubscribeEvent()
    for (const unsubscribe of debugUnsubscribers) unsubscribe()
    for (const key of pendingRendererDecorations.keys()) clearRendererRetry(key)
    for (const decoration of activeDecorations.values()) {
      try {
        decoration.dispose?.()
      } catch (error) {
        debugTui("decoration.dispose.failed", { error: error instanceof Error ? error.message : String(error) })
        continue
      }
    }
    activeDecorations.clear()
    store?.close()
  })
}

export default { id: "oh-my-opencode-maid", tui }
