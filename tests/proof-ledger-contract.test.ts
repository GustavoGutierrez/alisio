/**
 * Contract of the `ProofLedger` types (specs/011 Fase 0, section 4).
 *
 * Red by design: `@alisio/sdk` exports none of these types yet, so type-checking is disabled for
 * this file until Fase 1. Fase 1 activation: add the types to `packages/sdk/src/index.ts`
 * (additive), delete the `@ts-nocheck` line and make it green without editing the expectations.
 */
import type {
  GoalEvidence,
  ProofCriterion,
  ProofEvidence,
  ProofLedger,
  ProofStatus,
  ProofVerifierSpec,
  RunEventDataMap,
} from "@alisio/sdk";
import { describe, expectTypeOf, it } from "vitest";

describe("ProofLedger contract (specs/011 section 4)", () => {
  it("ProofStatus is exactly the five derived states (D4)", () => {
    expectTypeOf<ProofStatus>().toEqualTypeOf<
      "verified" | "failed" | "not_checked" | "manual_review" | "not_applicable"
    >();
  });

  it("verifier kinds are the closed set of the spec", () => {
    expectTypeOf<ProofVerifierSpec["kind"]>().toEqualTypeOf<
      "command" | "file" | "data-check" | "coverage" | "manual" | "plugin"
    >();
    expectTypeOf<Extract<ProofVerifierSpec, { kind: "command" }>>().toMatchTypeOf<{
      command: string;
      cwd?: string;
      successExitCodes?: number[];
      outputPattern?: string;
    }>();
  });

  it("a criterion without verifier is representable (D1) and carries derived status", () => {
    expectTypeOf<ProofCriterion["verifier"]>().toEqualTypeOf<ProofVerifierSpec | undefined>();
    expectTypeOf<ProofCriterion["status"]>().toEqualTypeOf<ProofStatus>();
    expectTypeOf<ProofCriterion["origin"]>().toEqualTypeOf<
      "plan" | "goal" | "user" | "inferred" | "cli"
    >();
    expectTypeOf<ProofCriterion["evidenceIds"]>().toEqualTypeOf<string[]>();
  });

  it("evidence always names its run and call (D2) and is immutable data", () => {
    expectTypeOf<ProofEvidence["runId"]>().toEqualTypeOf<string>();
    expectTypeOf<ProofEvidence["callId"]>().toEqualTypeOf<string>();
    expectTypeOf<ProofEvidence["capturedAt"]>().toEqualTypeOf<string>();
    expectTypeOf<ProofEvidence["outputHash"]>().toEqualTypeOf<string>();
    expectTypeOf<ProofEvidence["treeFingerprint"]>().toEqualTypeOf<string>();
    expectTypeOf<ProofEvidence["commandFingerprint"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ProofEvidence["exitCode"]>().toEqualTypeOf<number | undefined>();
  });

  it("the ledger bundles criteria, evidence and divergences", () => {
    expectTypeOf<ProofLedger["criteria"]>().toEqualTypeOf<ProofCriterion[]>();
    expectTypeOf<ProofLedger["evidence"]>().toEqualTypeOf<ProofEvidence[]>();
    expectTypeOf<ProofLedger["divergences"][number]>().toEqualTypeOf<{
      claim: string;
      criterionId?: string;
      actual: ProofStatus;
    }>();
  });

  it("run events are additive (RunEvent.schemaVersion stays 1)", () => {
    expectTypeOf<RunEventDataMap["proof_updated"]>().toEqualTypeOf<{
      criterionId: string;
      status: ProofStatus;
      stale: boolean;
      evidenceId?: string;
    }>();
    expectTypeOf<RunEventDataMap["proof_divergence"]>().toEqualTypeOf<{
      claim: string;
      criterionId?: string;
      actual: ProofStatus;
    }>();
  });

  it("GoalEvidence only gains an optional evidenceId", () => {
    expectTypeOf<GoalEvidence["evidenceId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<GoalEvidence["detail"]>().toEqualTypeOf<string>();
  });

  // Behavior contracts pinned by name for Fase 1/2 (tests/proof-ledger.test.ts, proof-recorder).
  it.todo("D1: a criterion without verifier derives not_checked even if the model claims it done");
  it.todo("D2: verified requires an existing evidence with runId, callId and capturedAt");
  it.todo(
    "D5: an edit inside the criterion scope marks earlier evidence stale; outside it does not",
  );
});
