/**
 * `PyodideBackend` (Python spec §4.3, §8): Pyodide in a child `node` started with the Permission
 * Model. `isolation: "wasm-process"`: the file system is limited to the Pyodide folder and the job (the scratchpad as a link-free copy),
 * there are no child processes, workers or addons; the network is NOT restricted on Node 22/24
 * (the self-probe says what this machine does) and Python reaches the runner's JavaScript through
 * the FFI. Memory is bounded by an RSS watchdog (soft), time by the kernel's deadline plus a startup
 * margin, and termination is SIGKILL of the child, confirmed by its exit (PD13).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EngineDescriptor } from "@alisio/sdk";
import { killProcessTree, type ProcessResult, runProcess } from "../../runtime/process.ts";
import type { TerminationReason, TerminationReport } from "../ports.ts";
import type {
  BackendReadiness,
  PreparedJob,
  ProcessSink,
  PythonBackend,
  PythonRequirements,
  RunningProcess,
  SupportVerdict,
} from "./backend.ts";
import { classifyModules, scanImports } from "./import-scan.ts";
import {
  inspectPyodide,
  type PyodideInspection,
  pyodideDir,
  verifyPyodideFiles,
} from "./pyodide-install.ts";
import {
  PYODIDE_MANIFEST,
  PYODIDE_PROFILE_ORDER,
  type PyodideFile,
  type PyodideManifest,
  type PyodideProfile,
} from "./pyodide-manifest.ts";
import { PYODIDE_RUNNER_SOURCE } from "./pyodide-runner-source.ts";
import { type RssReader, readRssMb } from "./rss.ts";
import { copyScratchNoFollow } from "./scratch-copy.ts";
import { settle } from "./settle.ts";
import {
  childEnv,
  currentNodeEnvironment,
  type NodeEnvironment,
  type NodeResolution,
  permissionArgs,
  probeNetwork,
  resolveNode,
} from "./wasm-node.ts";

/** `analysis.wasm`, read on every call: the settings can change between calls. */
export interface WasmSettings {
  memoryMb: number;
  startupMs: number;
  maxInputBytes: number;
  nodePath: string | null;
}

export interface PyodideBackendDeps {
  /** The state root; the distribution lives in `<root>/analysis/pyodide/<version>`. */
  stateRoot: string;
  settings: () => WasmSettings;
  manifest?: PyodideManifest;
  environment?: () => NodeEnvironment;
  /** Replaceable in tests. */
  rss?: RssReader;
  sampleMs?: number;
}

/** How often the watchdog samples the child (measured in P0: up to one tick of overshoot). */
const SAMPLE_MS = 250;
/** How often the parent looks for the runner's ready file. */
const READY_POLL_MS = 50;

const PROFILE_FIX = (profile: PyodideProfile) =>
  `alisio analysis setup --wasm${profile === "science" ? " --profile science" : ""}`;

/** Keys needed to load `wanted` (and what they depend on), in the manifest's load order. */
export function loadPlan(
  manifest: PyodideManifest,
  profile: PyodideProfile,
  wanted: readonly string[],
): { packages: string[]; wheels: string[]; files: PyodideFile[] } {
  const needed = new Set<string>();
  const add = (key: string): void => {
    if (needed.has(key)) return;
    const pkg = manifest.packages[key];
    if (!pkg) return;
    needed.add(key);
    for (const dep of pkg.depends) add(dep);
  };
  for (const key of wanted) add(key);
  const ordered = manifest.profiles[profile].filter((key) => needed.has(key));
  const packages: string[] = [];
  const wheels: string[] = [];
  const files: PyodideFile[] = [];
  for (const key of ordered) {
    const pkg = manifest.packages[key] as NonNullable<(typeof manifest.packages)[string]>;
    files.push(pkg);
    if (pkg.source === "pyodide") packages.push(key);
    else wheels.push(pkg.name);
  }
  return { packages, wheels, files };
}

export class PyodideBackend implements PythonBackend {
  readonly id = "wasm" as const;
  readonly #deps: PyodideBackendDeps;
  readonly #manifest: PyodideManifest;
  /** The profile found installed by the last `check()`; `supports` is synchronous and uses it. */
  #installed: PyodideProfile | undefined;

  constructor(deps: PyodideBackendDeps) {
    this.#deps = deps;
    this.#manifest = deps.manifest ?? PYODIDE_MANIFEST;
  }

  get #dir(): string {
    return pyodideDir(this.#deps.stateRoot, this.#manifest);
  }

  #node(): Promise<NodeResolution> {
    return resolveNode(
      this.#deps.settings().nodePath,
      (this.#deps.environment ?? currentNodeEnvironment)(),
    );
  }

