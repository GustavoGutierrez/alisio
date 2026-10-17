import type { ContextInvariantKind, ContextReport, ContextSegment, Message } from "@alisio/sdk";
import { projectContext } from "./elide.ts";
import {
  type ContextGovernorOptions,
  type GovernanceSnapshot,
  governanceSnapshot,
} from "./governance.ts";
import { buildInventory } from "./inventory.ts";
import { type UsageLedger, usedRatio } from "./usage.ts";

/**
 * The `ContextReport` (spec 012 phase 5): one explanation of what the next model request of a
 * session carries and what the Context Governor does with it. The web panel, `/context` in the TUI
 * and the route all render this value, so they show the same segments and reasons. It is built from
 * the same pure functions the runner uses for the `context_governed` event (`projectContext`,
 * `governanceSnapshot`, `buildInventory`), and it holds ids, counts, token estimates and metadata
 * (paths, tool names, the user's own invariants), never message or file text.
 */

/** Segments one report lists at most (the rest are counted in `segmentsOmitted`). */
export const MAX_REPORT_SEGMENTS = 400;

export interface ContextReportInput {
  sessionId: string;
  governor: ContextGovernorOptions;
  /** The active history of the session. */
  messages: Message[];
  /** The standing context of the next request (empty before the first compaction). */
  /** The invariants of the next request; only their kinds and counts reach the report. */
  invariants?: { items: readonly { kind: ContextInvariantKind; text: string }[]; omitted: number };
  /** In-memory usage ledger of the session, when the runner has one. */
  ledger?: UsageLedger;
  /** The latest snapshot of the session: only its request number is used. */
  governance?: Pick<GovernanceSnapshot, "request">;
  /** Overrides `MAX_REPORT_SEGMENTS`. */
  maxSegments?: number;
}

export function buildContextReport(input: ContextReportInput): ContextReport {
  const { governor } = input;
  const empty: ContextReport = {
    sessionId: input.sessionId,
    policyVersion: governor.policyVersion,
    mode: "off",
    messages: 0,
    segments: [],
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    elided: 0,
    byReason: { superseded_read: 0, stale_bg_output: 0, duplicate_search: 0 },
    invariants: { count: 0, omitted: 0, byKind: {} },
    usedRatioByKind: {},
  };
  // `off` measures nothing (D15): the report says so instead of computing an inventory.
  if (governor.mode === "off") return empty;

  const projection = projectContext(input.messages, governor);
  const snapshot = governanceSnapshot(projection, governor, 0);
  const elisions = new Map(projection.elisions.map((e) => [e.segmentId, e]));
  const items = input.invariants?.items ?? [];
  const byKind: ContextReport["invariants"]["byKind"] = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  // The texts only size the pinned segments here; the report keeps ids, tokens and counts.
  const inventory = buildInventory(input.messages, { invariants: items.map((i) => i.text) });

  const segments = inventory.segments.map((s): ContextSegment => {
    const elision = s.kind === "tool_result" ? elisions.get(s.id) : undefined;
    const used = s.kind === "tool_result" && s.callId ? input.ledger?.decided(s.callId) : undefined;
    return {
      id: s.id,
      kind: s.kind,
      origin: s.origin,
      ...(s.callId ? { callId: s.callId } : {}),
      tokens: s.tokens,
      criticality: s.criticality,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(elision
        ? {
            elided: {
              reason: elision.reason,
              replacedBy: elision.witnessCallId,
              tokensSaved: elision.tokensSaved,
            },
          }
        : {}),
      ...(used !== undefined ? { used } : {}),
    };
  });

  const { kept, omitted } = bound(segments, input.maxSegments ?? MAX_REPORT_SEGMENTS);
  const usage = input.ledger?.summary();
  const usedRatioByKind: ContextReport["usedRatioByKind"] = {};
  for (const [kind, counts] of Object.entries(usage?.byKind ?? {})) {
    const ratio = counts ? usedRatio(counts) : undefined;
    if (ratio !== undefined) usedRatioByKind[kind as ContextSegment["kind"]] = ratio;
  }
  const hasUsage =
    !!usage && usage.observed + usage.pending + usage.unattributed + usage.stubOnly > 0;

  return {
    sessionId: input.sessionId,
    policyVersion: snapshot.policyVersion,
    mode: snapshot.mode,
    ...(input.governance ? { request: input.governance.request } : {}),
    messages: snapshot.messages,
    segments: kept,
    ...(omitted > 0 ? { segmentsOmitted: omitted } : {}),
    tokensBefore: snapshot.tokensBefore,
    tokensAfter: snapshot.tokensAfter,
    tokensSaved: snapshot.tokensSaved,
    elided: snapshot.elided,
    byReason: { ...snapshot.byReason },
    invariants: { count: items.length, omitted: input.invariants?.omitted ?? 0, byKind },
    usedRatioByKind,
    ...(usage && hasUsage
      ? {
          usage: {
            observed: usage.observed,
            used: usage.used,
            pending: usage.pending,
            unattributed: usage.unattributed,
            stubOnly: usage.stubOnly,
            rereads: usage.rereads,
            ...(Object.keys(usage.byTool).length > 0 ? { byTool: usage.byTool } : {}),
          },
        }
      : {}),
  };
}

/** Keeps the pinned, elided and low segments first, then the most recent ones, in history order. */
function bound(
  segments: ContextSegment[],
  max: number,
): { kept: ContextSegment[]; omitted: number } {
  const limit = Math.max(1, Math.floor(max));
  if (segments.length <= limit) return { kept: segments, omitted: 0 };
  const keep = new Set<number>();
  const important = (s: ContextSegment) =>
    s.criticality === "pinned" || s.criticality === "low" || !!s.elided;
  segments.forEach((s, i) => {
    if (important(s) && keep.size < limit) keep.add(i);
  });
  for (let i = segments.length - 1; i >= 0 && keep.size < limit; i--) keep.add(i);
  const kept = segments.filter((_, i) => keep.has(i));
  return { kept, omitted: segments.length - kept.length };
}
