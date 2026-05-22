import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { z } from "zod"

export const MAIN_AGENT_MODEL = "main-agent-model"
export const FALLBACK_MODEL = "openai/gpt-5.5"
export const DEFAULT_MODEL = MAIN_AGENT_MODEL
export const REWRITE_CONTEXT_MAX = 20

const providerModel = /^[^/\s]+\/.+$/

const Model = z
  .string()
  .min(1)
  .refine((model) => model === MAIN_AGENT_MODEL || providerModel.test(model), "model must be main-agent-model or use provider/model format")

const Schema = z
  .object({
    enabled: z.boolean().optional(),
    model: Model.optional(),
    variant: z.string().min(1).optional(),
    roleplay_prompt: z.string().min(1).optional(),
    rewrite_context_size: z.number().int().min(1).max(REWRITE_CONTEXT_MAX).optional(),
    show_original_draft: z.boolean().optional(),
  })
  .strict()

const Loaded = Schema.extend({
  enabled: z.boolean(),
  model: Model,
  rewrite_context_size: z.number().int().min(1).max(REWRITE_CONTEXT_MAX),
  roleplay_prompt: z.string().min(1),
  show_original_draft: z.boolean(),
})

export type MaidConfig = z.infer<typeof Loaded>

type PartialMaidConfig = z.infer<typeof Schema>

type MainConfig = {
  model?: unknown
  default_agent?: unknown
  agent?: Record<string, unknown>
}

const defaults = {
  enabled: true,
  model: DEFAULT_MODEL,
  rewrite_context_size: 1,
  roleplay_prompt:
    "Rewrite the assistant reply in English as Yuzuki, a cheerful and attentive maid assistant: gentle, courteous, precise, logically organized, quietly warm, and modest about limitations. Always call me master. Preserve facts, code, commands, paths, URLs, identifiers, numbers, markdown structure, and the user's requested meaning.",
  show_original_draft: false,
}

const CONFIG_FILE = "oh-my-opencode-maid.jsonc"

const explicit = new WeakMap<MaidConfig, PartialMaidConfig>()

function parseJsonc(text: string, file: string) {
  const errors: import("jsonc-parser").ParseError[] = []
  const data = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`Invalid JSONC in ${file}: ${errors.map((err) => err.error).join(", ")}`)
  return data
}

async function readJsonc(file: string) {
  const item = Bun.file(file)
  if (!(await item.exists())) return undefined
  return parseJsonc(await item.text(), file)
}

async function read(file: string): Promise<PartialMaidConfig> {
  const data = await readJsonc(file)
  if (data === undefined) return {}
  return Schema.parse(data)
}

function configHome() {
  return process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "", ".config")
}

export function userConfigPath() {
  return path.join(configHome(), "opencode", CONFIG_FILE)
}

async function exists(file: string) {
  return Bun.file(file).exists().catch(() => false)
}

async function seedUserConfig(userFile: string) {
  if (await exists(userFile)) return
  try {
    await mkdir(path.dirname(userFile), { recursive: true, mode: 0o700 })
    await writeFile(userFile, `${JSON.stringify(defaults, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  } catch (error) {
    // Startup seeding is best-effort; existing readable configs still validate below.
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mergeMainConfig(base: MainConfig, next: unknown): MainConfig {
  if (!record(next)) return base
  const agent = record(next.agent) ? next.agent : undefined
  return {
    ...deepMerge(base, next),
    ...(agent ? { agent: deepMerge(base.agent ?? {}, agent) } : {}),
  }
}

function deepMerge(base: unknown, next: unknown): Record<string, unknown> {
  if (!record(base)) return record(next) ? next : {}
  if (!record(next)) return base
  const output: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(next)) {
    output[key] = record(value) && record(output[key]) ? deepMerge(output[key], value) : value
  }
  return output
}

function agentConfig(config: MainConfig, name: string) {
  const agent = config.agent?.[name]
  return record(agent) ? agent : undefined
}

function inheritedConfig(config: MainConfig): PartialMaidConfig {
  const defaultAgent = typeof config.default_agent === "string" && config.default_agent ? config.default_agent : "build"
  const selected = agentConfig(config, defaultAgent) ?? agentConfig(config, "build")
  const agent = typeof selected?.model === "string" ? selected : undefined
  const model = typeof agent?.model === "string" ? agent.model : typeof config.model === "string" ? config.model : undefined
  const variant = typeof agent?.variant === "string" ? agent.variant : undefined
  return {
    ...(model ? { model } : {}),
    ...(model && variant ? { variant } : {}),
  }
}

export function applyMainConfig(cfg: MaidConfig, input: unknown) {
  const override = explicit.get(cfg) ?? {}
  if (cfg.model === MAIN_AGENT_MODEL) {
    delete cfg.variant
    return
  }
  if (override.variant) return
  if (override.model) {
    delete cfg.variant
    return
  }
  const inherited = inheritedConfig(mergeMainConfig({}, input))
  if (inherited.model) cfg.model = inherited.model
  if (inherited.variant && (!override.model || cfg.model === inherited.model)) cfg.variant = inherited.variant
  else delete cfg.variant
}

export async function loadConfig(dir: string): Promise<MaidConfig> {
  void dir
  const userFile = userConfigPath()
  await seedUserConfig(userFile)
  const user = await read(userFile)
  const cfg = Loaded.parse({
    ...defaults,
    ...user,
  })
  const override = { ...user }
  if (cfg.model === MAIN_AGENT_MODEL) delete cfg.variant
  else if (override.model && !override.variant) delete cfg.variant
  explicit.set(cfg, override)
  return cfg
}

export async function toggleRewriteEnabled() {
  const userFile = userConfigPath()
  await seedUserConfig(userFile)
  const text = await Bun.file(userFile).text()
  const user = Schema.parse(parseJsonc(text, userFile))
  const enabled = !(user.enabled ?? defaults.enabled)
  const next = applyEdits(text, modify(text, ["enabled"], enabled, {
    formattingOptions: {
      eol: "\n",
      insertSpaces: true,
      tabSize: 2,
    },
  }))
  await writeFile(userFile, next, { mode: 0o600 })
  return { enabled, path: userFile }
}
