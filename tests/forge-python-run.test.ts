/**
 * `python_run` on the Forja kernel (Python spec §10.2, phase P2), through the real runner gates
 * with the fake interpreter and the fake container CLI. Covers FP-AC-01, 02, 03 (explicit `oci`),
 * 09, 10 (managed and oci), 18, 19, 20, 21 (managed and oci; `wasm` is in `forge-python-wasm-run`)
 * and 24, plus FJ-AC-32 and the pieces they rest on: journal, progress, frames, `codePath`. The
 * selection under `auto` and the isolation policy is in `forge-python-wasm-run`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OciRuntime } from "../packages/core/src/analysis/oci.ts";
import { toRef } from "../packages/core/src/artifacts/store.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { JavaScriptEngine } from "../packages/core/src/forge/javascript/engine.ts";
import { IsolateHostFactory } from "../packages/core/src/forge/javascript/hosts/factory.ts";
import { loadQuickJsModule } from "../packages/core/src/forge/javascript/wasm.ts";
import { SqliteExecutionJournal } from "../packages/core/src/forge/journal.ts";
import { ExecutionKernel } from "../packages/core/src/forge/kernel.ts";
import { createNestedDispatcher } from "../packages/core/src/forge/nested.ts";
import { framePrefix } from "../packages/core/src/forge/python/frame-parser.ts";
import { EngineRegistry } from "../packages/core/src/forge/registry.ts";
import { createJavaScriptSelector } from "../packages/core/src/forge/selector.ts";
import { SlotTable } from "../packages/core/src/forge/slots.ts";
import { SqliteStateStore } from "../packages/core/src/forge/state-store.ts";
import { rendererFor } from "../packages/web/src/util/panel.ts";
import { type AnalysisHarness, analysisHarness, fake } from "./analysis-run-helpers.ts";
import {
  type FakeContainer,
  fakeContainer,
  realInterpreter,
  realPython,
} from "./forge-python-helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Options = Parameters<typeof analysisHarness>[0];
async function harness(options: Options = {}) {
  const h = await analysisHarness(options);
  cleanups.push(() => h.dispose());
  return h;
}
async function container(options?: Parameters<typeof fakeContainer>[0]) {
  const c = await fakeContainer(options);
  cleanups.push(() => c.dispose());
  return c;
}

type Row = Record<string, unknown>;
const forgeRows = (h: AnalysisHarness) =>
  h.store.db.prepare("SELECT * FROM forge_executions ORDER BY started_at, id").all() as Row[];
const rootOf = (h: AnalysisHarness) => h.store.rootOf(h.session);
const artifacts = (h: AnalysisHarness) => h.artifacts.list(rootOf(h), { includeDeleted: true });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const lastLine = (text: string) => text.split("\n").at(-1);
const progressEvents = (h: AnalysisHarness) =>
  h.events.flatMap((e: RunEvent) =>
    e.type === "tool_progress" ? [(e.data as { data: unknown }).data] : [],
  );

/** A frame line with the nonce the run was given, as a script prints it. */
const frameJson = (type: string, payload: unknown, seq = 0) =>
  JSON.stringify({ protocol: 1, type, seq, payload });

/** `analysis.runtime` as a switch, with the managed and container runtimes behind it. */
function modes(c: FakeContainer, initial: "auto" | "managed" | "oci" = "managed") {
  const state = { mode: initial, runtime: c.runtime };
  return {
    state,
    oci: { mode: () => state.mode, runtime: () => state.runtime },
  };
}

describe("FP-AC-01: an old python_run request, unchanged configuration", () => {
  it("runs on the managed backend through the kernel and leaves a linked journal row", async () => {
    const h = await harness();
    const code = fake({ files: { "report.md": "# R\n" }, stdout: "hello\n" });
    const { text, result } = await h.run({ code });
    expect(result.isError).toBeFalsy();
    expect(lastLine(text)).toBe("engine: python-managed (none) · reason: analysis.runtime=managed");
    const [row] = forgeRows(h);
    const [execution] = h.executions();
    expect(row).toMatchObject({
      engine: "python-managed",
      isolation: "none",
      selection_reason: "analysis.runtime=managed",
      status: "succeeded",
      code_sha256: sha(code),
      analysis_execution_id: execution?.id,
    });
    expect(row?.session_id).toBe(h.session);
  });

  it("a failing script is a failed row with the exit as its code, and the tool answers as before", async () => {
    const h = await harness();
    const { result } = await h.run({ code: fake({ exit: 3 }) });
    expect(result.isError).toBe(true);
    expect(forgeRows(h)[0]).toMatchObject({ status: "failed", error_code: "SCRIPT_RUNTIME" });
  });
});

