/**
 * `OciBackend` (Python spec §4.3): Docker or Podman with a digest-pinned image, as `python_run` has
 * always run it (`ociRunArgs`, `OciRuntime.run`). `isolation: "os-container"`: no network, a
 * read-only root, no capabilities, memory and process limits; not a hardened sandbox.
 */
import type { EngineDescriptor } from "@alisio/sdk";
import { mountSource, type OciRuntime } from "../../analysis/oci.ts";
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

export interface OciBackendDeps {
  /** Read on every call: the settings can change between calls. `mode` is `analysis.runtime`. */
  oci: { runtime(): OciRuntime; mode?(): string };
}

export class OciBackend implements PythonBackend {
  readonly id = "oci" as const;
  readonly #deps: OciBackendDeps;

  constructor(deps: OciBackendDeps) {
    this.#deps = deps;
  }

  async describe(): Promise<EngineDescriptor> {
    const { settings } = this.#deps.oci.runtime();
    return {
      id: "python-oci",
      language: "python",
      version: settings.image ?? settings.engine,
      isolation: "os-container",
      ready: true,
      capabilities: {
        cooperativeInterrupt: false,
        hardTermination: true,
        hardMemoryLimit: true,
        networkDeniedByOS: true,
        toolCalls: false,
      },
    };
  }

  async check(signal?: AbortSignal): Promise<BackendReadiness> {
    const reason = await this.#deps.oci
      .runtime()
      .unavailable(signal, { auto: this.#deps.oci.mode?.() === "auto" });
    return reason === undefined ? { ready: true } : { ready: false, reason };
  }

  supports(): SupportVerdict {
    return { ok: true };
  }

  async launch(job: PreparedJob, sink: ProcessSink): Promise<RunningProcess> {
    const runtime = this.#deps.oci.runtime();
    const stop = new AbortController();
    // A scratchpad path the engine would misparse as mount syntax is simply not exposed.
    const scratch = job.scratch && mountable(job.scratch) ? job.scratch : undefined;
    const result = runtime.run({
      executionId: job.executionId,
      mounts: {
        script: job.paths.script,
        input: job.paths.input,
        work: job.paths.work,
        staging: job.paths.staging,
        ...(scratch ? { scratch } : {}),
      },
      signal: AbortSignal.any([job.signal, stop.signal]),
      timeoutMs: job.backstopMs,
      maxBytes: job.maxBytes,
      logFiles: job.logFiles,
      maxLogBytes: job.maxLogBytes,
      onData: sink.onData,
      env: job.env,
    });
    const { settings } = runtime;
    return {
      result,
      stop,
      runtime: {
        mode: "oci",
        engine: settings.engine,
        ...(settings.image ? { image: settings.image } : {}),
        extras: [],
      },
    };
  }

  /** Aborting the run kills the container by name (`OciRuntime.run` does it in its `finally`). */
  async terminate(process: RunningProcess, _reason: TerminationReason): Promise<TerminationReport> {
    const started = Date.now();
    process.stop.abort();
    return settle(process, "container-kill", started);
  }
}

function mountable(path: string): boolean {
  try {
    mountSource(path, process.platform);
    return true;
  } catch {
    return false;
  }
}
