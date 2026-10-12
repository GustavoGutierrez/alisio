/**
 * The live state of the Python backends for `alisio analysis status`, `alisio forge status` and the
 * API (Python spec §9.2-9.3). A descriptor says what a backend IS; readiness says whether it can
 * run now, so the two are merged here: `ready` and `reason` come from `check()`.
 */
import type { EngineDescriptor } from "@alisio/sdk";
import type { PythonBackend, PythonBackendId } from "./backend.ts";

/** Reading order: most isolated first, like `auto`. */
const ORDER: readonly PythonBackendId[] = ["oci", "wasm", "managed"];

export async function describePythonBackends(
  backends: Partial<Record<PythonBackendId, PythonBackend>>,
  signal?: AbortSignal,
): Promise<EngineDescriptor[]> {
  const found = ORDER.flatMap((id) => {
    const backend = backends[id];
    return backend ? [backend] : [];
  });
  return Promise.all(
    found.map(async (backend) => {
      const { reason: _own, ...descriptor } = await backend.describe();
      const state = await backend.check(signal);
      return state.ready
        ? { ...descriptor, ready: true }
        : { ...descriptor, ready: false, reason: state.reason };
    }),
  );
}