describe("FP-AC-02 and FP-AC-03 (explicit runtime): the configured runtime decides, never silently another", () => {
  it("managed configured while a container is ready: the host Python runs and no container is touched", async () => {
    const c = await container();
    const h = await harness({ deps: { oci: modes(c, "managed").oci } });
    const { text } = await h.run({ code: fake({ files: { "a.md": "x" } }) });
    expect(lastLine(text)).toContain("python-managed");
    expect(await c.calls()).toEqual([]);
  });

  it("oci configured: the container runs it, with the engine, isolation and reason recorded", async () => {
    const c = await container();
    const h = await harness({
      deps: {
        oci: modes(c, "oci").oci,
        runtime: { interpreter: async () => ({ ok: false, reason: "no host python" }) },
      },
    });
    const { text, result } = await h.run({ code: fake({ files: { "a.md": "x" } }) });
    expect(result.isError).toBeFalsy();
    expect(lastLine(text)).toBe("engine: python-oci (os-container) · reason: analysis.runtime=oci");
    expect(forgeRows(h)[0]).toMatchObject({
      engine: "python-oci",
      isolation: "os-container",
      selection_reason: "analysis.runtime=oci",
    });
    expect((await c.lastRun()).includes("--network=none")).toBe(true);
  });

  it("oci configured but not ready: runtime_unavailable, the host Python is never used", async () => {
    const c = await container({ engineMissing: true });
    let hostUsed = false;
    const h = await harness({
      deps: {
        oci: modes(c, "oci").oci,
        runtime: {
          interpreter: async () => {
            hostUsed = true;
            return fakeResolution();
          },
        },
      },
    });
    const { text, result } = await h.run({ code: fake({}) });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^runtime_unavailable: docker was not found on PATH/);
    expect(hostUsed).toBe(false);
    expect(forgeRows(h)).toEqual([]);
  });
});

const fakeResolution = () => ({
  ok: true as const,
  executable: process.execPath,
  prefixArgs: [join(process.cwd(), "fixtures", "fake-python.mjs")],
  version: "3.12.0",
  source: "python3" as const,
});

describe("FP-AC-09: the analysis.run grant belongs to the session, not to a backend", () => {
  it("changing the backend does not ask again", async () => {
    const c = await container();
    const m = modes(c, "managed");
    const approve = vi.fn(async () => "session" as const);
    const h = await harness({
      policy: { analysis: false },
      approve,
      deps: { oci: m.oci },
    });
    await h.run({ code: fake({ files: { "a.md": "x" } }) });
    expect(approve).toHaveBeenCalledTimes(1);
    m.state.mode = "oci";
    const { text } = await h.run({ code: fake({ files: { "b.md": "y" } }) });
    expect(lastLine(text)).toContain("python-oci");
    expect(approve).toHaveBeenCalledTimes(1);
  });
});

describe("FP-AC-24: provenance names the engine, the isolation and the reason (additive)", () => {
  it("managed", async () => {
    const h = await harness();
    await h.run({ code: fake({ files: { "a.md": "x" } }) });
    const [artifact] = artifacts(h);
    expect(artifact?.provenance).toMatchObject({
      engine: "python-managed",
      isolation: "none",
      selectionReason: "analysis.runtime=managed",
      // The fields that were there before are still there.
      runtime: { mode: "managed", python: "3.12.0", extras: [] },
      scriptSha256: expect.any(String),
    });
  });

  it("oci", async () => {
    const c = await container();
    const h = await harness({ deps: { oci: modes(c, "oci").oci } });
    await h.run({ code: fake({ files: { "a.md": "x" } }) });
    expect(artifacts(h)[0]?.provenance).toMatchObject({
      engine: "python-oci",
      isolation: "os-container",
      selectionReason: "analysis.runtime=oci",
      runtime: { mode: "oci", engine: "docker" },
    });
  });
});

