import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ProviderEvent, ToolResult } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { DatasetService } from "../packages/core/src/analysis/data/datasets.ts";
import { AnalysisJobs } from "../packages/core/src/analysis/jobs.ts";
import { createArtifactPublisher } from "../packages/core/src/artifacts/publisher.ts";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { registerAnalysisTools } from "../packages/core/src/tools/analysis.ts";
import { registerDataTools } from "../packages/core/src/tools/data.ts";
import { pythonCommand, realPython } from "./data-helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A runner with the data tools whose model calls `steps` in order (one call per turn). */
async function harness(steps: Array<(results: ToolResult[]) => { name: string; args: unknown }>) {
  const root = await mkdtemp(join(tmpdir(), "alisio-datatools-"));
  const workspace = join(root, "ws");
  await mkdir(workspace);
  const state = join(root, "state");
  const store = new SQLiteStore(join(state, "sessions.sqlite"));
  const datasets = new DatasetService({
    root: state,
    db: store.db,
    python: {
      interpreter: async () => ({
        ok: true,
        executable: "python3",
        version: "3.10.12",
        source: "python3",
      }),
    },
  });
  const artifacts = new ArtifactStore({ root: state, db: store.db });
  const registry = new ToolRegistry();
  registerDataTools(registry, { datasets, rootOf: (id) => store.rootOf(id) });
  registerAnalysisTools(registry, {
    store: artifacts,
    jobs: new AnalysisJobs({ root: state, db: store.db }),
    runtime: {
      interpreter: async () => ({
        ok: true,
        executable: "python3",
        version: "3.10.12",
        source: "python3",
      }),
    },
    datasets,
    rootOf: (id) => store.rootOf(id),
    limits: { timeoutMs: 60_000, maxLogBytes: 1_000_000 },
    startup: { candidates: true, extras: [] },
  });
  cleanups.push(async () => {
    datasets.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const results: ToolResult[] = [];
  let turn = 0;
  const provider: ModelProvider = {
    id: "fake",
    model: "fake-model",
    async *stream(request): AsyncGenerator<ProviderEvent> {
      const last = request.messages.at(-1);
      if (last?.role === "tool") results.push(last.result);
      const step = steps[turn++];
      if (!step) {
        yield { type: "completed", message: { role: "assistant", text: "done", calls: [] } };
        return;
      }
      const call = step(results);
      yield {
        type: "completed",
        message: {
          role: "assistant",
          text: "",
          calls: [{ id: `call-${turn}`, name: call.name, arguments: JSON.stringify(call.args) }],
        },
      };
    },
  };
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: { instructions: async () => "", beforePaths: async () => undefined },
    policy: { write: false, process: false, external: false, analysis: true },
    workspace,
    artifacts: (call, announce) =>
      createArtifactPublisher(
        artifacts,
        {
          sessionId: call.sessionId,
          rootSessionId: store.rootOf(call.sessionId),
          workspace,
          runId: call.runId,
          callId: call.callId,
        },
        announce,
      ),
  });
  const session = store.create(workspace, "fake", "fake-model");
  return {
    workspace,
    state,
    store,
    session: session.id,
    run: () => runner.run(session.id, "go"),
    /** Persisted results (with ui parts), in call order. */
    persisted: () =>
      steps.map((_, i) => store.callResult(session.id, `call-${i + 1}`) as ToolResult),
  };
}

