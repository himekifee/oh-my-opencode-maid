import { describe, expect, test } from "bun:test"
import type { MaidConfig } from "./config"
import { HANDOFF, finalResult, finalText, handoffSystemPrompt, maidAgentPrompt, maidUserPrompt, split } from "./rewrite"

const cfg: MaidConfig = {
  enabled: true,
  model: "openai/gpt-5.5",
  roleplay_prompt: "configured voice",
}

function note(mode = "rewrite") {
  return {
    audience: "user",
    tone_goal: "configured style",
    must_preserve: ["SECRET_TOKEN"],
    reply_constraints: ["keep markdown"],
    exact_reply_mode: mode,
  }
}

function carry(text: string, mode = "rewrite") {
  return `${text}\n\n\`\`\`${HANDOFF}\n${JSON.stringify(note(mode))}\n\`\`\``
}

describe("rewrite helpers", () => {
  test("splits private handoff notes from draft text", () => {
    const parsed = split(carry("Raw answer SECRET_TOKEN"))

    expect(parsed.text).toBe("Raw answer SECRET_TOKEN")
    expect(parsed.note).toEqual(note())
  })

  test("does not let verbatim mode bypass rewriting", () => {
    const parsed = split(carry("Exact output  \n", "verbatim"))

    expect(parsed.text).toBe("Exact output  \n")
    expect(finalText(carry("Exact SECRET_TOKEN", "verbatim"), "Maid SECRET_TOKEN")).toBe("Maid SECRET_TOKEN")
  })

  test("strips any rewrite-returned handoff note before final visibility", () => {
    expect(finalText(carry("Raw SECRET_TOKEN"), carry("Maid SECRET_TOKEN"))).toBe("Maid SECRET_TOKEN")
  })

  test("treats must_preserve as advisory", () => {
    expect(finalText(carry("Raw SECRET_TOKEN"), "Maid reply")).toBe("Maid reply")
  })

  test("falls back to the original visible draft when rewritten text is empty", () => {
    expect(finalResult(carry("Raw SECRET_TOKEN"), "")).toEqual({ text: "Raw SECRET_TOKEN", rewritten: false })
  })

  test("accepts partial handoff metadata", () => {
    const parsed = split(`Raw answer\n\n\`\`\`${HANDOFF}\n${JSON.stringify({ audience: "user" })}\n\`\`\``)

    expect(parsed.note).toEqual({
      audience: "user",
      tone_goal: "",
      must_preserve: [],
      reply_constraints: [],
      exact_reply_mode: "rewrite",
    })
  })

  test("builds handoff and rewrite prompts with advisory schema and final-only constraints", () => {
    expect(handoffSystemPrompt()).toContain(HANDOFF)
    expect(handoffSystemPrompt()).toContain("audience")
    expect(handoffSystemPrompt()).toContain("exact_reply_mode")
    expect(handoffSystemPrompt()).toContain("You may append")
    expect(maidAgentPrompt(cfg)).toContain("Configured roleplay prompt:\nconfigured voice")
    expect(maidAgentPrompt(cfg)).toContain("Return only the final rewritten assistant reply")
    expect(maidAgentPrompt(cfg)).not.toContain("You are Maid")
    expect(maidUserPrompt({ cfg, text: "Draft SECRET_TOKEN", note: note() })).toContain("Draft SECRET_TOKEN")
    expect(maidUserPrompt({ cfg, text: "Draft SECRET_TOKEN", note: note() })).not.toContain("You are Maid")
  })

  test("source has no dedicated chat completions or static response assumptions", async () => {
    const src = await Promise.all(
      ["config.ts", "rewrite.ts", "index.ts", "opencode.ts"].map((file) => Bun.file(new URL(file, import.meta.url)).text()),
    ).then((items) => items.join("\n"))

    for (const stale of [
      ["chat", "completions"].join("/"),
      ["base", "url"].join("_"),
      ["api", "key", "env"].join("_"),
      ["api", "key"].join("_"),
      ["static", "reply"].join("_"),
      ["timeout", "ms"].join("_"),
      ["OH", "MY", "OPENCODE", "MAID", "STATIC", "REPLY"].join("_"),
      "Pardon me, master",
      "You are Maid",
      "warm, playful maid",
    ]) {
      expect(src).not.toContain(stale)
    }
  })
})
