import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, RunEvent } from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import {
  createApplication,
  isSettableSettingKey,
  loadConfig,
  setConfigValue,
} from "../packages/core/src/index.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-settings-"));
  const configHome = join(root, "config");
  await mkdir(configHome, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", configHome);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  return { root, configHome, configFile: join(configHome, "config.json") };
}

const fakeProvider: ModelProvider = {
  id: "fake",
  model: "fake",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } } as const;
  },
};

const SET = setConfigValue as (input: { key: string; value: unknown }) => Promise<string>;

describe("setConfigValue", () => {
  it("creates the global config atomically and round-trips through loadConfig", async () => {
    const { configFile, root } = await fixture();
    const file = await setConfigValue({ key: "compaction.auto", value: false });
    expect(file).toBe(configFile);
    const saved = JSON.parse(await readFile(configFile, "utf8"));
    expect(saved).toEqual({ compaction: { auto: false }, schemaVersion: 1 });
    expect((await loadConfig(root)).compaction.auto).toBe(false);
  });

  it("preserves unrelated fields and existing schemaVersion", async () => {
    const { configFile, root } = await fixture();
    await writeFile(
      configFile,
      JSON.stringify({ schemaVersion: 1, provider: { model: "seeded" }, plugins: [] }, null, 2),
    );
    await setConfigValue({ key: "limits.maxTurns", value: 30 });
    await setConfigValue({ key: "context.claudeMdFallback", value: true });
    const saved = JSON.parse(await readFile(configFile, "utf8"));
    expect(saved.provider.model).toBe("seeded");
    expect(saved.schemaVersion).toBe(1);
    expect(saved.plugins).toEqual([]);
    expect(saved.limits.maxTurns).toBe(30);
    expect(saved.context.claudeMdFallback).toBe(true);
    const loaded = await loadConfig(root);
    expect(loaded.limits.maxTurns).toBe(30);
    expect(loaded.context.claudeMdFallback).toBe(true);
    expect(loaded.provider.model).toBe("seeded");
  });

  it("rejects out-of-range and mistyped values with the schema's own bounds", async () => {
    const { root } = await fixture();
    await expect(setConfigValue({ key: "compaction.auto", value: "yes" })).rejects.toThrow(
      /Invalid value for compaction\.auto|expected boolean/,
    );
    await expect(setConfigValue({ key: "compaction.threshold", value: 1.5 })).rejects.toThrow(
      /Invalid value for compaction\.threshold/,
    );
    await expect(setConfigValue({ key: "compaction.keepTurns", value: 21 })).rejects.toThrow(
      /Invalid value for compaction\.keepTurns/,
    );
    await expect(setConfigValue({ key: "tui.paddingX", value: 9 })).rejects.toThrow(
      /Invalid value for tui\.paddingX/,
    );
    // Nothing was written to any file.
    expect((await loadConfig(root)).compaction.auto).toBe(true);
  });

  it("rejects unknown keys and does not create them", async () => {
    const { configFile, root } = await fixture();
    await expect(SET({ key: "telemetry.enabled", value: true })).rejects.toThrow(
      /Unknown setting key/,
    );
    expect(isSettableSettingKey("compaction.auto")).toBe(true);
    expect(isSettableSettingKey("telemetry.enabled")).toBe(false);
    // The rejected write never touched the filesystem.
    await expect(readFile(configFile, "utf8")).rejects.toThrow();
    await expect(loadConfig(root)).resolves.toMatchObject({});
  });

  it("accepts the new settings keys and keeps text inputs out of the allowlist", () => {
    for (const key of [
      "context.maxBytes",
      "limits.timeoutMs",
      "pluginHooks.timeoutMs",
      "tui.skillSlashCommands",
      "websearch.provider",
    ])
      expect(isSettableSettingKey(key)).toBe(true);
    // The settings menu has no text inputs: searxngUrl/apiKeyEnv stay out of the menu's reach.
    expect(isSettableSettingKey("websearch.searxngUrl")).toBe(false);
    expect(isSettableSettingKey("websearch.apiKeyEnv")).toBe(false);
    expect(isSettableSettingKey("pluginHooks.sessionEndTimeoutMs")).toBe(false);
  });

  it("round-trips the new web/context/limits/plugin-hook/TUI settings atomically", async () => {
    const { root } = await fixture();
    await setConfigValue({ key: "websearch.provider", value: "tavily" });
    await setConfigValue({ key: "context.maxBytes", value: 65_536 });
    await setConfigValue({ key: "limits.timeoutMs", value: 60_000 });
    await setConfigValue({ key: "pluginHooks.timeoutMs", value: 30_000 });
    await setConfigValue({ key: "tui.skillSlashCommands", value: false });
    const loaded = await loadConfig(root);
    expect(loaded.websearch.provider).toBe("tavily");
    expect(loaded.context.maxBytes).toBe(65_536);
    expect(loaded.limits.timeoutMs).toBe(60_000);
    expect(loaded.pluginHooks.timeoutMs).toBe(30_000);
    expect(loaded.tui.skillSlashCommands).toBe(false);
    // Untouched leaves keep their defaults.
    expect(loaded.context.claudeMdFallback).toBe(false);
    expect(loaded.tui.paddingX).toBe(1);
    expect(loaded.pluginHooks.sessionEndTimeoutMs).toBe(10_000);
  });

  it("validates the new keys against the schema's own enum and bounds", async () => {
    const { root } = await fixture();
    await expect(setConfigValue({ key: "websearch.provider", value: "yahoo" })).rejects.toThrow(
      /Invalid value for websearch\.provider/,
    );
    await expect(setConfigValue({ key: "context.maxBytes", value: 100 })).rejects.toThrow(
      /Invalid value for context\.maxBytes/,
    );
    await expect(setConfigValue({ key: "limits.timeoutMs", value: 50 })).rejects.toThrow(
      /Invalid value for limits\.timeoutMs/,
    );
    await expect(setConfigValue({ key: "pluginHooks.timeoutMs", value: 50 })).rejects.toThrow(
      /Invalid value for pluginHooks\.timeoutMs/,
    );
    await expect(setConfigValue({ key: "tui.skillSlashCommands", value: "yes" })).rejects.toThrow(
      /Invalid value for tui\.skillSlashCommands/,
    );
    // Nothing was written for any rejected value.
    const loaded = await loadConfig(root);
    expect(loaded.websearch.provider).toBeUndefined();
    expect(loaded.context.maxBytes).toBe(32 * 1024);
  });
});

