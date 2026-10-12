/**
 * Gathers the `PythonEnvironment` snapshot the Python guides are written from: the backend the
 * selector would choose RIGHT NOW (same chain, same settings as `python_run`, no script known) and
 * the packages that backend really has. It probes readiness like a call would and never starts a
 * script or installs anything.
 */
import { EXTRAS_DISTRIBUTIONS } from "../../analysis/requirements.ts";
import { isForgeError } from "../errors.ts";
import type { BackendReadiness, PythonBackend, PythonBackendId } from "../python/backend.ts";
import {
  createPythonBackendSelector,
  type IsolationPolicy,
  neededBackends,
  type PythonRuntimeSetting,
} from "../python/backend-selector.ts";
import { PYODIDE_PROFILE_ORDER, PYODIDE_PROFILES } from "../python/pyodide-manifest.ts";
import type { PackageKnowledge, PythonEnvironment } from "./python.ts";

export interface PythonEnvironmentDeps {
  backends: Partial<Record<PythonBackendId, PythonBackend>>;
  /** `analysis.runtime`, read live. */
  runtime(): PythonRuntimeSetting;
  /** `analysis.isolation`, read live. */
  isolation(): IsolationPolicy;
  /** The extras installed in the managed virtual environment (`analysis`, `science`). */
  managedExtras(): Promise<readonly string[]>;
  /** `analysis.smartDashboard`. */
  smartDashboard(): boolean;
}

const selector = createPythonBackendSelector();

async function packagesOf(
  backend: PythonBackend,
  deps: PythonEnvironmentDeps,
): Promise<PackageKnowledge> {
  if (backend.id === "wasm") {
    const installed = (await backend.describe()).profiles ?? [];
    const top = PYODIDE_PROFILE_ORDER.filter((profile) => installed.includes(profile)).at(-1);
    return top
      ? {
          known: true,
          packages: [...PYODIDE_PROFILES[top]],
          detail: `Pyodide profile "${top}" is installed (profiles: ${installed.join(", ")}).`,
        }
      : { known: true, packages: [], detail: "No Pyodide package profile is installed (base)." };
  }
  if (backend.id === "managed") {
    const extras = await deps.managedExtras();
    const top = extras.includes("science")
      ? "science"
      : extras.includes("analysis")
        ? "analysis"
        : undefined;
    return top
      ? {
          known: true,
          packages: [...EXTRAS_DISTRIBUTIONS[top]],
          detail: `The "${top}" extras are installed in the managed environment.`,
        }
      : {
          known: true,
          packages: [],
          detail: "No extras are installed; pass `extras` to ask the user to install them.",
        };
  }
  return {
    known: false,
    detail:
      "A container has the packages of its image; scripts cannot install anything (no network).",
  };
}

export async function probePythonEnvironment(
  deps: PythonEnvironmentDeps,
  signal?: AbortSignal,
): Promise<PythonEnvironment> {
  const runtime = deps.runtime();
  const isolation = deps.isolation();
  const smartDashboard = deps.smartDashboard();
  const wanted = neededBackends({ runtime, isolation });
  const readiness: Partial<Record<PythonBackendId, BackendReadiness>> = {};
  const networkDenied: Partial<Record<PythonBackendId, boolean>> = {};
  await Promise.all(
    wanted.map(async (id) => {
      const backend = deps.backends[id];
      readiness[id] = backend
        ? await backend.check(signal)
        : { ready: false, reason: `${id} is not available here` };
      if (backend && readiness[id]?.ready && isolation === "strict")
        networkDenied[id] = (await backend.describe()).capabilities.networkDeniedByOS;
    }),
  );
  try {
    const chosen = selector.select({ runtime, isolation, readiness, networkDenied });
    const backend = deps.backends[chosen.engine];
    if (!backend)
      return { available: false, reason: `${chosen.engine} is not available here`, smartDashboard };
    return {
      available: true,
      backend: chosen.engine,
      reason: chosen.reason,
      packages: await packagesOf(backend, deps),
      smartDashboard,
    };
  } catch (error) {
    if (!isForgeError(error)) throw error;
    return { available: false, reason: error.message, smartDashboard };
  }
}
