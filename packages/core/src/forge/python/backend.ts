/**
 * The strategy behind `PythonEngine` (Python spec §4.2, PD1). A backend knows how to start a
 * prepared job and how to stop it; everything else of an execution (job folders, the frame
 * transport, publication, journal, state) is shared. The three implementations are `managed`, `oci`
 * and `wasm` (Pyodide in a restricted Node child process).
 */
import type { EngineDescriptor } from "@alisio/sdk";
import type { JobPaths } from "../../analysis/jobs.ts";
import type { ProcessResult } from "../../runtime/process.ts";
import type { TerminationReason, TerminationReport } from "../ports.ts";

export type PythonBackendId = "managed" | "oci" | "wasm";

/** What the selector may ask of a backend before choosing it (pure, no I/O). */
export interface PythonRequirements {
  extras: Array<"analysis" | "science">;
  /** Top-level modules the script imports (`scanImports`). */
  importedModules: string[];
  /** Sum of the input sizes. */
  inputBytes: number;
  rerunOfBackend?: PythonBackendId;
}

export type SupportVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      code: "PROFILE_UNSUPPORTED" | "PACKAGE_UNAVAILABLE" | "INPUT_TOO_LARGE" | "NOT_READY";
      /** The command that would make it fit, when there is one (`alisio analysis setup --wasm …`). */
      fix?: string;
    };

/** The live answer of "can this backend run now?", gathered before selection. */
export type BackendReadiness =
  | { ready: true }
  | {
      ready: false;
      /** Actionable, as the user reads it. */
      reason: string;
      /** The backend's own diagnosis (managed: the failed interpreter resolution), for rendering. */
      detail?: unknown;
      /** The command that makes it ready when it differs from the usual setup one; "" = none helps. */
      fix?: string;
    };

/** A job whose folders exist, handed to a backend to start. */
export interface PreparedJob {
  executionId: string;
  paths: JobPaths;
  /** Variables for the script on top of the job paths: the frame nonce, the scratchpad. */
  env: Record<string, string>;
  /** The Forja scratchpad, exposed read-only (managed: env var; oci: `:ro` mount). */
  scratch?: string;
  /** Aborted when the kernel stops the execution (deadline or cancellation). */
  signal: AbortSignal;
  /** A backstop for the process, longer than the kernel's own deadline. */
  backstopMs: number;
  maxBytes: number;
  maxLogBytes: number;
  logFiles: { stdout: string; stderr: string };
}

export interface ProcessSink {
  /** Live text of the script; `stdout` is where frames travel. */
  onData(chunk: string, stream: "stdout" | "stderr"): void;
}

export interface RunningProcess {
  /** Settles when the process ended; rejects with an abort error when it was stopped. */
  readonly result: Promise<ProcessResult>;
  /** The public runtime facts for the artifacts' provenance (`runtime`). */
  readonly runtime: Record<string, unknown>;
  /** Backend-private stop handle. */
  readonly stop: AbortController;
  /**
   * A limit the BACKEND enforced by killing the process (the wasm memory watchdog). The engine
   * reports it as the failure instead of a bare non-zero exit.
   */
  readonly limit?: () => { code: "MEMORY_LIMIT"; message: string } | undefined;
}

export interface PythonBackend {
  readonly id: PythonBackendId;
  describe(): Promise<EngineDescriptor>;
  /** Live readiness. May run a process (interpreter discovery) or call the container engine. */
  check(signal?: AbortSignal): Promise<BackendReadiness>;
  supports(requirements: PythonRequirements): SupportVerdict;
  launch(job: PreparedJob, sink: ProcessSink): Promise<RunningProcess>;
  terminate(process: RunningProcess, reason: TerminationReason): Promise<TerminationReport>;
}