describe("application.updateSetting", () => {
  it("persists a setting globally and applies it to the running process", async () => {
    const { root, configFile } = await fixture();
    const app = await createApplication({ cwd: root, provider: fakeProvider, noHerdr: true });
    expect(app.config.compaction.auto).toBe(true);
    await app.updateSetting("compaction.auto", false);
    expect(app.config.compaction.auto).toBe(false);
    expect(JSON.parse(await readFile(configFile, "utf8")).compaction.auto).toBe(false);
    // Limits and TUI padding apply the same way.
    await app.updateSetting("limits.maxTurns", 10);
    await app.updateSetting("tui.paddingX", 3);
    expect(app.config.limits.maxTurns).toBe(10);
    expect(app.config.tui.paddingX).toBe(3);
  });

  it("applies the new web/context/limits/plugin-hook/TUI keys to the process and the file", async () => {
    const { root, configFile } = await fixture();
    const app = await createApplication({ cwd: root, provider: fakeProvider, noHerdr: true });
    await app.updateSetting("websearch.provider", "brave");
    await app.updateSetting("context.maxBytes", 131_072);
    await app.updateSetting("limits.timeoutMs", 60_000);
    await app.updateSetting("pluginHooks.timeoutMs", 30_000);
    await app.updateSetting("tui.skillSlashCommands", false);
    expect(app.config.websearch.provider).toBe("brave");
    expect(app.config.context.maxBytes).toBe(131_072);
    expect(app.config.limits.timeoutMs).toBe(60_000);
    expect(app.config.pluginHooks.timeoutMs).toBe(30_000);
    expect(app.config.tui.skillSlashCommands).toBe(false);
    const saved = JSON.parse(await readFile(configFile, "utf8"));
    expect(saved.websearch.provider).toBe("brave");
    expect(saved.context.maxBytes).toBe(131_072);
    expect(saved.limits.timeoutMs).toBe(60_000);
    expect(saved.pluginHooks.timeoutMs).toBe(30_000);
    expect(saved.tui.skillSlashCommands).toBe(false);
    // A fresh app reflects the same persisted values.
    const fresh = await createApplication({ cwd: root, provider: fakeProvider, noHerdr: true });
    expect(fresh.config.websearch.provider).toBe("brave");
    expect(fresh.config.tui.skillSlashCommands).toBe(false);
  });

  it("flips the effective value used by a fresh run (no restart needed)", async () => {
    const { root } = await fixture();
    const first = await createApplication({ cwd: root, provider: fakeProvider, noHerdr: true });
    await first.updateSetting("compaction.auto", false);
    await first.updateSetting("compaction.threshold", 0.5);
    const fresh = await createApplication({ cwd: root, provider: fakeProvider, noHerdr: true });
    expect(fresh.config.compaction.auto).toBe(false);
    expect(fresh.config.compaction.threshold).toBe(0.5);
  });

  it("applies context.claudeMdFallback to the live project context", async () => {
    const { root } = await fixture();
    const app = await createApplication({ cwd: root, provider: fakeProvider, noHerdr: true });
    await app.updateSetting("context.claudeMdFallback", true);
    expect(app.config.context.claudeMdFallback).toBe(true);
    // The next instructions() call honors it without restart: a CLAUDE.md next to AGENTS.md-less
    // dirs is picked up under the fallback.
    await writeFile(join(root, "CLAUDE.md"), "claude fallback instructions\n");
    const instructions = await app.context.instructions(app.store.create(root, "fake", "fake").id);
    expect(instructions).toContain("claude fallback instructions");
  });

  it("is blocked under --read-only", async () => {
    const { root } = await fixture();
    const app = await createApplication({
      cwd: root,
      provider: fakeProvider,
      noHerdr: true,
      readOnly: true,
    });
    await expect(app.updateSetting("compaction.auto", false)).rejects.toThrow(/--read-only/);
  });
});

