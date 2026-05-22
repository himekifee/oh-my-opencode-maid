<div align="center">

# 🩷 oh-my-opencode-maid

**An OpenCode plugin that quietly rewrites every assistant reply in a roleplay voice — no fork, no proxy, no separate API client.**

[![npm](https://img.shields.io/npm/v/oh-my-opencode-maid?logo=npm&logoColor=white)](https://www.npmjs.com/package/oh-my-opencode-maid)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-plugin-cb3837?logo=opencode&logoColor=white)](https://opencode.ai)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![zod](https://img.shields.io/badge/validated%20with-zod-3e67b1)](https://zod.dev)
![version](https://img.shields.io/badge/version-0.1.0-blueviolet)

**English** · [简体中文](./README.zh-CN.md)

</div>

---

> 🎀 **The default persona is an homage to [Yuzuki](https://en.wikipedia.org/wiki/List_of_Chobits_characters#Yuzuki) from CLAMP's _Chobits_** — a calm, devoted persocom maid who always addresses you as *master*. Out of the box, every reply comes back gentle, courteous, and precise.

## ✨ What it does

Once enabled, the plugin sits invisibly between the model and your terminal. The model's raw draft never reaches your eyes — it is rewritten through OpenCode itself, in the voice you configure.

```text
You ▸ fix the failing test in src/foo.ts

  ┌─ raw assistant draft (suppressed, never displayed) ─────────────┐
  │ The bug is on line 42 — you're using == instead of ===.         │
  │ Change it and the test passes.                                  │
  └─────────────────────────────────────────────────────────────────┘

Yuzuki ▸ Of course, master. The trouble is on line 42 of src/foo.ts:
         the comparison uses `==` where it should use `===`. Once
         that is corrected, the test passes cleanly. Shall I see to
         anything else?
```

Facts, code, commands, paths, URLs, numbers, and markdown structure are preserved verbatim — only the *voice* changes.

## 🧩 How it works

| Stage | What happens |
|---|---|
| **Intercept** | Monkey patches around provider fetches, public event streams, global events, RPC messages, and plugin events suppress reachable raw text deltas. |
| **Rewrite** | A hidden, tool-less `roleplay_rewrite` agent is prompted in a temporary OpenCode session and produces the visible final text. |
| **Persist** | Successful rewrites store the stripped original in a private SQLite sidecar for display-only recovery; future model calls and compaction never receive the raw original. |
| **Fail closed** | If a rewrite fails, the stripped original is shown only after display-only bookkeeping is persisted; otherwise the plugin emits neutral fallback text instead of leaking an untracked draft. |

No OpenCode fork or source patch is required, but "plugin" undersells the mechanism: enabling it installs **process-wide monkey patches** and uses one private SDK field. Read the caveats below before adopting it.

## ⚠️ Caveats & how invasive this is

This plugin is deliberately invasive. With `enabled: true` it patches, for the lifetime of the OpenCode process:

- **`globalThis.fetch`** — to intercept provider responses and rewrite assistant text.
- **`globalThis.Response`** — to gate server-sent-event bodies.
- **`EventEmitter.prototype.emit`** — *process-wide*. Every `emit("event", …)` in the runtime (OpenCode core and any other plugin) passes through a filter that strips reachable raw-text deltas. This is the broadest patch and the one most likely to interact with other plugins or shift behavior across an OpenCode upgrade.
- **`globalThis.postMessage`** (when present) — to scrub raw deltas from RPC messages.

It also reads a **private SDK field** (`client._client`) as a fallback when the public client shape isn't found, in order to reach `session.create` / `session.prompt` / `session.delete`. That is internal surface and may break on an OpenCode upgrade; if it does, the plugin fails closed with neutral fallback text rather than exposing an untracked draft.

Patches are reference-counted per project directory and torn down when the last instance unloads or is set to `enabled: false`. Originals are stored unencrypted in a `0600` SQLite file under a `0700` directory (see [Persistence & compaction](#-persistence--compaction)). If any of this is unacceptable in your environment, set `"enabled": false` — every patch is then skipped or removed.

## 🚀 Install

> **Requirements:** Bun-only. The plugin uses `bun:sqlite` and Bun file APIs and will not run under plain Node.js. OpenCode already runs plugins under Bun, so a normal install needs nothing extra.

Just write the config — OpenCode downloads the published package from npm automatically. Register the **server** plugin in `.opencode/opencode.jsonc` (or your global `opencode.jsonc`):

```jsonc
{
  "plugin": ["oh-my-opencode-maid"]
}
```

Pin a specific version if you prefer reproducible installs:

```jsonc
{
  "plugin": ["oh-my-opencode-maid@0.1.0"]
}
```

The package also ships a separate **TUI** entry exported as `oh-my-opencode-maid/tui`. Enable it through OpenCode's TUI plugin manager — **do not** add the TUI entry to `opencode.jsonc`; that config loads the server runtime, and the TUI entry is intentionally not a server hook.

<details>
<summary>Install from source (development)</summary>

```bash
bun install
bun run build
```

```jsonc
{
  "plugin": ["file:///absolute/path/to/oh-my-opencode-maid/dist/index.js"]
}
```

</details>

## ⚙️ Configure

On startup the plugin seeds a global user config at
`$XDG_CONFIG_HOME/opencode/oh-my-opencode-maid.jsonc` (only if missing — existing files are never overwritten). Maid settings are read **only** from this global file.

```jsonc
{
  "enabled": true,
  "model": "main-agent-model",
  // "variant": "optional-provider-variant-for-concrete-models",
  "rewrite_context_size": 1,
  "roleplay_prompt": "Rewrite the assistant reply in English as Yuzuki, a cheerful and attentive maid assistant: gentle, courteous, precise, logically organized, quietly warm, and modest about limitations. Always call me master. Preserve facts, code, commands, paths, URLs, identifiers, numbers, markdown structure, and the user's requested meaning."
}
```

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch. When on, all interception monkey patches are installed. |
| `model` | `main-agent-model` | Sentinel: each hidden rewrite uses the same provider/model/variant as the active main session. Falls back to `openai/gpt-5.5` if no main model has been captured yet. May also be a concrete `provider/model`. |
| `variant` | — | Passed to the hidden rewrite agent **only for concrete models**. With `main-agent-model`, the captured main-session variant is used instead. |
| `rewrite_context_size` | `1` | Number of rewrite turns included in each hidden rewrite prompt, from `1` to `20`. `1` sends only the current rewrite target; higher values add the current user prompt plus previous successful rewrites from the same root session as reference-only context. |
| `roleplay_prompt` | *Yuzuki maid persona* | Followed exactly by the rewrite agent. This is where the magic lives. |

There are no separate endpoint, secret, deadline, canned-response, or invasive toggle settings.

The server plugin registers `/maid-rewrite-toggle` for slash-command discoverability. OpenCode does not currently expose a server-plugin "handled command" API, so the plugin handles this command in `command.execute.before`: it flips the persisted global `enabled` config, applies the new state immediately in the current server process, shows a status toast, then aborts the command before OpenCode can call the LLM. This prevents an assistant command-result turn; depending on OpenCode's TUI behavior, a short handled-error notification or an empty session shell may still appear.

## 🎭 The default persona — Yuzuki

The shipped `roleplay_prompt` turns the assistant into **Yuzuki**: cheerful, attentive, courteous, logically organized, quietly warm, modest about limitations — and she **always calls you `master`**, a nod to the devoted persocom maid from *Chobits*.

Want a different voice? Replace `roleplay_prompt` with anything — a terse senior engineer, a pirate, a haiku poet. The plugin only guarantees one thing: it follows your prompt *exactly* and never invents a persona, honorific, or nickname that isn't in your prompt or the original draft.

## 🗂️ Handoff notes

For normal sessions the system prompt encourages the main agent to append a fenced `handoff_note_json` block with `audience`, `tone_goal`, `must_preserve`, `reply_constraints`, and `exact_reply_mode`. The rewrite pass uses it when present but never depends on it — ordinary completed text is rewritten regardless. `exact_reply_mode` is preserved as metadata and does **not** bypass rewriting.

## 🖥️ Optional TUI entry

With `dist/tui.js` active:

- Rewrite failures resolve the stripped original from the sidecar store and show it in a **local** TUI dialog only.
- Registers `/maid-original` to reopen the latest sidecar original for the current session.
- Successful rewrite originals stay in the sidecar as display-only data. When the host renderer tree is available, the TUI injects a host-realm OpenTUI row before the visible reply that starts as a local collapsed `+ Original Draft Content` block.
- Clicking that renderer row fetches the original from the sidecar and expands it inline; clicking again collapses it and clears the raw text from the render-local row state. If renderer injection is unavailable or fails, no substitute decoration or overlay is shown; `/maid-original` remains the local recovery command.
- The TUI decoration is render-local: it does not mutate messages, synthesize reasoning parts, or expose those originals to exported conversation context.

## 🧠 Persistence & compaction

Successfully rewritten originals are stored as display-only rows in a private SQLite database at
`$XDG_STATE_HOME/opencode/oh-my-opencode-maid/responses.sqlite`
(or `$HOME/.local/state/opencode/oh-my-opencode-maid/responses.sqlite`).
They are sidecar data for local display/recovery paths only. `experimental.chat.messages.transform` leaves the visible rewritten transcript intact, and compaction does not append raw originals into `output.context`. Rewrite-failure originals use the same display-only boundary and are also **not** restored into future model context or compaction.

## 🤝 OMO compatibility

oh-my-openagent integrations keep working: normal public hooks, session history, compaction, subagent sessions, and tool surfaces are untouched. Hidden rewrite sessions, visible child sessions (including subagents detected via `Session.parentID`), and active rewrites are guarded so rewrites never recurse or contaminate subagent transcripts.

## 🔨 Build & QA

```bash
bun install
bun test
bun run typecheck
bun run build
```

Runtime QA should run inside tmux with OpenCode registered to the built `dist/index.js`: start a normal prompt, check whether the raw draft flashes, confirm the final reply follows `roleplay_prompt`, and exercise `/maid-rewrite-toggle` to confirm rewrites disable and re-enable immediately while persisting `enabled`, showing the matching status toast, and not calling the model for a command-result assistant turn. Exercise one rewrite-failure path to confirm the stripped original appears only after display-only sidecar persistence. Verify persistence-failure paths fail closed with neutral fallback text or `FAILURE` rather than exposing an untracked original. With `dist/tui.js` active, successful rewrites should show a local collapsed `+ Original Draft Content` renderer row when the host tree is available; it should expand inline on click, collapse on the next click, and never put raw original text into message history, logs, export, compaction, host decoration hints, or overlays. Fallback rows should open a local dialog, and `/maid-original` should reopen the sidecar original without changing session history.

## 📜 License

[MIT](./LICENSE) © 2026 Grider

---

<div align="center">
<sub>Made for OpenCode · 一份给 OpenCode 的女仆插件 · <a href="./README.zh-CN.md">简体中文文档</a></sub>
</div>
