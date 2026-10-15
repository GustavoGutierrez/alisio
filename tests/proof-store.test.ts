import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alisio-proof-"));
  roots.push(root);
  return join(root, "sessions.sqlite");
}

const evidenceInput = (criterionId: string, over: Record<string, unknown> = {}) => ({
  criterionId,
  verifierKind: "command" as const,
  runId: "run_1",
  callId: "call_1",
  ok: true,
  commandFingerprint: "fp",
  exitCode: 0,
  durationMs: 12,
  outputHash: "hash",
  excerpt: "ok",
  treeFingerprint: "tree",
  filesTouched: ["a.ts"],
  capturedAt: "2026-10-14T10:00:00.000Z",
  ...over,
});

async function open() {
  const store = new SQLiteStore(await tempDb());
  const proof = new ProofStore(store.db);
  const session = store.create("/w", "p", "m");
  return { store, proof, session };
}

describe("ProofStore", () => {
  it("round-trips criteria and evidence, and a criterion without verifier is not_checked", async () => {
    const { store, proof, session } = await open();
    try {
      const bare = proof.addCriterion({
        sessionId: session.id,
        text: "Docs updated",
        origin: "user",
      });
      const tested = proof.addCriterion({
        sessionId: session.id,
        text: "Tests pass",
        required: true,
        origin: "plan",
        verifier: { kind: "command", command: "pnpm test" },
        scope: ["packages/**"],
      });
      const evidence = proof.appendEvidence(evidenceInput(tested.criterionId));
      const ledger = proof.ledger(session.id);
      expect(ledger.criteria.find((c) => c.criterionId === bare.criterionId)).toMatchObject({
        status: "not_checked",
        required: false,
        evidenceIds: [],
      });
      expect(ledger.criteria.find((c) => c.criterionId === tested.criterionId)).toMatchObject({
        status: "verified",
        scope: ["packages/**"],
        verifier: { kind: "command", command: "pnpm test" },
        evidenceIds: [evidence.evidenceId],
      });
      expect(ledger.evidence).toEqual([evidence]);
      expect(evidence.filesTouched).toEqual(["a.ts"]);
    } finally {
      store.close();
    }
  });

  it("D2: refuses evidence without runId or callId and for unknown criteria", async () => {
    const { store, proof, session } = await open();
    try {
      const c = proof.addCriterion({ sessionId: session.id, text: "x", origin: "user" });
      expect(() => proof.appendEvidence(evidenceInput(c.criterionId, { callId: "" }))).toThrow();
      expect(() => proof.appendEvidence(evidenceInput(c.criterionId, { runId: "" }))).toThrow();
      expect(() => proof.appendEvidence(evidenceInput("crit_missing"))).toThrow();
      expect(proof.ledger(session.id).evidence).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("evidence is append-only: the database rejects UPDATE", async () => {
    const { store, proof, session } = await open();
    try {
      const c = proof.addCriterion({
        sessionId: session.id,
        text: "x",
        origin: "user",
        verifier: { kind: "command", command: "c" },
      });
      const e = proof.appendEvidence(evidenceInput(c.criterionId, { ok: false, exitCode: 1 }));
      expect(() =>
        store.db.prepare("UPDATE proof_evidence SET ok=1 WHERE evidence_id=?").run(e.evidenceId),
      ).toThrow(/append-only/);
      expect(proof.ledger(session.id).criteria[0]?.status).toBe("failed");
    } finally {
      store.close();
    }
  });

  it("not_applicable needs a reason and is stored on the criterion", async () => {
    const { store, proof, session } = await open();
    try {
      const c = proof.addCriterion({ sessionId: session.id, text: "x", origin: "user" });
      expect(() => proof.markNotApplicable(c.criterionId, "  ")).toThrow();
      proof.markNotApplicable(c.criterionId, "no UI in this change");
      expect(proof.ledger(session.id).criteria[0]).toMatchObject({
        status: "not_applicable",
        notApplicableReason: "no UI in this change",
      });
    } finally {
      store.close();
    }
  });

  it("deleting the session deletes its criteria and evidence", async () => {
    const { store, proof, session } = await open();
    const other = store.create("/w", "p", "m");
    try {
      const c = proof.addCriterion({ sessionId: session.id, text: "x", origin: "user" });
      proof.appendEvidence(evidenceInput(c.criterionId));
      const keep = proof.addCriterion({ sessionId: other.id, text: "keep", origin: "user" });
      store.db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
      expect(proof.ledger(session.id)).toMatchObject({ criteria: [], evidence: [] });
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM proof_evidence").get()).toEqual({ n: 0 });
      expect(proof.ledger(other.id).criteria.map((x) => x.criterionId)).toEqual([keep.criterionId]);
    } finally {
      store.close();
    }
  });
});

describe("SQLiteStore v11 migration (proof ledger)", () => {
  it("adds the proof tables to an existing v10 database and keeps its data", async () => {
    const path = await tempDb();
    const v10 = new SQLiteStore(path);
    // Roll the schema back to exactly what a v10 binary leaves.
    v10.db.exec(
      "DROP TABLE proof_evidence; DROP TABLE proof_criteria; DELETE FROM schema_migrations WHERE version>=11;",
    );
    const session = v10.create("/w", "p", "m");
    v10.append(session.id, { role: "user", text: "hello" });
    v10.close();

    const store = new SQLiteStore(path);
    try {
      expect(
        store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=11").get(),
      ).toBeDefined();
      expect(store.messages(session.id)).toEqual([{ role: "user", text: "hello" }]);
      const proof = new ProofStore(store.db);
      proof.addCriterion({ sessionId: session.id, text: "x", origin: "user" });
      expect(proof.ledger(session.id).criteria).toHaveLength(1);
    } finally {
      store.close();
    }
    // Opening again is idempotent and keeps the proof rows.
    const again = new SQLiteStore(path);
    try {
      expect(new ProofStore(again.db).ledger(session.id).criteria).toHaveLength(1);
    } finally {
      again.close();
    }
  });
});