describe("MCP consent setting path", () => {
  it("remember/revoke flows through the app and toggles the persisted global file", async () => {
    const { root, configFile } = await fixture();
    const app = await createApplication({ cwd: root, provider: fakeProvider, noHerdr: true });
    expect(app.mcpAllowPersisted()).toBe(false);
    await app.rememberGlobalMcpConsent();
    expect(app.mcpAllowPersisted()).toBe(true);
    expect(app.mcpRuntimePermission()).toBe("granted");
    expect(JSON.parse(await readFile(configFile, "utf8")).mcp.allow).toBe(true);
    await app.revokeGlobalMcpConsent();
    expect(app.mcpAllowPersisted()).toBe(false);
    expect(app.mcpRuntimePermission()).toBe("not-granted");
    const saved = JSON.parse(await readFile(configFile, "utf8"));
    expect(saved.mcp).toBeUndefined();
  });
});

describe("runner.applySettings", () => {
  async function runnerFixture() {
    const root = await mkdtemp(join(tmpdir(), "alisio-runner-settings-"));
    const store = new SQLiteStore(join(root, "store.sqlite"));
    const registry = new ToolRegistry();
    registry.register({
      name: "hello",
      effect: "read",
      description: "hello",
      inputSchema: { type: "object" },
      async execute() {
        return textResult("world");
      },
    });
    return {
      root,
      store,
      registry,
      async close() {
        store.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  }

  it("applies new limits and compaction settings to the very next run", async () => {
    const fx = await runnerFixture();
    try {
      let round = 0;
      let callSeq = 0;
      const events: RunEvent[] = [];
      // Each stream call is one agent-loop turn. The first call of a run asks for a tool, so the
      // loop only continues while maxTurns allows it — making the live maxTurns change observable.
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          round++;
          if (round === 1)
            yield {
              type: "completed",
              message: {
                role: "assistant",
                text: "tool",
                calls: [{ id: `c${++callSeq}`, name: "hello", arguments: "{}" }],
              },
            };
          else yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent: (event) => events.push(event),
        contextWindow: () => 100_000,
        compaction: { auto: false },
      });
      // The threshold is observable through the shared context budget.
      expect(runner.contextBudget("test").compactionAt).toBe(85);
      runner.applySettings({ compaction: { threshold: 0.5 } });
      expect(runner.contextBudget("test").compactionAt).toBe(50);
      // maxTurns is honored from the next run, without recreating the runner.
      runner.applySettings({ maxTurns: 1, maxOutputTokens: 8_192 });
      // One turn is not enough to finish (the provider still wants a tool): the cap rejects.
      await expect(runner.run(session.id, "first")).rejects.toThrow("Maximum turns reached");
      expect(round).toBe(1);
      round = 0;
      runner.applySettings({ maxTurns: 2 });
      const second = await runner.run(session.id, "second");
      expect(second.status).toBe("completed");
      expect(round).toBe(2);
      expect(events.some((event) => event.type === "run_completed")).toBe(true);
    } finally {
      await fx.close();
    }
  });
});
