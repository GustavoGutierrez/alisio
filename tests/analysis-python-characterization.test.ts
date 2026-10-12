/**
 * Characterization of `python_run` (Forja Python spec §10.1, phase P1): what the tool answers and
 * records, pinned BEFORE it was moved onto the Forja kernel (all of these passed against the code
 * of that day). They describe observable behavior (the text the model reads, the rows and artifacts
 * a run leaves, the container arguments), not the implementation, and they run against the fake
 * interpreter and the fake container CLI, so no Python, network or container engine is needed.
 *
 * The only expectation that changed in P2 is PD11: the text gained one last line naming the
 * engine, the isolation and the reason (`MANAGED_LINE` / `OCI_LINE`). Everything above it is as it
 * was.
 *
 * Already pinned elsewhere and not repeated here: the `analysis.install` approval of `extras` and
 * the headless refusal (analysis-extras), the rerun round trip (analysis-rerun), the cancel and
 * timeout lifecycle (analysis-python-run, analysis-oci) and `409 runs_active` of
 * `/api/artifacts/:aid/rerun` (server-analysis-phase4).
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { type OciHost, OciRuntime, ociRunArgs } from "../packages/core/src/analysis/oci.ts";
import {
  type AnalysisHarness,
  analysisHarness,
  FAKE_CONTAINER,
  fake,
} from "./analysis-run-helpers.ts";

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
/** The text with run-specific numbers made stable (duration, execution and artifact ids). */
const normalized = (text: string) =>
  text
    .replace(/in \d+\.\ds/, "in <s>s")
    .replace(/exec_[0-9A-Za-z]+/g, "<exec>")
    .replace(/art_[0-9A-Za-z]+/g, "<art>");
/** PD11 (Python spec §5): the last line of the text, which P2 added. */
const MANAGED_LINE = "engine: python-managed (none) · reason: analysis.runtime=managed";
const RERUN_LINE = "engine: python-managed (none) · reason: rerun: original backend managed";
const OCI_LINE = "engine: python-oci (os-container) · reason: analysis.runtime=oci";
const uiKinds = (result: ToolResult) =>
  result.content.flatMap((part) => (part.type === "ui" ? [part.block.kind] : []));

