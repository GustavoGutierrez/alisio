/**
 * Assembly of the Python side of Forja for `python_run` (Python spec §4.1): the two backends, the
 * two engines registered in the kernel's registry and the selector. The application hands in the
 * kernel it shares with `js_run` (one journal, one state store, one registry); an embedder that
 * registers the analysis tools alone gets a private kernel over the same database.
 */
import type { AnalysisJobs } from "../../analysis/jobs.ts";
import { SqliteExecutionJournal } from "../journal.ts";
import { ExecutionKernel } from "../kernel.ts";
import { EngineRegistry } from "../registry.ts";
import { createJavaScriptSelector } from "../selector.ts";
import { SlotTable } from "../slots.ts";
import { SqliteStateStore } from "../state-store.ts";
import type { PythonBackend, PythonBackendId } from "./backend.ts";
import { createPythonBackendSelector } from "./backend-selector.ts";
import { PythonEngine } from "./engine.ts";
import { ManagedBackend, type ManagedBackendDeps } from "./managed-backend.ts";
import { OciBackend, type OciBackendDeps } from "./oci-backend.ts";
import { PyodideBackend, type PyodideBackendDeps } from "./pyodide-backend.ts";

export interface PythonBackendOptions {
  runtime: ManagedBackendDeps["runtime"];
  oci?: OciBackendDeps["oci"];
  /** The Pyodide backend; without it `wasm` is not available in this process. */
  wasm?: PyodideBackendDeps;
}

/** The backends of one process, in no particular order (the selector orders them). */
export function createPythonBackends(
  options: PythonBackendOptions,
): Partial<Record<PythonBackendId, PythonBackend>> {
  return {
    managed: new ManagedBackend({ runtime: options.runtime }),
    ...(options.oci ? { oci: new OciBackend({ oci: options.oci }) } : {}),
    ...(options.wasm ? { wasm: new PyodideBackend(options.wasm) } : {}),
  };
}

export interface PythonForgeOptions extends PythonBackendOptions {
  jobs: AnalysisJobs;
  /** The application's kernel and registry. Without them a private pair is built. */
  shared?: { kernel: ExecutionKernel; engines: EngineRegistry };
}

export interface PythonForge {
  kernel: ExecutionKernel;
  engines: EngineRegistry;
  backends: Partial<Record<PythonBackendId, PythonBackend>>;
  selector: ReturnType<typeof createPythonBackendSelector>;
  /** Registers the engines in the registry (once). Await it before the first execution. */
  ready(): Promise<void>;
}

export function createPythonForge(options: PythonForgeOptions): PythonForge {
  const backends = createPythonBackends(options);
  const engines = options.shared?.engines ?? new EngineRegistry();
  const kernel =
    options.shared?.kernel ??
    new ExecutionKernel({
      engines,
      // Python hands the kernel its own selection; the JavaScript chain is never consulted.
      selector: createJavaScriptSelector(),
      journal: new SqliteExecutionJournal(options.jobs.database),
      state: new SqliteStateStore(options.jobs.database),
      slots: new SlotTable(),
      config: () => ({ enabled: false, limits: {}, stateEnabled: true }),
    });
  let registered: Promise<void> | undefined;
  return {
    kernel,
    engines,
    backends,
    selector: createPythonBackendSelector(),
    ready: () => {
      registered ??= (async () => {
        for (const backend of Object.values(backends))
          await engines.register(new PythonEngine({ backend, jobs: options.jobs }));
      })();
      return registered;
    },
  };
}
