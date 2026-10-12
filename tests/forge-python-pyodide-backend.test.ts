/**
 * The wasm backend (Python spec §8, PD6, PD13) without the real Pyodide: a fake `node` shows what
 * the parent hands the child (flags, environment, working directory, load plan) and how it reacts
 * to a ready marker, a hang and a memory spike. The real runtime is covered by the gated suite.
 */
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobPaths } from "../packages/core/src/analysis/jobs.ts";
import type { PreparedJob } from "../packages/core/src/forge/python/backend.ts";
import {
  loadPlan,
  PyodideBackend,
  type WasmSettings,
} from "../packages/core/src/forge/python/pyodide-backend.ts";
import { PYODIDE_RUNNER_SOURCE } from "../packages/core/src/forge/python/pyodide-runner-source.ts";
import {
  probeNetwork,
  resetNodeCaches,
  resolveNode,
} from "../packages/core/src/forge/python/wasm-node.ts";
import { fake } from "./analysis-run-helpers.ts";
import { type WasmFixture, wasmFixture } from "./forge-wasm-helpers.ts";

let fx: WasmFixture;
beforeEach(async () => {
  resetNodeCaches();
  fx = await wasmFixture();
});
afterEach(() => fx.dispose());

const settings = (over: Partial<WasmSettings> = {}): WasmSettings => ({
  memoryMb: 3072,
  startupMs: 30_000,
  maxInputBytes: 100 * 1024 * 1024,
  nodePath: null,
  ...over,
});

async function backend(over: Partial<WasmSettings> = {}, extra: { sampleMs?: number } = {}) {
  const nodePath = over.nodePath ?? (await fx.node());
  return new PyodideBackend({
    stateRoot: fx.stateRoot,
    manifest: fx.manifest,
    settings: () => settings({ ...over, nodePath }),
    ...extra,
  });
}

/** A job whose folders exist, as `AnalysisJobs.create` leaves them. */
async function job(code: string, over: Partial<PreparedJob> = {}): Promise<PreparedJob> {
  const root = join(fx.stateRoot, `job-${Math.random().toString(36).slice(2)}`);
  const paths: JobPaths = {
    id: "exec_1",
    root,
    script: join(root, "script"),
    main: join(root, "script", "main.py"),
    input: join(root, "input"),
    work: join(root, "work"),
    staging: join(root, "staging"),
    logs: join(root, "logs"),
  };
  for (const dir of [paths.script, paths.input, paths.work, paths.staging, paths.logs])
    await mkdir(dir, { recursive: true });
  await writeFile(paths.main, code);
  return {
    executionId: "exec_1",
    paths,
    env: { ALISIO_FORGE_NONCE: "n0nce", ALISIO_FORGE_ENGINE: "python-wasm", SECRET_TOKEN: "x" },
    signal: new AbortController().signal,
    backstopMs: 30_000,
    maxBytes: 64 * 1024,
    maxLogBytes: 1024 * 1024,
    logFiles: { stdout: join(paths.logs, "stdout.log"), stderr: join(paths.logs, "stderr.log") },
    ...over,
  };
}

const collect = () => {
  const out = { stdout: "", stderr: "" };
  return { out, sink: { onData: (c: string, s: "stdout" | "stderr") => void (out[s] += c) } };
};
const echoed = (stdout: string, key: string) =>
  JSON.parse(
    stdout
      .split("\n")
      .find((l) => l.startsWith(`${key}:`))
      ?.slice(key.length + 1) ?? "null",
  );