describe("python_run text for the model (managed)", () => {
  it("success: head line, then stdout and stderr tails", async () => {
    const h = await harness();
    const { text, result } = await h.run({
      code: fake({ files: { "report.md": "# R\n" }, stdout: "hello\n", stderr: "careful\n" }),
    });
    expect(result.isError).toBeFalsy();
    expect(normalized(text)).toBe(
      [
        "exit 0 in <s>s · published 1 artifact: report.md (document, 4 B, <art>)",
        "--- stdout (last 4 KB) ---",
        "hello",
        "",
        "--- stderr (last 4 KB) ---",
        "careful",
        MANAGED_LINE,
      ].join("\n"),
    );
    expect(uiKinds(result)).toEqual(["terminal", "artifact"]);
  });

  it("a script with no output has only the head line", async () => {
    const h = await harness();
    const { text } = await h.run({ code: fake({ files: { "a.md": "x" } }) });
    expect(normalized(text)).toBe(
      `exit 0 in <s>s · published 1 artifact: a.md (document, 1 B, <art>)\n${MANAGED_LINE}`,
    );
  });

  it("a script that produces nothing says it published 0 artifacts", async () => {
    const h = await harness();
    const { text, result } = await h.run({ code: fake({ stdout: "only text" }) });
    expect(result.isError).toBeFalsy();
    expect(normalized(text)).toBe(
      `exit 0 in <s>s · published 0 artifacts\n--- stdout (last 4 KB) ---\nonly text\n${MANAGED_LINE}`,
    );
  });

  it("error: a tool error that says nothing was published, with the stderr tail", async () => {
    const h = await harness();
    const { text, result } = await h.run({
      code: fake({ files: { "a.md": "x" }, exit: 3, stderr: "boom\n" }),
    });
    expect(result.isError).toBe(true);
    expect(normalized(text)).toBe(
      `exit 3 in <s>s · nothing was published (non-zero exit; pass publishOnError to keep partial outputs)\n--- stderr (last 4 KB) ---\nboom\n${MANAGED_LINE}`,
    );
    expect(uiKinds(result)).toEqual(["terminal"]);
    expect(artifacts(h)).toHaveLength(0);
    const [execution] = h.executions();
    expect(execution).toMatchObject({ status: "failed", exit_code: 3 });
  });

  it("publishOnError keeps the files of a failed run as partial artifacts, and the run stays an error", async () => {
    const h = await harness();
    const { text, result } = await h.run({
      code: fake({ files: { "partial.md": "half" }, exit: 2 }),
      publishOnError: true,
    });
    expect(result.isError).toBe(true);
    expect(normalized(text)).toBe(
      `exit 2 in <s>s · published 1 artifact: partial.md (document, 4 B, <art>)\n${MANAGED_LINE}`,
    );
    const [artifact] = artifacts(h);
    expect(artifact).toMatchObject({ fileName: "partial.md", partial: true, kind: "document" });
    expect(uiKinds(result)).toEqual(["terminal", "artifact"]);
  });

  it("timeout: a tool error naming the limit and the execution, with the output tail", async () => {
    const h = await harness({ deps: { limits: { timeoutMs: 1000, maxLogBytes: 1_000_000 } } });
    const { text, result } = await h.run({
      code: fake({ files: { "late.md": "x" }, stdout: "started\n", sleepMs: 10_000 }),
      timeoutMs: 1000,
    });
    expect(result.isError).toBe(true);
    expect(normalized(text)).toBe(
      `timed out after 1s; nothing was published (<exec>)\n--- output (last 4 KB) ---\nstarted\n${MANAGED_LINE}`,
    );
    expect(uiKinds(result)).toEqual(["terminal"]);
    expect(h.executions()[0]).toMatchObject({ status: "timed_out" });
    expect(artifacts(h)).toHaveLength(0);
  }, 15_000);

  it("only the last 4 KB of a long stdout reaches the model", async () => {
    const h = await harness();
    const { text } = await h.run({ code: fake({ stdout: `${"x".repeat(10_000)}END\n` }) });
    const section = (text.split("--- stdout (last 4 KB) ---\n")[1] ?? "").replace(MANAGED_LINE, "");
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(4 * 1024);
    expect(section.endsWith("END\n")).toBe(true);
  });

  it("a script that prints lines that look like protocol frames keeps them as plain output", async () => {
    // Without the per-run nonce nothing may interpret them.
    const h = await harness();
    const line =
      '\u001eALISIO-FORGE:not-the-nonce:{"protocol":1,"type":"progress","seq":0,"payload":{"message":"x"}}';
    const { text, result } = await h.run({ code: fake({ stdout: `${line}\n` }) });
    expect(result.isError).toBeFalsy();
    expect(text).toContain("ALISIO-FORGE:not-the-nonce");
  });
});

