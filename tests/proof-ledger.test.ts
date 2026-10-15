import type { ProofEvidence, ProofStatus, ProofVerifierSpec } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { buildLedger, deriveStatus } from "../packages/core/src/proof/ledger.ts";

const command: ProofVerifierSpec = { kind: "command", command: "pnpm test" };
const at = (minute: number) => `2026-10-14T10:${String(minute).padStart(2, "0")}:00.000Z`;

function evidence(over: Partial<ProofEvidence> = {}): ProofEvidence {
  return {
    evidenceId: "ev_1",
    criterionId: "crit_1",
    verifierKind: "command",
    runId: "run_1",
    callId: "call_1",
    ok: true,
    durationMs: 10,
    outputHash: "abc",
    treeFingerprint: "tree",
    filesTouched: [],
    capturedAt: at(10),
    ...over,
  };
}

interface Case {
  name: string;
  criterion: { verifier?: ProofVerifierSpec; notApplicableReason?: string };
  evidence: ProofEvidence[];
  lastEditAt?: string;
  status: ProofStatus;
  stale?: boolean;
}

const cases: Case[] = [
  { name: "D1: no verifier, no evidence", criterion: {}, evidence: [], status: "not_checked" },
  {
    name: "D1: no verifier ignores evidence attached to it",
    criterion: {},
    evidence: [evidence()],
    status: "not_checked",
  },
  {
    name: "verifier without evidence",
    criterion: { verifier: command },
    evidence: [],
    status: "not_checked",
  },
  {
    name: "successful evidence verifies",
    criterion: { verifier: command },
    evidence: [evidence()],
    status: "verified",
  },
  {
    name: "D2: evidence without callId cannot verify",
    criterion: { verifier: command },
    evidence: [evidence({ callId: "" })],
    status: "not_checked",
  },
  {
    name: "D2: evidence without runId cannot verify",
    criterion: { verifier: command },
    evidence: [evidence({ runId: "" })],
    status: "not_checked",
  },
  {
    name: "D2: evidence without a valid date cannot verify",
    criterion: { verifier: command },
    evidence: [evidence({ capturedAt: "yesterday" })],
    status: "not_checked",
  },
  {
    name: "latest evidence failed",
    criterion: { verifier: command },
    evidence: [evidence({ ok: false, exitCode: 1 })],
    status: "failed",
  },
  {
    name: "a later success supersedes an earlier failure",
    criterion: { verifier: command },
    evidence: [
      evidence({ evidenceId: "a", ok: false, capturedAt: at(1) }),
      evidence({ evidenceId: "b", ok: true, capturedAt: at(2) }),
    ],
    status: "verified",
  },
  {
    name: "a later failure supersedes an earlier success, whatever the input order",
    criterion: { verifier: command },
    evidence: [
      evidence({ evidenceId: "b", ok: false, capturedAt: at(2) }),
      evidence({ evidenceId: "a", ok: true, capturedAt: at(1) }),
    ],
    status: "failed",
  },
  {
    name: "manual verifier is manual_review",
    criterion: { verifier: { kind: "manual" } },
    evidence: [],
    status: "manual_review",
  },
  {
    name: "user not_applicable wins over evidence",
    criterion: { verifier: command, notApplicableReason: "out of scope" },
    evidence: [evidence()],
    status: "not_applicable",
  },
  {
    name: "D5: an edit after the evidence makes it stale",
    criterion: { verifier: command },
    evidence: [evidence({ capturedAt: at(10) })],
    lastEditAt: at(11),
    status: "not_checked",
    stale: true,
  },
  {
    name: "D5: an edit at the same instant is treated as stale (fail safe)",
    criterion: { verifier: command },
    evidence: [evidence({ capturedAt: at(10) })],
    lastEditAt: at(10),
    status: "not_checked",
    stale: true,
  },
  {
    name: "D5: an edit before the evidence keeps it verified",
    criterion: { verifier: command },
    evidence: [evidence({ capturedAt: at(10) })],
    lastEditAt: at(9),
    status: "verified",
  },
  {
    name: "D5: an expired failure is not_checked, not stale",
    criterion: { verifier: command },
    evidence: [evidence({ ok: false, capturedAt: at(10) })],
    lastEditAt: at(11),
    status: "not_checked",
  },
];

describe("deriveStatus (specs/011 section 3.2)", () => {
  it.each(cases)("$name", (c) => {
    const result = deriveStatus(c.criterion, c.evidence, { lastEditAt: c.lastEditAt });
    expect(result.status).toBe(c.status);
    expect(result.stale).toBe(c.stale ?? false);
  });

  it("does not mutate its inputs", () => {
    const list = [
      evidence({ evidenceId: "b", capturedAt: at(2) }),
      evidence({ evidenceId: "a", capturedAt: at(1) }),
    ];
    deriveStatus({ verifier: command }, list);
    expect(list.map((e) => e.evidenceId)).toEqual(["b", "a"]);
  });
});

describe("buildLedger", () => {
  const record = (criterionId: string, verifier?: ProofVerifierSpec) => ({
    criterionId,
    sessionId: "s1",
    text: criterionId,
    required: true,
    origin: "user" as const,
    verifier,
  });

  it("derives each criterion from its own evidence only", () => {
    const ledger = buildLedger(
      "s1",
      [record("c1", command), record("c2", command), record("c3")],
      [evidence({ evidenceId: "e1", criterionId: "c1" })],
      { now: at(30) },
    );
    expect(ledger.criteria.map((c) => [c.criterionId, c.status, c.evidenceIds])).toEqual([
      ["c1", "verified", ["e1"]],
      ["c2", "not_checked", []],
      ["c3", "not_checked", []],
    ]);
    expect(ledger.generatedAt).toBe(at(30));
    expect(ledger.divergences).toEqual([]);
  });

  it("marks the criterion stale when an edit came after its evidence", () => {
    const ledger = buildLedger(
      "s1",
      [record("c1", command)],
      [evidence({ criterionId: "c1", capturedAt: at(10) })],
      { now: at(30), lastEditAt: () => at(12) },
    );
    expect(ledger.criteria[0]).toMatchObject({ status: "not_checked", stale: true });
  });
});
