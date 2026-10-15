/**
 * Proof surfaces share one pure core (specs/011 phase 5): the versioned `proof/v1` export, the
 * Markdown report, the CI exit codes, the criteria a user or a CLI flag supplies, and the user's
 * edits of a criterion. Everything here reads the same ledger the surfaces show.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProofCriterion, ProofLedger } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROOF_EXPORT_SCHEMA,
  parseCriteriaInput,
  proofExitCode,
  proofSummary,
  publishProofExport,
  renderProofJson,
  renderProofMarkdown,
} from "../packages/core/src/proof/export.ts";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const crit = (over: Partial<ProofCriterion> & { criterionId: string }): ProofCriterion => ({
  sessionId: "s1",
  text: "criterion",
  required: true,
  origin: "cli",
  status: "not_checked",
  evidenceIds: [],
  ...over,
});
const ledgerOf = (criteria: ProofCriterion[]): ProofLedger => ({
  sessionId: "s1",
  criteria,
  evidence: [],
  divergences: [],
  generatedAt: "2026-10-14T10:00:00.000Z",
});

describe("proof/v1 export", () => {
  const ledger = ledgerOf([
    crit({
      criterionId: "c1",
      text: "Tests pass",
      status: "verified",
      evidenceIds: ["e1"],
      verifier: { kind: "command", command: "pnpm test" },
    }),
    crit({ criterionId: "c2", text: "Docs | updated", required: false, status: "not_checked" }),
  ]);
  ledger.evidence.push({
    evidenceId: "e1",
    criterionId: "c1",
    verifierKind: "command",
    runId: "run_1",
    callId: "call_1",
    ok: true,
    exitCode: 0,
    durationMs: 1200,
    outputHash: "abc",
    treeFingerprint: "tree",
    filesTouched: [],
    capturedAt: "2026-10-14T09:59:00.000Z",
  });

  it("is versioned, carries a summary and keeps key order stable", () => {
    const json = renderProofJson(ledger);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.schema).toBe(PROOF_EXPORT_SCHEMA);
    expect(PROOF_EXPORT_SCHEMA).toBe("proof/v1");
    expect(Object.keys(parsed)).toEqual([
      "schema",
      "sessionId",
      "generatedAt",
      "summary",
      "criteria",
      "evidence",
      "divergences",
    ]);
    expect(parsed.summary).toEqual({
      total: 2,
      required: 1,
      requiredUnmet: 0,
      verified: 1,
      failed: 0,
      notChecked: 1,
      manualReview: 0,
      notApplicable: 0,
    });
    expect(renderProofJson(ledger)).toBe(json);
    expect(json.endsWith("\n")).toBe(true);
  });

  it("renders the same statuses in Markdown and escapes table pipes", () => {
    const md = renderProofMarkdown(ledger);
    expect(md).toContain("# Proof");
    expect(md).toContain("verified");
    expect(md).toContain("Docs \\| updated");
    expect(md).toContain("call_1");
    expect(md).not.toContain("Docs | updated");
  });

  it("summarizes counts, counting only required criteria as unmet", () => {
    const s = proofSummary(
      ledgerOf([
        crit({ criterionId: "a", status: "failed" }),
        crit({ criterionId: "b", status: "manual_review" }),
        crit({ criterionId: "c", status: "not_applicable" }),
        crit({ criterionId: "d", status: "failed", required: false }),
      ]),
    );
    expect(s.requiredUnmet).toBe(2);
    expect(s.failed).toBe(2);
    expect(s.notApplicable).toBe(1);
  });
});

describe("proofExitCode", () => {
  const of = (...statuses: Array<[ProofCriterion["status"], boolean?]>) =>
    ledgerOf(
      statuses.map(([status, required], i) =>
        crit({ criterionId: `c${i}`, status, required: required ?? true }),
      ),
    );
  it("is 0 with everything verified, optional ones aside, and with no criteria", () => {
    expect(proofExitCode(ledgerOf([]))).toBe(0);
    expect(proofExitCode(of(["verified"], ["failed", false], ["not_applicable"]))).toBe(0);
  });
  it("is 10 for a required failed criterion, even next to unchecked ones", () => {
    expect(proofExitCode(of(["failed"], ["not_checked"]))).toBe(10);
  });
  it("is 11 for required not_checked or manual_review criteria", () => {
    expect(proofExitCode(of(["verified"], ["not_checked"]))).toBe(11);
    expect(proofExitCode(of(["manual_review"]))).toBe(11);
  });
  it("honors configured codes", () => {
    expect(proofExitCode(of(["failed"]), { failed: 20, unverified: 21 })).toBe(20);
    expect(proofExitCode(of(["not_checked"]), { failed: 20, unverified: 21 })).toBe(21);
  });
});

describe("parseCriteriaInput", () => {
  it("accepts a command shorthand and defaults to required", () => {
    const out = parseCriteriaInput([{ text: "Tests pass", verify: "pnpm test" }], {
      origin: "cli",
    });
    expect(out.errors).toEqual([]);
    expect(out.criteria).toEqual([
      {
        text: "Tests pass",
        required: true,
        origin: "cli",
        verifier: { kind: "command", command: "pnpm test" },
      },
    ]);
  });
  it("keeps a criterion without a verifier (not_checked later) and honors required:false", () => {
    const out = parseCriteriaInput([{ text: "Reads well", required: false }], { origin: "user" });
    expect(out.criteria[0]).toEqual({ text: "Reads well", required: false, origin: "user" });
  });
  it("reports invalid entries without throwing", () => {
    const out = parseCriteriaInput([{ text: "" }, { text: "ok", verifier: { kind: "plugin" } }], {
      origin: "user",
    });
    expect(out.criteria).toEqual([]);
    expect(out.errors.map((e) => e.index)).toEqual([0, 1]);
  });
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function open() {
  const root = await mkdtemp(join(tmpdir(), "alisio-proof-export-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "s.sqlite"));
  return { store, proof: new ProofStore(store.db), session: store.create("/w", "p", "m") };
}

describe("ProofStore user edits and divergences", () => {
  it("edits only the text and the required flag of a criterion, never the verifier", async () => {
    const { store, proof, session } = await open();
    try {
      const c = proof.addCriterion({
        sessionId: session.id,
        text: "old",
        origin: "user",
        verifier: { kind: "command", command: "pnpm test" },
      });
      const edited = proof.updateCriterion(c.criterionId, { text: "new", required: true });
      expect(edited).toMatchObject({
        text: "new",
        required: true,
        verifier: { kind: "command", command: "pnpm test" },
      });
      expect(proof.updateCriterion("missing", { text: "x" })).toBeUndefined();
      expect(() => proof.updateCriterion(c.criterionId, { text: "  " })).toThrow();
    } finally {
      store.close();
    }
  });

  it("reads the divergences of the last completed run from the event journal", async () => {
    const { store, proof, session } = await open();
    try {
      store.event(session.id, "run_a", "proof_divergence", {
        claim: "tests pass",
        actual: "not_checked",
      });
      store.event(session.id, "run_a", "run_completed", {});
      expect(proof.divergences(session.id)).toEqual([
        { claim: "tests pass", actual: "not_checked" },
      ]);
      // A later completed run without a warning clears it.
      store.event(session.id, "run_b", "run_completed", {});
      expect(proof.divergences(session.id)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("publishProofExport", () => {
  it("publishes proof.md and proof.json through the artifact publisher", async () => {
    const calls: Array<{ fileName: string; text: string }> = [];
    const publisher = {
      async publishText(input: { fileName: string; title?: string; text: string }) {
        calls.push({ fileName: input.fileName, text: input.text });
        return { id: `a${calls.length}`, fileName: input.fileName };
      },
    };
    const published = await publishProofExport(publisher as never, ledgerOf([]));
    expect(calls.map((c) => c.fileName)).toEqual(["proof.md", "proof.json"]);
    expect(JSON.parse(calls[1]?.text ?? "{}").schema).toBe("proof/v1");
    expect(published).toHaveLength(2);
  });
});
