import type { Elision, ElisionReason, Projection } from "./elide.ts";

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
 * only: never file contents, arguments or stub text (spec 012 D7). Core-internal for now; the
 * events and surfaces that expose it arrive in later phases.
 */
export interface GovernanceSnapshot {
  mode: Exclude<GovernorMode, "off">;
  policyVersion: number;
  /** 1-based number of the model request inside the current process for this session. */
  request: number;
  messages: number;
  /** Messages `[0, boundary)` were eligible for elision. */
  boundary: number;
  elided: number;
  byReason: Record<ElisionReason, number>;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  elisions: Array<Pick<Elision, "index" | "callId" | "segmentId" | "reason" | "tokensSaved">>;
  invariants: InvariantCounts;
}

export function governanceSnapshot(
  projection: Projection,
  options: ContextGovernorOptions,
  request: number,
): GovernanceSnapshot {
  const byReason: Record<ElisionReason, number> = {
    superseded_read: 0,
    stale_bg_output: 0,
    duplicate_search: 0,
  };
  for (const e of projection.elisions) byReason[e.reason]++;
  return {
    mode: options.mode === "on" ? "on" : "shadow",
    policyVersion: options.policyVersion,
    request,
    messages: projection.messages.length,
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
  };
}
