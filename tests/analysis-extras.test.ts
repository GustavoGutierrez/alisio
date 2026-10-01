/**
 * The optional Python extras: hash-locked, wheels-only installation (a fake pip, no network), the
 * offline-safe failure, and `python_run { extras }` asking for `analysis.install` (once, with the
 * packages, the size estimate and the network need) or failing with the optional command.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AnalysisRuntimeManager,
  ExtrasInstallError,
  type InstallStep,
  installPreview,
  venvInterpreter,
} from "../packages/core/src/analysis/runtime-manager.ts";
import type { ApprovalRequest } from "../packages/core/src/core/contracts.ts";
import { analysisHarness, fake, fakeInterpreter } from "./analysis-run-helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A manager with a fake base interpreter and a fake installer (no process, no network). */
async function manager(
  behavior: (command: string, args: string[]) => { exitCode: number; stderr?: string } = () => ({
    exitCode: 0,
  }),
  options: { uv?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "alisio-extras-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const python = join(bin, "python3");
  await writeFile(python, "");
  if (options.uv) await writeFile(join(bin, "uv"), "");
  const steps: Array<{ command: string; args: string[] }> = [];
  const install: InstallStep = async (command, args) => {
    steps.push({ command, args });
    const verdict = behavior(command, args);
    if (verdict.exitCode === 0) {
      // Creating the environment leaves its interpreter behind.
      const venvAt = args.includes("venv") ? args.at(-1) : undefined;
      if (venvAt) {
        const target = venvInterpreter(venvAt);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, "");
      }
    }
    return { exitCode: verdict.exitCode, stdout: "", stderr: verdict.stderr ?? "" };
  };
  const instance = new AnalysisRuntimeManager({
    stateDir: join(root, "state"),
    install,
    deps: {
      path: bin,
      stat: async (path) => {
        try {
          const { stat } = await import("node:fs/promises");
          const info = await stat(path);
          return { mtimeMs: info.mtimeMs, isFile: info.isFile() };
        } catch {
          return undefined;
        }
      },
      exec: async (command) => ({
        stdout: JSON.stringify([[3, 12, 1], command]),
        exitCode: 0,
      }),
    },
  });
  return { root, python, manager: instance, steps };
}

const signal = () => new AbortController().signal;

