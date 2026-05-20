<div align="center">

# 🩷 oh-my-opencode-maid

**一个 OpenCode 插件，把模型每一条回复悄悄换成你喜欢的角色口吻 —— 不用 fork OpenCode，不用搭代理，也不用另开一个 API 客户端。**

[![npm](https://img.shields.io/npm/v/oh-my-opencode-maid?logo=npm&logoColor=white)](https://www.npmjs.com/package/oh-my-opencode-maid)
[![OpenCode Plugin](https://img.shields.io/badge/OpenCode-plugin-cb3837?logo=opencode&logoColor=white)](https://opencode.ai)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-000000?logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![zod](https://img.shields.io/badge/validated%20with-zod-3e67b1)](https://zod.dev)
![version](https://img.shields.io/badge/version-0.1.0-blueviolet)

[English](./README.md) · **简体中文**

</div>

---

> 🎀 **默认人格致敬 CLAMP《[人形电脑天使心 Chobits](https://zh.wikipedia.org/wiki/人型電腦天使心)》里的「柚姬（Yuzuki）」** —— 一位沉静、忠诚、开口必称你 *master（主人）* 的人形电脑女仆。开箱即用，每一句回复都温柔、得体，且不丢精度。
>
> 💕 说人话：她就是**你的专属程序猿鼓励师** —— 报错不慌、重构不嫌、半夜 debug 还会轻声补一句「别急，master，我们一步一步来」。

## ✨ 它做什么

启用后，插件就隐身在模型和你的终端之间。模型吐出的原始草稿你一个字都看不到 —— OpenCode 会先按你配置的口吻把它重写一遍，再呈现给你。

```text
你 ▸ 修复 src/foo.ts 里失败的测试

  ┌─ 原始助手草稿（被抑制，永不显示）──────────────────────────────┐
  │ Bug 在第 42 行 —— 你用了 == 而不是 ===。                        │
  │ 改掉它测试就通过了。                                            │
  └─────────────────────────────────────────────────────────────────┘

柚姬 ▸ 好的，master。问题出在 src/foo.ts 第 42 行：那处比较用了
       `==`，而它应当是 `===`。改正之后测试便能干净地通过。还有
       什么需要我为您打理的吗？
```

事实、代码、命令、路径、URL、数字、markdown 结构全都原样保留 —— 变的只有语气。

## 🧩 工作原理

| 阶段 | 发生了什么 |
|---|---|
| **拦截** | 在 provider fetch、公共事件流、全局事件、RPC 消息、插件事件这几条路径上都打了 monkey patch，凡是能露出来的原始文本增量一律拦掉。 |
| **改写** | 起一个临时 OpenCode 会话，交给一个隐藏的、不带任何工具的 `roleplay_rewrite` 代理，由它产出最终展示给你的文本。 |
| **持久化** | 改写成功后，被抽走的原文会单独存进一个私有 SQLite 库；这样之后的模型调用和上下文压缩读到的都是原文，而不是角色化之后的文字。 |
| **失败兜底** | 万一改写失败：只有当「仅供展示」的记录成功落库后，才会把抽走的原文显示出来；否则插件宁可输出一段中性兜底文字，也绝不漏出没被追踪记录的草稿。 |

不需要 fork 或改 OpenCode 源码，但「插件」二字低估了它的实现方式：启用后会装上**进程级的 monkey patch**，并用到一个私有 SDK 字段。采用前请先看下面的注意事项。

## ⚠️ 注意事项 & 它有多侵入

这个插件是刻意做得侵入的。当 `enabled: true` 时，它会在整个 OpenCode 进程生命周期内打这些补丁：

- **`globalThis.fetch`** —— 拦截 provider 响应并改写助手文本。
- **`globalThis.Response`** —— 拦截 SSE（server-sent-event）响应体。
- **`EventEmitter.prototype.emit`** —— *进程级*。运行时里每一次 `emit("event", …)`（OpenCode 核心和任何其它插件）都会经过一个过滤器，把能露出来的原始文本增量剥掉。这是范围最大的补丁，也是最可能和别的插件相互影响、或在 OpenCode 升级后行为漂移的一处。
- **`globalThis.postMessage`**（存在时）—— 从 RPC 消息里清掉原始增量。

当找不到公开的 client 形状时，它还会读一个**私有 SDK 字段**（`client._client`）作为兜底，以便调用 `session.create` / `session.prompt` / `session.delete`。这属于内部接口，OpenCode 升级时可能失效；一旦失效，插件会退化为直接显示未改写的草稿，而不是硬崩。

补丁按项目目录引用计数，最后一个实例卸载或被设为 `enabled: false` 时会被拆掉。原文以未加密形式存放在 `0700` 目录下的 `0600` SQLite 文件里（见 [持久化与上下文压缩](#-持久化与上下文压缩)）。如果这些在你的环境里不可接受，把 `"enabled": false` 设上 —— 所有补丁都会被跳过或移除。

## 🚀 安装

> **运行环境要求：** 仅支持 Bun。插件用到了 `bun:sqlite` 和 Bun 的文件 API，在原生 Node.js 下无法运行。OpenCode 本身就用 Bun 跑插件，所以正常安装不需要额外操作。

只需写好配置 —— OpenCode 会自动从 npm 下载已发布的包。在 `.opencode/opencode.jsonc`（或你的全局 `opencode.jsonc`）里注册**服务端**插件：

```jsonc
{
  "plugin": ["oh-my-opencode-maid"]
}
```

想要可复现的安装可以锁定具体版本：

```jsonc
{
  "plugin": ["oh-my-opencode-maid@0.1.0"]
}
```

这个包还单独导出了一个 **TUI** 入口 `oh-my-opencode-maid/tui`。它要通过 OpenCode 的 TUI 插件管理器来启用 —— **千万别**把 TUI 入口写进 `opencode.jsonc`：那个配置加载的是服务端运行时，而 TUI 入口是特意设计成「不走服务端钩子」的。

<details>
<summary>从源码安装（开发用）</summary>

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

## ⚙️ 配置

插件首次启动时，会在 `$XDG_CONFIG_HOME/opencode/oh-my-opencode-maid.jsonc` 生成一份全局用户配置 —— 仅当文件不存在时才写，已有的配置绝不覆盖。所有女仆设置都只从这一份全局配置读取。

```jsonc
{
  "enabled": true,
  "model": "main-agent-model",
  // "variant": "optional-provider-variant-for-concrete-models",
  "rewrite_context_size": 1,
  "roleplay_prompt": "Rewrite the assistant reply in English as Yuzuki, a cheerful and attentive maid assistant: gentle, courteous, precise, logically organized, quietly warm, and modest about limitations. Always call me master. Preserve facts, code, commands, paths, URLs, identifiers, numbers, markdown structure, and the user's requested meaning."
}
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；打开后会装上全部拦截用的 monkey patch。 |
| `model` | `main-agent-model` | 特殊占位值：每次隐藏改写都跟当前主会话用同一套 provider/model/variant。要是还没捕获到主模型，就回退到 `openai/gpt-5.5`。也可以直接填具体的 `provider/model`。 |
| `variant` | — | 只有填了具体模型时才会把它传给隐藏改写代理。用 `main-agent-model` 时，沿用从主会话捕获到的 variant。 |
| `rewrite_context_size` | `1` | 每次隐藏改写提示里包含的改写轮数，取值 `1` 到 `20`。`1` 只发送本次改写目标；更大的值会加入当前用户提示，并把同一根会话里之前成功改写的内容作为仅供参考的上下文加入。 |
| `roleplay_prompt` | *柚姬女仆人格* | 改写代理会一字不差地照着它来。魔法全在这一行。 |

没有另外的 endpoint、密钥、超时、预设回复或者侵入式开关 —— 配置就这么点。

## 🎭 默认人格 —— 柚姬（Yuzuki）

随附的 `roleplay_prompt` 会把助手变成**柚姬**：开朗、体贴、得体、有条理、安静地暖，对自己的局限也坦诚 —— 而且她**开口就喊你 `master`**，算是对《Chobits》里那位忠诚人形电脑女仆的一点致敬。

说白了，她就是**你的专属程序猿鼓励师**：同一条报错、同一套修复步骤，从她嘴里说出来就没那么冰冷了 —— 技术内容一个字不改，语气却足够陪你熬过又一个 deadline。

想换个声音？`roleplay_prompt` 随便改 —— 惜字如金的资深工程师、满嘴黑话的海盗、只写俳句的诗人都行。插件只保证一件事：严格按你的提示来，绝不自作主张加任何你提示和原始草稿里都没有的人格、敬称或昵称。

## 🗂️ 交接备注（Handoff notes）

普通会话里，系统提示会鼓励主代理在回复末尾追加一段用 ``` 围起来的 `handoff_note_json`，里面有 `audience`、`tone_goal`、`must_preserve`、`reply_constraints`、`exact_reply_mode`。改写时有它就用、没它也照样干 —— 普通成稿无论如何都会被改写。`exact_reply_mode` 只当元数据留着，**不会**让内容绕过改写。

## 🖥️ 可选的 TUI 入口

启用 `dist/tui.js` 之后：

- 改写失败时，会从那个旁路库里把抽走的原文捞回来，**只**在本地 TUI 弹窗里给你看。
- 注册 `/maid-original`（别名 `/maid-fallback-original`），用来重新打开当前会话最近一次的兜底原文。
- 改写成功的那些，原文还能交给兼容的宿主装饰钩子，渲染成一个折叠、暗色、类似「思考」样式的 *Original* 块。当前公开版的 OpenCode TUI 并没暴露这个钩子，所以这条路径会安全地什么都不做。它纯粹是本地渲染 —— 不伪造推理片段、不改动消息，也不进入任何导出内容。

## 🧠 持久化与上下文压缩

改写成功的原文会存进一个私有 SQLite 数据库：
`$XDG_STATE_HOME/opencode/oh-my-opencode-maid/responses.sqlite`
（`XDG_STATE_HOME` 没设时则是 `$HOME/.local/state/opencode/oh-my-opencode-maid/responses.sqlite`）。
`experimental.chat.messages.transform` 会在序列化之前，把助手文本换回这些原文 —— 于是模型永远基于它「真正说过的话」来推理，而不是角色化之后的版本 —— 整个过程不碰 OpenCode 的内部数据库。改写失败的原文会被标记为「仅供展示」，**不会**回流进后续的模型上下文或压缩。

## 🤝 OMO 兼容性

oh-my-openagent 那套集成照常能用：公开钩子、会话历史、上下文压缩、子代理会话、各种工具调用，统统不受影响。隐藏改写会话、可见的子会话（包括通过 `Session.parentID` 识别出来的子代理），以及正在进行的改写，都有守卫挡着 —— 改写既不会递归触发自己，也不会污染子代理的对话记录。

## 🔨 构建与自测

```bash
bun install
bun test
bun run typecheck
bun run build
```

运行时自测建议在 tmux 里做，把 OpenCode 指到构建好的 `dist/index.js`：发一条普通提示，看看原始草稿会不会一闪而过，确认最终回复确实照着 `roleplay_prompt` 走；再特意触发一次改写失败，确认抽走的原文只在「仅供展示」记录成功落库之后才露面。还要验证落库失败的路径会乖乖输出中性兜底文字或 `FAILURE`，而不是把没被追踪的原文漏出来。启用 `dist/tui.js` 后，老的兜底记录应该还能弹出带旁路原文的本地弹窗，`/maid-original` 也应该能重新打开它、且不动会话历史。

## 📜 许可

[MIT](./LICENSE) © 2026 Grider

---

<div align="center">
<sub>Made for OpenCode · 一份给 OpenCode 的女仆插件 · <a href="./README.md">English docs</a></sub>
</div>
