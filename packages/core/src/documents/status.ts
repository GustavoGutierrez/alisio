/** Readiness of the document engines for `alisio documents status` (spec 026 §5.12, DOC-AC-31). */
import { ChromiumEngine, type ChromiumOptions } from "./engines/chromium/adapter.ts";
import type { EngineId, Readiness } from "./ports.ts";

export interface DocumentEngineStatus {
  id: EngineId;
  ready: boolean;
  version?: string;
  reason?: string;
  fix?: string;
}

export async function documentEngineStatus(
  options: Pick<ChromiumOptions, "explicitPath" | "detect">,
  signal: AbortSignal = new AbortController().signal,
): Promise<DocumentEngineStatus[]> {
  const chromium = new ChromiumEngine({ tmpRoot: "", ...options });
  const r: Readiness = await chromium.readiness(signal);
  await chromium.dispose();
  return [
    r.ready
      ? { id: "chromium", ready: true, version: r.version }
      : { id: "chromium", ready: false, reason: r.reason, ...(r.fix ? { fix: r.fix } : {}) },
  ];
}
