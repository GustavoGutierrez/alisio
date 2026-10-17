import type { ContextGovernedData } from "@alisio/sdk";
import type { Elision, ElisionReason, Projection } from "./elide.ts";
import { countSegments } from "./inventory.ts";
import type { UsageSummary } from "./usage.ts";

/** Mode of the Context Governor (spec 012): `off` is inert, `shadow` measures, `on` applies. */
export type GovernorMode = "off" | "shadow" | "on";

/** Settings the runner needs; `application.ts` builds them from `config.context`. */
export interface ContextGovernorOptions {
  mode: GovernorMode;
  minAgeTurns: number;
  epochMessages: number;
  policyVersion: number;
  /** Size cap of the `<invariants>` block (`context.invariants.maxChars`); default 4000. */
  invariantMaxChars?: number;
}

/** Counts of the invariants block; never its content (spec 012 D7). */
export interface InvariantCounts {
  /** Invariants rendered into the latest request's block. */
  count: number;
  /** Length of that block in characters (0 when none was built). */
  chars: number;
  /** Invariants left out because they did not fit `maxChars`. */
  omitted: number;
  /** Instruction quotes promoted by the compactions of this process (`on` only). */
  promoted: number;
  /** Proposed quotes refused by the substring check or the cap (`on` only). */
  rejected: number;
}

/**
 * What the governor decided for the latest request of a session. Counts, ids and token estimates
 * only: never file contents, arguments or stub text (spec 012 D7). `governedEventData` turns it
 * into the `context_governed` event.
 */
export interface GovernanceSnapshot {
  mode: Exclude<GovernorMode, "off">;
  policyVersion: number;
  /** 1-based number of the model request inside the current run. */
  request: number;
  messages: number;
  /** Inventory segments of the history (the rule of `buildInventory`, without pinned context). */
  segments: number;
  /** Messages `[0, boundary)` were eligible for elision. */
  boundary: number;
  elided: number;
  byReason: Record<ElisionReason, number>;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  elisions: Array<Pick<Elision, "index" | "callId" | "segmentId" | "reason" | "tokensSaved">>;
  invariants: InvariantCounts;
  /** Call ids elided at this request but not at the previous snapshot of the session. */
  newlyElided: string[];
}

export function governanceSnapshot(
  projection: Projection,
  options: ContextGovernorOptions,
  request: number,
  previous?: GovernanceSnapshot,
): GovernanceSnapshot {
  const byReason: Record<ElisionReason, number> = {
    superseded_read: 0,
    stale_bg_output: 0,
    duplicate_search: 0,
  };
  for (const e of projection.elisions) byReason[e.reason]++;
  const before = new Set(previous?.elisions.map((e) => e.callId));
  return {
    mode: options.mode === "on" ? "on" : "shadow",
    policyVersion: options.policyVersion,
    request,
    messages: projection.messages.length,
    segments: countSegments(projection.messages),
    boundary: projection.boundary,
    elided: projection.elisions.length,
    byReason,
    tokensBefore: projection.tokensBefore,
    tokensAfter: projection.tokensAfter,
    tokensSaved: projection.tokensBefore - projection.tokensAfter,
    elisions: projection.elisions.map(({ index, callId, segmentId, reason, tokensSaved }) => ({
      index,
      callId,
      segmentId,
      reason,
      tokensSaved,
    })),
    invariants: { count: 0, chars: 0, omitted: 0, promoted: 0, rejected: 0 },
    newlyElided: projection.elisions.map((e) => e.callId).filter((id) => !before.has(id)),
  };
}

const MAX_EVENT_IDS = 32;
const MAX_EVENT_TOOLS = 16;

/**
 * The `context_governed` payload of one request. Integers, enum keys, tool names and provider call
 * ids only; bounded (32 ids, 16 tools), so it stays well under 2 KB.
 */
export function governedEventData(
  snapshot: GovernanceSnapshot,
  usage?: UsageSummary,
): ContextGovernedData {
  const { invariants } = snapshot;
  const omitted = snapshot.newlyElided.length - MAX_EVENT_IDS;
  const data: ContextGovernedData = {
    policyVersion: snapshot.policyVersion,
    mode: snapshot.mode,
    request: snapshot.request,
    messages: snapshot.messages,
    segments: snapshot.segments,
    elided: snapshot.elided,
    byReason: { ...snapshot.byReason },
    tokensBefore: snapshot.tokensBefore,
    tokensAfter: snapshot.tokensAfter,
    tokensSaved: snapshot.tokensSaved,
  };
  if (snapshot.newlyElided.length > 0)
    data.elidedCallIds = snapshot.newlyElided.slice(0, MAX_EVENT_IDS);
  if (omitted > 0) data.elidedCallIdsOmitted = omitted;
  if (invariants.count > 0 || invariants.chars > 0 || invariants.omitted > 0)
    data.invariants = {
      count: invariants.count,
      chars: invariants.chars,
      omitted: invariants.omitted,
    };
  if (usage) {
    const byTool = capTools(usage.byTool);
    data.usage = {
      observed: usage.observed,
      used: usage.used,
      pending: usage.pending,
      unattributed: usage.unattributed,
      ...(Object.keys(usage.byKind).length > 0 ? { byKind: usage.byKind } : {}),
      ...(Object.keys(byTool).length > 0 ? { byTool } : {}),
    };
  }
  return data;
}

/** At most `MAX_EVENT_TOOLS` tools: the busiest ones, the rest folded into `other`. */
function capTools(
  byTool: UsageSummary["byTool"],
): Record<string, { observed: number; used: number }> {
  const all = Object.entries(byTool);
  if (all.length <= MAX_EVENT_TOOLS) return { ...byTool };
  const ranked = all.sort(
    ([an, a], [bn, b]) => b.observed - a.observed || (an < bn ? -1 : an > bn ? 1 : 0),
  );
  const out: Record<string, { observed: number; used: number }> = {};
  const other = { observed: 0, used: 0 };
  ranked.forEach(([name, counts], i) => {
    if (i < MAX_EVENT_TOOLS - 1 && name !== "other") out[name] = { ...counts };
    else {
      other.observed += counts.observed;
      other.used += counts.used;
    }
  });
  out.other = other;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
