/**
 * `alisio run --proof` (specs/011 3.7, O4, O5): criteria from `--criterion/--verify` and
 * `--proof-file`, the final ledger event of `--json`, the human report and the exit codes
 * 0/10/11 (configurable). The functions take an injected environment, so the real ledger (real
 * SQLite) is judged with no subprocess of the CLI; the built binary is covered by `test:cli`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProofEvidence } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectProofCriteria,
  finishProof,
  type ProofFlags,
  proofRequested,
  withProofBrief,
} from "../packages/cli/src/proof.ts";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function open() {
  const root = await mkdtemp(join(tmpdir(), "alisio-proof-cli-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "s.sqlite"));
  return { root, store, proof: new ProofStore(store.db), session: store.create("/w", "p", "m") };
}
const evidence = (criterionId: string, ok: boolean): Omit<ProofEvidence, "evidenceId"> => ({
  criterionId,
  verifierKind: "command",
  runId: "run_1",
  callId: "call_1",
  ok,
  exitCode: ok ? 0 : 1,
  durationMs: 5,
  outputHash: "h",
  treeFingerprint: "t",
  filesTouched: [],
  capturedAt: new Date().toISOString(),
});
const noop = () => undefined;

describe("proofRequested", () => {
  it("is on with --proof, with criteria flags, or with proof.ci", () => {
    expect(proofRequested({}, { ci: false })).toBe(false);
    expect(proofRequested({ proof: true }, { ci: false })).toBe(true);
    expect(proofRequested({ criterion: ["x"] }, { ci: false })).toBe(true);
    expect(proofRequested({ proofFile: "p.json" }, { ci: false })).toBe(true);
    expect(proofRequested({}, { ci: true })).toBe(true);
  });
});

describe("collectProofCriteria", () => {
  it("pairs the n-th --verify with the n-th --criterion and defaults to required", async () => {
    const out = await collectProofCriteria(
      { criterion: ["Tests pass", "Docs read well"], verify: ["pnpm test"] },
      { readFile: async () => "" },
    );
    expect(out).toEqual([
      {
        text: "Tests pass",
        required: true,
        origin: "cli",
        verifier: { kind: "command", command: "pnpm test" },
      },
      { text: "Docs read well", required: true, origin: "cli" },
    ]);
  });

  it("refuses a --verify without its --criterion", async () => {
    await expect(
      collectProofCriteria({ criterion: ["a"], verify: ["x", "y"] }, { readFile: async () => "" }),
    ).rejects.toThrow(/--verify/);
  });

  it("reads --proof-file, as an array or as {criteria}, and appends the flags", async () => {
    const file = JSON.stringify({
      schema: "proof/v1",
      criteria: [{ text: "Lint clean", verify: "pnpm lint", required: false }],
    });
    const out = await collectProofCriteria(
      { proofFile: "proof.json", criterion: ["Typecheck"], verify: ["pnpm typecheck"] },
      { readFile: async () => file },
    );
    expect(out.map((c) => [c.text, c.required, c.origin])).toEqual([
      ["Lint clean", false, "cli"],
      ["Typecheck", true, "cli"],
    ]);
  });

  it("fails loudly on a malformed proof file or an invalid criterion", async () => {
    await expect(
      collectProofCriteria({ proofFile: "p.json" }, { readFile: async () => "{nope" }),
    ).rejects.toThrow(/proof-file/);
    await expect(
      collectProofCriteria(
        { proofFile: "p.json" },
        { readFile: async () => JSON.stringify([{ text: "" }]) },
      ),
    ).rejects.toThrow(/criterion 1/);
  });
});

describe("finishProof", () => {
  async function judge(
    prepare: (h: Awaited<ReturnType<typeof open>>) => void,
    flags: ProofFlags = { proof: true },
    codes?: { failed: number; unverified: number },
  ) {
    const h = await open();
    try {
      prepare(h);
      const out: string[] = [];
      const err: string[] = [];
      const published: string[] = [];
      const code = await finishProof(
        {
          proof: h.proof,
          write: (text) => out.push(text),
          writeErr: (text) => err.push(text),
          publisher: {
            async publishText(input) {
              published.push(input.fileName);
              return { id: "a1", fileName: input.fileName } as never;
            },
          },
        },
        h.session.id,
        { ...flags, ...(codes ? { codes } : {}) },
      );
      return { code, out: out.join(""), err: err.join(""), published };
    } finally {
      h.store.close();
    }
  }
  const required = (h: Awaited<ReturnType<typeof open>>, text: string, command?: string) =>
    h.proof.addCriterion({
      sessionId: h.session.id,
      text,
      origin: "cli",
      required: true,
      ...(command ? { verifier: { kind: "command" as const, command } } : {}),
    });

  it("exits 0 when every required criterion is verified", async () => {
    const r = await judge((h) => {
      const c = required(h, "Tests pass", "pnpm test");
      h.proof.appendEvidence(evidence(c.criterionId, true));
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("verified");
  });

  it("exits 10 with a failed required criterion and 11 with an unchecked one", async () => {
    const failed = await judge((h) => {
      const c = required(h, "Tests pass", "pnpm test");
      h.proof.appendEvidence(evidence(c.criterionId, false));
    });
    expect(failed.code).toBe(10);
    const unchecked = await judge((h) => {
      required(h, "Tests pass", "pnpm test");
    });
    expect(unchecked.code).toBe(11);
    expect(unchecked.out).toContain("not_checked");
  });

  it("honors the configured exit codes", async () => {
    const r = await judge(
      (h) => {
        required(h, "x", "pnpm test");
      },
      { proof: true },
      { failed: 20, unverified: 21 },
    );
    expect(r.code).toBe(21);
  });

  it("emits the ledger as the final JSONL event with --json and prints no report", async () => {
    const r = await judge(
      (h) => {
        const c = required(h, "Tests pass", "pnpm test");
        h.proof.appendEvidence(evidence(c.criterionId, true));
      },
      { proof: true, json: true },
    );
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0] ?? "{}");
    expect(event).toMatchObject({ type: "proof_ledger", schema: "proof/v1", exitCode: 0 });
    expect(event.ledger.criteria[0]).toMatchObject({ text: "Tests pass", status: "verified" });
  });

  it("publishes proof.md and proof.json and mentions them on stderr", async () => {
    const r = await judge((h) => {
      required(h, "x", "pnpm test");
    });
    expect(r.published).toEqual(["proof.md", "proof.json"]);
    expect(r.err).toContain("proof.json");
  });

  it("exits 0 with an empty ledger (no criteria is not a failure)", async () => {
    const r = await judge(noop);
    expect(r.code).toBe(0);
  });
});

describe("a proof file on disk", () => {
  it("is read through node:fs by the default reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-proof-file-"));
    roots.push(root);
    const file = join(root, "proof.json");
    await writeFile(file, JSON.stringify({ criteria: [{ text: "A", verify: "true" }] }));
    const out = await collectProofCriteria({ proofFile: file });
    expect(out).toHaveLength(1);
  });
});

describe("withProofBrief", () => {
  it("leaves the prompt byte-identical without criteria (D7)", () => {
    expect(withProofBrief("Fix the bug", [])).toBe("Fix the bug");
  });
  it("tells the agent which commands Alisio will accept as evidence", () => {
    const text = withProofBrief("Fix the bug", [
      {
        text: "Tests pass",
        required: true,
        origin: "cli",
        verifier: { kind: "command", command: "pnpm test" },
      },
      { text: "Reads well", required: false, origin: "cli" },
    ]);
    expect(text.startsWith("Fix the bug")).toBe(true);
    expect(text).toContain("Tests pass");
    expect(text).toContain("`pnpm test`");
    expect(text).toContain("Reads well");
  });
  it("names the exact read and query that count as evidence for file and data-check criteria", () => {
    const text = withProofBrief("Report", [
      {
        text: "Report exists",
        required: true,
        origin: "cli",
        verifier: { kind: "file", path: "out/report.md" },
      },
      {
        text: "Total matches",
        required: true,
        origin: "cli",
        verifier: {
          kind: "data-check",
          datasetId: "ds_1",
          check: "sum",
          column: "amount",
          expected: 60,
        },
      },
    ]);
    expect(text).toContain("read_file");
    expect(text).toContain("out/report.md");
    expect(text).toContain("data_query");
    expect(text).toContain('SELECT TOTAL("amount") FROM "data"');
    expect(text).toContain("ds_1");
  });
});
