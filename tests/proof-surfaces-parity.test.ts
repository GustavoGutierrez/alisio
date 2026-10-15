/**
 * Acceptance 1 of specs/011 phase 5: TUI, Web and JSONL show the same statuses from the same
 * ledger. One real ledger (every status, a stale one) is rendered by each surface's own code and
 * the (criterion, status) sequences are compared.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finishProof } from "../packages/cli/src/proof.ts";
import { runProofCommand } from "../packages/cli/src/tui/proof.ts";
import {
  proofExportV1,
  renderProofJson,
  renderProofMarkdown,
} from "../packages/core/src/proof/export.ts";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { proofRows } from "../packages/web/src/store/proof.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function ledgerWithEveryStatus() {
  const root = await mkdtemp(join(tmpdir(), "alisio-proof-parity-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "s.sqlite"));
  const proof = new ProofStore(store.db);
  const session = store.create("/w", "p", "m").id;
  const cmd = { kind: "command" as const, command: "pnpm test" };
  const add = (text: string, over: Record<string, unknown> = {}) =>
    proof.addCriterion({ sessionId: session, text, origin: "cli", required: true, ...over });
  const evidence = (criterionId: string, ok: boolean, capturedAt: string) =>
    proof.appendEvidence({
      criterionId,
      verifierKind: "command",
      runId: "run_1",
      callId: `call_${criterionId.slice(-4)}`,
      ok,
      exitCode: ok ? 0 : 1,
      durationMs: 1,
      outputHash: "h",
      treeFingerprint: "t",
      filesTouched: [],
      capturedAt,
    });
  const docs = { verifier: cmd, scope: ["docs/**"] };
  evidence(add("Verified one", docs).criterionId, true, "2026-10-14T10:00:00.000Z");
  evidence(add("Failed one", docs).criterionId, false, "2026-10-14T10:00:00.000Z");
  add("Unchecked one");
  add("Manual one", { verifier: { kind: "manual" } });
  const na = add("Skipped one");
  proof.markNotApplicable(na.criterionId, "not in this repo");
  const stale = add("Stale one", { verifier: cmd, scope: ["src/**"] });
  evidence(stale.criterionId, true, "2026-10-14T10:00:00.000Z");
  proof.recordEdit(session, "src/a.ts", "2026-10-14T11:00:00.000Z");
  return { store, proof, session };
}

describe("one ledger, the same statuses on every surface", () => {
  it("TUI, web, JSONL, JSON and Markdown agree on (criterion, status)", async () => {
    const { store, proof, session } = await ledgerWithEveryStatus();
    try {
      const ledger = proof.view(session);
      const expected = ledger.criteria.map((c) => [c.text, c.status]);
      expect(expected.map(([, s]) => s)).toEqual([
        "verified",
        "failed",
        "not_checked",
        "manual_review",
        "not_applicable",
        "not_checked",
      ]);
      expect(ledger.criteria.at(-1)?.stale).toBe(true);

      // Web: the rows of the card.
      expect(proofRows(ledger).map((r) => [r.text, r.status])).toEqual(expected);

      // TUI: the lines `/proof` prints (status first, then the text).
      const shown = (await runProofCommand("", { proof, sessionId: session })).text;
      const tui = shown
        .split("\n")
        .slice(1)
        .map((line) => /^\s+(\S+?)(?:\(stale\))?\s+(.*?)(?: \(required\))?$/.exec(line))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[2], m[1]]);
      expect(tui).toEqual(expected);

      // JSONL: the final event of `--json`.
      const lines: string[] = [];
      await finishProof(
        { proof, write: (t) => lines.push(t), writeErr: () => undefined },
        session,
        { json: true },
      );
      const event = JSON.parse(lines.join(""));
      expect(
        event.ledger.criteria.map((c: { text: string; status: string }) => [c.text, c.status]),
      ).toEqual(expected);

      // The exports: the JSON file and the Markdown carry the same statuses.
      expect(
        JSON.parse(renderProofJson(ledger)).criteria.map((c: { text: string; status: string }) => [
          c.text,
          c.status,
        ]),
      ).toEqual(expected);
      const md = renderProofMarkdown(ledger);
      for (const [text, status] of expected) expect(md).toMatch(new RegExp(`${status}.*${text}`));
    } finally {
      store.close();
    }
  });

  it("the JSON export is stable: the same ledger renders byte-identically and is versioned", async () => {
    const { store, proof, session } = await ledgerWithEveryStatus();
    try {
      const ledger = proof.view(session, "2026-10-14T12:00:00.000Z");
      expect(renderProofJson(ledger)).toBe(renderProofJson(structuredClone(ledger)));
      expect(proofExportV1(ledger).schema).toBe("proof/v1");
      expect(Object.keys(JSON.parse(renderProofJson(ledger)))).toEqual([
        "schema",
        "sessionId",
        "generatedAt",
        "summary",
        "criteria",
        "evidence",
        "divergences",
      ]);
    } finally {
      store.close();
    }
  });
});
