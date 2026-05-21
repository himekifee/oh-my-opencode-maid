// End-to-end test: runs the *real* opencode binary with the *built* plugin,
// pointed at a fake OpenAI-compatible provider, and proves the plugin actually
// routes the assistant reply through the hidden rewrite agent.
//
//   bun run scripts/e2e/run.ts
//
// Exits 0 on success, 1 on failure. Used unchanged by CI.

import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  COMPACTION_MODEL,
  COMPACTION_SUMMARY,
  COMPACTION_TRIGGER_TASK,
  MAIN_MODEL,
  PROVIDER_ID,
  RAW_DRAFT,
  REWRITE_MODEL,
  REWRITE_VARIANT,
  REWRITTEN_TEXT,
  ROLEPLAY_SENTINEL,
  SECOND_RAW_DRAFT,
  SECOND_USER_TASK,
  SMALL_CONTEXT_MODEL,
  USER_TASK,
  VARIANT_WIRE_SENTINEL,
} from "./constants"
import { startFakeProvider } from "./server"

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..")
const OPENCODE_BIN = process.env.E2E_OPENCODE ?? "opencode"
const RUN_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180_000)

type Check = { name: string; ok: boolean; detail?: string }
const checks: Check[] = []
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail })
}

function sh(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // stdin must be a closed/EOF stream: `opencode run` reads stdin for piped
    // input when stdout is not a TTY, and an open unwritten pipe blocks forever.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, opts.timeoutMs)
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: stderr + `\n[spawn error] ${String(err)}`, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

// The root user session is logged (with --print-logs) as a `service=session`
// line that has no parentID and the auto-generated "New session" title; the
// hidden rewrite turn is a child session (parentID + "Roleplay rewrite").
function rootSessionID(stderr: string): string | undefined {
  for (const line of stderr.split("\n")) {
    if (!line.includes("service=session ") || !line.includes("title=New session")) continue
    if (line.includes("parentID=")) continue
    const m = line.match(/service=session id=(ses_[A-Za-z0-9]+)/)
    if (m) return m[1]
  }
  return undefined
}

// Pull the visible assistant text opencode actually persisted. `--pure` skips
// runtime plugin side effects while preserving the transcript exactly as the user saw it.
function assistantText(exportJson: string): string {
  const data = JSON.parse(exportJson) as {
    messages?: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: unknown }> }>
  }
  const out: string[] = []
  for (const msg of data.messages ?? []) {
    if (msg.info?.role !== "assistant") continue
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string") out.push(part.text)
    }
  }
  return out.join("\n")
}

