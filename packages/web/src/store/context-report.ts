/**
 * The Context panel's logic (specs/012 phase 5): the pure model the tests exercise and the loader.
 * This module is its own chunk (it loads when the Context tab opens), so none of it is in the
 * initial bundle. The report is the `ContextReport` of `GET /api/sessions/:sid/context/report`,
 * the same value `/context` prints in the TUI; rows are a plain mapping of its segments, never a
 * recomputation, so every surface shows the same segments and reasons.
 */
import type {
  ContextCriticality,
  ContextElisionReason,
  ContextReport,
  ContextSegmentKind,
} from "@alisio/sdk";
import { signal } from "@preact/signals";
import { api, currentId } from "./app.ts";

/** The report of the open session (`undefined` until loaded). */
export const report = signal<ContextReport | undefined>(undefined);
export const loading = signal(false);
export const failed = signal(false);

export interface ContextRow {
  id: string;
  kind: ContextSegmentKind;
  origin: string;
  callId?: string;
  tokens: number;
  criticality: ContextCriticality;
  reason?: string;
  elided?: { reason: ContextElisionReason; replacedBy?: string; tokensSaved: number };
  used?: boolean;
}

/**
 * The segments of the report in order. By default only the ones that carry a decision to explain
 * (pinned, low and elided); `all` lists every segment the report holds.
 */
export function contextRows(source: ContextReport, all = false): ContextRow[] {
  return source.segments
    .filter((s) => all || s.criticality === "pinned" || s.criticality === "low" || !!s.elided)
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      origin: s.origin ?? "",
      ...(s.callId ? { callId: s.callId } : {}),
      tokens: s.tokens,
      criticality: s.criticality,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.elided ? { elided: s.elided } : {}),
      ...(s.used !== undefined ? { used: s.used } : {}),
    }));
}

export interface ContextSummary {
  active: boolean;
  elided: number;
  /** `[reason, count]` for the reasons with a count, in a fixed order. */
  reasons: Array<[ContextElisionReason, number]>;
  /** Percent (0..100) of decided tool results used later, if any is decided. */
  usedPercent?: number;
  hidden: number;
}

const REASONS: ContextElisionReason[] = ["superseded_read", "stale_bg_output", "duplicate_search"];

export function contextSummary(source: ContextReport): ContextSummary {
  const ratio = source.usedRatioByKind.tool_result;
  return {
    active: source.mode !== "off",
    elided: source.elided,
    reasons: REASONS.filter((r) => source.byReason[r] > 0).map((r) => [r, source.byReason[r]]),
    ...(ratio !== undefined ? { usedPercent: Math.round(ratio * 100) } : {}),
    hidden: contextRows(source, true).length - contextRows(source).length,
  };
}

export const reportHref = (sessionId: string): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/context/report`;

/** Reads the report of a session (ignored when another session is open by the time it answers). */
export async function loadContextReport(sessionId: string): Promise<void> {
  loading.value = true;
  try {
    const next = await api.request<ContextReport>("GET", reportHref(sessionId));
    if (currentId.value === sessionId) {
      report.value = next;
      failed.value = false;
    }
  } catch {
    if (currentId.value === sessionId) failed.value = true;
  } finally {
    loading.value = false;
  }
}