describe("FP-AC-21: under auto, rerunOf prefers the original backend when it is ready", () => {
  it("an execution that ran in a container is repeated there when auto is on", async () => {
    const c = await container();
    const m = modes(c, "oci");
    const h = await harness({ deps: { oci: m.oci } });
    await h.run({ code: fake({ files: { "r.md": "x" } }) });
    const [original] = artifacts(h);
    m.state.mode = "auto";
    const { text } = await h.run({ rerunOf: original?.id });
    expect(lastLine(text)).toBe(
      "engine: python-oci (os-container) · reason: rerun: original backend oci",
    );
    expect(h.executions().map((e) => e.runtime)).toEqual(["oci", "oci"]);
  });

  it("selects anew, saying why, when the original backend is not ready", async () => {
    const c = await container();
    const m = modes(c, "oci");
    const h = await harness({ deps: { oci: m.oci } });
    await h.run({ code: fake({ files: { "r.md": "x" } }) });
    const [original] = artifacts(h);
    m.state.mode = "auto";
    m.state.runtime = (await container({ engineMissing: true })).runtime;
    const { text, result } = await h.run({ rerunOf: original?.id });
    expect(result.isError).toBeFalsy();
    const line = lastLine(text) ?? "";
    expect(line).toContain("python-managed");
    expect(line).toContain("rerun: original backend oci not used (not ready (");
    expect(line).toContain("docker was not found on PATH");
  });

  it("an explicit runtime beats the original backend: nothing silently moves to a container", async () => {
    const c = await container();
    const m = modes(c, "oci");
    const h = await harness({ deps: { oci: m.oci } });
    await h.run({ code: fake({ files: { "r.md": "x" } }) });
    const [original] = artifacts(h);
    m.state.mode = "managed";
    const { text } = await h.run({ rerunOf: original?.id });
    expect(lastLine(text)).toBe("engine: python-managed (none) · reason: analysis.runtime=managed");
  });

  it("a managed original is not repeated on the host once the policy forbids the host", async () => {
    const c = await container();
    const m = modes(c, "managed");
    let policy: "preferred" | "required" = "preferred";
    const h = await harness({ deps: { oci: m.oci, isolation: () => policy } });
    await h.run({ code: fake({ files: { "r.md": "x" } }) });
    const [original] = artifacts(h);
    m.state.mode = "auto";
    policy = "required";
    const { text } = await h.run({ rerunOf: original?.id });
    expect(lastLine(text)).toContain("python-oci");
    expect(lastLine(text)).toContain("rerun: original backend managed not used");
    expect(lastLine(text)).toContain("excluded by analysis.isolation=required");
  });
});

describe("FP-AC-10: dashboards from alisio_runtime.charts, on both backends", () => {
  const dashboard = [
    "from alisio_runtime import charts",
    "body = charts.grid(charts.card('Status', charts.donut(['A', 'B'], [81.7, 18.3])))",
    "charts.write('dashboard.html', 'Sales', body)",
  ].join("\n");

  it.skipIf(!realPython)(
    "managed: a dashboard artifact the panel opens in its HTML frame",
    async () => {
      const h = await harness({ deps: { runtime: { interpreter: realInterpreter } } });
      const { text, result } = await h.run({ code: dashboard });
      expect(result.isError).toBeFalsy();
      expect(text).not.toContain("warning:");
      const [artifact] = artifacts(h);
      expect(artifact?.kind).toBe("dashboard");
      expect(rendererFor(toRef(artifact as never))).toEqual({ kind: "html" });
    },
    30_000,
  );

  it.skipIf(!realPython)(
    "oci: the same dashboard through the container path",
    async () => {
      const c = await container();
      await c.useRealPython();
      const h = await harness({ deps: { oci: modes(c, "oci").oci } });
      const { text, result } = await h.run({ code: dashboard });
      expect(result.isError).toBeFalsy();
      expect(text).not.toContain("warning:");
      const [artifact] = artifacts(h);
      expect(artifact?.kind).toBe("dashboard");
      expect(rendererFor(toRef(artifact as never))).toEqual({ kind: "html" });
      expect(artifact?.provenance).toMatchObject({ engine: "python-oci" });
    },
    30_000,
  );
});

