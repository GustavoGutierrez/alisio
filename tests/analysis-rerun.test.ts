/**
 * Rerun (spec §19): the same script and the same inputs (verified by sha256) as a NEW execution
 * with new artifacts that carry `rerunOf`; the original execution and artifacts are never
 * touched; a missing or changed input, a missing script or an unknown reference runs nothing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../packages/core/src/core/contracts.ts";
import { type AnalysisHarness, analysisHarness, fake } from "./analysis-run-helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function harness(options: Parameters<typeof analysisHarness>[0] = {}) {
  const h = await analysisHarness(options);
  cleanups.push(() => h.dispose());
  return h;
}

const rootOf = (h: AnalysisHarness) => h.store.rootOf(h.session);
const artifacts = (h: AnalysisHarness) => h.artifacts.list(rootOf(h), { includeDeleted: true });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A first run that reads one workspace file and publishes report.md. */
async function firstRun(h: AnalysisHarness, extra: Record<string, unknown> = {}) {
  await writeFile(join(h.workspace, "data.csv"), "a,b\n1,2\n");
  const code = fake({ files: { "report.md": "# Report v1\n" }, stdout: "first\n" });
  const { text, result } = await h.run({ code, inputs: [{ path: "data.csv" }], ...extra });
  expect(result.isError).toBeFalsy();
  const [artifact] = artifacts(h);
  return { code, text, artifact: artifact as NonNullable<typeof artifact> };
}

