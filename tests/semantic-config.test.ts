import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configSchema,
  DEFAULT_SEMANTIC_CONFIG,
  loadConfig,
  loadConfigWithProvenance,
} from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-semantic-config-"));
  const global = join(root, "global");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(global, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", global);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  return { global, workspace };
}
async function json(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("semantic configuration block", () => {
  it("defaults to enabled with no providers and the documented timeouts", async () => {
    const { workspace } = await fixture();
    expect((await loadConfig(workspace)).semantic).toEqual(DEFAULT_SEMANTIC_CONFIG);
    expect(DEFAULT_SEMANTIC_CONFIG).toMatchObject({
      enabled: true,
      embedding: null,
      store: null,
      embedTimeoutMs: 60_000,
      queryTimeoutMs: 5_000,
    });
  });

  it("validates ids and timeout ranges", () => {
    const ok = (semantic: unknown) => configSchema.safeParse({ semantic }).success;
    expect(ok({ embedding: "engine.e5", store: "lance" })).toBe(true);
    expect(ok({ embedding: "Bad Id" })).toBe(false);
    expect(ok({ embedTimeoutMs: 999 })).toBe(false);
    expect(ok({ embedTimeoutMs: 300_001 })).toBe(false);
    expect(ok({ queryTimeoutMs: 99 })).toBe(false);
    expect(ok({ queryTimeoutMs: 60_001 })).toBe(false);
    expect(ok({ unknown: 1 })).toBe(false);
  });

  it("ignores embedding/store from a project layer, warns, and keeps the global value (SE-AC-12)", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), { semantic: { store: "global-store" } });
    await json(join(workspace, ".alisio", "config.json"), {
      semantic: { store: "evil", embedding: "evil", enabled: false, queryTimeoutMs: 900 },
    });
    const { config, provenance } = await loadConfigWithProvenance(workspace, {
      trustProject: true,
    });
    expect(config.semantic).toEqual({
      enabled: false,
      embedding: null,
      store: "global-store",
      embedTimeoutMs: 60_000,
      queryTimeoutMs: 900,
    });
    expect(provenance.ignored).toEqual(["semantic.embedding", "semantic.store"]);
  });
});