async function main() {
  // 1. Build the plugin exactly as it ships.
  process.stdout.write("· building plugin (bun run build)\n")
  const build = await sh("bun", ["run", "build"], { cwd: repoRoot, env: process.env, timeoutMs: 120_000 })
  if (build.code !== 0) {
    console.error(build.stdout, build.stderr)
    throw new Error("plugin build failed")
  }
  const pluginEntry = path.join(repoRoot, "dist", "index.js")

  // 2. Hermetic environment — never touch the developer's real opencode state.
  const root = await mkdtemp(path.join(tmpdir(), "omo-e2e-"))
  const HOME = path.join(root, "home")
  const XDG_CONFIG_HOME = path.join(root, "config")
  const XDG_DATA_HOME = path.join(root, "data")
  const XDG_CACHE_HOME = path.join(root, "cache")
  const XDG_STATE_HOME = path.join(root, "state")
  const project = path.join(root, "project")
  for (const d of [HOME, path.join(XDG_CONFIG_HOME, "opencode"), XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME, project]) {
    await mkdir(d, { recursive: true })
  }

  const fake = startFakeProvider()
  process.stdout.write(`· fake provider listening on ${fake.url}\n`)

  try {
    // 3. Plugin config (read from $XDG_CONFIG_HOME/opencode by src/config.ts):
    //    route the rewrite through a model + variant distinct from the main one.
    await writeFile(
      path.join(XDG_CONFIG_HOME, "opencode", "oh-my-opencode-maid.jsonc"),
      JSON.stringify(
        {
          enabled: true,
          model: `${PROVIDER_ID}/${REWRITE_MODEL}`,
          variant: REWRITE_VARIANT,
          rewrite_context_size: 3,
          roleplay_prompt: `${ROLEPLAY_SENTINEL} Rewrite the assistant reply faithfully; keep every token, path and number.`,
        },
        null,
        2,
      ),
    )

    // 4. opencode project config: fake provider + the built plugin by file path.
    await writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          autoupdate: false,
          share: "disabled",
          small_model: `${PROVIDER_ID}/${COMPACTION_MODEL}`,
          compaction: { auto: true, prune: false, tail_turns: 0, preserve_recent_tokens: 0, reserved: 64 },
          agent: { compaction: { model: `${PROVIDER_ID}/${COMPACTION_MODEL}` } },
          plugin: [`file://${pluginEntry}`],
          provider: {
            [PROVIDER_ID]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Fake E2E Provider",
              options: { baseURL: `${fake.url}/v1`, apiKey: "e2e-not-a-real-key" },
              models: {
                [MAIN_MODEL]: { name: "Main", tool_call: false, reasoning: false },
                [SMALL_CONTEXT_MODEL]: {
                  name: "Small Context",
                  tool_call: false,
                  reasoning: false,
                  limit: { context: 1_200, output: 100 },
                },
                [COMPACTION_MODEL]: { name: "Compaction", tool_call: false, reasoning: false },
                [REWRITE_MODEL]: {
                  name: "Rewrite",
                  tool_call: false,
                  reasoning: false,
                  // opencode merges the chosen variant's record into
                  // providerOptions; @ai-sdk/openai-compatible serializes
                  // reasoningEffort as the `reasoning_effort` body field, so the
                  // rewrite request can be proven to carry the configured variant.
                  variants: { [REWRITE_VARIANT]: { reasoningEffort: VARIANT_WIRE_SENTINEL } },
                },
              },
            },
          },
        },
        null,
        2,
      ),
    )

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME,
      XDG_CONFIG_HOME,
      XDG_DATA_HOME,
      XDG_CACHE_HOME,
      XDG_STATE_HOME,
      // opencode resolves its working directory from PWD/cwd, not just the
      // spawn cwd — without this it runs the turn in the real repo (whose
      // config has no `fake` provider) and fails with ProviderModelNotFound.
      PWD: project,
      CI: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_TELEMETRY: "1",
    }

    // 5. Drive a real opencode turn through the main model.
    process.stdout.write("· running opencode\n")
    const run = await sh(
      OPENCODE_BIN,
      ["run", "--dir", project, "--model", `${PROVIDER_ID}/${MAIN_MODEL}`, "--print-logs", USER_TASK],
      { cwd: project, env, timeoutMs: RUN_TIMEOUT_MS },
    )

    const sessionID = rootSessionID(run.stderr)
    let contextRun: Awaited<ReturnType<typeof sh>> | undefined
    let compactRun: Awaited<ReturnType<typeof sh>> | undefined
    if (sessionID) {
      process.stdout.write("· running opencode context continuation\n")
      contextRun = await sh(
        OPENCODE_BIN,
        ["run", "--dir", project, "--session", sessionID, "--model", `${PROVIDER_ID}/${MAIN_MODEL}`, "--print-logs", SECOND_USER_TASK],
        { cwd: project, env, timeoutMs: RUN_TIMEOUT_MS },
      )

      process.stdout.write("· running opencode compaction trigger\n")
      compactRun = await sh(
        OPENCODE_BIN,
        ["run", "--dir", project, "--session", sessionID, "--model", `${PROVIDER_ID}/${SMALL_CONTEXT_MODEL}`, "--print-logs", COMPACTION_TRIGGER_TASK],
        { cwd: project, env, timeoutMs: RUN_TIMEOUT_MS },
      )
    }

    // 6. Read back the visible assistant text opencode persisted.
    let exported = ""
    if (sessionID) {
      const exp = await sh(OPENCODE_BIN, ["export", sessionID, "--pure"], { cwd: project, env, timeoutMs: 60_000 })
      if (exp.code === 0) exported = exp.stdout
    }
    let visible = ""
    try {
      visible = exported ? assistantText(exported) : ""
    } catch {
      visible = ""
    }

    if (process.env.E2E_DEBUG) {
      process.stdout.write(`\n----- opencode stderr -----\n${run.stderr}\n`)
      if (contextRun) process.stdout.write(`----- context continuation stderr -----\n${contextRun.stderr}\n`)
      if (compactRun) process.stdout.write(`----- compaction trigger stderr -----\n${compactRun.stderr}\n`)
      process.stdout.write(`----- session ${sessionID ?? "(none)"} visible assistant text -----\n${visible}\n`)
      process.stdout.write(`----- fake requests -----\n${JSON.stringify(fake.requests, null, 2)}\n`)
    }

    // 7. Assertions.
    check("opencode exited cleanly", run.code === 0 && !run.timedOut, `code=${run.code} timedOut=${run.timedOut}`)
    check("a root session was created", Boolean(sessionID), "no root session id in opencode logs")
    check(
      "context continuation exited cleanly",
      contextRun !== undefined && contextRun.code === 0 && !contextRun.timedOut,
      `code=${contextRun?.code} timedOut=${contextRun?.timedOut}`,
    )
    check(
      "compaction trigger exited cleanly",
      compactRun !== undefined && compactRun.code === 0 && !compactRun.timedOut,
      `code=${compactRun?.code} timedOut=${compactRun?.timedOut}`,
    )

    const mainReqs = fake.mainRequests()
    const smallReqs = fake.smallMainRequests()
    const compactionReqs = fake.compactionRequests()
    const rewriteReqs = fake.rewriteRequests()
    check("fake provider got both main agent turns", mainReqs.length >= 2, `main requests=${mainReqs.length}`)
    check("fake provider got the small-context continuation", smallReqs.length >= 1, `small-context requests=${smallReqs.length}`)
    check("fake provider got the compaction turn", compactionReqs.length >= 1, `compaction requests=${compactionReqs.length}`)
    check("fake provider got repeated hidden rewrite turns", rewriteReqs.length >= 2, `rewrite requests=${rewriteReqs.length}`)

    if (mainReqs.length) {
      check(
        `main turn used ${MAIN_MODEL}`,
        mainReqs.every((r) => r.model === MAIN_MODEL),
        `main models=${[...new Set(mainReqs.map((r) => r.model))].join(",")}`,
      )
    }
    if (smallReqs.length) {
      check(
        `small-context turn used ${SMALL_CONTEXT_MODEL}`,
        smallReqs.every((r) => r.model === SMALL_CONTEXT_MODEL),
        `small-context models=${[...new Set(smallReqs.map((r) => r.model))].join(",")}`,
      )
      check(
        "small-context continuation received the compaction summary",
        smallReqs.some((r) => r.hasCompactionSummary),
        `${COMPACTION_SUMMARY} was absent from the small-context continuation`,
      )
    }
    if (compactionReqs.length) {
      check(
        `compaction turn used ${COMPACTION_MODEL}`,
        compactionReqs.every((r) => r.model === COMPACTION_MODEL),
        `compaction models=${[...new Set(compactionReqs.map((r) => r.model))].join(",")}`,
      )
    }
    if (rewriteReqs.length) {
      check(
        `rewrite turn used the configured model ${REWRITE_MODEL}`,
        rewriteReqs.every((r) => r.model === REWRITE_MODEL),
        `rewrite models=${[...new Set(rewriteReqs.map((r) => r.model))].join(",")}`,
      )
      check(
        "rewrite turn carried the configured roleplay prompt",
        rewriteReqs.every((r) => r.hasRoleplaySentinel),
        "ROLEPLAY_SENTINEL absent from a rewrite request",
      )
      check(
        `rewrite turn carried the configured variant "${REWRITE_VARIANT}" on the wire`,
        rewriteReqs.every((r) => r.hasVariantSentinel),
        "VARIANT_WIRE_SENTINEL absent from a rewrite request body",
      )
      const secondRewrite = rewriteReqs[1]
      check("fake provider got the context rewrite turn", Boolean(secondRewrite), `rewrite requests=${rewriteReqs.length}`)
      check(
        "context rewrite received previous rewritten text without previous raw text",
        Boolean(secondRewrite
          && secondRewrite.rawBody.includes("Previous context, reference only")
          && secondRewrite.rawBody.includes(REWRITTEN_TEXT)
          && !secondRewrite.rawBody.includes(RAW_DRAFT)),
        "second rewrite body did not include rewritten-only prior context",
      )
      check(
        "context rewrite received the current continuation prompt",
        Boolean(secondRewrite
          && secondRewrite.rawBody.includes("Current user prompt")
          && secondRewrite.rawBody.includes(SECOND_USER_TASK)
          && secondRewrite.rawBody.includes(SECOND_RAW_DRAFT)),
        "second rewrite body did not include current user prompt",
      )
      check(
        "compaction summary was not sent to hidden rewrite",
        rewriteReqs.every((r) => !r.hasCompactionSummary),
        `${COMPACTION_SUMMARY} appeared in a rewrite request body`,
      )
    }

    check(
      "user-visible reply is the rewritten text",
      visible.includes(REWRITTEN_TEXT),
      `visible assistant text=${JSON.stringify(visible).slice(0, 200)}`,
    )
    check(
      "raw draft never became the visible reply",
      visible.length > 0 && !visible.includes(RAW_DRAFT) && !visible.includes(SECOND_RAW_DRAFT),
      "RAW_DRAFT leaked into the visible reply (rewrite did not take over)",
    )

    const ok = checks.every((c) => c.ok)
    process.stdout.write("\n")
    for (const c of checks) {
      process.stdout.write(`${c.ok ? "  ✓" : "  ✗"} ${c.name}${c.ok ? "" : `  — ${c.detail ?? ""}`}\n`)
    }
    process.stdout.write(`\n${ok ? "E2E PASSED" : "E2E FAILED"}\n`)
    if (!ok && !process.env.E2E_DEBUG) {
      process.stdout.write("\n(hint: re-run with E2E_DEBUG=1 for opencode logs + recorded provider requests)\n")
    }
    return ok
  } finally {
    await fake.stop()
    if (!process.env.E2E_KEEP) await rm(root, { recursive: true, force: true })
    else process.stdout.write(`· kept temp root: ${root}\n`)
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