const text = (result: ToolResult | undefined) =>
  (result?.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");

describe("data_inspect and data_query", () => {
  it("describes a workspace CSV, then queries it by dataset id", async () => {
    const h = await harness([
      () => ({ name: "data_inspect", args: { path: "sales.csv" } }),
      (results) => {
        const id = /ds_[0-9A-Z]+/.exec(text(results[0]))?.[0];
        return {
          name: "data_query",
          args: {
            datasetId: id,
            sql: "SELECT region, sum(revenue) AS total FROM data GROUP BY region ORDER BY 1",
          },
        };
      },
    ]);
    await writeFile(join(h.workspace, "sales.csv"), "region,revenue\nWest,10\nEast,20\nWest,5\n");
    await h.run();
    const [inspect, query] = h.persisted();
    expect(text(inspect)).toMatch(/Dataset ds_\w+ "sales\.csv" · csv/);
    expect(text(inspect)).toMatch(/revenue \(integer\)/);
    expect(text(inspect)).toContain("First 3 rows");
    expect(inspect?.isError).toBeFalsy();
    // Tables for the TUI and the web.
    expect(
      inspect?.content
        .filter((p) => p.type === "ui")
        .map((p) => (p as { block: { kind: string } }).block.kind),
    ).toEqual(["table", "table"]);
    expect(text(query)).toContain("East\t20\nWest\t15");
    expect(query?.content.some((p) => p.type === "ui" && p.block.kind === "table")).toBe(true);
    // Nothing is written to the repository.
    expect(await readdir(h.workspace)).toEqual(["sales.csv"]);
  });

  it("reports query rejections and another session's dataset as tool errors", async () => {
    const h = await harness([
      () => ({ name: "data_inspect", args: { path: "a.csv" } }),
      (results) => ({
        name: "data_query",
        args: {
          datasetId: /ds_[0-9A-Z]+/.exec(text(results[0]))?.[0],
          sql: "SELECT 1; DROP TABLE data",
        },
      }),
      () => ({ name: "data_query", args: { datasetId: "ds_other", sql: "SELECT 1" } }),
      () => ({ name: "data_inspect", args: {} }),
      () => ({ name: "data_inspect", args: { path: "a.csv", datasetId: "x" } }),
    ]);
    await writeFile(join(h.workspace, "a.csv"), "x\n1\n");
    await h.run();
    const [, rejected, missing, neither, both] = h.persisted();
    expect(rejected?.isError).toBe(true);
    expect(text(rejected)).toMatch(/^query_rejected: .*one statement/i);
    expect(missing?.isError).toBe(true);
    expect(text(missing)).toMatch(/^not_found: /);
    expect(text(neither)).toMatch(/exactly one of path or datasetId/);
    expect(text(both)).toMatch(/exactly one of path or datasetId/);
  });

  it("stays inside the workspace for paths", async () => {
    const h = await harness([() => ({ name: "data_inspect", args: { path: "../outside.csv" } })]);
    await h.run();
    const [result] = h.persisted();
    expect(result?.isError).toBe(true);
    expect(text(result)).toMatch(/outside the workspace/i);
  });

  it("answers dataset_unsupported for an unsupported file type", async () => {
    const h = await harness([() => ({ name: "data_inspect", args: { path: "data.parquet" } })]);
    await writeFile(join(h.workspace, "data.parquet"), "PAR1");
    await h.run();
    expect(text(h.persisted()[0])).toMatch(/^dataset_unsupported: /);
  });
});

describe.skipIf(!pythonCommand)("python_run with a dataset input", () => {
  it("copies the dataset file and lets the script read it with sqlite3 and alisio_runtime", async () => {
    const script = [
      "import json, sqlite3",
      "from alisio_runtime import datasets, outputs, output_dir",
      "db = datasets.open('sales')",
      "total = db.execute('SELECT sum(revenue) FROM data').fetchone()[0]",
      "cols = [c['name'] for c in datasets.columns('sales')]",
      "try:",
      "    db.execute('DELETE FROM data'); wrote = True",
      "except sqlite3.OperationalError:",
      "    wrote = False",
      "(output_dir() / 'out.json').write_text(json.dumps({'total': total, 'cols': cols, 'wrote': wrote, 'inputs': datasets.inputs()}))",
    ].join("\n");
    const h = await harness([
      () => ({ name: "data_inspect", args: { path: "sales.csv" } }),
      (results) => ({
        name: "python_run",
        args: { code: script, inputs: [{ datasetId: /ds_[0-9A-Z]+/.exec(text(results[0]))?.[0] }] },
      }),
      () => ({ name: "artifact_read", args: { id: "x" } }),
    ]);
    await writeFile(join(h.workspace, "sales.csv"), "region,revenue\nWest,10\nEast,20\n");
    await h.run();
    const run = h.persisted()[1];
    expect(text(run)).toMatch(/exit 0/);
    const artifact = run?.content.find((p) => p.type === "ui" && p.block.kind === "artifact") as
      | { block: { artifact: { id: string; fileName: string } } }
      | undefined;
    expect(artifact?.block.artifact.fileName).toBe("out.json");
    const record = h.store.db.prepare("SELECT rel_dir FROM artifacts").get() as { rel_dir: string };
    const { readFile } = await import("node:fs/promises");
    const out = JSON.parse(
      await readFile(join(h.state, record.rel_dir, "files", "out.json"), "utf8"),
    );
    expect(out).toMatchObject({ total: 30, cols: ["region", "revenue"], wrote: false });
    expect(out.inputs[0]).toMatchObject({
      name: "sales.sqlite",
      kind: "dataset",
      source: "sales.csv",
    });
  });
});