describe("rerun", () => {
  it("runs the same script on the same inputs as a new execution with new artifacts and rerunOf", async () => {
    const h = await harness();
    const first = await firstRun(h);
    const before = await readFile(h.artifacts.localPath(first.artifact), "utf8");
    const { text, result } = await h.run({ rerunOf: first.artifact.id });
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/^rerun of exec_\S+ · exit 0 .* published 1 artifact: report\.md/);
    const [one, two] = h.executions();
    expect(h.executions()).toHaveLength(2);
    expect(two?.script_sha256).toBe(one?.script_sha256);
    expect(one?.script_sha256).toBe(sha(first.code));
    expect(two?.rerun_of).toBe(one?.id);
    expect(two?.id).not.toBe(one?.id);
    expect(two?.rel_dir).not.toBe(one?.rel_dir);
    const all = artifacts(h);
    expect(all).toHaveLength(2);
    const fresh = all.find((a) => a.id !== first.artifact.id);
    expect(fresh?.provenance).toMatchObject({
      rerunOf: one?.id,
      rerunOfArtifact: first.artifact.id,
      scriptSha256: sha(first.code),
    });
    expect(fresh?.executionId).toBe(two?.id);
    // The input was verified and carried over to the new job.
    expect(fresh?.provenance.inputs).toEqual([{ name: "data.csv", sha256: sha("a,b\n1,2\n") }]);
    expect(await readFile(join(h.state, String(two?.rel_dir), "input", "data.csv"), "utf8")).toBe(
      "a,b\n1,2\n",
    );
  });

  it("never overwrites the previous execution or its artifacts", async () => {
    const h = await harness();
    const first = await firstRun(h);
    const original = h.executions()[0];
    const originalFolder = join(h.state, String(original?.rel_dir));
    const originalFiles = await readFile(join(originalFolder, "job.json"), "utf8");
    await h.run({ rerunOf: first.artifact.id });
    const after = h.artifacts.get(first.artifact.id);
    expect(after).toMatchObject({ status: "ready", bytes: first.artifact.bytes });
    expect(after?.relDir).toBe(first.artifact.relDir);
    expect(await readFile(h.artifacts.localPath(first.artifact), "utf8")).toBe("# Report v1\n");
    expect(await readFile(join(originalFolder, "job.json"), "utf8")).toBe(originalFiles);
    expect(h.executions()[0]).toMatchObject({ id: original?.id, status: "completed" });
    // A second rerun of the same artifact makes a third, independent execution.
    await h.run({ rerunOf: first.artifact.id });
    expect(h.executions()).toHaveLength(3);
    expect(artifacts(h)).toHaveLength(3);
  });

  it("accepts an execution id as the reference", async () => {
    const h = await harness();
    await firstRun(h);
    const { result } = await h.run({ rerunOf: String(h.executions()[0]?.id) });
    expect(result.isError).toBeFalsy();
    expect(h.executions()).toHaveLength(2);
  });

  it("a changed input runs nothing and reports it", async () => {
    const h = await harness();
    const first = await firstRun(h);
    const original = h.executions()[0];
    await writeFile(join(h.state, String(original?.rel_dir), "input", "data.csv"), "a,b\n9,9\n");
    const { text, result } = await h.run({ rerunOf: first.artifact.id });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/rerun refused; nothing was executed/);
    expect(text).toMatch(/Input data\.csv changed/);
    expect(h.executions()).toHaveLength(1);
    expect(artifacts(h)).toHaveLength(1);
  });

  it("a missing input runs nothing and reports it", async () => {
    const h = await harness();
    const first = await firstRun(h);
    const original = h.executions()[0];
    await rm(join(h.state, String(original?.rel_dir), "input", "data.csv"));
    const { text, result } = await h.run({ rerunOf: first.artifact.id });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/Input data\.csv is missing/);
    expect(h.executions()).toHaveLength(1);
  });

  it("reports every problem at once", async () => {
    const h = await harness();
    await writeFile(join(h.workspace, "a.csv"), "1\n");
    await writeFile(join(h.workspace, "b.csv"), "2\n");
    await h.run({
      code: fake({ files: { "r.md": "x" } }),
      inputs: [{ path: "a.csv" }, { path: "b.csv" }],
    });
    const original = h.executions()[0];
    await rm(join(h.state, String(original?.rel_dir), "input", "a.csv"));
    await writeFile(join(h.state, String(original?.rel_dir), "input", "b.csv"), "changed");
    const { text } = await h.run({ rerunOf: String(original?.id) });
    expect(text).toMatch(/a\.csv is missing/);
    expect(text).toMatch(/b\.csv changed/);
  });

  it("a script that is no longer on disk runs nothing", async () => {
    const h = await harness();
    const first = await firstRun(h);
    const original = h.executions()[0];
    await rm(join(h.state, String(original?.rel_dir), "script"), { recursive: true });
    const { text, result } = await h.run({ rerunOf: first.artifact.id });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/script of exec_\S+ is no longer available/);
    expect(h.executions()).toHaveLength(1);
  });

  it("refuses a script that no longer matches its recorded hash", async () => {
    const h = await harness();
    const first = await firstRun(h);
    const original = h.executions()[0];
    await writeFile(join(h.state, String(original?.rel_dir), "script", "main.py"), "# tampered\n");
    const { text } = await h.run({ rerunOf: first.artifact.id });
    expect(text).toMatch(/does not match its recorded hash/);
    expect(h.executions()).toHaveLength(1);
  });

  it("refuses references that are unknown, from another session, deleted or not from python_run", async () => {
    const h = await harness();
    const first = await firstRun(h);
    const text = async (ref: string) => (await h.run({ rerunOf: ref })).text;
    expect(await text("art_missing")).toMatch(/was not found in this session/);
    expect(await text("nonsense")).toMatch(/neither an artifact/);
    // Another session of the same workspace does not see it.
    const other = h.store.create(h.workspace, "fake", "fake-model").id;
    const foreign = await h.runner.runToolCall(other, "python_run", { rerunOf: first.artifact.id });
    expect(h.text(foreign.result)).toMatch(/was not found in this session/);
    // A text artifact has no script.
    const made = await h.artifacts.publishText(
      { fileName: "notes.md", text: "x" },
      { sessionId: h.session, rootSessionId: rootOf(h), workspace: h.workspace },
    );
    expect(await text(made.artifact.id)).toMatch(/was not produced by python_run/);
    await h.artifacts.delete(first.artifact.id);
    expect(await text(first.artifact.id)).toMatch(/was deleted/);
    expect(h.executions()).toHaveLength(1);
  });

  it("still works after the artifact expired (the folder is gone, the script stays)", async () => {
    const h = await harness();
    const first = await firstRun(h);
    expect(await h.artifacts.markExpired(first.artifact.id)).toBe(true);
    expect(existsSync(h.artifacts.folder(first.artifact))).toBe(false);
    const { result } = await h.run({ rerunOf: first.artifact.id });
    expect(result.isError).toBeFalsy();
    const ready = h.artifacts.list(rootOf(h));
    expect(ready).toHaveLength(1);
    expect(h.artifacts.get(first.artifact.id)?.status).toBe("expired");
  });

  it("needs exactly one of code and rerunOf", async () => {
    const h = await harness();
    const first = await firstRun(h);
    const both = await h.run({ code: fake({}), rerunOf: first.artifact.id });
    expect(both.text).toMatch(/either code or rerunOf/);
    const none = await h.run({});
    expect(none.text).toMatch(/needs code/);
  });

  it("uses the same capability gate: it asks, shows the saved script and runs nothing when denied", async () => {
    const requests: ApprovalRequest[] = [];
    let answer: "once" | "deny" = "once";
    const h = await harness({
      policy: { analysis: false },
      approve: async (request) => {
        requests.push(request);
        return answer;
      },
    });
    const first = await firstRun(h);
    expect(requests).toHaveLength(1); // the first run asked too
    requests.length = 0;
    answer = "deny";
    const denied = await h.run({ rerunOf: first.artifact.id });
    expect(denied.result.isError).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ capability: "analysis.run" });
    expect(requests[0]?.preview).toContain("# fake:");
    expect(h.executions()).toHaveLength(1);
    answer = "once";
    const allowed = await h.run({ rerunOf: first.artifact.id });
    expect(allowed.result.isError).toBeFalsy();
    expect(h.executions()).toHaveLength(2);
  });

  it("repeats a dataset input while the dataset exists and refuses once it is gone", async () => {
    const h = await harness();
    const file = join(h.workspace, "sales.csv");
    await writeFile(file, "region,total\nnorth,10\nsouth,20\n");
    const { record } = await h.datasets.ingest({
      rootSessionId: rootOf(h),
      sessionId: h.session,
      workspace: h.workspace,
      path: file,
    });
    const { result } = await h.run({
      code: fake({ files: { "r.md": "x" } }),
      inputs: [{ datasetId: record.id }],
    });
    expect(result.isError).toBeFalsy();
    const first = artifacts(h)[0];
    const again = await h.run({ rerunOf: String(first?.id) });
    expect(again.result.isError).toBeFalsy();
    const second = h.executions()[1];
    expect(existsSync(join(h.state, String(second?.rel_dir), "input", "sales.sqlite"))).toBe(true);
    await h.datasets.remove(record);
    const gone = await h.run({ rerunOf: String(first?.id) });
    expect(gone.result.isError).toBe(true);
    expect(gone.text).toMatch(/dataset .* no longer exists/);
    expect(h.executions()).toHaveLength(2);
  });

  it("asks again for the extras the original run needed", async () => {
    const asked: string[] = [];
    let installed = false;
    const h = await harness({
      policy: { analysis: true },
      approve: async (request) => {
        asked.push(request.capability ?? "effect");
        return "once";
      },
      deps: {
        runtime: {
          interpreter: async () => ({
            ok: true,
            executable: process.execPath,
            prefixArgs: [join(process.cwd(), "fixtures", "fake-python.mjs")],
            version: "3.12.0",
            source: "python3",
          }),
          hasExtras: async () => installed,
          installExtras: async () => {
            installed = true;
            return {
              runtimeVersion: "x",
              python: "p",
              pythonVersion: "3.12.0",
              extras: ["analysis" as const],
              createdAt: 0,
              ok: true,
            };
          },
        },
      },
    });
    await h.run({ code: fake({ files: { "r.md": "x" } }), extras: ["analysis"] });
    expect(asked).toEqual(["analysis.install"]);
    installed = false; // the environment was removed meanwhile
    await h.run({ rerunOf: String(artifacts(h)[0]?.id) });
    expect(asked).toEqual(["analysis.install", "analysis.install"]);
  });
});