describe("stdout frames (Python spec §7)", () => {
  it("progress frames become ForgeProgress, and no frame line reaches the model or the live view", async () => {
    const h = await harness();
    const { text } = await h.run({
      code: fake({
        frames: [{ type: "progress", payload: { message: "Training", completed: 1, total: 3 } }],
        stdout: "plain line\n",
      }),
    });
    expect(text).toContain("plain line");
    expect(text).not.toContain("ALISIO-FORGE");
    const events = progressEvents(h);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "forge",
        engine: "python-managed",
        phase: "running",
        message: "Training",
        completed: 1,
        total: 3,
      }),
    );
    for (const phase of ["preparing", "running", "collecting"])
      expect(events).toContainEqual(expect.objectContaining({ kind: "forge", phase }));
    expect(events.filter((e) => typeof e === "string").join("")).not.toContain("ALISIO-FORGE");
  });

  it("forge.text and forge.result reach the model after the script's own output", async () => {
    const h = await harness();
    const { text } = await h.run({
      code: fake({
        frames: [
          { type: "output", payload: { type: "text", text: "rows: 1200\n" } },
          { type: "complete", payload: { value: { accuracy: 0.91 } } },
        ],
        stdout: "done\n",
      }),
    });
    expect(text).toContain('--- forge output ---\nrows: 1200\n\nvalue: {"accuracy":0.91}');
    expect(text.indexOf("--- forge output ---")).toBeGreaterThan(text.indexOf("done"));
    expect(lastLine(text)).toContain("engine: python-managed");
  });

  it("the full stdout, frames included, stays in the job log", async () => {
    const h = await harness();
    await h.run({ code: fake({ frames: [{ type: "progress", payload: { message: "x" } }] }) });
    const log = await readFile(
      join(h.state, String(h.executions()[0]?.rel_dir), "logs", "stdout.log"),
      "utf8",
    );
    expect(log).toContain("ALISIO-FORGE");
  });

  it("FP-AC-18: a frame with another nonce is just output", async () => {
    const h = await harness();
    const other = `${framePrefix("0".repeat(32))}${frameJson("complete", { value: "forged" })}`;
    const { text, result } = await h.run({ code: fake({ rawLines: [other], stdout: "ok\n" }) });
    expect(result.isError).toBeFalsy();
    expect(text).toContain(other);
    expect(text).not.toContain("--- forge output ---");
  });

  it("FP-AC-18: a tool call frame ends the run with PROTOCOL_VIOLATION and publishes nothing", async () => {
    const h = await harness();
    const began = Date.now();
    const { text, result } = await h.run({
      code: fake({
        files: { "late.md": "x" },
        frames: [{ type: "call", payload: { callId: 0, tool: "read_file", input: {} } }],
        sleepMs: 20_000,
      }),
    });
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(result.isError).toBe(true);
    expect(text).toContain("PROTOCOL_VIOLATION");
    expect(artifacts(h)).toEqual([]);
    expect(forgeRows(h)[0]).toMatchObject({ status: "failed", error_code: "PROTOCOL_VIOLATION" });
    expect(h.executions()[0]).toMatchObject({ status: "failed" });
  }, 30_000);

  it("FP-AC-18: a frame over 256 KiB is a PROTOCOL_VIOLATION", async () => {
    const h = await harness();
    const { text, result } = await h.run({ code: fake({ giantFrame: 300_000, sleepMs: 20_000 }) });
    expect(result.isError).toBe(true);
    expect(text).toContain("PROTOCOL_VIOLATION");
  }, 30_000);

  it("FP-AC-18: 10 000 messages are ignored past 1 000, with one warning, and the run succeeds", async () => {
    const h = await harness();
    const { text, result } = await h.run({
      code: fake({ files: { "a.md": "x" }, manyFrames: 10_000 }),
    });
    expect(result.isError).toBeFalsy();
    expect(text.match(/warning: the script sent more than 1000 protocol messages/g)).toHaveLength(
      1,
    );
    expect(artifacts(h)).toHaveLength(1);
  });

  it("no frame can call a tool, so a session policy that allows nothing is never consulted", async () => {
    const h = await harness();
    const { result } = await h.run({
      code: fake({
        frames: [{ type: "catalog", payload: { requestId: 0, op: "search", query: "x" } }],
      }),
    });
    expect(result.isError).toBe(true);
  });
});

