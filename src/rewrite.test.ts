import { describe, expect, test } from "bun:test"
import type { MaidConfig } from "./config"
import { HANDOFF, finalResult, finalText, handoffSystemPrompt, maidAgentPrompt, maidUserPrompt, split } from "./rewrite"

const cfg: MaidConfig = {
  enabled: true,
  model: "openai/gpt-5.5",
  rewrite_context_size: 1,
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
    const systemPrompt = maidAgentPrompt(cfg)
    const userPrompt = maidUserPrompt({ cfg, text: "Draft SECRET_TOKEN", note: note() })

    expect(handoffSystemPrompt()).toContain(HANDOFF)
    expect(handoffSystemPrompt()).toContain("audience")
    expect(handoffSystemPrompt()).toContain("exact_reply_mode")
    expect(handoffSystemPrompt()).toContain("You may append")
    expect(systemPrompt).toContain("Follow the configured roleplay prompt exactly.")
    expect(systemPrompt).toContain("Do not add any persona, honorific, relationship, nickname, or address form unless it appears in the configured prompt or assistant draft.")
    expect(systemPrompt).toContain("Configured roleplay prompt:\nconfigured voice")
    expect(systemPrompt).toContain("Return only the final rewritten assistant reply")
    expect(systemPrompt).not.toContain("You are Maid")
    expect(userPrompt).toContain("Draft SECRET_TOKEN")
    expect(userPrompt).toContain(`Private handoff note: ${JSON.stringify(note())}`)
    expect(userPrompt).toContain("Return only the final rewritten assistant reply. Do not include the private handoff note or any wrapper text.")
    expect(userPrompt).not.toContain("Follow the configured roleplay prompt exactly.")
    expect(userPrompt).not.toContain("Do not add any persona, honorific, relationship, nickname, or address form unless it appears in the configured prompt or assistant draft.")
    expect(userPrompt).not.toContain("Configured roleplay prompt:\nconfigured voice")
    expect(userPrompt).not.toContain("You are Maid")
  })

  test("default rewrite prompt labels only the current target without context", () => {
    const prompt = maidUserPrompt({ cfg, text: "Current draft SECRET_TOKEN" })

    expect(prompt).not.toContain("Previous context, reference only")
    expect(prompt).not.toContain("Current user prompt")
    expect(prompt).not.toContain("Current user prompt\n\nnone supplied")
    expect(prompt).toContain("This-time rewrite target")
    expect(prompt).toContain("Current draft SECRET_TOKEN")
  })

  test("labels current prompt when context mode passes one", () => {
    const prompt = maidUserPrompt({ cfg, text: "Current draft SECRET_TOKEN", currentUserPrompt: "Current request" })

    expect(prompt).toContain("Current user prompt")
    expect(prompt).toContain("Current request")
    expect(prompt).toContain("This-time rewrite target")
  })

  test("includes previous rewrite context as reference-only before the current target", () => {
    const prompt = maidUserPrompt({
      cfg,
      text: "Current draft SECRET_TOKEN",
      currentUserPrompt: "Current request",
      previousContext: [{ userPrompt: "Previous request", originalText: "Previous raw SECRET_TOKEN", visibleText: "Previous maid SECRET_TOKEN" }],
    })

    expect(prompt).toContain("Previous context, reference only")
    expect(prompt).not.toContain("Previous request")
    expect(prompt).not.toContain("Previous raw SECRET_TOKEN")
    expect(prompt).toContain("Previous maid SECRET_TOKEN")
    expect(prompt.indexOf("Previous context, reference only")).toBeLessThan(prompt.indexOf("Current user prompt"))
    expect(prompt.indexOf("Current user prompt")).toBeLessThan(prompt.indexOf("This-time rewrite target"))
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
