/**
 * `/proof` in the terminal (specs/011 phase 5): it shows the ledger of the session and carries the
 * user's own actions (add, edit, not applicable, export). The function takes an injected
 * environment over a real ledger, so no terminal is needed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROOF_USAGE, parseProofCommand, runProofCommand } from "../packages/cli/src/tui/proof.ts";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function open() {
  const root = await mkdtemp(join(tmpdir(), "alisio-tui-proof-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "s.sqlite"));
  const proof = new ProofStore(store.db);
  const session = store.create("/w", "p", "m").id;
  const published: string[] = [];
  const env = {
    proof,
    sessionId: session,
    publisher: {
      async publishText(input: { fileName: string }) {
        published.push(input.fileName);
        return { id: "a", fileName: input.fileName } as never;
      },
    },
  };
  return { store, proof, env, published, session };
}

describe("parseProofCommand", () => {
  it("parses the verbs", () => {
    expect(parseProofCommand("")).toEqual({ type: "show" });
    expect(parseProofCommand("help")).toEqual({ type: "help" });
    expect(parseProofCommand("add Tests pass -- pnpm test")).toEqual({
      type: "add",
      text: "Tests pass",
      command: "pnpm test",
      required: false,
    });
    expect(parseProofCommand("add required Tests pass")).toEqual({
      type: "add",
      text: "Tests pass",
      required: true,
    });
    expect(parseProofCommand("edit 2 New wording")).toEqual({
      type: "edit",
      index: 2,
      text: "New wording",
    });
    expect(parseProofCommand("required 1")).toEqual({ type: "required", index: 1, required: true });
    expect(parseProofCommand("optional 1")).toEqual({
      type: "required",
      index: 1,
      required: false,
    });
    expect(parseProofCommand("na 3 No UI in this change")).toEqual({
      type: "na",
      index: 3,
      reason: "No UI in this change",
    });
    expect(parseProofCommand("export")).toEqual({ type: "export" });
  });
  it("rejects what it cannot understand with the usage", () => {
    for (const bad of ["add", "edit x y", "na 1", "na 0 why", "fly"])
      expect(parseProofCommand(bad)).toMatchObject({ type: "error" });
    expect(PROOF_USAGE).toContain("/proof");
  });
});

describe("runProofCommand", () => {
  it("shows the ledger with the same statuses every surface shows", async () => {
    const h = await open();
    try {
      expect((await runProofCommand("", h.env)).text).toContain("no criteria");
      await runProofCommand("add required Tests pass -- pnpm test", h.env);
      const shown = await runProofCommand("", h.env);
      expect(shown.text).toContain("not_checked");
      expect(shown.text).toContain("Tests pass");
      expect(shown.text).toContain("(required)");
    } finally {
      h.store.close();
    }
  });

  it("adds, edits, flags and marks not applicable by position, as the user", async () => {
    const h = await open();
    try {
      await runProofCommand("add Docs updated", h.env);
      await runProofCommand("edit 1 Docs explain the flag", h.env);
      await runProofCommand("required 1", h.env);
      const [c] = h.proof.criteria(h.session);
      expect(c).toMatchObject({ text: "Docs explain the flag", required: true, origin: "user" });
      const na = await runProofCommand("na 1 No docs in this repo", h.env);
      expect(na.text).toContain("not_applicable");
      expect(h.proof.ledger(h.session).criteria[0]).toMatchObject({
        status: "not_applicable",
        notApplicableReason: "No docs in this repo",
      });
    } finally {
      h.store.close();
    }
  });

  it("says so for a position that does not exist and never throws", async () => {
    const h = await open();
    try {
      const r = await runProofCommand("na 5 whatever", h.env);
      expect(r.tone).toBe("notice");
      expect(r.text).toContain("no criterion 5");
    } finally {
      h.store.close();
    }
  });

  it("exports proof.md and proof.json as session artifacts", async () => {
    const h = await open();
    try {
      const r = await runProofCommand("export", h.env);
      expect(h.published).toEqual(["proof.md", "proof.json"]);
      expect(r.text).toContain("proof.json");
    } finally {
      h.store.close();
    }
  });
});

describe("the divergence warning in the terminal (D8)", () => {
  it("adds one notice and changes nothing else", async () => {
    const { initialViewState, reduceEvent } = await import("../packages/cli/src/tui/state.ts");
    const state = initialViewState("m", 0);
    const next = reduceEvent(state, {
      eventId: "e1",
      schemaVersion: 1,
      sessionId: "s",
      runId: "r",
      type: "proof_divergence",
      timestamp: new Date(0).toISOString(),
      data: { claim: "the tests pass", criterionId: "c1", actual: "not_checked" },
    } as never);
    const added = next.items.slice(state.items.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "notice" });
    expect(JSON.stringify(added[0])).toContain("the tests pass");
    expect(JSON.stringify(added[0])).toContain("not_checked");
  });
});