describe("shared state (FP-AC-19, FP-AC-20, PD10)", () => {
  /** A real JavaScript execution through a kernel over the same state store, as `js_run` would. */
  async function runJavaScript(h: AnalysisHarness, source: string) {
    const engines = new EngineRegistry();
    await engines.register(
      new JavaScriptEngine({
        hosts: new IsolateHostFactory({ choice: "worker", module: loadQuickJsModule }),
      }),
    );
    const kernel = new ExecutionKernel({
      engines,
      selector: createJavaScriptSelector(),
      journal: new SqliteExecutionJournal(h.store.db),
      state: new SqliteStateStore(h.store.db),
      slots: new SlotTable(),
      config: () => ({ enabled: true, limits: {}, stateEnabled: true }),
    });
    const signal = new AbortController().signal;
    const { result } = await kernel.execute({
      source,
      call: {
        toolCallId: "js-call",
        session: h.session,
        rootSessionId: rootOf(h),
        workspace: h.workspace,
        signal,
        permissionMode: "ask",
        allowAnalysis: false,
        allowProcess: false,
        dispatcher: createNestedDispatcher({
          registry: new ToolRegistry(),
          policy: { write: false, process: false, external: false },
          approvals: false,
          workspace: h.workspace,
          session: h.session,
          parentCallId: "js-call",
          signal,
          markEffectful: () => {},
        }),
        emit: () => {},
      },
    });
    return result;
  }

  const setState = (value: unknown, extra: Record<string, unknown> = {}) =>
    fake({
      frames: [{ type: "state.set", payload: { key: "lastDataset", value } }],
      ...extra,
    });

  it("FP-AC-19: a value Python sets is what a later JavaScript execution reads", async () => {
    const h = await harness();
    const { result } = await h.run({ code: setState("ds_123") });
    expect(result.isError).toBeFalsy();
    const js = await runJavaScript(h, 'return state.get("lastDataset")');
    expect(js.status).toBe("succeeded");
    expect(js.value).toBe("ds_123");
  });

  it("FP-AC-19: and the next Python run starts with it in work/.forge/state.json", async () => {
    const h = await harness();
    await h.run({ code: setState("ds_123") });
    const { text } = await h.run({ code: fake({ state: true }) });
    expect(text).toContain('STATE:{"lastDataset":"ds_123"}');
  });

  it("FP-AC-20: a script that fails after setting state leaves no trace", async () => {
    const h = await harness();
    const { result } = await h.run({ code: setState("ds_123", { exit: 3 }) });
    expect(result.isError).toBe(true);
    expect((await runJavaScript(h, 'return state.get("lastDataset") ?? null')).value).toBeNull();
  });

  it("FP-AC-20: nor does a run whose publication was rejected", async () => {
    const h = await harness();
    // outputs.json naming a path outside the staging folder makes the publisher refuse the run.
    const { result, text } = await h.run({
      code: setState("ds_123", {
        files: { "outputs.json": JSON.stringify({ artifacts: [{ path: "../escape.md" }] }) },
      }),
    });
    expect(result.isError).toBe(true);
    expect(text).toContain("publication rejected");
    expect(forgeRows(h)[0]).toMatchObject({ status: "failed", error_code: "PUBLICATION_REJECTED" });
    expect((await runJavaScript(h, 'return state.get("lastDataset") ?? null')).value).toBeNull();
  });

  it("a script cannot change the snapshot file to alter the store", async () => {
    // The file is a copy: only protocol messages travel back.
    const h = await harness();
    await h.run({ code: setState("real") });
    await h.run({ code: fake({ files: { "a.md": "x" } }) });
    const js = await runJavaScript(h, 'return state.get("lastDataset")');
    expect(js.value).toBe("real");
  });
});

