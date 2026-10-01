/**
 * The state of the analysis runtime for `alisio analysis status`, `alisio doctor` and the web
 * Settings page: mode, interpreter and extras, container engine (probed only when it matters),
 * limits and retention. One shape (`AnalysisStatus` of the SDK) for every surface.
 */
import type { AnalysisStatus } from "@alisio/sdk";
import type { Config } from "../config.ts";
import { detectHintHost, pythonInstallHints } from "./install-hints.ts";
import type { AnalysisJanitor } from "./janitor.ts";
import type { OciRuntime } from "./oci.ts";
import type { AnalysisRuntimeManager } from "./runtime-manager.ts";

export async function analysisStatus(input: {
  config: Config["analysis"];
  runtime: Pick<AnalysisRuntimeManager, "interpreter">;
  /** Builds the container runtime of the current settings (probed on demand). */
  oci?: () => OciRuntime;
  janitor?: Pick<AnalysisJanitor, "lastSweep">;
  /** python_run is registered (analysis enabled and not `--read-only`). */
  enabled: boolean;
  readOnly: boolean;
  signal?: AbortSignal;
}): Promise<AnalysisStatus> {
  const { config } = input;
  const resolved = await input.runtime.interpreter(input.signal);
  const python: AnalysisStatus["python"] = resolved.ok
    ? {
        found: true,
        path: resolved.executable,
        version: resolved.version,
        source: resolved.source,
        extras: resolved.extras ?? [],
        ...(resolved.runtimeVersion ? { runtimeVersion: resolved.runtimeVersion } : {}),
      }
    : {
        found: false,
        reason: resolved.reason,
        hints: await (async () => {
          const hints = pythonInstallHints(await detectHintHost(resolved.found));
          return {
            system: hints.system,
            ...(hints.heading ? { heading: hints.heading } : {}),
            primary: hints.primary,
            alternatives: hints.alternatives,
            notes: hints.notes,
          };
        })(),
      };
  const oci: AnalysisStatus["oci"] = {
    engine: config.oci.engine,
    ...(config.oci.image ? { image: config.oci.image } : {}),
    memoryMb: config.oci.memoryMb,
    cpus: config.oci.cpus,
  };
  if (input.oci && (config.runtime === "oci" || config.oci.image)) {
    const status = await input.oci().status(input.signal);
    oci.available = status.ok;
    if (status.ok) oci.version = status.version;
    else oci.reason = status.reason;
  }
  const lastSweep = await input.janitor?.lastSweep();
  return {
    enabled: input.enabled,
    readOnly: input.readOnly,
    mode: config.runtime,
    python,
    oci,
    limits: { timeoutMs: config.limits.timeoutMs },
    retention: { ...config.retention, ...(lastSweep !== undefined ? { lastSweep } : {}) },
  };
}
