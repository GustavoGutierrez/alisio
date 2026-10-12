/**
 * `ManagedBackend` (Python spec §4.3): the discovered host Python, as `python_run` has always run
 * it. NOT a sandbox (`isolation: "none"`): the script has the user's permissions. This wraps
 * `AnalysisRuntimeManager.interpreter` and `runProcess` without changing what they do.
 */
import type { EngineDescriptor } from "@alisio/sdk";
import type { AnalysisRuntimeManager } from "../../analysis/runtime-manager.ts";
import { runProcess } from "../../runtime/process.ts";
import type { TerminationReason, TerminationReport } from "../ports.ts";
import type {
  BackendReadiness,
  PreparedJob,
  ProcessSink,
  PythonBackend,
  RunningProcess,
  SupportVerdict,
} from "./backend.ts";
import { settle } from "./settle.ts";

/** Environment of the script: the usual whitelist, HOME/TMP inside work/, and the job paths. */
export function scriptEnv(job: {
  input: string;
  staging: string;
  work: string;
  id: string;
}): Record<string, string> {
  const keep = [
    "PATH",
    "LANG",
    "LC_ALL",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
    "SYSTEMDRIVE",
    "WINDIR",
  ];
  return {
    ...Object.fromEntries(
      keep.flatMap((k) => (process.env[k] ? [[k, process.env[k] as string]] : [])),
    ),
    HOME: job.work,
    USERPROFILE: job.work,
    TMPDIR: job.work,
    TEMP: job.work,
    TMP: job.work,
    ALISIO_INPUT_DIR: job.input,
    ALISIO_OUTPUT_DIR: job.staging,
    ALISIO_WORK_DIR: job.work,
    ALISIO_EXECUTION_ID: job.id,
    MPLBACKEND: "Agg",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

export interface ManagedBackendDeps {
  /** Discovery of the interpreter; the installed extras environment is part of its answer. */
  runtime: Pick<AnalysisRuntimeManager, "interpreter">;
}

export class ManagedBackend implements PythonBackend {
  readonly id = "managed" as const;
  readonly #deps: ManagedBackendDeps;

  constructor(deps: ManagedBackendDeps) {
    this.#deps = deps;
  }

  async describe(): Promise<EngineDescriptor> {
    return {
      id: "python-managed",
      language: "python",
      version: "host python",
      isolation: "none",
      ready: true,
      capabilities: {
        cooperativeInterrupt: false,
        hardTermination: true,
        hardMemoryLimit: false,
        networkDeniedByOS: false,
        toolCalls: false,
      },
    };
  }

  async check(signal?: AbortSignal): Promise<BackendReadiness> {
    const resolved = await this.#deps.runtime.interpreter(signal);
    return resolved.ok
      ? { ready: true }
      : { ready: false, reason: resolved.reason, detail: resolved };
  }

  supports(): SupportVerdict {
    return { ok: true };
  }

  async launch(job: PreparedJob, sink: ProcessSink): Promise<RunningProcess> {
    const interpreter = await this.#deps.runtime.interpreter(job.signal);
    if (!interpreter.ok) throw new Error(`runtime_unavailable: ${interpreter.reason}`);
    const stop = new AbortController();
    const args = [
      ...(interpreter.prefixArgs ?? []),
      "-E",
      "-s",
      "-B",
      "-u",
      "-X",
      "utf8",
      job.paths.main,
    ];
    const result = runProcess(interpreter.executable, args, {
      cwd: job.paths.work,
      signal: AbortSignal.any([job.signal, stop.signal]),
      timeoutMs: job.backstopMs,
      maxBytes: job.maxBytes,
      onOverflow: "truncate",
      logFiles: job.logFiles,
      maxLogBytes: job.maxLogBytes,
      env: {
        ...scriptEnv(job.paths),
        ...job.env,
        // The scratchpad is the user's own folder: the variable names it, nothing enforces read-only.
        ...(job.scratch ? { ALISIO_SCRATCH_DIR: job.scratch } : {}),
      },
      onData: sink.onData,
    });
    return {
      result,
      stop,
      runtime: {
        mode: "managed",
        python: interpreter.version,
        extras: interpreter.extras ?? [],
        ...(interpreter.runtimeVersion ? { runtimeVersion: interpreter.runtimeVersion } : {}),
      },
    };
  }

  async terminate(process: RunningProcess, _reason: TerminationReason): Promise<TerminationReport> {
    const started = Date.now();
    process.stop.abort();
    return settle(process, "kill", started);
  }
}