describe("readiness", () => {
  it("is not ready, saying how to fix it, until Pyodide is installed", async () => {
    const b = await backend();
    expect(await b.check()).toEqual({ ready: false, reason: "Pyodide is not installed" });
    await fx.install();
    expect(await b.check()).toEqual({ ready: true });
  });

  it("is not ready without a supported node, and no setup command is suggested for it", async () => {
    await fx.install();
    const old = await backend({ nodePath: await fx.node({ reports: "v20.11.0", name: "old" }) });
    const state = await old.check();
    expect(state).toMatchObject({ ready: false, fix: "" });
    expect((state as { reason: string }).reason).toContain("Node v20.11.0");
    const missing = await backend({ nodePath: join(fx.stateRoot, "no-such-node") });
    expect(((await missing.check()) as { reason: string }).reason).toContain("did not run");
  });

  it("FP-AC-26: under Bun with no node on PATH it is not ready and says why; other backends are unaffected", async () => {
    await fx.install();
    const b = new PyodideBackend({
      stateRoot: fx.stateRoot,
      manifest: fx.manifest,
      settings: () => settings(),
      environment: () => ({
        isBun: true,
        execPath: "/$bunfs/alisio",
        version: "v22.22.0",
        pathEnv: join(fx.stateRoot, "empty"),
        platform: process.platform,
      }),
    });
    const state = await b.check();
    expect(state.ready).toBe(false);
    expect((state as { reason: string }).reason).toContain("was found on PATH");
  });

  it("under Bun it takes the first supported node on PATH and skips older ones", async () => {
    await fx.install();
    await fx.node({ reports: "v18.19.0", name: "node" });
    const oldDir = join(fx.stateRoot, "bin");
    const newDir = join(fx.stateRoot, "bin2");
    await mkdir(newDir, { recursive: true });
    const second = await (async () => {
      const { chmod, writeFile: write } = await import("node:fs/promises");
      const path = join(newDir, "node");
      await write(
        path,
        `#!/bin/sh\nexec "${process.execPath}" "${join(process.cwd(), "fixtures/fake-node.mjs")}" --reports=v24.16.0 "$@"\n`,
      );
      await chmod(path, 0o755);
      return path;
    })();
    const found = await resolveNode(null, {
      isBun: true,
      execPath: "/$bunfs/alisio",
      version: "v22.22.0",
      pathEnv: `${oldDir}:${newDir}`,
      platform: process.platform,
    });
    expect(found).toEqual({ ok: true, path: second, version: "v24.16.0" });
  });
});

describe("supports (pure fit check, §6.1)", () => {
  const req = (over: Record<string, unknown> = {}) => ({
    extras: [] as Array<"analysis" | "science">,
    importedModules: [] as string[],
    inputBytes: 0,
    ...over,
  });

  it("covers the standard library and the installed profile, and nothing beyond", async () => {
    await fx.install("analysis");
    const b = await backend();
    await b.check();
    expect(b.supports(req({ importedModules: ["json", "pandas", "docx"] }))).toEqual({ ok: true });
    const science = b.supports(req({ importedModules: ["sklearn"] }));
    expect(science).toMatchObject({
      ok: false,
      code: "PROFILE_UNSUPPORTED",
      fix: "alisio analysis setup --wasm --profile science",
    });
    const stranger = b.supports(req({ importedModules: ["pandas", "torch", "requests"] }));
    expect(stranger).toMatchObject({ ok: false, code: "PACKAGE_UNAVAILABLE" });
    expect((stranger as { reason: string }).reason).toBe(
      "modules torch, requests are not in the wasm profiles",
    );
  });

  it("an extra the installed profile does not cover excludes wasm, as do oversized inputs", async () => {
    await fx.install("analysis");
    const b = await backend({ maxInputBytes: 1024 * 1024 });
    await b.check();
    expect(b.supports(req({ extras: ["science"] }))).toMatchObject({
      ok: false,
      code: "PROFILE_UNSUPPORTED",
    });
    expect(b.supports(req({ extras: ["analysis"] }))).toEqual({ ok: true });
    expect(b.supports(req({ inputBytes: 2 * 1024 * 1024 }))).toMatchObject({
      ok: false,
      code: "INPUT_TOO_LARGE",
    });
  });

  it("before a successful check there is nothing to run on", async () => {
    const b = await backend();
    expect(b.supports(req())).toMatchObject({ ok: false, code: "NOT_READY" });
  });
});

describe("loadPlan", () => {
  it("loads what the imports need, dependencies first, lock packages apart from pure wheels", async () => {
    const plan = loadPlan(fx.manifest, "science", ["python-docx", "pandas"]);
    expect(plan.packages).toEqual([
      "numpy",
      "python-dateutil",
      "pytz",
      "pandas",
      "lxml",
      "typing-extensions",
    ]);
    expect(plan.wheels).toEqual(["python-docx-1.0-py3-none-any.whl"]);
    expect(plan.files.map((f) => f.name)).toContain("numpy-1.0-py3-none-any.whl");
    expect(loadPlan(fx.manifest, "science", []).packages).toEqual([]);
  });
});

