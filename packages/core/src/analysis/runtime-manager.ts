/**
 * Zero-configuration Python discovery for `python_run`. Startup only looks for candidate
 * executables on PATH with `stat` (no process); the first call probes them in order
 * (`--python` → `uv python find` → `py -3` on Windows → `python3` → `python`), accepts the first
 * Python ≥ 3.10 and caches `{ executable, version, mtime }` in `runtimes/python/discovery.json`.
 * Only positive results are cached, so installing Python is picked up without a restart.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";
import type { InstallPreview } from "@alisio/sdk";
import { runProcess } from "../runtime/process.ts";
import {
  EXTRAS_DISTRIBUTIONS,
  EXTRAS_ESTIMATED_BYTES,
  EXTRAS_LOCK,
  EXTRAS_PACKAGES,
  lockedDistributionCount,
} from "./requirements.ts";

export const MIN_PYTHON: readonly [number, number] = [3, 10];
/** Prints `[[major, minor, micro], executable]` as JSON. */
export const PROBE_CODE =
  "import sys, json; print(json.dumps([list(sys.version_info[:3]), sys.executable]))";

export type CandidateSource = "flag" | "uv" | "py" | "python3" | "python";
export interface PythonCandidate {
  source: CandidateSource;
  /** Absolute path of the launcher or interpreter found on PATH (or the `--python` path). */
  command: string;
}

export interface FileInfo {
  mtimeMs: number;
  isFile: boolean;
}
export interface DiscoveryDeps {
  platform: NodeJS.Platform;
  /** `PATH` of the process. */
  path: string;
  /** Windows `PATHEXT`. */
  pathext?: string;
  /** Windows `%LOCALAPPDATA%` (to skip the Microsoft Store alias). */
  localAppData?: string;
  stat(path: string): Promise<FileInfo | undefined>;
  /** Runs a probe; never a shell. */
  exec(
    command: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<{ stdout: string; exitCode: number }>;
}

export type PythonResolution =
  | {
      ok: true;
      executable: string;
      version: string;
      source: CandidateSource;
      venv?: boolean;
      /** Arguments placed before the interpreter flags (embedders and test launchers only). */
      prefixArgs?: string[];
    }
  | {
      ok: false;
      /** Human-readable cause. */
      reason: string;
      /** A Python that was found but is too old, or the unusable `--python`. */
      found?: { version?: string; path: string; reason?: string };
      /** `--python` was given (no other candidate was tried). */
      flag?: boolean;
    };

interface DiscoveryCache {
  executable: string;
  version: string;
  mtime: number;
  source: CandidateSource;
}

/** The interpreter of a virtual environment, built with the target platform's path rules. */
export function venvInterpreter(
  venv: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32"
    ? win32.join(venv, "Scripts", "python.exe")
    : posix.join(venv, "bin", "python");
}

/** `3.10.12` → true when at least `MIN_PYTHON`. */
export function supportedVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]);
}

/** Parses the probe output; undefined when it is not ours. */
export function parseProbe(stdout: string): { version: string; executable: string } | undefined {
  try {
    const value = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "") as unknown;
    if (
      !Array.isArray(value) ||
      !Array.isArray(value[0]) ||
      typeof value[1] !== "string" ||
      !value[0].every((n: unknown) => typeof n === "number")
    )
      return undefined;
    return { version: (value[0] as number[]).join("."), executable: value[1] };
  } catch {
    return undefined;
  }
}

export function defaultDiscoveryDeps(): DiscoveryDeps {
  return {
    platform: process.platform,
    path: process.env.PATH ?? process.env.Path ?? "",
    ...(process.env.PATHEXT ? { pathext: process.env.PATHEXT } : {}),
    ...(process.env.LOCALAPPDATA ? { localAppData: process.env.LOCALAPPDATA } : {}),
    async stat(path) {
      try {
        const s = await stat(path);
        return { mtimeMs: s.mtimeMs, isFile: s.isFile() };
      } catch {
        return undefined;
      }
    },
    async exec(command, args, signal) {
      const result = await runProcess(command, args, {
        cwd: process.cwd(),
        signal,
        timeoutMs: 15_000,
      });
      return { stdout: result.stdout, exitCode: result.exitCode };
    },
  };
}

