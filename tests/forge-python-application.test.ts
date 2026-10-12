/**
 * `python_run` wired into the Application (Python spec §4.1, P2): it shares the kernel, the journal
 * and the state store with `js_run`, `codePath` and `$ALISIO_SCRATCH_DIR` follow the Forja
 * scratchpad (same gate as `js_run`), and with Forja off nothing about the tool changes except the
 * journal row and the engine line.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisRuntimeManager } from "../packages/core/src/analysis/runtime-manager.ts";
import { createApplication } from "../packages/core/src/index.ts";
import { fake, fakeInterpreter } from "./analysis-run-helpers.ts";

let root: string;
let workspace: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-forge-py-app-"));
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

async function app() {
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
  });
  apps.push(created);
  return created;
}
const enableForge = () =>
  writeFile(
    join(root, "config", "config.json"),
    JSON.stringify({
      forge: { javascript: { enabled: true }, scratch: { root: join(root, "tmp") } },
    }),
  );
const pythonRun = (a: Awaited<ReturnType<typeof app>>) =>
  a.registry.list().find((t) => t.name === "python_run");
const text = (result: { content: Array<{ type: string }> }) =>
  result.content
    .flatMap((p) => (p.type === "text" ? [(p as unknown as { text: string }).text] : []))
    .join("\n");

describe("with Forja on", () => {
  it("records the run in the shared journal, linked to its analysis execution", async () => {
    await enableForge();
    const a = await app();
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const { result } = await a.runner.runToolCall(session, "python_run", {
      code: fake({ files: { "r.md": "x" } }),
    });
    expect(result.isError).toBeFalsy();
    const [row] = a.forge.journal.listByRoot(session);
    expect(row).toMatchObject({
      engine: "python-managed",
      isolation: "none",
      status: "succeeded",
      // Default `auto` with nothing isolated ready: the host, with the reason for each skipped backend.
      selectionReason: expect.stringMatching(
        /^analysis\.runtime=auto, analysis\.isolation=preferred: managed is ready; oci: not ready \(.+\); wasm: not ready \(Pyodide (is not installed|needs Node .+)\)$/,
      ),
    });
    const analysis = a.store.db.prepare("SELECT id FROM analysis_executions").get() as {
      id: string;
    };
    expect(row?.analysisExecutionId).toBe(analysis.id);
  });

  it("offers codePath and exposes the scratchpad read-only to the script", async () => {
    await enableForge();
    const a = await app();
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const pad = (await a.forge.scratchpad?.(session)) as string;
    await writeFile(join(pad, "notes.txt"), "kept between runs");
    await writeFile(join(pad, "plan.py"), fake({ scratch: { read: "notes.txt" } }));
    const { result } = await a.runner.runToolCall(session, "python_run", { codePath: "plan.py" });
    expect(result.isError).toBeFalsy();
    const report = JSON.parse(/SCRATCH:(.*)/.exec(text(result))?.[1] ?? "{}") as {
      dir: string;
      read: string;
    };
    expect(report).toEqual({ dir: pad, read: "kept between runs" });
    // The live log of the execution goes to the session's tasks/ folder, like a js_run's.
    const row = a.forge.journal.listByRoot(session)[0];
    expect(await readFile(join(pad, "..", "tasks", `${row?.id}.log`), "utf8")).toMatch(/started/);
  });
});

describe("the model's guidance", () => {
  it("python_run keeps its description byte for byte; codePath lives in the schema and the routing rule", async () => {
    await enableForge();
    const a = await app();
    expect(pythonRun(a)?.description).not.toMatch(/codePath|SCRATCH/);
    expect(JSON.stringify(pythonRun(a)?.inputSchema)).toContain("codePath");
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const prompt = await a.context.instructions(session);
    expect(prompt).toMatch(/`python_run` `codePath` \(\.py\)/);
  });
});

describe("forge_guide with Python", () => {
  it("offers the python topics and python.environment describes the backend python_run would use", async () => {
    await enableForge();
    const a = await app();
    const guide = a.registry.list().find((t) => t.name === "forge_guide");
    const topics = (guide?.inputSchema as { properties: { topic: { enum: string[] } } }).properties
      .topic.enum;
    expect(topics).toContain("python.environment");
    expect(topics).toContain("js.api");
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const { result } = await a.runner.runToolCall(session, "forge_guide", {
      topic: "python.environment",
    });
    expect(result.isError).toBeFalsy();
    // The same default `auto` as the selection test above: nothing isolated is ready, the host is.
    expect(text(result)).toContain("Backend that runs your next script: managed");
    expect(text(result)).toContain("Isolation: none");
    expect(text(result)).not.toContain("--network=none");
    // The pointer in python_run results is on, the description is untouched.
    expect(pythonRun(a)?.description).not.toMatch(/forge_guide/);
  });

  it("with Forja off the tool does not exist, though python_run does", async () => {
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify({ forge: { javascript: { enabled: false } } }),
    );
    const a = await app();
    expect(pythonRun(a)).toBeDefined();
    expect(a.registry.list().some((t) => t.name === "forge_guide")).toBe(false);
  });
});

describe("with Forja off (forge.javascript.enabled: false)", () => {
  it("python_run is as before: no codePath, no scratchpad variable; the run is still journaled", async () => {
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify({ forge: { javascript: { enabled: false } } }),
    );
    const a = await app();
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const { result } = await a.runner.runToolCall(session, "python_run", {
      code: fake({ scratch: {} }),
    });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('SCRATCH:{"dir":null}');
    expect(a.forge.journal.listByRoot(session)).toHaveLength(1);
    const refused = await a.runner.runToolCall(session, "python_run", { codePath: "plan.py" });
    expect(refused.result.isError).toBe(true);
    expect(text(refused.result)).toMatch(/needs the session scratchpad/);
  });
});
