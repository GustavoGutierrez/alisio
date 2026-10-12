/**
 * `python_run` choosing and using the wasm backend (Python spec §6, §8; FP-AC-04..08, 13, 16, 17,
 * 21, 28 in their fast form), through the real runner gates. The container is the fake CLI, the
 * host Python is the fake interpreter and the Pyodide child is `fixtures/fake-node.mjs`; the real
 * runtime is exercised by `forge-python-wasm-real.test.ts` (ALISIO_TEST_PYODIDE=1).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PythonResolution } from "../packages/core/src/analysis/runtime-manager.ts";
import type {
  IsolationPolicy,
  PythonRuntimeSetting,
} from "../packages/core/src/forge/python/backend-selector.ts";
import { resetNodeCaches } from "../packages/core/src/forge/python/wasm-node.ts";
import {
  type AnalysisHarness,
  analysisHarness,
  fake,
  fakeInterpreter,
} from "./analysis-run-helpers.ts";
import { fakeContainer } from "./forge-python-helpers.ts";
import { type WasmFixture, wasmFixture } from "./forge-wasm-helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  resetNodeCaches();
});

interface Options {
  mode: PythonRuntimeSetting;
  isolation?: IsolationPolicy;
  /** `none` leaves Pyodide uninstalled. */
  profile?: "analysis" | "science" | "none";
  containerMissing?: boolean;
  net?: "denied" | "open";
  memoryMb?: number;
  startupMs?: number;
  noWasm?: boolean;
}

async function setup(options: Options) {
  resetNodeCaches();
  const fx: WasmFixture = await wasmFixture();
  cleanups.push(() => fx.dispose());
  if (options.profile !== "none") await fx.install(options.profile ?? "analysis");
  const nodePath = await fx.node(options.net ? { net: options.net } : {});
  const c = await fakeContainer({ engineMissing: options.containerMissing ?? true });
  cleanups.push(() => c.dispose());
  const state = {
    mode: options.mode,
    isolation: options.isolation ?? ("preferred" as IsolationPolicy),
  };
  const hostCalls: string[] = [];
  const interpreter = async (): Promise<PythonResolution> => {
    hostCalls.push("interpreter");
    return fakeInterpreter();
  };
  const settings = {
    memoryMb: options.memoryMb ?? 3072,
    startupMs: options.startupMs ?? 30_000,
    maxInputBytes: 100 * 1024 * 1024,
    nodePath,
  };
  const h = await analysisHarness({
    deps: {
      runtime: { interpreter },
      oci: { mode: () => state.mode, runtime: () => c.runtime },
      isolation: () => state.isolation,
      ...(options.noWasm
        ? {}
        : {
            wasm: {
              stateRoot: fx.stateRoot,
              manifest: fx.manifest,
              settings: () => settings,
              sampleMs: 50,
            },
          }),
    },
  });
  cleanups.push(() => h.dispose());
  return { h, fx, c, state, hostCalls, settings };
}

const lastLine = (text: string) => text.split("\n").at(-1) ?? "";
const forgeRows = (h: AnalysisHarness) =>
  h.store.db.prepare("SELECT * FROM forge_executions ORDER BY started_at, id").all() as Array<
    Record<string, unknown>
  >;

describe("FP-AC-03: auto with the container ready", () => {
  it("runs in the container first and records why", async () => {
    const { h, c } = await setup({ mode: "auto", containerMissing: false });
    const { text, result } = await h.run({ code: fake({ files: { "a.md": "x" } }) });
    expect(result.isError).toBeFalsy();
    expect(lastLine(text)).toBe(
      "engine: python-oci (os-container) · reason: analysis.runtime=auto, analysis.isolation=preferred: oci is ready",
    );
    expect(h.executions().map((e) => e.runtime)).toEqual(["oci"]);
    expect((await c.lastRun()).includes("--network=none")).toBe(true);
  });
});

