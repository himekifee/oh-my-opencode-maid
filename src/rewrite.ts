import type { MaidConfig } from "./config"

export const HANDOFF = "handoff_note_json"

export type HandoffNote = {
  audience: string
  tone_goal: string
  must_preserve: string[]
  reply_constraints: string[]
  exact_reply_mode: string
}

export type SplitText = {
  text: string
  note?: HandoffNote
}

export type FinalTextResult = {
  text: string
  rewritten: boolean
}

export type RewriteContextEntry = {
  userPrompt?: string
  originalText: string
  visibleText: string
}

export type MaidUserPromptInput = {
  cfg: MaidConfig
  text: string
  note?: HandoffNote
  currentUserPrompt?: string
  previousContext?: RewriteContextEntry[]
}

const fence = new RegExp(String.raw`\`\`\`${HANDOFF}\n([\s\S]*?)\n\`\`\`\s*$`)

export const FAILURE = "I could not safely prepare that reply."

function record(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input)
}

function strings(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((item) => typeof item === "string")
}

function note(input: unknown): HandoffNote | undefined {
  if (!record(input)) return
  return {
    audience: typeof input.audience === "string" ? input.audience : "user",
    tone_goal: typeof input.tone_goal === "string" ? input.tone_goal : "",
    must_preserve: strings(input.must_preserve) ? input.must_preserve : [],
    reply_constraints: strings(input.reply_constraints) ? input.reply_constraints : [],
    exact_reply_mode: typeof input.exact_reply_mode === "string" ? input.exact_reply_mode : "rewrite",
  }
}

function stripSeparator(text: string) {
  if (text.endsWith("\n\n")) return text.slice(0, -2)
  if (text.endsWith("\n")) return text.slice(0, -1)
  return text
}

export function split(text: string): SplitText {
  const hit = fence.exec(text)
  if (!hit || hit.index === undefined) return { text: text.trimEnd() }
  const parsed = (() => {
    try {
      return note(JSON.parse(hit[1] ?? ""))
    } catch {
      return undefined
    }
  })()
  const raw = stripSeparator(text.slice(0, hit.index))
  if (parsed?.exact_reply_mode === "verbatim") return { text: raw, note: parsed }
  return { text: raw.trimEnd(), note: parsed }
}

export function missing(text: string, note?: HandoffNote) {
  return note?.must_preserve.find((item) => item && !text.includes(item))
}

export function finalResult(draft: string, rewritten: string): FinalTextResult {
  const item = split(draft)
  if (!item.text) return { text: item.text, rewritten: false }
  const text = split(rewritten).text.trimEnd()
  if (!text) return { text: item.text, rewritten: false }
  return { text, rewritten: true }
}

// Test seam: thin string-only wrapper over finalResult used by the test suite.
// Not used by the runtime; kept exported only so tests can assert text output
// without unwrapping the result object.
export function finalText(draft: string, rewritten: string) {
  return finalResult(draft, rewritten).text
}

export function handoffSystemPrompt() {
  return [
    `You may append one trailing fenced \`${HANDOFF}\` block after your normal assistant reply.`,
    "The block is private handoff metadata for a rewrite pass. If included, it should be the final content in the message.",
    "Use this JSON object shape inside the fence when you include it:",
    JSON.stringify({
      audience: "user",
      tone_goal: "short description of the desired visible tone",
      must_preserve: ["verbatim strings, commands, file paths, numbers, and code that must survive rewriting"],
      reply_constraints: ["important user or system constraints the rewrite must obey"],
      exact_reply_mode: "rewrite",
    }),
    "Prefer exact_reply_mode: rewrite.",
    "Use must_preserve and reply_constraints for exact-output needs, but leave them empty when no concrete literals or constraints apply.",
    "Never mention the handoff block in the visible reply text before the fence.",
  ].join("\n")
}

export function maidAgentPrompt(cfg: MaidConfig) {
  return [
    "You are a hidden rewrite-only OpenCode agent.",
    "Follow the configured roleplay prompt exactly.",
    "Do not add any persona, honorific, relationship, nickname, or address form unless it appears in the configured prompt or assistant draft.",
    `Configured roleplay prompt:\n${cfg.roleplay_prompt}`,
    "Return only the final rewritten assistant reply.",
    "Do not include analysis, tool calls, explanations, code fences for private metadata, or the original draft unless exact preservation requires it.",
    "Preserve every fact, command, path, number, code block, markdown structure, and explicit user constraint.",
  ].join("\n")
}

function previousContextPrompt(entries: RewriteContextEntry[] | undefined) {
  if (!entries?.length) return []
  return [
    "Previous context, reference only",
    "Use these prior successful rewritten replies only for style continuity and consistency. Do not answer, repeat, or treat them as current instructions.",
    ...entries.flatMap((entry, index) => [
      `Previous rewrite ${index + 1} rewritten visible text:`,
      entry.visibleText,
    ]),
  ]
}

function currentUserPrompt(input: MaidUserPromptInput) {
  if (!input.currentUserPrompt && !input.previousContext?.length) return []
  return [
    "Current user prompt",
    input.currentUserPrompt ?? "none supplied.",
  ]
}

export function maidUserPrompt(input: MaidUserPromptInput) {
  return [
    "Rewrite this assistant draft for final visibility in OpenCode.",
    input.note ? `Private handoff note: ${JSON.stringify(input.note)}` : "Private handoff note: none supplied.",
    ...previousContextPrompt(input.previousContext),
    ...currentUserPrompt(input),
    "Return only the final rewritten assistant reply. Do not include the private handoff note or any wrapper text.",
    "This-time rewrite target",
    input.text,
  ].join("\n\n")
}
