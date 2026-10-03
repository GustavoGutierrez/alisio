import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configSchema,
  createApplication,
  DEFAULT_DECISIONS_CONFIG,
  isSettableSettingKey,
  loadConfig,
  loadConfigWithProvenance,
  setConfigValue,
  settableSettings,
} from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-decisions-config-"));
  const global = join(root, "global");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(global, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", global);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  return { root, global, workspace };
}
async function json(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("decisions configuration block", () => {
  it("defaults match the service defaults (timeoutMs 1500) and a config without the block loads", async () => {
    const { workspace } = await fixture();
    const config = await loadConfig(workspace);
    expect(config.decisions).toEqual({
      enabled: true,
      provider: null,
      timeoutMs: 1500,
      minConfidence: 0.6,
      telemetry: true,
    });
    expect(config.decisions).toEqual(DEFAULT_DECISIONS_CONFIG);
    expect(config.pluginHooks.disposeTimeoutMs).toBe(2000);
  });

  it("validates ranges, the provider id and strictness", () => {
    const parse = (decisions: unknown) => configSchema.safeParse({ decisions }).success;
    expect(parse({ timeoutMs: 49 })).toBe(false);
    expect(parse({ timeoutMs: 10_001 })).toBe(false);
    expect(parse({ timeoutMs: 50.5 })).toBe(false);
    expect(parse({ timeoutMs: 50 })).toBe(true);
    expect(parse({ minConfidence: 1.1 })).toBe(false);
    expect(parse({ minConfidence: -0.1 })).toBe(false);
    expect(parse({ provider: "Bad Id" })).toBe(false);
    expect(parse({ provider: "../x" })).toBe(false);
    expect(parse({ provider: null })).toBe(true);
    expect(parse({ provider: "laya-ts.v1" })).toBe(true);
    expect(parse({ unknown: 1 })).toBe(false);
    expect(configSchema.safeParse({ pluginHooks: { disposeTimeoutMs: 99 } }).success).toBe(false);
    expect(configSchema.safeParse({ pluginHooks: { disposeTimeoutMs: 10_001 } }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ pluginHooks: { disposeTimeoutMs: 100 } }).success).toBe(true);
  });

  it("ignores provider and telemetry from a trusted project layer and reports them", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      decisions: { provider: "global-engine", telemetry: false },
    });
    await json(join(workspace, ".alisio", "config.json"), {
      decisions: {
        provider: "evil",
        telemetry: true,
        enabled: false,
        timeoutMs: 900,
        minConfidence: 0.8,
      },
    });
    const { config, provenance } = await loadConfigWithProvenance(workspace, {
      trustProject: true,
    });
    expect(config.decisions).toEqual({
      enabled: false,
      provider: "global-engine",
      timeoutMs: 900,
      minConfidence: 0.8,
      telemetry: false,
    });
    expect(provenance.ignored).toEqual(["decisions.provider", "decisions.telemetry"]);
  });

  it("does the same for an explicit --config file, without failing", async () => {
    const { global, workspace, root } = await fixture();
    await json(join(global, "config.json"), { decisions: { provider: "mine" } });
    const explicit = join(root, "explicit.json");
    await json(explicit, { decisions: { provider: "other", timeoutMs: 700 } });
    const { config, provenance } = await loadConfigWithProvenance(workspace, { file: explicit });
    expect(config.decisions.provider).toBe("mine");
    expect(config.decisions.timeoutMs).toBe(700);
    expect(provenance.ignored).toEqual(["decisions.provider"]);
  });

  it("a project layer without those keys reports nothing and keeps the global values", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), { decisions: { provider: "mine", telemetry: false } });
    await json(join(workspace, ".alisio", "config.json"), { decisions: { timeoutMs: 600 } });
    const { config, provenance } = await loadConfigWithProvenance(workspace, {
      trustProject: true,
    });
    expect(config.decisions).toMatchObject({ provider: "mine", telemetry: false, timeoutMs: 600 });
    expect(provenance.ignored).toBeUndefined();
  });
});

describe("live settings", () => {
  it("exposes the five decisions keys and persists them", async () => {
    const { global, workspace } = await fixture();
    const keys = settableSettings().map((s) => s.key as string);
    for (const key of [
      "decisions.enabled",
      "decisions.provider",
      "decisions.timeoutMs",
      "decisions.minConfidence",
      "decisions.telemetry",
      "pluginHooks.disposeTimeoutMs",
    ]) {
      expect(keys).toContain(key);
      expect(isSettableSettingKey(key)).toBe(true);
    }
    await setConfigValue({ key: "decisions.provider", value: "engine" });
    await setConfigValue({ key: "decisions.timeoutMs", value: 800 });
    const saved = JSON.parse(await readFile(join(global, "config.json"), "utf8"));
    expect(saved.decisions).toEqual({ provider: "engine", timeoutMs: 800 });
    expect((await loadConfig(workspace)).decisions.provider).toBe("engine");
    await expect(setConfigValue({ key: "decisions.timeoutMs", value: 10 })).rejects.toThrow();
    await expect(setConfigValue({ key: "decisions.provider", value: "Bad Id" })).rejects.toThrow();
  });

  it("updateSetting changes the running configuration and !clear (undefined) drops the provider", async () => {
    const { root, workspace } = await fixture();
    const app = await createApplication({
      cwd: workspace,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      provider: {
        id: "p",
        defaultModel: "m",
        async *stream() {
          yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
        },
      } as never,
    });
    try {
      await app.updateSetting("decisions.provider", "engine");
      expect(app.config.decisions.provider).toBe("engine");
      await app.updateSetting("decisions.timeoutMs", 900);
      await app.updateSetting("decisions.minConfidence", 0.7);
      await app.updateSetting("decisions.telemetry", false);
      await app.updateSetting("decisions.enabled", false);
      expect(app.config.decisions).toEqual({
        enabled: false,
        provider: "engine",
        timeoutMs: 900,
        minConfidence: 0.7,
        telemetry: false,
      });
      await app.updateSetting("pluginHooks.disposeTimeoutMs", 500);
      expect(app.config.pluginHooks.disposeTimeoutMs).toBe(500);
      await app.updateSetting("decisions.provider", undefined);
      expect(app.config.decisions.provider).toBeNull();
      expect(app.decisions.service.available()).toBe(false);
    } finally {
      await app.close();
    }
  });
});
