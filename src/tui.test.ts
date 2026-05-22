import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DISPLAY_ONLY_FALLBACK } from "./fallback"
import { createResponseStore } from "./responses"
import tuiModule from "./tui"

type EventHandler = (event: unknown) => void

type TextPartDecoration = {
  type: "collapsed-thought"
  label: string
  content: string
  style: "dark"
  collapsed: true
}

type DecoratingUi = FakeApi["ui"] & {
  decorateTextPart(messageID: string, partID: string, decoration: TextPartDecoration): void | (() => void)
}

type FakeApi = Parameters<typeof tuiModule.tui>[0]

type FakeRuntime = {
  api: FakeApi
  dialogs: string[]
  sizes: string[]
  handlers: Record<string, EventHandler>
  dispose?: () => void | Promise<void>
  parts: Record<string, unknown[]>
}

type FakeBufferCall = {
  method: "drawText" | "fillRect"
  args: unknown[]
}

type FakePostProcess = (buffer: FakeBuffer, deltaTime: number) => void

class FakeRenderable {
  id: string
  parent: FakeRenderable | null = null
  ctx: unknown
  screenX: number
  screenY: number
  width: number
  height: number
  selectable: boolean
  children: FakeRenderable[] = []
  renderRequests = 0
  onMouseDown?: (event?: unknown) => void
  options: Record<string, unknown>
  destroyed = false

  constructor(ctx: unknown, options: Record<string, unknown>) {
    this.ctx = ctx
    this.options = options
    this.id = typeof options.id === "string" ? options.id : crypto.randomUUID()
    this.screenX = typeof options.screenX === "number" ? options.screenX : 0
    this.screenY = typeof options.screenY === "number" ? options.screenY : 0
    this.width = typeof options.width === "number" ? options.width : 40
    this.height = typeof options.height === "number" ? options.height : 1
    this.selectable = typeof options.selectable === "boolean" ? options.selectable : false
    this.onMouseDown = typeof options.onMouseDown === "function" ? options.onMouseDown as (event?: unknown) => void : undefined
  }

  get content() {
    return this.options.content
  }

  set content(value: unknown) {
    this.options.content = value
  }

  add(obj: unknown, index?: number) {
    if (!(obj instanceof FakeRenderable)) return this.children.length
    obj.parent = this
    if (index === undefined || index < 0 || index >= this.children.length) this.children.push(obj)
    else this.children.splice(index, 0, obj)
    return this.children.indexOf(obj)
  }

  remove(id: string) {
    const index = this.children.findIndex((child) => child.id === id)
    if (index >= 0) {
      this.children[index].parent = null
      this.children.splice(index, 1)
    }
  }

  getChildren() {
    return this.children
  }

  findDescendantById(id: string): FakeRenderable | undefined {
    for (const child of this.children) {
      if (child.id === id) return child
      const descendant = child.findDescendantById(id)
      if (descendant) return descendant
    }
    return undefined
  }

  requestRender() {
    this.renderRequests += 1
  }

  getSelectedText() {
    return this.selectable && typeof this.content === "string" ? this.content : ""
  }

  destroyRecursively() {
    this.destroyed = true
    this.parent?.remove(this.id)
  }

  destroy() {
    this.destroyed = true
  }
}

class FakeTextRenderable extends FakeRenderable {
  plainText: string

  constructor(ctx: unknown, options: Record<string, unknown>) {
    super(ctx, { selectable: true, ...options })
    this.plainText = typeof options.content === "string" ? options.content : ""
  }

  override set content(value: unknown) {
    this.options.content = value
    this.plainText = typeof value === "string" ? value : ""
  }

  override get content() {
    return this.options.content
  }
}

class PendingLayoutRenderable extends FakeRenderable {
  constructor(ctx: unknown, options: Record<string, unknown>) {
    super(ctx, options)
    if (typeof options.width !== "number") this.width = 0
  }
}