describe("codePath: a script kept in the session scratchpad", () => {
  async function withPad(options: Options = {}) {
    const pad = await mkdtemp(join(tmpdir(), "alisio-pad-"));
    cleanups.push(() => rm(pad, { recursive: true, force: true }));
    const h = await harness({
      ...options,
      deps: { scratchpad: async () => pad, ...options?.deps },
    });
    return { h, pad };
  }

  it("copies the file to script/main.py and hashes it like code", async () => {
    const { h, pad } = await withPad();
    const code = fake({ files: { "r.md": "x" } });
    await writeFile(join(pad, "plan.py"), code);
    const { result } = await h.run({ codePath: "plan.py" });
    expect(result.isError).toBeFalsy();
    const execution = h.executions()[0];
    expect(execution?.script_sha256).toBe(sha(code));
    expect(
      await readFile(join(h.state, String(execution?.rel_dir), "script", "main.py"), "utf8"),
    ).toBe(code);
    expect(forgeRows(h)[0]?.code_sha256).toBe(sha(code));
    // A rerun of it works like any other execution.
    const [artifact] = artifacts(h);
    const again = await h.run({ rerunOf: artifact?.id });
    expect(again.result.isError).toBeFalsy();
  });

  it("is exclusive with code and with rerunOf", async () => {
    const { h, pad } = await withPad();
    await writeFile(join(pad, "plan.py"), fake({}));
    await expect(h.run({ codePath: "plan.py", code: "print(1)" })).resolves.toMatchObject({
      result: { isError: true },
    });
    const both = await h.run({ codePath: "plan.py", rerunOf: "art_00000" });
    expect(both.result.isError).toBe(true);
    expect(both.text).toMatch(/only one of code, codePath or rerunOf/);
  });

  it.each([
    ["a path that leaves the scratchpad", "../outside.py", /outside the scratchpad/],
    ["a file that is not .py", "plan.txt", /must be a \.py file/],
    ["a file that does not exist", "missing.py", /does not name a file/],
  ])("refuses %s", async (_name, codePath, message) => {
    const { h, pad } = await withPad();
    await writeFile(join(pad, "plan.txt"), "x");
    const { result, text } = await h.run({ codePath });
    expect(result.isError).toBe(true);
    expect(text).toMatch(message);
    expect(h.executions()).toEqual([]);
  });

  it("refuses a symlink that points out of the scratchpad", async () => {
    const { h, pad } = await withPad();
    const outside = await mkdtemp(join(tmpdir(), "alisio-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "secret.py"), "print('secret')");
    await symlink(join(outside, "secret.py"), join(pad, "link.py"));
    const { result, text } = await h.run({ codePath: "link.py" });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/escapes the scratchpad/);
  });

  it("is unavailable, with a clear message, where there is no scratchpad", async () => {
    const h = await harness();
    const { result, text } = await h.run({ codePath: "plan.py" });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/needs the session scratchpad/);
  });
});

