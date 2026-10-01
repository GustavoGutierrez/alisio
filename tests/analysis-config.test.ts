import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSettableSettingKey,
  loadConfig,
  loadConfigWithProvenance,
  setConfigValue,
  settableSettings,
} from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

const DIGEST = `sha256:${"a".repeat(64)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-analysis-config-"));
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

describe("analysis configuration (runtime, oci, retention)", () => {
  it("defaults to managed with the retention of the spec", async () => {
    const { workspace } = await fixture();
    const { analysis } = await loadConfig(workspace);
    expect(analysis.runtime).toBe("managed");
    expect(analysis.oci).toEqual({ engine: "docker", memoryMb: 2048, cpus: 2 });
    expect(analysis.retention).toEqual({ jobsDays: 30, intermediateDays: 7, artifactsDays: 0 });
  });

  it("rejects an image without a digest while loading the configuration", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      analysis: { runtime: "oci", oci: { image: "python:3.12-slim" } },
    });
    await expect(loadConfig(workspace)).rejects.toThrow(/pinned by digest/);
    // A floating tag with a digest-looking suffix elsewhere is not a digest either.
    await json(join(global, "config.json"), {
      analysis: { oci: { image: "python:3.12@sha256:abc" } },
    });
    await expect(loadConfig(workspace)).rejects.toThrow(/pinned by digest/);
    await json(join(global, "config.json"), {
      analysis: { oci: { image: "-v/:/host@sha256:" + "a".repeat(64) } },
    });
    await expect(loadConfig(workspace)).rejects.toThrow(/pinned by digest/);
  });

  it("accepts a digest-pinned image with its resource limits", async () => {
    const { global, workspace } = await fixture();
    const image = `docker.io/library/python@${DIGEST}`;
    await json(join(global, "config.json"), {
      analysis: { runtime: "oci", oci: { engine: "podman", image, memoryMb: 1024, cpus: 1.5 } },
    });
    const { analysis } = await loadConfig(workspace);
    expect(analysis.runtime).toBe("oci");
    expect(analysis.oci).toEqual({ engine: "podman", image, memoryMb: 1024, cpus: 1.5 });
  });

  it("ignores runtime, oci and retention from a project layer and reports them", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      analysis: { retention: { jobsDays: 10 } },
    });
    await json(join(workspace, ".alisio", "config.json"), {
      analysis: {
        enabled: false,
        runtime: "oci",
        oci: { engine: "podman", image: `evil@${DIGEST}` },
        retention: { artifactsDays: 1 },
        limits: { timeoutMs: 5000 },
      },
    });
    const { config, provenance } = await loadConfigWithProvenance(workspace, {
      trustProject: true,
    });
    // What the project may decide still applies.
    expect(config.analysis.enabled).toBe(false);
    expect(config.analysis.limits.timeoutMs).toBe(5000);
    // What only the user decides does not.
    expect(config.analysis.runtime).toBe("managed");
    expect(config.analysis.oci.image).toBeUndefined();
    expect(config.analysis.retention).toEqual({
      jobsDays: 10,
      intermediateDays: 7,
      artifactsDays: 0,
    });
    expect(provenance.ignored).toEqual(["analysis.runtime", "analysis.oci", "analysis.retention"]);
  });
});

describe("setConfigValue with three-level keys", () => {
  it("writes analysis.retention.* and analysis.limits.timeoutMs next to their siblings", async () => {
    const { global, workspace } = await fixture();
    const file = join(global, "config.json");
    await json(file, {
      schemaVersion: 1,
      provider: { model: "seeded" },
      analysis: { limits: { maxFiles: 50 }, retention: { jobsDays: 3 } },
    });
    await setConfigValue({ key: "analysis.retention.artifactsDays", value: 90 });
    await setConfigValue({ key: "analysis.limits.timeoutMs", value: 60_000 });
    await setConfigValue({ key: "analysis.enabled", value: false });
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.provider.model).toBe("seeded");
    expect(saved.analysis).toEqual({
      enabled: false,
      limits: { maxFiles: 50, timeoutMs: 60_000 },
      retention: { jobsDays: 3, artifactsDays: 90 },
    });
    const loaded = await loadConfig(workspace);
    expect(loaded.analysis.retention).toEqual({
      jobsDays: 3,
      intermediateDays: 7,
      artifactsDays: 90,
    });
    expect(loaded.analysis.limits.timeoutMs).toBe(60_000);
  });

  it("creates the nested objects in an empty file", async () => {
    const { global } = await fixture();
    await setConfigValue({ key: "analysis.retention.intermediateDays", value: 2 });
    expect(JSON.parse(await readFile(join(global, "config.json"), "utf8"))).toEqual({
      analysis: { retention: { intermediateDays: 2 } },
      schemaVersion: 1,
    });
  });

  it("validates with the schema leaf and refuses keys that are not settable", async () => {
    await fixture();
    await expect(setConfigValue({ key: "analysis.limits.timeoutMs", value: 500 })).rejects.toThrow(
      /Invalid value/,
    );
    await expect(setConfigValue({ key: "analysis.retention.jobsDays", value: -1 })).rejects.toThrow(
      /Invalid value/,
    );
    await expect(
      setConfigValue({ key: "analysis.retention.jobsDays", value: "30" }),
    ).rejects.toThrow(/Invalid value/);
    for (const key of ["analysis.runtime", "analysis.oci.image", "analysis.limits.maxFiles"]) {
      expect(isSettableSettingKey(key)).toBe(false);
      await expect(setConfigValue({ key: key as never, value: "x" })).rejects.toThrow(
        /Unknown setting key/,
      );
    }
  });

  it("lists the five analysis keys with their value kinds", () => {
    const byKey = Object.fromEntries(settableSettings().map((s) => [s.key, s.kind]));
    expect(byKey["analysis.enabled"]).toBe("boolean");
    expect(byKey["analysis.limits.timeoutMs"]).toBe("number");
    expect(byKey["analysis.retention.jobsDays"]).toBe("number");
    expect(byKey["analysis.retention.intermediateDays"]).toBe("number");
    expect(byKey["analysis.retention.artifactsDays"]).toBe("number");
  });
});