class ThrowingParentConstructorRenderable extends FakeRenderable {
  constructor(ctx: unknown, options: Record<string, unknown>) {
    if (options.id !== "scroll-box-content") throw new Error("parent constructor should not create decoration rows")
    super(ctx, options)
  }
}

class FakeBuffer {
  width = 80
  height = 24
  calls: FakeBufferCall[] = []

  drawText(text: string, x: number, y: number, fg: unknown, bg?: unknown, attributes?: number) {
    const args = [text, x, y, fg, bg, attributes]
    this.calls.push({ method: "drawText", args })
  }

  fillRect(x: number, y: number, width: number, height: number, bg: unknown) {
    const args = [x, y, width, height, bg]
    this.calls.push({ method: "fillRect", args })
  }
}

function renderRow(row: FakeRenderable) {
  const buffer = new FakeBuffer()
  const renderAfter = row.options.renderAfter
  if (typeof renderAfter === "function") {
    ;(renderAfter as (buffer: FakeBuffer, deltaTime: number) => void)(buffer, 0)
  }
  return buffer
}

function resetPluginGlobals() {
  globalThis.__ohMyOpencodeMaidResponses?.close()
  delete globalThis.__ohMyOpencodeMaidResponses
}

async function isolated<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "omo-maid-tui-"))
  const xdg = process.env.XDG_STATE_HOME
  const home = process.env.HOME
  process.env.XDG_STATE_HOME = path.join(dir, "state")
  process.env.HOME = path.join(dir, "home")
  try {
    return await fn(dir)
  } finally {
    resetPluginGlobals()
    if (xdg === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = xdg
    if (home === undefined) delete process.env.HOME
    else process.env.HOME = home
    await rm(dir, { recursive: true, force: true })
  }
}

function fakeApi(directory: string): FakeRuntime {
  const dialogs: string[] = []
  const sizes: string[] = []
  const handlers: Record<string, EventHandler> = {}
  const parts: Record<string, unknown[]> = {}
  let dispose: (() => void | Promise<void>) | undefined
  const api = {
    event: {
      on(type: string, handler: EventHandler) {
        handlers[type] = handler
        return () => {
          delete handlers[type]
        }
      },
    },
    state: {
      path: { directory },
      part(messageID: string) {
        return parts[messageID] ?? []
      },
    },
    route: {
      current: { name: "session", params: { sessionID: "user-session" } },
    },
    ui: {
      DialogAlert(props: { title: string; message: string; onConfirm?: () => void }) {
        dialogs.push(props.message)
        return { title: props.title, message: props.message }
      },
      dialog: {
        replace(render: () => unknown) {
          render()
        },
        clear() {},
        setSize(size: "medium" | "large" | "xlarge") {
          sizes.push(size)
        },
      },
    },
    lifecycle: {
      onDispose(fn: () => void | Promise<void>) {
        dispose = fn
        return () => {
          dispose = undefined
        }
      },
    },
  } satisfies FakeApi
  return {
    api,
    dialogs,
    sizes,
    handlers,
    get dispose() {
      return dispose
    },
    parts,
  }
}

function fakeRenderer(root: FakeRenderable) {
  const postProcessFns: FakePostProcess[] = []
  return {
    root,
    postProcessFns,
    renderRequests: 0,
    requestRender() {
      this.renderRequests += 1
    },
    addPostProcessFn(fn: FakePostProcess) {
      postProcessFns.push(fn)
    },
    removePostProcessFn(fn: FakePostProcess) {
      const index = postProcessFns.indexOf(fn)
      if (index >= 0) postProcessFns.splice(index, 1)
    },
  }
}

function rewritePart(text = "Rewritten text") {
  return {
    id: "p",
    sessionID: "user-session",
    messageID: "m",
    type: "text",
    text,
    time: { start: 1, end: 2 },
  }
}