describe("artifacts and provenance of a managed run", () => {
  it("publishes names and kinds as written, with the runtime, script hash and inputs in the provenance", async () => {
    const h = await harness();
    await writeFile(join(h.workspace, "data.csv"), "a,b\n1,2\n");
    const code = fake({
      files: { "report.md": "# R\n", "chart.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" },
    });
    await h.run({ code, inputs: [{ path: "data.csv" }], title: "My analysis" });
    const published = artifacts(h);
    expect(published.map((a) => [a.fileName, a.kind]).sort()).toEqual([
      ["chart.svg", "image"],
      ["report.md", "document"],
    ]);
    const execution = h.executions()[0];
    for (const artifact of published) {
      expect(artifact.executionId).toBe(execution?.id);
      expect(artifact.provenance).toMatchObject({
        runtime: { mode: "managed", python: "3.12.0", extras: [] },
        scriptSha256: sha(code),
        inputs: [{ name: "data.csv", sha256: sha("a,b\n1,2\n") }],
      });
      expect(artifact.provenance).not.toHaveProperty("rerunOf");
    }
    expect(execution).toMatchObject({ runtime: "managed", script_sha256: sha(code) });
  });

  it("a rerun is a new execution whose artifacts name the original (rerunOf, rerunOfArtifact)", async () => {
    const h = await harness();
    const code = fake({ files: { "report.md": "# R\n" } });
    await h.run({ code });
    const [original] = artifacts(h);
    const { text } = await h.run({ rerunOf: original?.id });
    expect(normalized(text)).toBe(
      `rerun of <exec> · exit 0 in <s>s · published 1 artifact: report.md (document, 4 B, <art>)\n${RERUN_LINE}`,
    );
    const fresh = artifacts(h).find((a) => a.id !== original?.id);
    expect(fresh?.provenance).toMatchObject({
      scriptSha256: sha(code),
      rerunOf: original?.executionId,
      rerunOfArtifact: original?.id,
    });
  });

  it("a rerun with a saved script that no longer matches its hash runs nothing and says why", async () => {
    const h = await harness();
    await h.run({ code: fake({ files: { "report.md": "# R\n" } }) });
    const [original] = artifacts(h);
    const execution = h.executions()[0];
    await writeFile(join(h.state, String(execution?.rel_dir), "script", "main.py"), "# tampered\n");
    const { text, result } = await h.run({ rerunOf: original?.id });
    expect(result.isError).toBe(true);
    expect(normalized(text)).toBe(
      "rerun refused; nothing was executed:\n- The saved script of <exec> does not match its recorded hash",
    );
    expect(h.executions()).toHaveLength(1);
  });

  it("a rerun whose recorded input still matches by hash runs", async () => {
    const h = await harness();
    await writeFile(join(h.workspace, "data.csv"), "a,b\n1,2\n");
    await h.run({ code: fake({ files: { "report.md": "x" } }), inputs: [{ path: "data.csv" }] });
    const [original] = artifacts(h);
    // The original workspace file changing does not matter: the rerun uses the verified copy.
    await writeFile(join(h.workspace, "data.csv"), "changed\n");
    const { result } = await h.run({ rerunOf: original?.id });
    expect(result.isError).toBeFalsy();
  });
});

describe("python_run in container mode (fake container CLI)", () => {
  const IMAGE = `registry.example/python@sha256:${"b".repeat(64)}`;

  async function ociHarness() {
    const engineState = await mkdtemp(join(tmpdir(), "alisio-char-engine-"));
    const runtime = new OciRuntime(
      { engine: "docker", memoryMb: 512, cpus: 1, image: IMAGE },
      {
        locate: async () => process.execPath,
        prefixArgs: [FAKE_CONTAINER, engineState],
        host: async () => ({ platform: process.platform, uid: 1000, gid: 1000 }),
      },
    );
    const h = await harness({
      deps: {
        runtime: { interpreter: async () => ({ ok: false, reason: "no host python" }) },
        oci: { mode: () => "oci", runtime: () => runtime },
      },
    });
    cleanups.push(() => rm(engineState, { recursive: true, force: true }));
    return h;
  }

  it("answers like a managed run and records the engine and image in the provenance", async () => {
    const h = await ociHarness();
    const { text, result } = await h.run({
      code: fake({ files: { "report.md": "# R\n" }, stdout: "hi\n" }),
    });
    expect(result.isError).toBeFalsy();
    expect(normalized(text)).toBe(
      `exit 0 in <s>s · published 1 artifact: report.md (document, 4 B, <art>)\n--- stdout (last 4 KB) ---\nhi\n${OCI_LINE}`,
    );
    const [artifact] = artifacts(h);
    expect(artifact?.provenance).toMatchObject({
      runtime: { mode: "oci", engine: "docker", image: IMAGE, extras: [] },
    });
    expect(h.executions()[0]).toMatchObject({ runtime: "oci" });
  });

  it("an unavailable container runtime answers runtime_unavailable and creates no job", async () => {
    const runtime = new OciRuntime({ engine: "docker", memoryMb: 512, cpus: 1 });
    const h = await harness({ deps: { oci: { mode: () => "oci", runtime: () => runtime } } });
    const { text, result } = await h.run({ code: fake({}) });
    expect(result.isError).toBe(true);
    expect(text).toMatch(
      /^runtime_unavailable: analysis\.runtime is "oci" but analysis\.oci\.image is not set/,
    );
    expect(h.executions()).toHaveLength(0);
  });
});