describe("launch: what the restricted child is given (PD6, §8.2)", () => {
  it("starts node with the Permission Model, one flag per path, no process/worker/addon flags, and an empty environment", async () => {
    await fx.install();
    const b = await backend();
    await b.check();
    const prepared = await job(fake({ echo: true }));
    const { out, sink } = collect();
    const running = await b.launch(prepared, sink);
    const result = await running.result;
    expect(result.exitCode).toBe(0);
    const args = echoed(out.stdout, "ARGS") as string[];
    expect(args[0]).toBe("--permission");
    const reads = args.filter((a) => a.startsWith("--allow-fs-read="));
    const writes = args.filter((a) => a.startsWith("--allow-fs-write="));
    // One flag per path, never a comma list.
    expect([...reads, ...writes].every((a) => !a.slice(a.indexOf("=") + 1).includes(","))).toBe(
      true,
    );
    expect(reads.map((a) => a.split("=")[1]).sort()).toEqual(
      [
        fx.dist,
        prepared.paths.script,
        prepared.paths.input,
        prepared.paths.work,
        prepared.paths.staging,
      ].sort(),
    );
    expect(writes.map((a) => a.split("=")[1]).sort()).toEqual(
      [prepared.paths.work, prepared.paths.staging].sort(),
    );
    for (const forbidden of [
      "--allow-child-process",
      "--allow-worker",
      "--allow-addons",
      "--allow-wasi",
      "--allow-net",
    ])
      expect(args.some((a) => a.startsWith(forbidden))).toBe(false);
    // Only the job's ALISIO_ variables reach the child (no PATH, no HOME, no SECRET_TOKEN).
    // (the wrapper's /bin/sh adds PWD itself)
    const { PWD: _pwd, ...env } = echoed(out.stdout, "ENV");
    expect(env).toEqual({
      ALISIO_FORGE_NONCE: "n0nce",
      ALISIO_FORGE_ENGINE: "python-wasm",
      ALISIO_EXECUTION_ID: "exec_1",
    });
    expect(out.stdout.split("\n").find((l) => l.startsWith("CWD:"))).toBe(
      `CWD:${prepared.paths.work}`,
    );
  });

  it("writes the embedded runner next to the distribution and loads only what the script imports", async () => {
    await fx.install();
    const b = await backend();
    await b.check();
    const prepared = await job(`${fake({ echo: true })}import pandas\nimport docx\n`);
    const { out, sink } = collect();
    const running = await b.launch(prepared, sink);
    await running.result;
    const spec = echoed(out.stdout, "SPEC");
    expect(spec.dist).toBe(fx.dist);
    expect(spec.packages).toEqual([
      "numpy",
      "python-dateutil",
      "pytz",
      "pandas",
      "lxml",
      "typing-extensions",
    ]);
    expect(spec.wheels).toEqual(["python-docx-1.0-py3-none-any.whl"]);
    expect(spec.job.out).toBe(prepared.paths.staging);
    const args = echoed(out.stdout, "ARGS") as string[];
    const runner = args.at(-1) as string;
    expect(runner.startsWith(`${fx.dist}/runner-`)).toBe(true);
    expect(await readFile(runner, "utf8")).toBe(PYODIDE_RUNNER_SOURCE);
    expect(running.runtime).toMatchObject({
      mode: "wasm",
      pyodide: "9.9.9",
      profile: "analysis",
      node: "v22.22.0",
    });
  });

  it("M1: grants the child a link-free copy of the scratchpad, never the real folder", async () => {
    await fx.install();
    const b = await backend();
    await b.check();
    const scratch = join(fx.stateRoot, "scratch");
    const outside = join(fx.stateRoot, "outside");
    await mkdir(join(scratch, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await writeFile(join(scratch, "sub", "tool.py"), "x = 1\n");
    await symlink(outside, join(scratch, "link"));
    const prepared = await job(fake({ echo: true, listScratch: true }), { scratch });
    const { out, sink } = collect();
    await (await b.launch(prepared, sink)).result;
    const args = echoed(out.stdout, "ARGS") as string[];
    const spec = echoed(out.stdout, "SPEC");
    // Not the real folder, not writable, and inside the job's own root.
    expect(args).not.toContain(`--allow-fs-read=${scratch}`);
    expect(args).toContain(`--allow-fs-read=${spec.job.scratch}`);
    expect(args.some((a) => a === `--allow-fs-write=${spec.job.scratch}`)).toBe(false);
    expect(spec.job.scratch).not.toBe(scratch);
    expect(spec.job.scratch.startsWith(prepared.paths.root)).toBe(true);
    // The link is not in what the child can see; the regular file is.
    expect(echoed(out.stdout, "SCRATCH")).toEqual(["sub", "sub/tool.py"]);
  });

  it("removes the scratchpad copy when the job ends", async () => {
    await fx.install();
    const b = await backend();
    await b.check();
    const scratch = join(fx.stateRoot, "scratch");
    await mkdir(scratch);
    await writeFile(join(scratch, "a.txt"), "a");
    const prepared = await job(fake({ echo: true }), { scratch });
    const { out, sink } = collect();
    await (await b.launch(prepared, sink)).result;
    const copy = echoed(out.stdout, "SPEC").job.scratch as string;
    expect(await readdir(copy).catch(() => "gone")).toBe("gone");
  });

  it("refuses to launch when a file no longer matches its pinned hash", async () => {
    await fx.install();
    const b = await backend();
    await b.check();
    await writeFile(join(fx.dist, "pyodide.mjs"), `contents of pyodide.mjX\n`);
    await expect(b.launch(await job(fake({})), collect().sink)).rejects.toThrow(
      /pyodide\.mjs does not match its pinned SHA-256/,
    );
  });

  it("measures the startup apart from the compute, and the script's output stays its own", async () => {
    await fx.install();
    const b = await backend();
    await b.check();
    const { out, sink } = collect();
    const running = await b.launch(
      await job(fake({ startupMs: 400, stdout: "hello\n", stderr: "warn\n" })),
      sink,
    );
    await running.result;
    expect(out.stderr).toBe("warn\n");
    expect(out.stdout).toBe("hello\n");
    const startup = running.runtime.startupMs as number;
    expect(startup).toBeGreaterThanOrEqual(400);
    expect(startup).toBeLessThan(5000);
  });
});

describe("termination and the memory watchdog (PD13, FP-AC-16, FP-AC-17)", () => {
  it("kills a hung child on terminate and confirms it is gone", async () => {
    await fx.install();
    const b = await backend();
    await b.check();
    const running = await b.launch(await job(fake({ hang: true })), collect().sink);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    const report = await b.terminate(running, "timeout");
    expect(report).toMatchObject({ confirmed: true, method: "kill" });
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(running.result).rejects.toThrow();
  });

  it("kills a child over analysis.wasm.memoryMb and reports MEMORY_LIMIT, not a bare exit", async () => {
    await fx.install();
    const b = await backend({ memoryMb: 200 }, { sampleMs: 50 });
    await b.check();
    const running = await b.launch(await job(fake({ allocMb: 400 })), collect().sink);
    const result = await running.result;
    expect(result.exitCode).not.toBe(0);
    expect(running.limit?.()).toMatchObject({ code: "MEMORY_LIMIT" });
    expect(running.limit?.()?.message).toContain("analysis.wasm.memoryMb (200 MB)");
    expect(running.runtime.peakRssMb).toBeGreaterThan(200);
  });

  it("leaves a script under the limit alone", async () => {
    await fx.install();
    const b = await backend({ memoryMb: 3072 }, { sampleMs: 50 });
    await b.check();
    const running = await b.launch(await job(fake({ sleepMs: 300 })), collect().sink);
    expect((await running.result).exitCode).toBe(0);
    expect(running.limit?.()).toBeUndefined();
  });
});

describe("the network self-probe (D-32, FP-AC-13, FP-AC-28)", () => {
  it("a child whose connection the OS refuses makes the backend declare networkDeniedByOS", async () => {
    await fx.install();
    const denied = await backend({ nodePath: await fx.node({ net: "denied", name: "n25" }) });
    expect((await denied.describe()).capabilities.networkDeniedByOS).toBe(true);
  });

  it("a child that reaches the local port keeps networkDeniedByOS false, whatever the version says", async () => {
    await fx.install();
    // This one claims to be Node 99: the version must not matter.
    const open = await backend({ nodePath: await fx.node({ reports: "v99.0.0", name: "n99" }) });
    const descriptor = await open.describe();
    expect(descriptor.capabilities.networkDeniedByOS).toBe(false);
    expect(descriptor).toMatchObject({
      id: "python-wasm",
      isolation: "wasm-process",
      ready: true,
      profiles: ["base", "analysis"],
      capabilities: { hardTermination: true, hardMemoryLimit: false, cooperativeInterrupt: false },
    });
  });

  it("an inconclusive probe (the child printed nothing) is not read as denial", async () => {
    const result = await probeNetwork({ path: process.execPath, version: "v-test" }, [
      "--no-such-flag",
    ]);
    expect(result.denied).toBe(false);
    expect(result.detail).toContain("inconclusive");
  });

  it("is remembered per binary and version: a second describe spawns nothing", async () => {
    await fx.install();
    const path = await fx.node({ name: "once" });
    const b = await backend({ nodePath: path });
    await b.describe();
    // Make the wrapper fail: a cached answer survives, a new probe would be inconclusive (false) —
    // so flip the answer instead and see that the first one is kept.
    const flipped = await fx.node({ net: "denied", name: "once" });
    expect(flipped).toBe(path);
    expect((await b.describe()).capabilities.networkDeniedByOS).toBe(false);
  });
});

describe("the network self-probe is conclusive only for the Permission Model (M2)", () => {
  it.each(["ECONNREFUSED", "EADDRNOTAVAIL", "ENETUNREACH"])(
    "a plain %s is inconclusive: not denied, with the code recorded, and not remembered as denied",
    async (code) => {
      await fx.install();
      const path = await fx.node({ net: `error:${code}`, name: `err-${code}` });
      const b = await backend({ nodePath: path });
      expect((await b.describe()).capabilities.networkDeniedByOS).toBe(false);
      const direct = await probeNetwork({ path, version: "v22.22.0" }, []);
      expect(direct.denied).toBe(false);
      expect(direct.detail).toContain(`probe inconclusive: ${code}`);
      // Not cached: when the same binary later answers with the Permission Model, it is believed.
      await fx.node({ net: "denied", name: `err-${code}` });
      expect((await b.describe()).capabilities.networkDeniedByOS).toBe(true);
    },
  );
});

describe("node selection (L1, L7)", () => {
  const bun = (pathEnv: string) => ({
    isBun: true,
    execPath: "/$bunfs/alisio",
    version: "v22.22.0",
    pathEnv,
    platform: process.platform,
  });

  it("L1: under Bun a relative PATH entry is never searched", async () => {
    const dir = join(fx.stateRoot, "cwdbin");
    await mkdir(dir, { recursive: true });
    const { chmod, writeFile: write } = await import("node:fs/promises");
    await write(join(dir, "node"), `#!/bin/sh\necho v24.16.0\n`);
    await chmod(join(dir, "node"), 0o755);
    const before = process.cwd();
    process.chdir(fx.stateRoot);
    try {
      for (const pathEnv of ["cwdbin", "./cwdbin", `.${delimiter}cwdbin`, ".."]) {
        resetNodeCaches();
        const found = await resolveNode(null, bun(pathEnv));
        expect(found.ok).toBe(false);
      }
    } finally {
      process.chdir(before);
    }
  });

  it.each([
    ["v22.19.0", false],
    ["v22.21.9", false],
    ["v22.22.0", true],
    ["v23.11.0", false],
    ["v24.12.0", false],
    ["v24.13.0", true],
    ["v25.2.0", false],
    ["v25.3.0", true],
    ["v26.0.0", true],
  ])(
    "L7: %s is %s for the wasm backend (CVE-2025-55130 fixed in 22.22, 24.13, 25.3)",
    async (reports, ok) => {
      resetNodeCaches();
      const path = await fx.node({ reports, name: `v-${reports}` });
      const found = await resolveNode(path);
      expect(found.ok).toBe(ok);
      if (!found.ok) expect(found.reason).toContain("CVE-2025-55130");
      resetNodeCaches();
      const running = await resolveNode(null, {
        isBun: false,
        execPath: "/usr/bin/node",
        version: reports,
        pathEnv: "",
        platform: process.platform,
      });
      expect(running.ok).toBe(ok);
    },
  );
});