describe("tui fallback display", () => {
  test("does not host-decorate successful rewrites if renderer rows are unavailable", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      const decorations: { messageID: string; partID: string; decoration: TextPartDecoration }[] = []
      ;(runtime.api.ui as DecoratingUi).decorateTextPart = (messageID, partID, decoration) => {
        decorations.push({ messageID, partID, decoration })
      }

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })

      const part = {
        id: "p",
        sessionID: "user-session",
        messageID: "m",
        type: "text",
        text: "Rewritten text",
        time: { start: 1, end: 2 },
      }
      const originalPart = structuredClone(part)

      runtime.handlers["message.part.updated"]?.({
        type: "message.part.updated",
        properties: { part },
      })

      expect(decorations).toEqual([])
      expect(part).toEqual(originalPart)

      await runtime.dispose?.()
    })
  })

  test("does not host-decorate display-only successful rows", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      const decorations: { messageID: string; partID: string; decoration: TextPartDecoration }[] = []
      ;(runtime.api.ui as DecoratingUi).decorateTextPart = (messageID, partID, decoration) => {
        decorations.push({ messageID, partID, decoration })
      }

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })

      runtime.handlers["message.part.updated"]?.({
        type: "message.part.updated",
        properties: {
          part: {
            id: "p",
            sessionID: "user-session",
            messageID: "m",
            type: "text",
            text: "Rewritten text",
            time: { start: 1, end: 2 },
          },
        },
      })

      expect(decorations).toEqual([])

      await runtime.dispose?.()
    })
  })

  test("injects renderer rows for identifier-only successful rewrite updates", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      const root = new FakeRenderable({}, { id: "root" })
      const parent = new FakeRenderable({}, { id: "message-m" })
      const target = new FakeTextRenderable({}, { id: "text-p" })
      root.add(parent)
      parent.add(target)
      runtime.api.renderer = fakeRenderer(root)
      runtime.parts.m = [rewritePart()]

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({
        type: "message.part.updated",
        properties: { part: { id: "p", sessionID: "user-session", messageID: "m", type: "text", time: { start: 1, end: 2 } } },
      })

      expect(parent.children.some((child) => child.id === "oh-my-opencode-maid-original-m-p")).toBe(true)
      expect(runtime.dialogs).toEqual([])
      await runtime.dispose?.()
    })
  })

  test("safely retries when renderer rows are unavailable", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })

      expect(() => {
        runtime.handlers["message.part.updated"]?.({
          type: "message.part.updated",
          properties: {
            part: {
              id: "p",
              sessionID: "user-session",
              messageID: "m",
              type: "text",
              text: "Rewritten text",
              time: { start: 1, end: 2 },
            },
          },
        })
      }).not.toThrow()

      await runtime.dispose?.()
    })
  })

  test("injects a host-realm renderer row that toggles the sidecar original inline", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      const root = new FakeRenderable({}, { id: "root" })
      const parent = new FakeRenderable({}, { id: "message-m" })
      const target = new FakeTextRenderable({}, { id: "text-p", screenX: 4, screenY: 7, width: 48, height: 2 })
      root.add(parent)
      parent.add(target)
      const renderer = fakeRenderer(root)
      runtime.api.renderer = renderer

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part: rewritePart() } })

      const row = parent.children.find((child) => child.id === "oh-my-opencode-maid-original-m-p")
      expect(row).toBeDefined()
      expect(row?.options.content).toBe("+ Original Draft Content")
      expect(row?.options.title).toBeUndefined()
      expect(parent.children.indexOf(row!)).toBe(parent.children.indexOf(target) - 1)
      expect(renderer.postProcessFns).toHaveLength(0)

      const collapsedBuffer = renderRow(row!)
      expect(collapsedBuffer.calls.some((call) => call.args.includes("Original text"))).toBe(false)
      expect(collapsedBuffer.calls.some((call) => call.method === "drawText" && typeof call.args[0] === "string" && call.args[0].includes("+ Original Draft Content"))).toBe(true)

      row?.onMouseDown?.({ y: 1, preventDefault() {}, stopPropagation() {} })
      const expandedBuffer = renderRow(row!)
      const body = row?.children.find((child) => child.id === "oh-my-opencode-maid-original-m-p-body")
      expect(body).toBeInstanceOf(FakeTextRenderable)
      expect(body?.selectable).toBe(true)
      expect(body?.getSelectedText()).toBe("Original text")
      expect(body?.options.position).toBe("absolute")
      expect(body?.options.left).toBe(2)
      expect(body?.options.top).toBe(1)
      expect(body?.options.width).toBe(row ? Math.max(1, row.width - 4) : undefined)
      expect(body?.options.border).toBeUndefined()
      expect(body?.options.borderStyle).toBeUndefined()
      expect(body?.options.bottomTitle).toBeUndefined()
      expect(expandedBuffer.calls.some((call) => call.args.includes("Original text"))).toBe(false)
      expect(expandedBuffer.calls.some((call) => call.method === "drawText" && typeof call.args[0] === "string" && call.args[0].includes("- Original Draft Content"))).toBe(true)
      expect(row?.options.content).toBe("- Original Draft Content")
      expect(row?.options.title).toBeUndefined()
      expect(JSON.stringify(row?.options)).not.toContain("Original text")
      expect(runtime.dialogs).toEqual([])
      if (row) row.screenY = 7

      let bodyPrevented = 0
      let bodyStopped = 0
      row?.onMouseDown?.({
        y: 2,
        preventDefault() {
          bodyPrevented += 1
        },
        stopPropagation() {
          bodyStopped += 1
        },
      })
      expect(row?.options.content).toBe("- Original Draft Content")
      expect(renderRow(row!).calls.some((call) => call.args.includes("Original text"))).toBe(false)
      expect(row?.children.filter((child) => child.id === "oh-my-opencode-maid-original-m-p-body")).toHaveLength(1)
      expect(body?.getSelectedText()).toBe("Original text")
      expect(bodyPrevented).toBe(0)
      expect(bodyStopped).toBe(0)

      let targetBodyPrevented = 0
      let targetBodyStopped = 0
      row?.onMouseDown?.({
        y: 0,
        target: body,
        preventDefault() {
          targetBodyPrevented += 1
        },
        stopPropagation() {
          targetBodyStopped += 1
        },
      })
      expect(row?.options.content).toBe("- Original Draft Content")
      expect(row?.children.filter((child) => child.id === "oh-my-opencode-maid-original-m-p-body")).toHaveLength(1)
      expect(targetBodyPrevented).toBe(0)
      expect(targetBodyStopped).toBe(0)

      let screenBodyPrevented = 0
      let screenBodyStopped = 0
      row?.onMouseDown?.({
        y: 9,
        preventDefault() {
          screenBodyPrevented += 1
        },
        stopPropagation() {
          screenBodyStopped += 1
        },
      })
      expect(row?.options.content).toBe("- Original Draft Content")
      expect(row?.children.filter((child) => child.id === "oh-my-opencode-maid-original-m-p-body")).toHaveLength(1)
      expect(screenBodyPrevented).toBe(0)
      expect(screenBodyStopped).toBe(0)

      row?.onMouseDown?.({ y: 1, preventDefault() {}, stopPropagation() {} })
      const recollapsedBuffer = renderRow(row!)
      expect(recollapsedBuffer.calls.some((call) => call.args.includes("Original text"))).toBe(false)
      expect(recollapsedBuffer.calls.some((call) => call.method === "drawText" && typeof call.args[0] === "string" && call.args[0].includes("+ Original Draft Content"))).toBe(true)
      expect(row?.options.content).toBe("+ Original Draft Content")
      expect(row?.options.title).toBeUndefined()
      expect(row?.children.some((child) => child.id === "oh-my-opencode-maid-original-m-p-body")).toBe(false)
      expect(body?.destroyed).toBe(true)
      await runtime.dispose?.()
      expect(row?.destroyed).toBe(true)
      expect(parent.children.some((child) => child.id === "oh-my-opencode-maid-original-m-p")).toBe(false)
    })
  })

  test("keeps the initially collapsed renderer row compact before layout reports width", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      const root = new PendingLayoutRenderable({}, { id: "root" })
      const parent = new PendingLayoutRenderable({}, { id: "message-m" })
      const target = new FakeTextRenderable({}, { id: "text-p", width: 48 })
      root.add(parent)
      parent.add(target)
      runtime.api.renderer = fakeRenderer(root)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part: rewritePart() } })

      const row = parent.children.find((child) => child.id === "oh-my-opencode-maid-original-m-p")
      expect(row).toBeDefined()
      expect(row?.width).toBe(0)
      expect(row?.height).toBe(3)
      expect(row?.options.height).toBe(3)
      expect(row?.options.minHeight).toBe(3)
      expect(row?.options.content).toBe("+ Original Draft Content")
      expect(row?.options.title).toBeUndefined()
      expect(JSON.stringify(row?.options)).not.toContain("Original text")
      await runtime.dispose?.()
    })
  })

  test("uses renderer-tree inline rows without calling the private decoration hook", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      let decorations = 0
      ;(runtime.api.ui as DecoratingUi).decorateTextPart = () => {
        decorations += 1
      }
      const root = new FakeRenderable({}, { id: "root" })
      const parent = new FakeRenderable({}, { id: "message-m" })
      const target = new FakeTextRenderable({}, { id: "text-p" })
      root.add(parent)
      parent.add(target)
      runtime.api.renderer = fakeRenderer(root)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part: rewritePart() } })

      const row = parent.children.find((child) => child.id === "oh-my-opencode-maid-original-m-p")
      expect(row).toBeDefined()
      expect(decorations).toBe(0)
      expect(renderRow(row!).calls.some((call) => call.args.includes("Original text"))).toBe(false)
      await runtime.dispose?.()
    })
  })

  test("avoids scroll content constructors when the target is inside scroll content", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      const root = new FakeRenderable({}, { id: "root" })
      const parent = new ThrowingParentConstructorRenderable({}, { id: "scroll-box-content" })
      const target = new FakeRenderable({}, { id: "text-p" })
      const textProbe = new FakeTextRenderable({}, { id: "text-probe" })
      root.add(parent)
      parent.add(target)
      root.add(textProbe)
      runtime.api.renderer = fakeRenderer(root)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part: rewritePart() } })

      expect(parent.children.some((child) => child.id === "oh-my-opencode-maid-original-m-p")).toBe(true)
      await runtime.dispose?.()
    })
  })

  test("does not attach a post-process overlay after renderer row retries are exhausted", async () => {
    await isolated(async (dir) => {
      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      const pendingTimeouts: Array<() => void> = []
      globalThis.setTimeout = ((handler: TimerHandler) => {
        if (typeof handler === "function") pendingTimeouts.push(handler as () => void)
        return pendingTimeouts.length as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout
      globalThis.clearTimeout = (() => undefined) as typeof clearTimeout
      try {
        const store = await createResponseStore()
        store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
        store.close()
        const runtime = fakeApi(dir)
        const root = new FakeRenderable({}, { id: "root" })
        const parent = new FakeRenderable({}, { id: "message-m" })
        const target = new FakeTextRenderable({}, { id: "text-p", screenX: 3, screenY: 5, width: 50, height: 2 })
        root.add(parent)
        parent.add(target)
        const add = parent.add.bind(parent)
        parent.add = (obj: unknown, index?: number) => {
          if (obj instanceof FakeRenderable && obj.id === "oh-my-opencode-maid-original-m-p") throw new Error("cannot insert row")
          return add(obj, index)
        }
        const renderer = fakeRenderer(root)
        runtime.api.renderer = renderer

        await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
        runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part: rewritePart() } })
        while (pendingTimeouts.length > 0) pendingTimeouts.shift()?.()

        expect(parent.children.some((child) => child.id === "oh-my-opencode-maid-original-m-p")).toBe(false)
        expect(renderer.postProcessFns).toHaveLength(0)

        await runtime.dispose?.()
        expect(renderer.postProcessFns).toHaveLength(0)
      } finally {
        globalThis.setTimeout = realSetTimeout
        globalThis.clearTimeout = realClearTimeout
      }
    })
  })

  test("does not attach an overlay if renderer insertion is unverified", async () => {
    await isolated(async (dir) => {
      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      const pendingTimeouts: Array<() => void> = []
      globalThis.setTimeout = ((handler: TimerHandler) => {
        if (typeof handler === "function") pendingTimeouts.push(handler as () => void)
        return pendingTimeouts.length as unknown as ReturnType<typeof setTimeout>
      }) as typeof setTimeout
      globalThis.clearTimeout = (() => undefined) as typeof clearTimeout
      try {
        const store = await createResponseStore()
        store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
        store.close()
        const runtime = fakeApi(dir)
        const root = new FakeRenderable({}, { id: "root" })
        const parent = new FakeRenderable({}, { id: "message-m" })
        const target = new FakeTextRenderable({}, { id: "text-p", screenX: 3, screenY: 5, width: 50, height: 2 })
        root.add(parent)
        parent.add(target)
        const add = parent.add.bind(parent)
        parent.add = (obj: unknown, index?: number) => {
          if (obj instanceof FakeRenderable && obj.id === "oh-my-opencode-maid-original-m-p") return -1
          return add(obj, index)
        }
        const renderer = fakeRenderer(root)
        runtime.api.renderer = renderer

        await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
        runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part: rewritePart() } })
        while (pendingTimeouts.length > 0) pendingTimeouts.shift()?.()

        expect(parent.children.some((child) => child.id === "oh-my-opencode-maid-original-m-p")).toBe(false)
        expect(renderer.postProcessFns).toHaveLength(0)
        await runtime.dispose?.()
      } finally {
        globalThis.setTimeout = realSetTimeout
        globalThis.clearTimeout = realClearTimeout
      }
    })
  })

  test("cleans up an already attached renderer row on dispose", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      const root = new FakeRenderable({}, { id: "root" })
      const parent = new FakeRenderable({}, { id: "message-m" })
      const target = new FakeTextRenderable({}, { id: "text-p" })
      const existing = new FakeRenderable({}, { id: "oh-my-opencode-maid-original-m-p" })
      root.add(parent)
      parent.add(target)
      parent.add(existing)
      runtime.api.renderer = fakeRenderer(root)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part: rewritePart() } })
      await runtime.dispose?.()

      expect(existing.destroyed).toBe(true)
      expect(parent.children.includes(existing)).toBe(false)
    })
  })

  test("debug logging omits message text", async () => {
    await isolated(async (dir) => {
      const debugPath = path.join(dir, "tui-debug.log")
      const previousDebug = process.env.OH_MY_OPENCODE_MAID_TUI_DEBUG
      process.env.OH_MY_OPENCODE_MAID_TUI_DEBUG = debugPath
      try {
        const store = await createResponseStore()
        store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten SECRET_TOKEN", "Original SECRET_TOKEN")
        store.close()
        const runtime = fakeApi(dir)

        await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
        runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part: rewritePart("Rewritten SECRET_TOKEN") } })
        await runtime.dispose?.()

        const log = await readFile(debugPath, "utf8")
        expect(log).not.toContain("Rewritten SECRET_TOKEN")
        expect(log).not.toContain("Original SECRET_TOKEN")
      } finally {
        if (previousDebug === undefined) delete process.env.OH_MY_OPENCODE_MAID_TUI_DEBUG
        else process.env.OH_MY_OPENCODE_MAID_TUI_DEBUG = previousDebug
      }
    })
  })

  test("does not create host decoration disposers when the TUI plugin is disposed", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      let disposed = 0
      ;(runtime.api.ui as DecoratingUi).decorateTextPart = () => {
        return () => {
          disposed += 1
        }
      }

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({
        type: "message.part.updated",
        properties: {
          part: {
            id: "p",
            sessionID: "user-session",
            messageID: "m",
            type: "text",
            text: "Rewritten text",
            time: { start: 1, end: 2 },
          },
        },
      })

      await runtime.dispose?.()
      expect(disposed).toBe(0)
    })
  })

  test("does not host-decorate fallback display-only rows", async () => {
    await isolated(async (dir) => {
      const runtime = fakeApi(dir)
      let decorations = 0
      ;(runtime.api.ui as DecoratingUi).decorateTextPart = () => {
        decorations += 1
      }

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })

      runtime.handlers["message.part.updated"]?.({
        type: "message.part.updated",
        properties: {
          part: {
            id: "p",
            sessionID: "user-session",
            messageID: "m",
            type: "text",
            text: DISPLAY_ONLY_FALLBACK,
            time: { start: 1, end: 2 },
          },
        },
      })

      expect(decorations).toBe(0)
      expect(runtime.dialogs).toEqual([])

      await runtime.dispose?.()
    })
  })

  test("does not call host decorations for repeated completed updates", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      let decorations = 0
      ;(runtime.api.ui as DecoratingUi).decorateTextPart = () => {
        decorations += 1
      }

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      const event = {
        type: "message.part.updated",
        properties: {
          part: {
            id: "p",
            sessionID: "user-session",
            messageID: "m",
            type: "text",
            text: "Rewritten text",
            time: { start: 1, end: 2 },
          },
        },
      }

      runtime.handlers["message.part.updated"]?.(event)
      runtime.handlers["message.part.updated"]?.(event)

      expect(decorations).toBe(0)
      await runtime.dispose?.()
    })
  })

  test("ignores host decoration hooks even if they would fail", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
      store.close()
      const runtime = fakeApi(dir)
      let calls = 0
      ;(runtime.api.ui as DecoratingUi).decorateTextPart = () => {
        calls += 1
        if (calls === 1) throw new Error("host hook failed")
        return () => {
          throw new Error("host disposer failed")
        }
      }

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      const part = {
        id: "p",
        sessionID: "user-session",
        messageID: "m",
        type: "text",
        text: "Rewritten text",
        time: { start: 1, end: 2 },
      }

      expect(() => runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part } })).not.toThrow()
      expect(() => runtime.handlers["message.part.updated"]?.({ type: "message.part.updated", properties: { part } })).not.toThrow()
      expect(calls).toBe(0)
      await runtime.dispose?.()
    })
  })

  afterEach(resetPluginGlobals)

  test("default export is a TUI module with a stable id and without a named tui export", async () => {
    const exports = await import("./tui")

    expect(tuiModule).toHaveProperty("id", "oh-my-opencode-maid")
    expect(tuiModule).toHaveProperty("tui")
    expect("tui" in exports).toBe(false)
  })

  test("opens sidecar original for completed fallback part events", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK, "Raw SECRET_TOKEN")
      store.close()
      const runtime = fakeApi(dir)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({
        type: "message.part.updated",
        properties: {
          part: {
            id: "p",
            sessionID: "user-session",
            messageID: "m",
            type: "text",
            text: DISPLAY_ONLY_FALLBACK,
            time: { start: 1, end: 2 },
          },
        },
      })

      expect(runtime.dialogs).toEqual(["Raw SECRET_TOKEN"])
      expect(runtime.sizes).toEqual(["xlarge"])
      await runtime.dispose?.()
    })
  })

  test("no-ops when fallback original is unavailable", async () => {
    await isolated(async (dir) => {
      const runtime = fakeApi(dir)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({
        type: "message.part.updated",
        properties: {
          part: {
            id: "p",
            sessionID: "user-session",
            messageID: "m",
            type: "text",
            text: DISPLAY_ONLY_FALLBACK,
            time: { start: 1, end: 2 },
          },
        },
      })

      expect(runtime.dialogs).toEqual([])
      expect(runtime.sizes).toEqual([])
      await runtime.dispose?.()
    })
  })

  test("does not expose TUI slash commands", async () => {
    await isolated(async (dir) => {
      const runtime = fakeApi(dir)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })

      expect("command" in runtime.api).toBe(false)
      await runtime.dispose?.()
    })
  })
})