describe("FJ-AC-32: the scratchpad is exposed read-only", () => {
  async function pad() {
    const dir = await mkdtemp(join(tmpdir(), "alisio-pad-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "notes.txt"), "from the model");
    return dir;
  }

  it("managed: $ALISIO_SCRATCH_DIR names it and the script can read it (not guaranteed read-only)", async () => {
    const dir = await pad();
    const h = await harness({ deps: { scratchpad: async () => dir } });
    const { text } = await h.run({
      code: fake({ scratch: { read: "notes.txt", write: "w.txt" } }),
    });
    const report = JSON.parse(/SCRATCH:(.*)/.exec(text)?.[1] ?? "{}") as Row;
    expect(report).toMatchObject({ dir, read: "from the model" });
    // Documented limit: the host process has the user's permissions, so nothing stops a write.
    expect(report.write).toBe("ok");
  });

  it("oci: mounted :ro at /job/scratch, with the variable pointing there", async () => {
    const dir = await pad();
    const c = await container();
    const h = await harness({
      deps: { oci: modes(c, "oci").oci, scratchpad: async () => dir },
    });
    const { text } = await h.run({ code: fake({ scratch: { read: "notes.txt" } }) });
    const run = await c.lastRun();
    expect(run).toContain(`${dir}:/job/scratch:ro`);
    expect(run).toContain("ALISIO_SCRATCH_DIR=/job/scratch");
    const report = JSON.parse(/SCRATCH:(.*)/.exec(text)?.[1] ?? "{}") as Row;
    expect(report.read).toBe("from the model");
  });

  it("nothing is exposed when there is no scratchpad", async () => {
    const c = await container();
    const h = await harness({ deps: { oci: modes(c, "oci").oci } });
    await h.run({ code: fake({ scratch: {} }) });
    const run = await c.lastRun();
    expect(run.some((a) => a.includes("/job/scratch"))).toBe(false);
    const managed = await harness();
    const { text } = await managed.run({ code: fake({ scratch: {} }) });
    expect(JSON.parse(/SCRATCH:(.*)/.exec(text)?.[1] ?? "{}")).toEqual({ dir: null });
  });

  it("a scratchpad that does not exist is not exposed", async () => {
    const h = await harness({
      deps: { scratchpad: async () => join(tmpdir(), "alisio-pad-that-is-not-there") },
    });
    const { text } = await h.run({ code: fake({ scratch: {} }) });
    expect(JSON.parse(/SCRATCH:(.*)/.exec(text)?.[1] ?? "{}")).toEqual({ dir: null });
  });
});

describe("the work folder", () => {
  it("holds the state snapshot under .forge and keeps it out of the artifacts", async () => {
    const h = await harness();
    await h.run({ code: fake({ files: { "a.md": "x" } }) });
    const folder = join(h.state, String(h.executions()[0]?.rel_dir));
    expect(
      JSON.parse(await readFile(join(folder, "work", ".forge", "state.json"), "utf8")),
    ).toEqual({});
    expect((await stat(join(folder, "work", ".forge"))).isDirectory()).toBe(true);
    expect(artifacts(h).map((a) => a.fileName)).toEqual(["a.md"]);
  });
});

// ---- a real engine (the same gate as analysis-oci.test.ts) -----------------------------------
const REAL_IMAGE = process.env.ALISIO_TEST_OCI_IMAGE;
const REAL_ENGINE = process.env.ALISIO_TEST_OCI_ENGINE === "podman" ? "podman" : "docker";
const realEngine =
  !!REAL_IMAGE &&
  spawnSync(REAL_ENGINE, ["version"], { stdio: "ignore", timeout: 15_000 }).status === 0;

describe.skipIf(!realEngine)(
  `FJ-AC-32 and the frame transport in a real ${REAL_ENGINE} container (needs ALISIO_TEST_OCI_IMAGE)`,
  () => {
    async function real(scratch?: string) {
      const runtime = new OciRuntime({
        engine: REAL_ENGINE,
        image: REAL_IMAGE as string,
        memoryMb: 512,
        cpus: 1,
      });
      return harness({
        deps: {
          runtime: { interpreter: async () => ({ ok: false, reason: "container only" }) },
          oci: { mode: () => "oci", runtime: () => runtime },
          ...(scratch ? { scratchpad: async () => scratch } : {}),
        },
      });
    }

    it("a script cannot write into $ALISIO_SCRATCH_DIR, but reads what the model left there", async () => {
      const dir = await mkdtemp(join(tmpdir(), "alisio-pad-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      await writeFile(join(dir, "notes.txt"), "from the model");
      const h = await real(dir);
      const { text } = await h.run({
        code: [
          "import os",
          "pad = os.environ['ALISIO_SCRATCH_DIR']",
          "print('READ', open(os.path.join(pad, 'notes.txt')).read())",
          "try:",
          "    open(os.path.join(pad, 'w.txt'), 'w').write('x')",
          "    print('WROTE')",
          "except OSError:",
          "    print('BLOCKED')",
        ].join("\n"),
      });
      expect(text).toContain("READ from the model");
      expect(text).toContain("BLOCKED");
      expect(text).not.toContain("WROTE");
    }, 60_000);

    it("frames travel through docker run: alisio_runtime.forge needs only the image's Python", async () => {
      const h = await real();
      const { text } = await h.run({
        code: [
          "from alisio_runtime import forge",
          "forge.progress('step', completed=1, total=2)",
          "forge.text('hello')",
          "forge.result({'ok': True})",
        ].join("\n"),
      });
      expect(text).toContain('--- forge output ---\nhello\nvalue: {"ok":true}');
      expect(text).not.toContain("ALISIO-FORGE");
    }, 60_000);
  },
);
