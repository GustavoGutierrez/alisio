/** Pure engine selector (spec 026 D3): a chain of rules, decided once per call before rendering. */
import type { EngineId, Readiness } from "./ports.ts";

export interface EngineCandidate {
  id: EngineId;
  readiness: Readiness;
}

export type EngineChoice = "auto" | "chromium" | "weasyprint";

export interface SelectInput {
  /** `documents.engine`. */
  configured: EngineChoice;
  /** `engine` of this call; wins over the configuration. */
  requested?: EngineChoice | undefined;
  candidates: readonly EngineCandidate[];
  /** The spec needs a feature only the editorial engine has (running headers, footnotes). */
  needsWeasyprintOnly?: boolean;
  quality: "fast" | "professional";
}

export type EngineUnavailableReason = {
  engine: EngineId;
  reason: string;
  fix?: string | undefined;
};

export type Selection =
  | { ok: true; engine: EngineId }
  | { ok: false; reasons: EngineUnavailableReason[] };

export function selectDocumentEngine(input: SelectInput): Selection {
  const choice = input.requested ?? input.configured;
  const find = (id: EngineId) => input.candidates.find((c) => c.id === id);
  const ready = (id: EngineId) => find(id)?.readiness.ready === true;
  const reasonOf = (id: EngineId): EngineUnavailableReason => {
    const c = find(id);
    if (!c) return { engine: id, reason: "Not available in this build or surface" };
    return c.readiness.ready
      ? { engine: id, reason: "Ready" }
      : { engine: id, reason: c.readiness.reason, fix: c.readiness.fix };
  };

  // An explicit choice is honored or fails; it is never silently replaced.
  if (choice === "weasyprint")
    return ready("weasyprint")
      ? { ok: true, engine: "weasyprint" }
      : { ok: false, reasons: [reasonOf("weasyprint")] };
  if (choice === "chromium") {
    if (ready("electron")) return { ok: true, engine: "electron" };
    if (ready("chromium")) return { ok: true, engine: "chromium" };
    return {
      ok: false,
      reasons: [reasonOf("electron"), reasonOf("chromium")].filter(keepInformative),
    };
  }
  if (input.needsWeasyprintOnly && input.quality === "professional" && ready("weasyprint"))
    return { ok: true, engine: "weasyprint" };
  for (const id of ["electron", "chromium", "weasyprint"] as const)
    if (ready(id)) return { ok: true, engine: id };
  return {
    ok: false,
    reasons: (["electron", "chromium", "weasyprint"] as const)
      .map(reasonOf)
      .filter(keepInformative),
  };
}

/** Engines that do not exist on this surface add noise to the message. */
const keepInformative = (r: EngineUnavailableReason, _i?: number, _a?: unknown) =>
  r.reason !== "Not available in this build or surface";