  async check(_signal?: AbortSignal): Promise<BackendReadiness> {
    const node = await this.#node();
    if (!node.ok) {
      this.#installed = undefined;
      return { ready: false, reason: node.reason, fix: "" };
    }
    const installation = await inspectPyodide(this.#dir, this.#manifest);
    this.#installed = installation.ok ? installation.profile : undefined;
    return installation.ok ? { ready: true } : { ready: false, reason: installation.reason };
  }

  /** Static facts plus the observed network answer; `ready` is the live state of `check()`. */
  async describe(): Promise<EngineDescriptor> {
    const state = await this.check();
    let networkDeniedByOS = false;
    if (state.ready) {
      const node = await this.#node();
      if (node.ok) {
        const dir = this.#dir;
        networkDeniedByOS = (await probeNetwork(node, permissionArgs({ read: [dir], write: [] })))
          .denied;
      }
    }
    return {
      id: "python-wasm",
      language: "python",
      version: `pyodide-${this.#manifest.version} (python ${this.#manifest.python})`,
      isolation: "wasm-process",
      // Registered once: readiness is checked on every call (like the other backends).
      ready: true,
      ...(state.ready ? {} : { reason: state.reason }),
      capabilities: {
        cooperativeInterrupt: false,
        hardTermination: true,
        hardMemoryLimit: false,
        networkDeniedByOS,
        toolCalls: false,
      },
      profiles: this.#installed
        ? PYODIDE_PROFILE_ORDER.slice(0, PYODIDE_PROFILE_ORDER.indexOf(this.#installed) + 1).map(
            String,
          )
        : [],
    };
  }

  supports(requirements: PythonRequirements): SupportVerdict {
    const { maxInputBytes } = this.#deps.settings();
    if (requirements.inputBytes > maxInputBytes)
      return {
        ok: false,
        code: "INPUT_TOO_LARGE",
        reason: `the inputs are ${Math.ceil(requirements.inputBytes / (1024 * 1024))} MB, over analysis.wasm.maxInputBytes (${Math.floor(maxInputBytes / (1024 * 1024))} MB)`,
      };
    const found = classifyModules(requirements.importedModules);
    if (found.unknown.length)
      return {
        ok: false,
        code: "PACKAGE_UNAVAILABLE",
        reason: `module${found.unknown.length === 1 ? "" : "s"} ${found.unknown.join(", ")} ${found.unknown.length === 1 ? "is" : "are"} not in the wasm profiles`,
      };
    const wanted = [found.profile, ...requirements.extras].reduce<PyodideProfile>(
      (top, p) => (PYODIDE_PROFILE_ORDER.indexOf(p) > PYODIDE_PROFILE_ORDER.indexOf(top) ? p : top),
      "base",
    );
    if (this.#installed === undefined)
      return {
        ok: false,
        code: "NOT_READY",
        reason: "Pyodide is not installed",
        fix: PROFILE_FIX("analysis"),
      };
    if (PYODIDE_PROFILE_ORDER.indexOf(wanted) > PYODIDE_PROFILE_ORDER.indexOf(this.#installed))
      return {
        ok: false,
        code: "PROFILE_UNSUPPORTED",
        reason: `this script needs the ${wanted} profile and ${this.#installed} is installed`,
        fix: PROFILE_FIX(wanted),
      };
    return { ok: true };
  }

  async launch(job: PreparedJob, sink: ProcessSink): Promise<RunningProcess> {
    const settings = this.#deps.settings();
    const node = await this.#node();
    if (!node.ok) throw new Error(`runtime_unavailable: ${node.reason}`);
    const installation: PyodideInspection = await inspectPyodide(this.#dir, this.#manifest);
    if (!installation.ok) throw new Error(`runtime_unavailable: ${installation.reason}`);

    // What this script loads: its imports, nothing of the profile it does not use.
    const source = await readFile(job.paths.main, "utf8");
    const wantedPackages = classifyModules(scanImports(source)).packages;
    const plan = loadPlan(this.#manifest, installation.profile, wantedPackages);
    const mismatch = await verifyPyodideFiles(installation.dir, [
      ...this.#manifest.core,
      ...plan.files,
    ]);
    if (mismatch)
      throw new Error(
        `runtime_unavailable: Pyodide file ${mismatch} does not match its pinned SHA-256; run "alisio analysis setup --wasm" again`,
      );

    // The runner is written next to the distribution so the restricted child may read it.
    const runnerName = `runner-${createHash("sha256").update(PYODIDE_RUNNER_SOURCE).digest("hex").slice(0, 12)}.mjs`;
    const runner = join(installation.dir, runnerName);
    if ((await readFile(runner, "utf8").catch(() => undefined)) !== PYODIDE_RUNNER_SOURCE) {
      const temporary = `${runner}.${process.pid}.tmp`;
      await writeFile(temporary, PYODIDE_RUNNER_SOURCE);
      await rename(temporary, runner);
    }

    const real = (path: string) => realpath(path);
    // The Permission Model follows links that already exist, so the real scratchpad is never
    // granted: the child gets a copy made here without following any link (M1).
    const scratchCopy = join(job.paths.root, "scratch-copy");
    let scratch: string | undefined;
    if (job.scratch) {
      const source = await real(job.scratch).catch(() => undefined);
      if (source) {
        await rm(scratchCopy, { recursive: true, force: true });
        await copyScratchNoFollow(source, scratchCopy);
        scratch = await real(scratchCopy);
      }
    }
    const [dist, script, input, work, staging] = await Promise.all([
      real(installation.dir),
      real(job.paths.script),
      real(job.paths.input),
      real(job.paths.work),
      real(job.paths.staging),
    ]);
    await mkdir(staging, { recursive: true });
    const spec = {
      dist,
      packages: plan.packages,
      wheels: plan.wheels,
      job: { script, input, work, out: staging, ...(scratch ? { scratch } : {}) },
    };
    const args = [
      ...permissionArgs({
        read: [dist, script, input, work, staging, ...(scratch ? [scratch] : [])],
        write: [work, staging],
      }),
      join(dist, runnerName),
      JSON.stringify(spec),
    ];

    const stop = new AbortController();
    const memory: { hit?: { code: "MEMORY_LIMIT"; message: string }; peakMb: number } = {
      peakMb: 0,
    };
    const runtime: Record<string, unknown> = {
      mode: "wasm",
      pyodide: this.#manifest.version,
      python: this.#manifest.python,
      node: node.version,
      profile: installation.profile,
      extras: [],
      packages: [...plan.packages, ...plan.wheels],
      memoryMb: settings.memoryMb,
    };
    const spawnedAt = Date.now();
    // The runner leaves a file when Pyodide and the packages are loaded: its modification time
    // ends the startup, whenever the parent happens to look.
    const readyFile = join(work, ".forge", "wasm-ready");
    const readStartup = async (): Promise<boolean> => {
      try {
        const info = await stat(readyFile);
        runtime.startupMs ??= Math.max(0, Math.round(info.mtimeMs - spawnedAt));
        return true;
      } catch {
        return false;
      }
    };
    const watchReady = setInterval(() => {
      void readStartup().then((found) => found && clearInterval(watchReady));
    }, READY_POLL_MS);
    watchReady.unref?.();
    let sampler: ReturnType<typeof setInterval> | undefined;
    const read = this.#deps.rss ?? readRssMb;
    const sample = async (pid: number): Promise<void> => {
      const rss = await read(pid);
      if (rss === undefined) return;
      memory.peakMb = Math.max(memory.peakMb, rss);
      runtime.peakRssMb = Math.round(memory.peakMb);
      if (rss > settings.memoryMb && !memory.hit) {
        memory.hit = {
          code: "MEMORY_LIMIT",
          message: `the wasm runtime used ${Math.round(rss)} MB, over analysis.wasm.memoryMb (${settings.memoryMb} MB)`,
        };
        killProcessTree(pid);
      }
    };
    const result: Promise<ProcessResult> = runProcess(node.path, args, {
      cwd: work,
      signal: AbortSignal.any([job.signal, stop.signal]),
      timeoutMs: job.backstopMs,
      maxBytes: job.maxBytes,
      onOverflow: "truncate",
      logFiles: job.logFiles,
      maxLogBytes: job.maxLogBytes,
      // Kill, don't ask: Pyodide has no cooperative interrupt (PD13).
      killGraceMs: 1,
      env: childEnv({ ...job.env, ALISIO_EXECUTION_ID: job.executionId }),
      onSpawn: (pid) => {
        sampler = setInterval(() => void sample(pid), this.#deps.sampleMs ?? SAMPLE_MS);
        sampler.unref?.();
      },
      onData: sink.onData,
    }).finally(async () => {
      clearInterval(sampler);
      clearInterval(watchReady);
      await readStartup();
      if (scratch) await rm(scratchCopy, { recursive: true, force: true }).catch(() => undefined);
    });
    return {
      result,
      stop,
      runtime,
      limit: () => memory.hit,
    };
  }

  async terminate(process: RunningProcess, _reason: TerminationReason): Promise<TerminationReport> {
    const started = Date.now();
    process.stop.abort();
    return settle(process, "kill", started);
  }
}
