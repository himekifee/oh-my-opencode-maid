// Shared sentinels for the e2e. Kept deliberately weird so substring checks
// against opencode output / fake-server request bodies cannot match by accident.

export const PROVIDER_ID = "fake"
export const MAIN_MODEL = "main-model"
export const REWRITE_MODEL = "rewrite-model"
export const REWRITE_VARIANT = "deluxe"

// opencode maps a model `variants` entry into providerOptions; for
// @ai-sdk/openai-compatible `reasoningEffort` is serialized as the
// `reasoning_effort` request-body field. We point the configured variant at a
// sentinel string so the rewrite request can be proven to carry the variant.
export const VARIANT_WIRE_SENTINEL = "E2E-VARIANT-DELUXE-7f3a"

// Put in the maid roleplay_prompt so the rewrite request can be proven to use
// the configured prompt (it is echoed into the rewrite agent system + user
// prompt by rewrite.ts).
export const ROLEPLAY_SENTINEL = "E2E_ROLEPLAY_SENTINEL_b91c"

// The user turn we send to `opencode run`.
export const USER_TASK = "E2E_USER_TASK_q42: reply with the raw draft exactly."

// What the fake provider returns for the *main* agent turn (the draft the
// plugin must intercept and hand to the rewrite agent).
export const RAW_TOKEN = "TOKEN_KEEP_9173"
export const RAW_DRAFT = `RAW_DRAFT::do-not-show-this-verbatim::${RAW_TOKEN}`

// What the fake provider returns for the *rewrite* agent turn (the only thing
// the user should ever see). Carries RAW_TOKEN so we also exercise preservation.
export const REWRITTEN_TEXT = `REWRITTEN::yuzuki-says-hello::${RAW_TOKEN}`

// Markers emitted by src/rewrite.ts. Presence of either in a request proves the
// hidden rewrite agent (not the main agent) made the call.
export const REWRITE_AGENT_SYSTEM_MARKER = "You are a hidden rewrite-only OpenCode agent."
export const REWRITE_USER_MARKER = "Rewrite this assistant draft for final visibility in OpenCode."