export type Extras = "analysis" | "science";

/**
 * The installation failed. `offline` means the download could not start or finish because there
 * is no network (or the package index is unreachable): nothing was installed and the base runtime
 * is untouched, so the message says so and how to retry.
 */
export class ExtrasInstallError extends Error {
  constructor(
    message: string,
    readonly kind: "offline" | "failed",
  ) {
    super(message);
    this.name = "ExtrasInstallError";
  }
}

const OFFLINE_SIGNS =
  /Temporary failure in name resolution|Name or service not known|nodename nor servname|Failed to establish a new connection|Connection (refused|reset|aborted|timed out)|Network is unreachable|No route to host|getaddrinfo|dns error|error sending request|failed to lookup address|Max retries exceeded|ReadTimeout|ConnectTimeout|ConnectionError|SSLError|Could not find a version that satisfies|No matching distribution found|Failed to download|Failed to fetch|Temporary failure/i;

/** The command that installs the extras by hand (the optional, explicit route). */
export const setupCommand = (extras: Extras) => `alisio analysis setup --extras ${extras}`;

/** What an `analysis.install` approval shows for a set of extras. */
export function installPreview(extras: Extras): InstallPreview {
  return {
    extras,
    packages: [...EXTRAS_DISTRIBUTIONS[extras]],
    packageCount: lockedDistributionCount(extras),
    estimatedBytes: EXTRAS_ESTIMATED_BYTES[extras],
    network: true,
  };
}

/** Runs one installation step (replaceable in tests so no network or pip is needed). */
export type InstallStep = (
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; onOutput?: (text: string) => void },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const installEnv = (): Record<string, string> => ({
  ...Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USERPROFILE",
      "TMPDIR",
      "TEMP",
      "SystemRoot",
      "LANG",
      "LOCALAPPDATA",
      "APPDATA",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
      "REQUESTS_CA_BUNDLE",
      "PIP_INDEX_URL",
      "UV_INDEX_URL",
    ].flatMap((k) => (process.env[k] ? [[k, process.env[k] as string]] : [])),
  ),
  // Fail fast when offline instead of retrying for minutes.
  UV_HTTP_TIMEOUT: "20",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
});

const defaultInstallStep: InstallStep = (command, args, options) =>
  runProcess(command, args, {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: 30 * 60_000,
    maxBytes: 256 * 1024,
    onOverflow: "truncate",
    env: installEnv(),
    ...(options.onOutput ? { onData: options.onOutput } : {}),
  });

/** Persisted state of an extras environment (`runtime.json`). */
export interface RuntimeState {
  runtimeVersion: string;
  python: string;
  pythonVersion: string;
  extras: Extras[];
  createdAt: number;
  ok: boolean;
}

export class AnalysisRuntimeManager {
  readonly deps: DiscoveryDeps;
  private memory?: DiscoveryCache;

  constructor(
    private options: {
      /** State root (`stateHome()` or the folder of `--db`). */
      stateDir: string;
      /** `--python <path>`: pins the interpreter; nothing else is tried. */
      python?: string;
      deps?: Partial<DiscoveryDeps>;
      /** Replaces the installation steps (tests: a fake pip, no network). */
      install?: InstallStep;
    },
  ) {
    this.deps = { ...defaultDiscoveryDeps(), ...options.deps };
  }

  get pythonFlag(): string | undefined {
    return this.options.python ? resolve(this.options.python) : undefined;
  }

  private get dir(): string {
    return join(this.options.stateDir, "runtimes", "python");
  }

  private sep(): string {
    return this.deps.platform === "win32" ? ";" : ":";
  }

