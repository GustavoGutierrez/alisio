/**
 * Fixtures for the Forja Python acceptance tests: a fake container CLI that runs the job with the
 * fake (or a real) interpreter, and the runtimes `python_run` is wired to in each mode.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OciRuntime } from "../packages/core/src/analysis/oci.ts";
import type { PythonResolution } from "../packages/core/src/analysis/runtime-manager.ts";
import { FAKE_CONTAINER } from "./analysis-run-helpers.ts";

export const IMAGE = `registry.example/python@sha256:${"c".repeat(64)}`;

/** A real Python 3.10+ on this machine, when there is one. */
export const realPython: string | undefined = ["python3", "python"].find((cmd) => {
  const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 10))"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() === "True";
});

/** An interpreter resolution that points at the real Python (for `alisio_runtime` scripts). */
export const realInterpreter = async (): Promise<PythonResolution> => ({
  ok: true,
  executable: realPython as string,
  version: "3.10.0",
  source: "python3",
});

export interface FakeContainer {
  runtime: OciRuntime;
  /** Every engine invocation, in order. */
  calls(): Promise<string[][]>;
  /** The `run` invocation's arguments. */
  lastRun(): Promise<string[]>;
  /** From now on the "container" runs scripts with the real interpreter. */
  useRealPython(): Promise<void>;
  dispose(): Promise<void>;
}

export async function fakeContainer(
  options: { image?: string | null; engineMissing?: boolean } = {},
): Promise<FakeContainer> {
  const engineState = await mkdtemp(join(tmpdir(), "alisio-fake-engine-"));
  const runtime = new OciRuntime(
    {
      engine: "docker",
      memoryMb: 512,
      cpus: 1,
      ...(options.image === null ? {} : { image: options.image ?? IMAGE }),
    },
    {
      locate: async () => (options.engineMissing ? undefined : process.execPath),
      prefixArgs: [FAKE_CONTAINER, engineState],
      host: async () => ({ platform: process.platform, uid: 1000, gid: 1000 }),
    },
  );
  const calls = async () =>
    (await readFile(join(engineState, "calls.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  return {
    runtime,
    calls,
    lastRun: async () => (await calls()).filter((c) => c[0] === "run").at(-1) ?? [],
    useRealPython: () => writeFile(join(engineState, "python"), realPython as string),
    dispose: () => rm(engineState, { recursive: true, force: true }),
  };
}
