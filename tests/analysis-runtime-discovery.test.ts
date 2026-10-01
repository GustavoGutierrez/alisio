import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AnalysisRuntimeManager,
  type DiscoveryDeps,
  type FileInfo,
  PROBE_CODE,
  venvInterpreter,
} from "../packages/core/src/analysis/runtime-manager.ts";

let state: string;
beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "alisio-discovery-"));
});
afterEach(async () => {
  await rm(state, { recursive: true, force: true });
});

/**
 * A fake machine: `files` maps paths to mtimes, `pythons` maps an executable path to its
 * version (and the real executable it reports), `uv` answers `uv python find`.
 */
function machine(options: {
  platform?: NodeJS.Platform;
  path: string;
  files: Record<string, number>;
  pythons?: Record<string, { version: string; real?: string }>;
  uvFinds?: string;
  localAppData?: string;
}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const deps: Partial<DiscoveryDeps> = {
    platform: options.platform ?? "linux",
    path: options.path,
    ...(options.localAppData ? { localAppData: options.localAppData } : {}),
    async stat(path): Promise<FileInfo | undefined> {
      const mtime = options.files[path];
      return mtime === undefined ? undefined : { mtimeMs: mtime, isFile: true };
    },
    async exec(command, args) {
      calls.push({ command, args });
      if (args[0] === "python" && args[1] === "find")
        return options.uvFinds
          ? { stdout: `${options.uvFinds}\n`, exitCode: 0 }
          : { stdout: "", exitCode: 2 };
      const python = options.pythons?.[command];
      if (!python || !args.includes(PROBE_CODE)) return { stdout: "", exitCode: 1 };
      const [major, minor, micro] = python.version.split(".").map(Number);
      return {
        stdout: `${JSON.stringify([[major, minor, micro], python.real ?? command])}\n`,
        exitCode: 0,
      };
    },
  };
  return { deps, calls, files: options.files };
}

