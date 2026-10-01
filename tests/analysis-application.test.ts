/**
 * Phase 4 wired into the Application: the container mode from the user configuration, the
 * provenance (model and provider) of every artifact, live application of the analysis settings,
 * and the project layer not being able to pick the runtime, the image or the retention.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisRuntimeManager } from "../packages/core/src/analysis/runtime-manager.ts";
import { createApplication } from "../packages/core/src/index.ts";
import { FAKE_CONTAINER, fake, fakeInterpreter } from "./analysis-run-helpers.ts";

const DIGEST = `sha256:${"d".repeat(64)}`;
let root: string;
let workspace: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-analysis-app-"));
  workspace = join(root, "ws");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const silent: ModelProvider = {
  id: "fake-provider",
  model: "fake-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
};

async function app(options: Parameters<typeof createApplication>[0] = {}) {
  const manager = Object.assign(new AnalysisRuntimeManager({ stateDir: join(root, "state") }), {
    interpreter: fakeInterpreter,
  });
  const created = await createApplication({
    cwd: workspace,
    db: join(root, "state", "sessions.sqlite"),
    noHerdr: true,
    provider: silent,
    analysisRuntime: manager,
    allowAnalysis: true,
    ...options,
  });
  apps.push(created);
  return created;
}

const write = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));

describe("Application wiring", () => {
  it("records the model and provider in the provenance of every published artifact", async () => {
    const a = await app();
    const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
    await a.runner.runToolCall(session, "python_run", {
      code: fake({ files: { "r.md": "# r" } }),
    });
    const [artifact] = a.artifacts.list(session);
    expect(artifact?.provenance).toMatchObject({
      model: "fake-model",
      provider: "fake-provider",
      runtime: { mode: "managed", python: "3.12.0" },
    });
    // Public: nothing in the manifest names a path of this machine.
    const manifest = await readFile(
      join(a.artifacts.folder(artifact as never), "manifest.json"),
      "utf8",
    );
    expect(manifest).not.toContain(root);
  });

  it("runs in a container when the user configuration says so", async () => {
    const engineState = join(root, "engine");
    await mkdir(engineState, { recursive: true });
    await write(join(root, "config", "config.json"), {
      analysis: {
        runtime: "oci",
        oci: { engine: "docker", image: `registry.example/python@${DIGEST}`, memoryMb: 512 },
      },
    });
    const a = await app({
      analysisOci: {
        locate: async () => process.execPath,
        prefixArgs: [FAKE_CONTAINER, engineState],
        host: async () => ({ platform: process.platform, uid: 1000, gid: 1000 }),
      },
    });
    expect(a.config.analysis.runtime).toBe("oci");
    const description = a.registry.list().find((t) => t.name === "python_run")?.description ?? "";
    expect(description).toMatch(/container/);
    expect(description).not.toMatch(/Managed Python is not a sandbox/);
    const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
    const { result } = await a.runner.runToolCall(session, "python_run", {
      code: fake({ files: { "r.md": "# in a container" } }),
    });
    expect(result.isError).toBeFalsy();
    const [artifact] = a.artifacts.list(session);
    expect(artifact?.provenance.runtime).toMatchObject({ mode: "oci", engine: "docker" });
    const calls = (await readFile(join(engineState, "calls.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.find((c) => c[0] === "run")).toEqual(
      expect.arrayContaining(["--network=none", "--memory=512m"]),
    );
    // The approval of a container run says so (live from the configuration).
    expect(a.analysis.oci.mode()).toBe("oci");
  });

  it("ignores runtime, oci and retention from a trusted project layer and says so", async () => {
    await write(join(workspace, ".alisio", "config.json"), {
      analysis: {
        runtime: "oci",
        oci: { image: `evil@${DIGEST}` },
        retention: { artifactsDays: 1 },
        limits: { timeoutMs: 5000 },
      },
    });
    const a = await app({ trustProject: true });
    expect(a.config.analysis.runtime).toBe("managed");
    expect(a.config.analysis.oci.image).toBeUndefined();
    expect(a.config.analysis.retention.artifactsDays).toBe(0);
    expect(a.config.analysis.limits.timeoutMs).toBe(5000); // limits remain project-settable
    expect(a.configDiagnostics).toEqual(["analysis.runtime", "analysis.oci", "analysis.retention"]);
  });

  it("applies the analysis settings live and persists them to the user configuration", async () => {
    const a = await app();
    await a.updateSetting("analysis.retention.jobsDays", 14);
    await a.updateSetting("analysis.retention.artifactsDays", 90);
    await a.updateSetting("analysis.limits.timeoutMs", 30_000);
    expect(a.config.analysis.retention).toEqual({
      jobsDays: 14,
      intermediateDays: 7,
      artifactsDays: 90,
    });
    expect(a.config.analysis.limits.timeoutMs).toBe(30_000);
    const saved = JSON.parse(await readFile(join(root, "config", "config.json"), "utf8"));
    expect(saved.analysis).toEqual({
      retention: { jobsDays: 14, artifactsDays: 90 },
      limits: { timeoutMs: 30_000 },
    });
    // The timeout of the very next call is the new one, without a restart.
    await a.updateSetting("analysis.limits.timeoutMs", 1000);
    const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
    const began = Date.now();
    const { result } = await a.runner.runToolCall(session, "python_run", {
      code: fake({ sleepMs: 30_000 }),
    });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(JSON.stringify(result.content)).toMatch(/timed out after 1s/);
  });

  it("launches the retention sweep in the background, and only when analysis is on and writable", async () => {
    const mark = join(root, "state", "analysis", ".last-sweep");
    await app({ analysisSweepDelayMs: 20 });
    for (let i = 0; i < 100 && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(mark)).toBe(true);
    await rm(mark);
    // --read-only and analysis.enabled=false never sweep (and register no analysis tools).
    await app({ readOnly: true, analysisSweepDelayMs: 20 });
    await write(join(root, "config", "config.json"), { analysis: { enabled: false } });
    await app({ analysisSweepDelayMs: 20 });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(mark)).toBe(false);
  });

  it("refuses to change a setting under --read-only", async () => {
    const a = await app({ readOnly: true });
    await expect(a.updateSetting("analysis.retention.jobsDays", 3)).rejects.toThrow(/read-only/);
    expect(a.registry.list().some((t) => t.name === "python_run")).toBe(false);
  });
});
