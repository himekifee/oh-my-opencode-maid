import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DISPLAY_ONLY_FALLBACK } from "./fallback"
import { createResponseStore } from "./responses"
import tuiModule from "./tui"

type EventHandler = (event: unknown) => void

type Command = {
  title: string
  value: string
  description?: string
  category?: string
  slash?: {
    name: string
    aliases?: string[]
  }
  onSelect?: () => void | Promise<void>
}

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
  commands: Command[]
  dispose?: () => void | Promise<void>
  messages: unknown[]
  parts: Record<string, unknown[]>
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
  const commands: Command[] = []
  const messages: unknown[] = []
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
      session: {
        messages() {
          return messages
        },
      },
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
    command: {
      register(cb: () => Command[]) {
        commands.splice(0, commands.length, ...cb())
        return () => commands.splice(0, commands.length)
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
    commands,
    get dispose() {
      return dispose
    },
    messages,
    parts,
  }
}

describe("tui fallback display", () => {
  test("shows inline original decoration for successful rewrites if hook is available", async () => {
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

      expect(decorations.length).toBe(1)
      expect(decorations[0]).toEqual({
        messageID: "m",
        partID: "p",
        decoration: {
          type: "collapsed-thought",
          label: "Original",
          content: "Original text",
          style: "dark",
          collapsed: true,
        },
      })
      expect(part).toEqual(originalPart)

      await runtime.dispose?.()
    })
  })

  test("shows inline original decoration for display-only successful rows", async () => {
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

      expect(decorations.length).toBe(1)
      expect(decorations[0].decoration.content).toBe("Original text")

      await runtime.dispose?.()
    })
  })

  test("safely no-ops if host decoration hook is missing", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Original text")
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

  test("disposes inline decorations when the TUI plugin is disposed", async () => {
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
      expect(disposed).toBe(1)
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

  test("does not duplicate inline decorations for repeated completed updates", async () => {
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

      expect(decorations).toBe(1)
      await runtime.dispose?.()
    })
  })

  test("isolates host decoration hook and disposer failures", async () => {
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

  test("slash command reopens latest fallback from TUI state", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, DISPLAY_ONLY_FALLBACK, "Command raw SECRET_TOKEN")
      store.close()
      const runtime = fakeApi(dir)
      runtime.messages.push({ id: "m", role: "assistant" })
      runtime.parts.m = [{ id: "p", sessionID: "user-session", messageID: "m", type: "text", text: DISPLAY_ONLY_FALLBACK, time: { start: 1, end: 2 } }]

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      await runtime.commands.find((command) => command.slash?.name === "maid-original")?.onSelect?.()

      expect(runtime.commands.find((command) => command.slash?.name === "maid-original")?.slash?.name).toBe("maid-original")
      expect(runtime.dialogs).toEqual(["Command raw SECRET_TOKEN"])
      await runtime.dispose?.()
    })
  })

  test("slash command reopens latest successful rewrite original from TUI state", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "p" }, "Rewritten text", "Successful original SECRET_TOKEN")
      store.close()
      const runtime = fakeApi(dir)
      runtime.messages.push({ id: "m", role: "assistant" })
      runtime.parts.m = [{ id: "p", sessionID: "user-session", messageID: "m", type: "text", text: "Rewritten text", time: { start: 1, end: 2 } }]

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      await runtime.commands.find((command) => command.slash?.name === "maid-original")?.onSelect?.()

      expect(runtime.dialogs).toEqual(["Successful original SECRET_TOKEN"])
      await runtime.dispose?.()
    })
  })

  test("slash command skips completed text parts without sidecar originals", async () => {
    await isolated(async (dir) => {
      const store = await createResponseStore()
      store.putDisplayOriginal({ directory: dir, sessionID: "user-session", messageID: "m", partID: "stored" }, "Rewritten text", "Stored original SECRET_TOKEN")
      store.close()
      const runtime = fakeApi(dir)
      runtime.messages.push({ id: "m", role: "assistant" })
      runtime.parts.m = [
        { id: "stored", sessionID: "user-session", messageID: "m", type: "text", text: "Rewritten text", time: { start: 1, end: 2 } },
        { id: "plain", sessionID: "user-session", messageID: "m", type: "text", text: "Plain text without sidecar", time: { start: 3, end: 4 } },
      ]

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })
      runtime.handlers["message.part.updated"]?.({
        type: "message.part.updated",
        properties: { part: runtime.parts.m[1] },
      })
      await runtime.commands.find((command) => command.slash?.name === "maid-original")?.onSelect?.()

      expect(runtime.dialogs).toEqual(["Stored original SECRET_TOKEN"])
      await runtime.dispose?.()
    })
  })

  test("does not register the server-owned rewrite toggle command", async () => {
    await isolated(async (dir) => {
      const runtime = fakeApi(dir)

      await tuiModule.tui(runtime.api, undefined, { id: "maid-tui" })

      expect(runtime.commands.map((command) => command.slash?.name)).toEqual(["maid-original"])
      await runtime.dispose?.()
    })
  })
})