  /** First PATH match of `name` (with `PATHEXT` on Windows), by `stat` only. */
  private async onPath(name: string): Promise<string | undefined> {
    const win = this.deps.platform === "win32";
    const join_ = win ? win32.join : posix.join;
    const extensions = win
      ? (this.deps.pathext ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((e) => e.toLowerCase())
      : [""];
    for (const dir of this.deps.path.split(this.sep()).filter(Boolean))
      for (const ext of extensions) {
        const candidate = join_(dir, `${name}${ext}`);
        if (win && this.storeAlias(candidate)) continue;
        if ((await this.deps.stat(candidate))?.isFile) return candidate;
      }
    return undefined;
  }

  /** The Microsoft Store alias opens the Store instead of running Python. */
  private storeAlias(path: string): boolean {
    if (this.deps.platform !== "win32") return false;
    const base = this.deps.localAppData
      ? win32.join(this.deps.localAppData, "Microsoft", "WindowsApps")
      : undefined;
    const normalized = path.toLowerCase();
    return base
      ? normalized.startsWith(`${base.toLowerCase()}\\`)
      : normalized.includes("\\microsoft\\windowsapps\\");
  }

  /** Candidate executables, in discovery order (stat only; launches nothing). */
  async candidates(): Promise<PythonCandidate[]> {
    const flag = this.pythonFlag;
    if (flag) return [{ source: "flag", command: flag }];
    const out: PythonCandidate[] = [];
    const uv = await this.onPath("uv");
    if (uv) out.push({ source: "uv", command: uv });
    if (this.deps.platform === "win32") {
      const py = await this.onPath("py");
      if (py) out.push({ source: "py", command: py });
    }
    for (const name of ["python3", "python"] as const) {
      const found = await this.onPath(name);
      if (found) out.push({ source: name, command: found });
    }
    return out;
  }

  private async readCache(): Promise<DiscoveryCache | undefined> {
    if (this.memory) return this.memory;
    try {
      const value = JSON.parse(
        await readFile(join(this.dir, "discovery.json"), "utf8"),
      ) as DiscoveryCache;
      return typeof value.executable === "string" && typeof value.mtime === "number"
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeCache(cache: DiscoveryCache): Promise<void> {
    this.memory = cache;
    try {
      await mkdir(this.dir, { recursive: true });
      const file = join(this.dir, "discovery.json");
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`);
      await rename(temporary, file);
    } catch {
      /* The cache is an optimization; discovery still works without it. */
    }
  }

  /** Probes one interpreter path: its version and real executable, or undefined. */
  private async probe(
    command: string,
    prefix: string[],
    signal: AbortSignal,
  ): Promise<{ version: string; executable: string } | undefined> {
    try {
      const result = await this.deps.exec(command, [...prefix, "-c", PROBE_CODE], signal);
      return result.exitCode === 0 ? parseProbe(result.stdout) : undefined;
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }

  /**
   * The interpreter to run: the cached one while its file is unchanged, else a fresh discovery.
   * With `--python`, only that path is considered.
   */
  async resolve(signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<PythonResolution> {
    const flag = this.pythonFlag;
    const cached = await this.readCache();
    if (
      cached &&
      (flag ? cached.source === "flag" && cached.executable === flag : cached.source !== "flag")
    ) {
      const info = await this.deps.stat(cached.executable);
      if (info?.isFile && info.mtimeMs === cached.mtime)
        return {
          ok: true,
          executable: cached.executable,
          version: cached.version,
          source: cached.source,
        };
    }
    this.memory = undefined;
    let tooOld: { version: string; path: string } | undefined;
    const accept = async (
      source: CandidateSource,
      probed: { version: string; executable: string } | undefined,
    ): Promise<PythonResolution | undefined> => {
      if (!probed) return undefined;
      if (!supportedVersion(probed.version)) {
        tooOld ??= { version: probed.version, path: probed.executable };
        return undefined;
      }
      if (this.storeAlias(probed.executable)) return undefined;
      const info = await this.deps.stat(probed.executable);
      const executable = info?.isFile ? probed.executable : undefined;
      if (!executable) return undefined;
      await this.writeCache({
        executable,
        version: probed.version,
        mtime: info?.mtimeMs ?? 0,
        source,
      });
      return { ok: true, executable, version: probed.version, source };
    };
    if (flag) {
      const info = await this.deps.stat(flag);
      if (!info?.isFile)
        return {
          ok: false,
          flag: true,
          reason: `--python ${flag} does not exist`,
          found: { path: flag, reason: "not found" },
        };
      const probed = await this.probe(flag, [], signal);
      const accepted = await accept("flag", probed);
      if (accepted) return accepted;
      return {
        ok: false,
        flag: true,
        reason: probed
          ? `--python ${flag} is Python ${probed.version}; Alisio needs ${MIN_PYTHON.join(".")} or newer`
          : `--python ${flag} is not a working Python interpreter`,
        found: probed
          ? { version: probed.version, path: flag }
          : { path: flag, reason: "not a working Python interpreter" },
      };
    }
    for (const candidate of await this.candidates()) {
      signal.throwIfAborted();
      let accepted: PythonResolution | undefined;
      if (candidate.source === "uv") {
        try {
          const found = await this.deps.exec(
            candidate.command,
            ["python", "find", ">=3.10"],
            signal,
          );
          const path = found.stdout.trim().split(/\r?\n/).pop()?.trim();
          if (found.exitCode === 0 && path && isAbsolute(path))
            accepted = await accept("uv", await this.probe(path, [], signal));
        } catch {
          signal.throwIfAborted();
        }
      } else if (candidate.source === "py")
        accepted = await accept("py", await this.probe(candidate.command, ["-3"], signal));
      else
        accepted = await accept(candidate.source, await this.probe(candidate.command, [], signal));
      if (accepted) return accepted;
    }
    const old = tooOld as { version: string; path: string } | undefined;
    return old
      ? { ok: false, reason: `Python ${old.version} is too old`, found: old }
      : { ok: false, reason: "No Python interpreter was found on PATH" };
  }

  /** The interpreter `python_run` uses: an installed extras environment, else the base one. */
  async interpreter(
    signal?: AbortSignal,
  ): Promise<PythonResolution & { extras?: Extras[]; runtimeVersion?: string }> {
    const base = await this.resolve(signal);
    if (!base.ok) return base;
    const active = await this.activeRuntime();
    if (active && active.pythonVersion === base.version) {
      const python = venvInterpreter(
        join(this.dir, active.runtimeVersion, "venv"),
        this.deps.platform,
      );
      if ((await this.deps.stat(python))?.isFile)
        return {
          ...base,
          executable: python,
          venv: true,
          extras: active.extras,
          runtimeVersion: active.runtimeVersion,
        };
    }
    return base;
  }

  /** The extras environment recorded by `alisio analysis setup --extras`, when healthy. */
  async activeRuntime(): Promise<RuntimeState | undefined> {
    try {
      const pointer = JSON.parse(await readFile(join(this.dir, "active.json"), "utf8")) as {
        runtimeVersion?: string;
      };
      if (!pointer.runtimeVersion || !/^[a-f0-9]{8,64}$/.test(pointer.runtimeVersion))
        return undefined;
      const state = JSON.parse(
        await readFile(join(this.dir, pointer.runtimeVersion, "runtime.json"), "utf8"),
      ) as RuntimeState;
      return state.ok ? state : undefined;
    } catch {
      return undefined;
    }
  }

  private installing = new Map<string, Promise<RuntimeState>>();

  /** Whether the healthy extras environment already provides `extras` (`science` includes `analysis`). */
  async hasExtras(extras: Extras): Promise<boolean> {
    const active = await this.activeRuntime();
    if (!active) return false;
    const base = await this.resolve().catch(() => undefined);
    if (!base?.ok || base.version !== active.pythonVersion) return false;
    return (
      active.extras.includes(extras) || (extras === "analysis" && active.extras.includes("science"))
    );
  }

  /**
   * Creates the extras environment and installs the hash-locked wheels (`--require-hashes`,
   * `--only-binary=:all:`; nothing is compiled). Needs network. Never called by `python_run`
   * without an `analysis.install` approval. Failing (offline, no wheel for this platform) leaves
   * no half-built environment and does not touch the active one. Concurrent calls share one run.
   */
  installExtras(
    extras: Extras,
    options: { signal: AbortSignal; onOutput?: (text: string) => void },
  ): Promise<RuntimeState> {
    const running = this.installing.get(extras);
    if (running) return running;
    const work = this.doInstall(extras, options).finally(() => this.installing.delete(extras));
    this.installing.set(extras, work);
    return work;
  }

  private async doInstall(
    extras: Extras,
    options: { signal: AbortSignal; onOutput?: (text: string) => void },
  ): Promise<RuntimeState> {
    const base = await this.resolve(options.signal);
    if (!base.ok) throw new Error(base.reason);
    const lock = EXTRAS_LOCK[extras];
    const runtimeVersion = createHash("sha256")
      .update(`${extras}\n${base.version}\n${lock}`)
      .digest("hex")
      .slice(0, 8);
    const root = join(this.dir, runtimeVersion);
    const venv = join(root, "venv");
    const python = venvInterpreter(venv, this.deps.platform);
    const existed = !!(await this.deps.stat(root));
    await mkdir(root, { recursive: true });
    const lockFile = join(root, `${extras}.txt`);
    await writeFile(lockFile, lock);
    const uv = await this.onPath("uv");
    const step = this.options.install ?? defaultInstallStep;
    const run = async (command: string, args: string[]) => {
      const result = await step(command, args, {
        cwd: root,
        signal: options.signal,
        ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      });
      if (result.exitCode !== 0) {
        const detail = `${result.stderr || result.stdout}`.slice(-4000);
        if (OFFLINE_SIGNS.test(detail))
          throw new ExtrasInstallError(
            `Could not download the Python packages: there is no network connection, or the package index is unreachable. ` +
              `Nothing was installed and python_run keeps working with the standard library. ` +
              `Connect to the internet and try again (${setupCommand(extras)}).\n${detail.trim().split(/\r?\n/).slice(-3).join("\n")}`,
            "offline",
          );
        throw new ExtrasInstallError(
          `${command} ${args.join(" ")} failed (exit ${result.exitCode}):\n${detail}`,
          "failed",
        );
      }
    };
    try {
      if (!(await this.deps.stat(python))?.isFile) {
        if (uv) await run(uv, ["venv", "--python", base.executable, venv]);
        else await run(base.executable, ["-m", "venv", venv]);
      }
      if (uv)
        await run(uv, [
          "pip",
          "install",
          "--python",
          python,
          "--require-hashes",
          "--only-binary",
          ":all:",
          "-r",
          lockFile,
        ]);
      else
        await run(python, [
          "-m",
          "pip",
          "install",
          "--require-hashes",
          "--only-binary=:all:",
          "--no-input",
          "--retries",
          "1",
          "--timeout",
          "20",
          "-r",
          lockFile,
        ]);
      await run(python, ["-c", `import ${EXTRAS_PACKAGES[extras].join(", ")}`]);
    } catch (error) {
      // A new, half-built environment is useless (and misleading): remove what this call made.
      if (!existed) await rm(root, { recursive: true, force: true }).catch(() => undefined);
      if (options.signal.aborted) throw options.signal.reason ?? error;
      throw error;
    }
    const state: RuntimeState = {
      runtimeVersion,
      python: base.executable,
      pythonVersion: base.version,
      extras: [extras],
      createdAt: Date.now(),
      ok: true,
    };
    await writeFile(join(root, "runtime.json"), `${JSON.stringify(state, null, 2)}\n`);
    const pointer = join(this.dir, "active.json");
    const temporary = `${pointer}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ runtimeVersion }, null, 2)}\n`);
    await rename(temporary, pointer);
    return state;
  }
}