describe("FP-AC-04: auto with the container not ready and wasm ready", () => {
  it("runs a pandas script on wasm, publishes what it left, and says why", async () => {
    const { h, hostCalls } = await setup({ mode: "auto" });
    const code = `${fake({ files: { "report.md": "# R\n" }, stdout: "rows 3\n", startupMs: 50 })}import pandas as pd\n`;
    const { text, result } = await h.run({ code });
    expect(result.isError).toBeFalsy();
    expect(lastLine(text)).toMatch(
      /^engine: python-wasm \(wasm-process\) · reason: analysis\.runtime=auto, analysis\.isolation=preferred: wasm is ready; oci: not ready \(/,
    );
    expect(text).toContain("rows 3");
    expect(text).toMatch(/exit 0 in [\d.]+s \(startup 0\.\d+s\) · published 1 artifact/);
    expect(h.executions().map((e) => e.runtime)).toEqual(["wasm"]);
    expect(forgeRows(h)[0]).toMatchObject({
      engine: "python-wasm",
      isolation: "wasm-process",
      status: "succeeded",
    });
    const [artifact] = h.artifacts.list(h.store.rootOf(h.session));
    expect(artifact?.fileName).toBe("report.md");
    // The host Python was probed for readiness (auto), but never ran the script.
    expect(hostCalls.length).toBeGreaterThan(0);
    expect((h.executions()[0] as { runtime: string }).runtime).not.toBe("managed");
  });

  it("records engine, isolation and reason in the provenance of the artifact (FP-AC-24 for wasm)", async () => {
    const { h } = await setup({ mode: "auto" });
    await h.run({ code: fake({ files: { "a.md": "x" } }) });
    const row = h.store.db.prepare("SELECT provenance FROM artifacts").get() as {
      provenance: string;
    };
    const provenance = JSON.parse(row.provenance) as Record<string, unknown>;
    expect(provenance).toMatchObject({ engine: "python-wasm", isolation: "wasm-process" });
    expect(String(provenance.selectionReason)).toContain("wasm is ready");
    expect(provenance.runtime).toMatchObject({
      mode: "wasm",
      pyodide: "9.9.9",
      profile: "analysis",
    });
  });
});

describe("FP-AC-05: a script that wasm cannot run goes to the next backend that can", () => {
  it("a package outside the profiles drops wasm, with the reason, and the host runs it", async () => {
    const { h } = await setup({ mode: "auto" });
    const { text } = await h.run({ code: `${fake({ files: { "a.md": "x" } })}import torch\n` });
    expect(lastLine(text)).toContain("python-managed");
    expect(lastLine(text)).toContain("wasm: module torch is not in the wasm profiles");
  });

  it("a science import with only the analysis profile installed says which profile would fit", async () => {
    const { h } = await setup({ mode: "auto", isolation: "required" });
    const { text, result } = await h.run({
      code: `${fake({})}from sklearn.linear_model import LogisticRegression\n`,
    });
    expect(result.isError).toBe(true);
    expect(text).toContain("runtime_unavailable:");
    expect(text).toContain("needs the science profile and analysis is installed");
    expect(text).toContain('Shortest fix: run "alisio analysis setup --wasm --profile science"');
  });
});

describe("FP-AC-06: isolation required never falls back to the host", () => {
  it("with only the host available it fails with the setup commands and runs nothing", async () => {
    const { h, hostCalls } = await setup({ mode: "auto", isolation: "required", profile: "none" });
    const { text, result } = await h.run({ code: fake({ files: { "a.md": "x" } }) });
    expect(result.isError).toBe(true);
    expect(text).toContain("runtime_unavailable:");
    expect(text).toContain("managed");
    expect(text).toContain("alisio analysis setup --wasm");
    expect(h.executions()).toEqual([]);
    // Refused before anything was prepared: no job, no journal row.
    expect(forgeRows(h)).toEqual([]);
    // The host's interpreter was not even asked.
    expect(hostCalls).toEqual([]);
  });
});

describe("FP-AC-07: an explicit wasm that cannot run the script is an error, not a switch", () => {
  it("names the reason and the way out, and nothing else runs", async () => {
    const { h, hostCalls } = await setup({ mode: "wasm", containerMissing: false });
    const { text, result } = await h.run({ code: `${fake({})}import torch\n` });
    expect(result.isError).toBe(true);
    expect(text).toContain("wasm cannot run this script: module torch is not in the wasm profiles");
    expect(text).toContain("set analysis.runtime=auto");
    expect(h.executions()).toEqual([]);
    expect(hostCalls).toEqual([]);
  });

  it("not installed: the same error with the setup command", async () => {
    const { h } = await setup({ mode: "wasm", profile: "none" });
    const { text, result } = await h.run({ code: fake({}) });
    expect(result.isError).toBe(true);
    expect(text).toContain("wasm is not ready: Pyodide is not installed");
    expect(text).toContain('run "alisio analysis setup --wasm"');
  });

  it("an embedder without the backend gets a clear refusal", async () => {
    const { h } = await setup({ mode: "wasm", noWasm: true });
    const { text, result } = await h.run({ code: fake({}) });
    expect(result.isError).toBe(true);
    expect(text).toContain("wasm is not available here");
  });
});

describe("FP-AC-08: a failure after the start is never retried elsewhere", () => {
  it("a wasm run that fails leaves one execution, on wasm, and touches no other backend", async () => {
    const { h, c } = await setup({ mode: "auto" });
    const { text, result } = await h.run({ code: fake({ exit: 3, stderr: "boom\n" }) });
    expect(result.isError).toBe(true);
    expect(text).toContain("exit 3");
    expect(h.executions().map((e) => [e.runtime, e.status])).toEqual([["wasm", "failed"]]);
    expect((await c.calls()).filter((call) => call[0] === "run")).toEqual([]);
    expect(forgeRows(h)).toHaveLength(1);
  });
});

describe("FP-AC-16 (fast): a hung script is stopped and confirmed gone", () => {
  it("times out after the run's own deadline plus the startup margin, and the child is reaped", async () => {
    const { h } = await setup({ mode: "wasm", startupMs: 1000 });
    const started = Date.now();
    const { text, result } = await h.run({ code: fake({ hang: true }), timeoutMs: 1000 });
    const elapsed = Date.now() - started;
    expect(result.isError).toBe(true);
    expect(text).toContain("timed out after 1s");
    // 1 s of compute + 1 s of startup margin: not earlier.
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(forgeRows(h)[0]).toMatchObject({ status: "timed_out", termination_unconfirmed: 0 });
    expect(h.executions()[0]).toMatchObject({ status: "timed_out" });
    // The core is responsive: the next call runs.
    const next = await h.run({ code: fake({ files: { "ok.md": "x" } }) });
    expect(next.result.isError).toBeFalsy();
  });
});

describe("FP-AC-17 (fast): the memory watchdog ends a runaway script", () => {
  it("reports MEMORY_LIMIT and the core carries on", async () => {
    const { h } = await setup({ mode: "wasm", memoryMb: 200 });
    const { text, result } = await h.run({ code: fake({ allocMb: 400 }) });
    expect(result.isError).toBe(true);
    expect(text).toContain("MEMORY_LIMIT");
    expect(text).toContain("analysis.wasm.memoryMb (200 MB)");
    expect(forgeRows(h)[0]).toMatchObject({ status: "failed", error_code: "MEMORY_LIMIT" });
    const next = await h.run({ code: fake({ files: { "ok.md": "x" } }) });
    expect(next.result.isError).toBeFalsy();
  });
});

describe("FP-AC-13 and FP-AC-28: strict admits only a backend whose network the OS denies", () => {
  it("excludes wasm when the self-probe found the network open", async () => {
    const { h } = await setup({ mode: "auto", isolation: "strict", net: "open" });
    const { text, result } = await h.run({ code: fake({}) });
    expect(result.isError).toBe(true);
    expect(text).toContain(
      "wasm: excluded by analysis.isolation=strict (its network is not denied by the OS)",
    );
    expect(h.executions()).toEqual([]);
  });

  it("admits it when the self-probe saw the connection refused", async () => {
    const { h } = await setup({ mode: "auto", isolation: "strict", net: "denied" });
    const { text, result } = await h.run({ code: fake({ files: { "a.md": "x" } }) });
    expect(result.isError).toBeFalsy();
    expect(lastLine(text)).toContain("python-wasm");
  });
});

describe("FP-AC-21 on wasm: rerunOf prefers the original backend when it is ready", () => {
  it("repeats on wasm; when Pyodide is gone it selects anew and says so", async () => {
    const { h, fx } = await setup({ mode: "auto" });
    await h.run({ code: fake({ files: { "r.md": "x" } }) });
    const [original] = h.artifacts.list(h.store.rootOf(h.session));
    const again = await h.run({ rerunOf: original?.id });
    expect(lastLine(again.text)).toBe(
      "engine: python-wasm (wasm-process) · reason: rerun: original backend wasm",
    );
    const { rm } = await import("node:fs/promises");
    await rm(fx.dist, { recursive: true, force: true });
    const moved = await h.run({ rerunOf: original?.id });
    expect(lastLine(moved.text)).toContain("python-managed");
    expect(lastLine(moved.text)).toContain(
      "rerun: original backend wasm not used (not ready (Pyodide is not installed))",
    );
    expect(h.executions().map((e) => e.runtime)).toEqual(["wasm", "wasm", "managed"]);
  });
});