describe("ociRunArgs", () => {
  const host: OciHost = { platform: "linux", uid: 1000, gid: 1000 };
  const IMAGE = `registry.example/python@sha256:${"b".repeat(64)}`;
  const mounts = {
    script: "/state/jobs/exec_1/script",
    input: "/state/jobs/exec_1/input",
    work: "/state/jobs/exec_1/work",
    staging: "/state/jobs/exec_1/staging",
  };

  it("is exactly this argument list for a plain run (any new option must be additive)", () => {
    expect(
      ociRunArgs({
        settings: { engine: "docker", image: IMAGE, memoryMb: 2048, cpus: 2 },
        executionId: "exec_1",
        mounts,
        host,
      }),
    ).toEqual([
      "run",
      "--rm",
      "--name",
      "alisio-exec_1",
      "--label",
      "alisio=analysis",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=2048m",
      "--memory-swap=2048m",
      "--cpus=2",
      "--user",
      "1000:1000",
      "-v",
      `${mounts.script}:/job/script:ro`,
      "-v",
      `${mounts.input}:/job/input:ro`,
      "-v",
      `${mounts.work}:/job/work:rw`,
      "-v",
      `${mounts.staging}:/job/out:rw`,
      "--tmpfs",
      "/tmp:size=256m",
      "-e",
      "ALISIO_INPUT_DIR=/job/input",
      "-e",
      "ALISIO_OUTPUT_DIR=/job/out",
      "-e",
      "ALISIO_WORK_DIR=/job/work",
      "-e",
      "ALISIO_EXECUTION_ID=exec_1",
      "-e",
      "HOME=/job/work",
      "-e",
      "TMPDIR=/tmp",
      "-e",
      "MPLCONFIGDIR=/job/work/.matplotlib",
      "-e",
      "MPLBACKEND=Agg",
      "-e",
      "PYTHONDONTWRITEBYTECODE=1",
      "-e",
      "PYTHONUNBUFFERED=1",
      "-e",
      "PYTHONNOUSERSITE=1",
      "-e",
      "PYTHONIOENCODING=utf-8",
      "-w",
      "/job/work",
      IMAGE,
      "python",
      "-E",
      "-s",
      "-B",
      "-u",
      "-X",
      "utf8",
      "/job/script/main.py",
    ]);
  });
});

describe("the job folder a run leaves", () => {
  it("keeps the script, the runtime helpers and the full logs, and records the inputs for a rerun", async () => {
    const h = await harness();
    await writeFile(join(h.workspace, "data.csv"), "a\n1\n");
    await h.run({
      code: fake({ files: { "r.md": "x" }, stdout: "out-line\n" }),
      inputs: [{ path: "data.csv" }],
      extras: [],
    });
    const folder = join(h.state, String(h.executions()[0]?.rel_dir));
    expect(await readFile(join(folder, "script", "main.py"), "utf8")).toContain("# fake:");
    expect(await readFile(join(folder, "logs", "stdout.log"), "utf8")).toBe("out-line\n");
    const job = JSON.parse(await readFile(join(folder, "job.json"), "utf8")) as {
      inputs: Array<{ name: string }>;
      runtime: string;
    };
    expect(job).toMatchObject({ runtime: "managed", inputs: [{ name: "data.csv" }] });
  });
});
