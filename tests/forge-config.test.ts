/**
 * The `forge` configuration block (spec §10): defaults (the JavaScript engine is on since the
 * Phase 3 gate), strict keys, the global-only keys and what a project layer may still lower.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, loadConfigWithProvenance } from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-forge-config-"));
  const global = join(root, "global");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(global, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", global);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  const json = async (file: string, value: unknown) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  return {
    workspace,
    setGlobal: (value: unknown) => json(join(global, "config.json"), value),
    setProject: (value: unknown) => json(join(workspace, ".alisio", "config.json"), value),
  };
}

describe("forge configuration", () => {
  it("defaults to the spec values, with JavaScript on since the Phase 3 gate", async () => {
    const { workspace } = await fixture();
    expect((await loadConfig(workspace)).forge).toEqual({
      javascript: {
        enabled: true,
        host: "auto",
        timeoutMs: 30_000,
        memoryBytes: 33_554_432,
        stackBytes: 262_144,
        maxToolCalls: 50,
        maxConcurrency: 4,
        maxOutputChars: 16_000,
      },
      state: { enabled: true, maxTotalBytes: 524_288 },
      scratch: { enabled: true, root: null, retentionDays: 7, maxBytes: 268_435_456 },
      guides: { enabled: true },
    });
  });

  it("accepts the user's values within the hard maxima and merges them with the defaults", async () => {
    const { workspace, setGlobal } = await fixture();
    await setGlobal({
      forge: {
        javascript: { enabled: true, host: "process", timeoutMs: 60_000, maxToolCalls: 500 },
        scratch: { root: "/var/scratch", retentionDays: 0 },
      },
    });
    const { forge } = await loadConfig(workspace);
    expect(forge.javascript).toMatchObject({
      enabled: true,
      host: "process",
      timeoutMs: 60_000,
      maxToolCalls: 500,
      maxConcurrency: 4,
    });
    expect(forge.scratch).toEqual({
      enabled: true,
      root: "/var/scratch",
      retentionDays: 0,
      maxBytes: 268_435_456,
    });
  });

  it("rejects unknown keys at every level and values past the hard maxima", async () => {
    const { workspace, setGlobal } = await fixture();
    for (const bad of [
      { forge: { unknown: true } },
      { forge: { javascript: { unknown: 1 } } },
      { forge: { state: { nope: 1 } } },
      { forge: { scratch: { nope: 1 } } },
      { forge: { guides: { nope: 1 } } },
      { forge: { javascript: { host: "thread" } } },
      { forge: { javascript: { timeoutMs: 300_001 } } },
      { forge: { javascript: { memoryBytes: 128 * 1024 * 1024 + 1 } } },
      { forge: { javascript: { stackBytes: 512 * 1024 + 1 } } },
      { forge: { javascript: { maxToolCalls: 501 } } },
      { forge: { javascript: { maxConcurrency: 17 } } },
      { forge: { javascript: { maxOutputChars: 48_001 } } },
      { forge: { javascript: { timeoutMs: 0 } } },
      { forge: { scratch: { retentionDays: -1 } } },
      { forge: { scratch: { root: "" } } },
    ]) {
      await setGlobal(bad);
      await expect(loadConfig(workspace), JSON.stringify(bad)).rejects.toThrow();
    }
  });

  it("lets a project only lower timeoutMs, maxToolCalls, maxConcurrency and maxOutputChars", async () => {
    const { workspace, setGlobal, setProject } = await fixture();
    await setGlobal({
      forge: { javascript: { timeoutMs: 60_000, maxToolCalls: 100, maxConcurrency: 8 } },
    });
    await setProject({
      forge: {
        javascript: {
          timeoutMs: 10_000,
          maxToolCalls: 400,
          maxConcurrency: 2,
          maxOutputChars: 1000,
        },
      },
    });
    const { config } = await loadConfigWithProvenance(workspace, { trustProject: true });
    expect(config.forge.javascript).toMatchObject({
      timeoutMs: 10_000, // lowered
      maxToolCalls: 100, // a project cannot raise it
      maxConcurrency: 2,
      maxOutputChars: 1000,
    });
  });

  it("does not let a project layer that is silent about a limit reset the global one", async () => {
    const { workspace, setGlobal, setProject } = await fixture();
    await setGlobal({ forge: { javascript: { timeoutMs: 60_000 } } });
    await setProject({ forge: { guides: { enabled: false } } });
    const { config } = await loadConfigWithProvenance(workspace, { trustProject: true });
    expect(config.forge.javascript.timeoutMs).toBe(60_000);
  });

  it("ignores the global-only keys of a project and reports them", async () => {
    const { workspace, setGlobal, setProject } = await fixture();
    await setGlobal({
      forge: {
        javascript: { host: "worker", memoryBytes: 16_777_216 },
        state: { maxTotalBytes: 100_000 },
        scratch: { root: "/global/scratch", retentionDays: 3 },
      },
    });
    await setProject({
      forge: {
        javascript: { host: "process", memoryBytes: 1_000_000, stackBytes: 65_536 },
        state: { maxTotalBytes: 1_000_000 },
        scratch: { root: "/project/scratch", retentionDays: 365, maxBytes: 5 },
      },
    });
    const { config, provenance } = await loadConfigWithProvenance(workspace, {
      trustProject: true,
    });
    expect(config.forge.javascript).toMatchObject({
      host: "worker",
      memoryBytes: 16_777_216,
      stackBytes: 262_144,
    });
    expect(config.forge.state.maxTotalBytes).toBe(100_000);
    expect(config.forge.scratch).toMatchObject({ root: "/global/scratch", retentionDays: 3 });
    expect(provenance.ignored).toEqual([
      "forge.javascript.host",
      "forge.javascript.memoryBytes",
      "forge.javascript.stackBytes",
      "forge.state.maxTotalBytes",
      "forge.scratch",
    ]);
  });

  it("lets a project switch features off but never on", async () => {
    const { workspace, setGlobal, setProject } = await fixture();
    await setGlobal({ forge: { javascript: { enabled: true } } });
    await setProject({
      forge: {
        javascript: { enabled: false },
        state: { enabled: false },
        guides: { enabled: false },
      },
    });
    let { config } = await loadConfigWithProvenance(workspace, { trustProject: true });
    expect(config.forge.javascript.enabled).toBe(false);
    expect(config.forge.state.enabled).toBe(false);
    expect(config.forge.guides.enabled).toBe(false);

    await setGlobal({ forge: { javascript: { enabled: false }, guides: { enabled: false } } });
    await setProject({ forge: { javascript: { enabled: true }, guides: { enabled: true } } });
    ({ config } = await loadConfigWithProvenance(workspace, { trustProject: true }));
    expect(config.forge.javascript.enabled).toBe(false);
    expect(config.forge.guides.enabled).toBe(false);
  });

  it("keeps the global features when a project block does not mention them", async () => {
    const { workspace, setGlobal, setProject } = await fixture();
    await setGlobal({ forge: { javascript: { enabled: true } } });
    await setProject({ forge: { javascript: { timeoutMs: 1000 } } });
    const { config } = await loadConfigWithProvenance(workspace, { trustProject: true });
    expect(config.forge.javascript.enabled).toBe(true);
  });
});
