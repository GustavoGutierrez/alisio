/**
 * Pure derivation of the Proof ledger (specs/011 section 3.2). Nothing here reads a clock, a
 * database or the filesystem: the same inputs always give the same statuses (D4).
 */
import type {
  ProofCriterion,
  ProofEvidence,
  ProofLedger,
  ProofStatus,
  ProofVerifierSpec,
} from "@alisio/sdk";
import type { CriterionRecord } from "./types.ts";

export interface DerivedStatus {
  status: ProofStatus;
  /** True when the criterion had successful evidence that a later edit in its scope invalidated. */
  stale: boolean;
}

export interface DeriveOptions {
  /** ISO time of the latest edit inside the criterion scope (D5), when there was one. */
  lastEditAt?: string;
}

const time = (iso: string): number => Date.parse(iso);

/** D2: only evidence that names its run, its call and a real date can back a status. */
const backs = (e: ProofEvidence): boolean =>
  e.runId.length > 0 && e.callId.length > 0 && Number.isFinite(time(e.capturedAt));

/**
 * Derives the status of one criterion from its own evidence.
 *
 * - user `not_applicable` wins; no verifier is `not_checked` whatever evidence exists (D1);
 *   a `manual` verifier is `manual_review`.
 * - the latest backed evidence decides (later `capturedAt` wins; ties go to the later entry); a
 *   latest evidence of kind `manual` means a verifier degraded the criterion to `manual_review`;
 * - an edit at or after that evidence expires it (D5, fail safe on equal instants): an expired
 *   success is `not_checked` and stale, an expired failure is just `not_checked`.
 */
export function deriveStatus(
  criterion: { verifier?: ProofVerifierSpec; notApplicableReason?: string },
  evidence: readonly ProofEvidence[],
  options: DeriveOptions = {},
): DerivedStatus {
  if (criterion.notApplicableReason) return { status: "not_applicable", stale: false };
  if (!criterion.verifier) return { status: "not_checked", stale: false };
  if (criterion.verifier.kind === "manual") return { status: "manual_review", stale: false };
  let latest: ProofEvidence | undefined;
  for (const e of evidence) {
    if (backs(e) && (!latest || time(e.capturedAt) >= time(latest.capturedAt))) latest = e;
  }
  if (!latest) return { status: "not_checked", stale: false };
  const edited =
    options.lastEditAt !== undefined && time(options.lastEditAt) >= time(latest.capturedAt);
  if (edited) return { status: "not_checked", stale: latest.ok };
  // A verifier handed the criterion to a person (a plugin result with no traceable evidence).
  if (latest.verifierKind === "manual") return { status: "manual_review", stale: false };
  return { status: latest.ok ? "verified" : "failed", stale: false };
}

export interface BuildLedgerOptions {
  /** ISO time stamped on the ledger; the caller owns the clock. */
  now: string;
  /** Latest edit time inside the scope of a criterion (Fase 3 supplies it). */
  lastEditAt?: (criterion: CriterionRecord) => string | undefined;
  divergences?: ProofLedger["divergences"];
}

/** Assembles the ledger of one session: every criterion derived from its own evidence. */
export function buildLedger(
  sessionId: string,
  criteria: readonly CriterionRecord[],
  evidence: readonly ProofEvidence[],
  options: BuildLedgerOptions,
): ProofLedger {
  const derived: ProofCriterion[] = criteria.map((criterion) => {
    const own = evidence.filter((e) => e.criterionId === criterion.criterionId);
    const { status, stale } = deriveStatus(criterion, own, {
      lastEditAt: options.lastEditAt?.(criterion),
    });
    return {
      ...criterion,
      status,
      ...(stale ? { stale } : {}),
      evidenceIds: own.map((e) => e.evidenceId),
    };
  });
  return {
    sessionId,
    criteria: derived,
    evidence: [...evidence],
    divergences: options.divergences ?? [],
    generatedAt: options.now,
  };
}