describe("installExtras (fake pip)", () => {
  it("creates the venv, installs from the hashed lockfile with wheels only, then checks the imports", async () => {
    const m = await manager();
    const state = await m.manager.installExtras("analysis", { signal: signal() });
    expect(state).toMatchObject({ ok: true, extras: ["analysis"], pythonVersion: "3.12.1" });
    const [create, pip, check] = m.steps;
    expect(create?.args.slice(0, 2)).toEqual(["-m", "venv"]);
    expect(pip?.args).toEqual(
      expect.arrayContaining(["pip", "install", "--require-hashes", "--only-binary=:all:"]),
    );
    expect(pip?.args).not.toContain("--no-binary");
    // Nothing is compiled: no sdist fallback and no build tooling flags.
    expect(pip?.args.join(" ")).not.toMatch(/--no-build-isolation|--prefer-binary|setup\.py/);
    const lock = await readFile(pip?.args.at(-1) as string, "utf8");
    expect(lock).toMatch(/pandas==/);
    expect(lock).toMatch(/--hash=sha256:[a-f0-9]{64}/);
    expect(check?.args.slice(0, 1)).toEqual(["-c"]);
    expect(check?.args[1]).toMatch(/import pandas, numpy, matplotlib/);
    // The environment is now the one `python_run` uses.
    const resolved = await m.manager.interpreter();
    expect(resolved).toMatchObject({ ok: true, venv: true, extras: ["analysis"] });
    expect(existsSync((resolved as { executable: string }).executable)).toBe(true);
    expect(await m.manager.hasExtras("analysis")).toBe(true);
    expect(await m.manager.hasExtras("science")).toBe(false);
  });

  it("uses uv with --require-hashes and --only-binary when uv is installed", async () => {
    const m = await manager(() => ({ exitCode: 0 }), { uv: true });
    await m.manager.installExtras("science", { signal: signal() });
    const uvSteps = m.steps.filter((s) => s.command.endsWith("uv"));
    expect(uvSteps).toHaveLength(2);
    expect(uvSteps[0]?.args.slice(0, 1)).toEqual(["venv"]);
    expect(uvSteps[1]?.args).toEqual(
      expect.arrayContaining(["pip", "install", "--require-hashes", "--only-binary", ":all:"]),
    );
    expect(await m.manager.hasExtras("analysis")).toBe(true); // science includes analysis
  });

  it("fails offline with a clear message, installs nothing and leaves the base runtime working", async () => {
    const m = await manager((_command, args) =>
      args.includes("install")
        ? {
            exitCode: 1,
            stderr:
              "WARNING: Retrying (Retry(total=0)) after connection broken by 'NewConnectionError: Failed to establish a new connection: [Errno -3] Temporary failure in name resolution'",
          }
        : { exitCode: 0 },
    );
    const error = await m.manager
      .installExtras("analysis", { signal: signal() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExtrasInstallError);
    expect((error as ExtrasInstallError).kind).toBe("offline");
    expect((error as Error).message).toMatch(/no network connection/);
    expect((error as Error).message).toMatch(/Nothing was installed/);
    expect((error as Error).message).toMatch(/alisio analysis setup --extras analysis/);
    // No half-built environment and no active pointer.
    expect(existsSync(join(m.root, "state", "runtimes", "python", "active.json"))).toBe(false);
    expect(await m.manager.activeRuntime()).toBeUndefined();
    const base = await m.manager.interpreter();
    expect(base).toMatchObject({ ok: true });
    expect((base as { venv?: boolean }).venv).toBeUndefined();
  });

  it("a failed installation keeps the environment that was already active", async () => {
    let offline = false;
    const m = await manager((_c, args) =>
      offline && args.includes("install")
        ? { exitCode: 1, stderr: "ERROR: No matching distribution found for scipy" }
        : { exitCode: 0 },
    );
    await m.manager.installExtras("analysis", { signal: signal() });
    offline = true;
    await expect(m.manager.installExtras("science", { signal: signal() })).rejects.toThrow(
      /no network connection/,
    );
    expect((await m.manager.activeRuntime())?.extras).toEqual(["analysis"]);
  });

  it("other failures keep their detail (no wheel for this platform, for example)", async () => {
    const m = await manager((_c, args) =>
      args.includes("install")
        ? { exitCode: 1, stderr: "ERROR: Hash mismatch for numpy-2.5.3" }
        : { exitCode: 0 },
    );
    const error = (await m.manager
      .installExtras("analysis", { signal: signal() })
      .catch((e: unknown) => e)) as ExtrasInstallError;
    expect(error.kind).toBe("failed");
    expect(error.message).toMatch(/Hash mismatch/);
  });

  it("concurrent requests for the same extras share one installation", async () => {
    const m = await manager();
    await Promise.all([
      m.manager.installExtras("analysis", { signal: signal() }),
      m.manager.installExtras("analysis", { signal: signal() }),
    ]);
    expect(m.steps.filter((s) => s.args.includes("venv"))).toHaveLength(1);
  });

  it("describes what an approval shows: packages, size estimate and the network need", () => {
    const preview = installPreview("analysis");
    expect(preview).toMatchObject({ extras: "analysis", network: true });
    expect(preview.packages).toEqual(
      expect.arrayContaining(["pandas", "numpy", "matplotlib", "openpyxl", "plotly"]),
    );
    expect(preview.packageCount).toBeGreaterThan(preview.packages.length);
    expect(preview.estimatedBytes).toBeGreaterThan(50_000_000);
    expect(installPreview("science").estimatedBytes).toBeGreaterThan(preview.estimatedBytes);
  });
});

/** python_run with a manager that records installs instead of running pip. */
async function extrasHarness(options: {
  approve?: (request: ApprovalRequest) => Promise<"once" | "session" | "deny">;
  install?: () => Promise<void>;
  policy?: Record<string, boolean>;
}) {
  const installed = { value: false, calls: 0 };
  const runtime = {
    interpreter: async () => ({
      ...(await fakeInterpreter()),
      ...(installed.value ? { extras: ["analysis" as const], venv: true } : {}),
    }),
    hasExtras: async () => installed.value,
    installExtras: async () => {
      installed.calls++;
      await options.install?.();
      installed.value = true;
      return {
        runtimeVersion: "abc12345",
        python: "p",
        pythonVersion: "3.12.0",
        extras: ["analysis" as const],
        createdAt: 0,
        ok: true,
      };
    },
  };
  const h = await analysisHarness({
    deps: { runtime },
    ...(options.approve ? { approve: options.approve } : {}),
    policy: { analysis: false, ...options.policy },
  });
  cleanups.push(() => h.dispose());
  return { h, installed };
}

describe("python_run { extras } and the analysis.install approval", () => {
  it("asks once with the packages, the estimate and the network need, installs on approval and runs", async () => {
    const requests: ApprovalRequest[] = [];
    const { h, installed } = await extrasHarness({
      approve: async (request) => {
        requests.push(request);
        return "once";
      },
    });
    const { text, result } = await h.run({
      code: fake({ files: { "out.txt": "pandas time" } }),
      extras: ["analysis"],
    });
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/published 1 artifact: out\.txt/);
    expect(installed.calls).toBe(1);
    const install = requests.find((r) => r.capability === "analysis.install");
    expect(install?.install).toMatchObject({ extras: "analysis", network: true });
    expect(install?.install?.packages).toContain("pandas");
    expect(install?.install?.estimatedBytes).toBeGreaterThan(0);
    // Both approvals are in the event trail, the install one with its preview.
    const requested = h.events.filter((e) => e.type === "approval_requested");
    expect(requested.map((e) => (e.data as { capability?: string }).capability)).toEqual([
      "analysis.run",
      "analysis.install",
    ]);
    expect(h.runner).toBeDefined();
  });

  it("never persists an installation permission, even when answered 'session'", async () => {
    const { h } = await extrasHarness({
      approve: async (request) => (request.capability === "analysis.install" ? "session" : "once"),
    });
    await h.run({ code: fake({}), extras: ["analysis"] });
    expect(h.grants.granted("analysis.install", h.session)).toBe(false);
    const audit = h.grants.list(h.session).filter((g) => g.capability === "analysis.install");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ scope: "once", decision: "allow" });
    const resolved = h.events.find(
      (e) =>
        e.type === "approval_resolved" &&
        (e.data as { capability?: string }).capability === "analysis.install",
    );
    expect((resolved?.data as { decision: string }).decision).toBe("once");
  });

  it("asks again on the next call that needs it (nothing was remembered)", async () => {
    let asked = 0;
    const { h, installed } = await extrasHarness({
      approve: async (request) => {
        if (request.capability === "analysis.install") asked++;
        return request.capability === "analysis.install" ? "deny" : "once";
      },
    });
    await h.run({ code: fake({}), extras: ["analysis"] });
    await h.run({ code: fake({}), extras: ["analysis"] });
    expect(asked).toBe(2);
    expect(installed.calls).toBe(0);
  });

  it("a denial installs nothing, runs nothing and names the optional command", async () => {
    const { h, installed } = await extrasHarness({
      approve: async (request) => (request.capability === "analysis.install" ? "deny" : "once"),
    });
    const { text, result } = await h.run({ code: fake({}), extras: ["analysis"] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/extras_not_installed/);
    expect(text).toContain("alisio analysis setup --extras analysis");
    expect(installed.calls).toBe(0);
    expect(h.executions()).toHaveLength(0);
  });

  it("headless (nobody to ask) fails with the remedy, even with --allow-process and --allow-analysis", async () => {
    const { h, installed } = await extrasHarness({
      policy: { process: true, analysis: true },
    });
    const { text, result } = await h.run({ code: fake({}), extras: ["analysis"] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/headless runs never install/);
    expect(text).toContain("alisio analysis setup --extras analysis");
    expect(installed.calls).toBe(0);
  });

  it("an offline installation is reported without running the script", async () => {
    const { h } = await extrasHarness({
      approve: async () => "once",
      install: async () => {
        throw new ExtrasInstallError(
          "Could not download the Python packages: there is no network connection",
          "offline",
        );
      },
    });
    const { text, result } = await h.run({ code: fake({}), extras: ["analysis"] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/extras_install_failed: Could not download the Python packages/);
    expect(h.executions()).toHaveLength(0);
  });

  it("does not ask when the extras are already installed", async () => {
    const asked: string[] = [];
    const { h, installed } = await extrasHarness({
      approve: async (request) => {
        asked.push(request.capability ?? "effect");
        return "once";
      },
    });
    installed.value = true;
    const { result } = await h.run({ code: fake({}), extras: ["analysis"] });
    expect(result.isError).toBeFalsy();
    expect(asked).toEqual(["analysis.run"]);
    expect(installed.calls).toBe(0);
  });
});
