import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_MODEL, MAIN_AGENT_MODEL, REWRITE_CONTEXT_MAX, applyMainConfig, loadConfig } from "./config"

async function temp() {
  return mkdtemp(path.join(tmpdir(), "omo-maid-"))
}

async function isolated<T>(fn: (dir: string) => Promise<T>) {
  const dir = await temp()
  const xdg = process.env.XDG_CONFIG_HOME
  const home = process.env.HOME
  process.env.XDG_CONFIG_HOME = path.join(dir, "xdg")
  process.env.HOME = path.join(dir, "home")
  try {
    return await fn(dir)
  } finally {
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = xdg
    if (home === undefined) delete process.env.HOME
    else process.env.HOME = home
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(value))
}

function userConfigFile() {
  return path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "oh-my-opencode-maid.jsonc")
}

function projectConfigFile(dir: string) {
  return path.join(dir, ".opencode", "oh-my-opencode-maid.jsonc")
}

describe("config", () => {
  test("loads minimal OpenCode rewrite defaults", async () => {
    await isolated(async (dir) => {
      const cfg = await loadConfig(dir)

      expect(cfg).toEqual({
        enabled: true,
        model: DEFAULT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
      expect(cfg.roleplay_prompt).toContain("maid assistant")
      expect(cfg.roleplay_prompt).toContain("courteous")
      expect(cfg.roleplay_prompt).toContain("Preserve facts")
      expect(cfg.roleplay_prompt).not.toMatch(/Chobits|Minoru|Kaede/)
      expect(DEFAULT_MODEL).toBe(MAIN_AGENT_MODEL)

      const created = JSON.parse(await Bun.file(userConfigFile()).text())
      expect(created).toEqual({
        enabled: true,
        model: DEFAULT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: cfg.roleplay_prompt,
      })
    })
  })

  test("does not overwrite existing user config", async () => {
    await isolated(async (dir) => {
      const file = userConfigFile()
      const original = '{\n  "enabled": false,\n  "roleplay_prompt": "custom maid"\n}\n'
      await mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, original)

      const cfg = await loadConfig(dir)

      expect(cfg).toEqual({
        enabled: false,
        model: DEFAULT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: "custom maid",
      })
      expect(await Bun.file(file).text()).toBe(original)
    })
  })

  test("ignores project plugin config and creates user config", async () => {
    await isolated(async (dir) => {
      await writeJson(projectConfigFile(dir), {
        enabled: false,
        model: "openai/gpt-5.5",
        variant: "fast",
      })

      await expect(loadConfig(dir)).resolves.toEqual({
        enabled: true,
        model: DEFAULT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
      const created = JSON.parse(await Bun.file(userConfigFile()).text())
      expect(created).toEqual({
        enabled: true,
        model: DEFAULT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
    })
  })

  test("user config is the only maid config source", async () => {
    await isolated(async (dir) => {
      await writeJson(userConfigFile(), {
        enabled: true,
        model: "anthropic/claude-sonnet-4-5",
        variant: "thinking",
        rewrite_context_size: 1,
        roleplay_prompt: "user maid",
      })
      await writeJson(projectConfigFile(dir), {
        enabled: false,
        model: "openai/gpt-5.5",
        roleplay_prompt: "project maid",
      })

      await expect(loadConfig(dir)).resolves.toEqual({
        enabled: true,
        model: "anthropic/claude-sonnet-4-5",
        variant: "thinking",
        rewrite_context_size: 1,
        roleplay_prompt: "user maid",
      })
    })
  })

  test("continues with defaults when user config creation fails", async () => {
    await isolated(async (dir) => {
      const blocked = path.join(dir, "blocked-config-home")
      await Bun.write(blocked, "not a directory")
      process.env.XDG_CONFIG_HOME = blocked

      await expect(loadConfig(dir)).resolves.toEqual({
        enabled: true,
        model: DEFAULT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
    })
  })

  test("accepts only enabled, model, variant, roleplay_prompt, and rewrite_context_size", async () => {
    await isolated(async (dir) => {
      await writeJson(userConfigFile(), { enabled: false, model: "anthropic/claude-sonnet-4-5", variant: "thinking", roleplay_prompt: "formal maid", rewrite_context_size: REWRITE_CONTEXT_MAX })

      await expect(loadConfig(dir)).resolves.toEqual({
        enabled: false,
        model: "anthropic/claude-sonnet-4-5",
        variant: "thinking",
        rewrite_context_size: REWRITE_CONTEXT_MAX,
        roleplay_prompt: "formal maid",
      })
    })
  })

  test("accepts main-agent-model and ignores standalone variant", async () => {
    await isolated(async (dir) => {
      await writeJson(userConfigFile(), {
        model: MAIN_AGENT_MODEL,
        variant: "thinking",
      })

      await expect(loadConfig(dir)).resolves.toEqual({
        enabled: true,
        model: MAIN_AGENT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
    })
  })

  test("keeps main-agent-model default when user OpenCode config sets a model", async () => {
    await isolated(async (dir) => {
      await writeJson(path.join(process.env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.jsonc"), {
        model: "anthropic/claude-sonnet-4-5",
      })

      await expect(loadConfig(dir)).resolves.toEqual({
        enabled: true,
        model: MAIN_AGENT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
    })
  })

  test("keeps main-agent-model default when project OpenCode config sets default agent model and variant", async () => {
    await isolated(async (dir) => {
      await writeJson(path.join(dir, ".opencode", "opencode.jsonc"), {
        model: "anthropic/claude-sonnet-4-5",
        default_agent: "build",
        agent: {
          build: {
            model: "openai/gpt-5.5",
            variant: "high",
          },
        },
      })

      await expect(loadConfig(dir)).resolves.toEqual({
        enabled: true,
        model: MAIN_AGENT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
    })
  })

  test("does not inherit split main OpenCode agent config", async () => {
    await isolated(async (dir) => {
      await writeJson(path.join(dir, ".opencode", "opencode.json"), {
        agent: {
          build: {
            model: "openai/gpt-5.5",
          },
        },
      })
      await writeJson(path.join(dir, ".opencode", "opencode.jsonc"), {
        agent: {
          build: {
            variant: "high",
          },
        },
      })

      await expect(loadConfig(dir)).resolves.toMatchObject({
        model: MAIN_AGENT_MODEL,
      })
    })
  })

  test("lets maid config set a concrete rewrite model", async () => {
    await isolated(async (dir) => {
      await writeJson(path.join(dir, ".opencode", "opencode.jsonc"), {
        model: "anthropic/claude-sonnet-4-5",
      })
      await writeJson(userConfigFile(), {
        model: "openai/gpt-5.5",
        variant: "fast",
      })

      await expect(loadConfig(dir)).resolves.toMatchObject({
        model: "openai/gpt-5.5",
        variant: "fast",
      })
    })
  })

  test("does not keep inherited variant when maid config sets only concrete model", async () => {
    await isolated(async (dir) => {
      await writeJson(path.join(dir, ".opencode", "opencode.jsonc"), {
        agent: {
          build: {
            model: "anthropic/claude-sonnet-4-5",
            variant: "thinking",
          },
        },
      })
      await writeJson(userConfigFile(), {
        model: "openai/gpt-5.5",
      })

      await expect(loadConfig(dir)).resolves.toEqual({
        enabled: true,
        model: "openai/gpt-5.5",
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
    })
  })

  test("resolved OpenCode config hook input does not replace main-agent-model", async () => {
    await isolated(async (dir) => {
      const cfg = await loadConfig(dir)

      applyMainConfig(cfg, {
        agent: {
          build: {
            model: "anthropic/claude-sonnet-4-5",
            variant: "thinking",
          },
        },
      })

      expect(cfg).toEqual({
        enabled: true,
        model: MAIN_AGENT_MODEL,
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
    })
  })

  test("resolved OpenCode config hook input does not add variant to explicit concrete model", async () => {
    await isolated(async (dir) => {
      await writeJson(userConfigFile(), {
        model: "openai/gpt-5.5",
      })
      const cfg = await loadConfig(dir)

      applyMainConfig(cfg, {
        agent: {
          build: {
            model: "openai/gpt-5.5",
            variant: "high",
          },
        },
      })

      expect(cfg).toEqual({
        enabled: true,
        model: "openai/gpt-5.5",
        rewrite_context_size: 1,
        roleplay_prompt: expect.stringContaining("Yuzuki"),
      })
    })
  })

  test("permits unrelated main OpenCode config keys", async () => {
    await isolated(async (dir) => {
      await writeJson(path.join(dir, ".opencode", "opencode.jsonc"), {
        $schema: "https://opencode.ai/config.json",
        plugin: ["file:///tmp/plugin.js"],
        provider: { fake: { models: {} } },
        model: "openai/gpt-5.5",
      })

      await expect(loadConfig(dir)).resolves.toMatchObject({
        model: MAIN_AGENT_MODEL,
      })
    })
  })

  test("rejects invalid model strings except main-agent-model", async () => {
    await isolated(async (dir) => {
      await writeJson(userConfigFile(), {
        model: "gpt-5.5",
      })

      await expect(loadConfig(dir)).rejects.toThrow('model must be main-agent-model or use provider/model format')
    })
  })

  test("rejects invalid rewrite_context_size values", async () => {
    for (const value of [0, 1.5, REWRITE_CONTEXT_MAX + 1, "2"]) {
      await isolated(async (dir) => {
        await writeJson(userConfigFile(), { rewrite_context_size: value })

        await expect(loadConfig(dir)).rejects.toThrow()
      })
    }
  })

  test("rejects stale dedicated API client config", async () => {
    await isolated(async (dir) => {
      await writeJson(userConfigFile(), { ["base" + "_url"]: "https://example.invalid/v1" })

      await expect(loadConfig(dir)).rejects.toThrow("Unrecognized key")
    })
  })
})
