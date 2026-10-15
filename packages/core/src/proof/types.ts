/**
 * Core-side shapes of the Proof ledger (specs/011). The wire types (`ProofCriterion`,
 * `ProofEvidence`, `ProofLedger`) live in `@alisio/sdk`; these are what the store keeps before the
 * status is derived (D4: the status is never stored).
 */
import type { ProofCriterion, ProofEvidence } from "@alisio/sdk";

/** A criterion as persisted: the wire shape without the derived fields. */
export type CriterionRecord = Omit<ProofCriterion, "status" | "stale" | "evidenceIds">;

/** What a caller supplies to create a criterion. */
export interface NewCriterion {
  sessionId: string;
  text: string;
  origin: ProofCriterion["origin"];
  /** Defaults to false. */
  required?: boolean;
  goalId?: string;
  verifier?: ProofCriterion["verifier"];
  scope?: string[];
}

/** What a caller supplies to append evidence: the store assigns `evidenceId`. */
export type NewEvidence = Omit<ProofEvidence, "evidenceId">;