describe("AnalysisRuntimeManager discovery", () => {
  it("startup launches no process; the first call probes once and caches discovery.json", async () => {
    const m = machine({
      path: "/opt/bin:/usr/bin",
      files: { "/usr/bin/python3": 10 },
      pythons: { "/usr/bin/python3": { version: "3.12.4" } },
    });
    const manager = new AnalysisRuntimeManager({ stateDir: state, deps: m.deps });
    expect(await manager.candidates()).toEqual([
      { source: "python3", command: "/usr/bin/python3" },
    ]);
    expect(m.calls).toEqual([]);
    expect(await manager.resolve()).toMatchObject({
      ok: true,
      executable: "/usr/bin/python3",
      version: "3.12.4",
    });
    expect(m.calls).toHaveLength(1);
    const cached = JSON.parse(
      await readFile(join(state, "runtimes", "python", "discovery.json"), "utf8"),
    );
    expect(cached).toMatchObject({ executable: "/usr/bin/python3", version: "3.12.4", mtime: 10 });
    // A new process (fresh manager) reuses the cache with a stat only.
    const again = new AnalysisRuntimeManager({ stateDir: state, deps: m.deps });
    expect((await again.resolve()).ok).toBe(true);
    expect(m.calls).toHaveLength(1);
    // A changed executable (mtime) forces a new discovery.
    m.files["/usr/bin/python3"] = 11;
    expect((await again.resolve()).ok).toBe(true);
    expect(m.calls).toHaveLength(2);
  });

  it("prefers uv, then python3, then python, and requires 3.10+", async () => {
    const m = machine({
      path: "/bin",
      files: { "/bin/uv": 1, "/bin/python3": 1, "/bin/python": 1, "/uv/python3.11": 1 },
      pythons: {
        "/bin/python3": { version: "3.8.10" },
        "/bin/python": { version: "3.11.2" },
        "/uv/python3.11": { version: "3.11.9" },
      },
      uvFinds: "/uv/python3.11",
    });
    const manager = new AnalysisRuntimeManager({ stateDir: state, deps: m.deps });
    expect((await manager.candidates()).map((c) => c.source)).toEqual(["uv", "python3", "python"]);
    expect(await manager.resolve()).toMatchObject({ executable: "/uv/python3.11", source: "uv" });
    // Without uv: python3 is too old (remembered), python wins.
    const noUv = machine({
      path: "/bin",
      files: { "/bin/python3": 1, "/bin/python": 1 },
      pythons: { "/bin/python3": { version: "3.8.10" }, "/bin/python": { version: "3.11.2" } },
    });
    const second = new AnalysisRuntimeManager({ stateDir: join(state, "b"), deps: noUv.deps });
    expect(await second.resolve()).toMatchObject({ executable: "/bin/python", version: "3.11.2" });
  });

  it("reports a too-old Python and caches nothing, so a later install is found", async () => {
    const m = machine({
      path: "/bin",
      files: { "/bin/python3": 1 },
      pythons: { "/bin/python3": { version: "3.9.18" } },
    });
    const manager = new AnalysisRuntimeManager({ stateDir: state, deps: m.deps });
    expect(await manager.resolve()).toMatchObject({
      ok: false,
      found: { version: "3.9.18", path: "/bin/python3" },
    });
    m.files["/bin/python3"] = 2;
    // The user installs 3.12 at the same path; no restart.
    Object.assign(manager.deps, {
      exec: async () => ({ stdout: JSON.stringify([[3, 12, 1], "/bin/python3"]), exitCode: 0 }),
    });
    expect(await manager.resolve()).toMatchObject({ ok: true, version: "3.12.1" });
  });

  it("with --python tries nothing else and explains a missing path", async () => {
    const m = machine({
      path: "/bin",
      files: { "/bin/python3": 1 },
      pythons: { "/bin/python3": { version: "3.12.0" } },
    });
    const manager = new AnalysisRuntimeManager({
      stateDir: state,
      python: "/does/not/exist",
      deps: m.deps,
    });
    // The flag is resolved against the host's path rules (a drive letter is added on Windows).
    expect(await manager.candidates()).toEqual([
      { source: "flag", command: resolve("/does/not/exist") },
    ]);
    expect(await manager.resolve()).toMatchObject({
      ok: false,
      flag: true,
      reason: expect.stringContaining("does not exist"),
    });
    expect(m.calls).toEqual([]);
  });

  it("Windows: uses PATHEXT, tries py -3 and skips the Microsoft Store alias", async () => {
    const apps = "C:\\Users\\Ana\\AppData\\Local";
    const store = `${apps}\\Microsoft\\WindowsApps`;
    const m = machine({
      platform: "win32",
      localAppData: apps,
      path: `${store};C:\\Windows;C:\\Python312`,
      files: {
        [`${store}\\python.exe`]: 1,
        [`${store}\\python3.exe`]: 1,
        "C:\\Windows\\py.exe": 1,
        "C:\\Python312\\python.exe": 1,
      },
      pythons: {
        "C:\\Windows\\py.exe": { version: "3.12.3", real: "C:\\Python312\\python.exe" },
      },
    });
    const manager = new AnalysisRuntimeManager({ stateDir: state, deps: m.deps });
    expect(await manager.candidates()).toEqual([
      { source: "py", command: "C:\\Windows\\py.exe" },
      { source: "python", command: "C:\\Python312\\python.exe" },
    ]);
    expect(await manager.resolve()).toMatchObject({
      ok: true,
      source: "py",
      executable: "C:\\Python312\\python.exe",
    });
    expect(m.calls[0]?.args.slice(0, 1)).toEqual(["-3"]);
  });

  it("resolves the venv interpreter with each platform's path rules", () => {
    expect(venvInterpreter("C:\\state\\venv", "win32")).toBe(
      "C:\\state\\venv\\Scripts\\python.exe",
    );
    expect(venvInterpreter("/state/my venv/ñ", "linux")).toBe("/state/my venv/ñ/bin/python");
    expect(venvInterpreter("/state/venv", "darwin")).toBe("/state/venv/bin/python");
  });
});
