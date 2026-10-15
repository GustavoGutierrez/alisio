/**
 * Proof phase 3 (specs/011 3.5, D7, D8): `detectDivergence` is pure. It reads the closed EN/ES
 * claim patterns of a final answer, cross-references them with equivalent criteria and reports
 * what the ledger does not back. It never edits text or statuses.
 */
import type { ProofCriterion, ProofLedger, ProofStatus, RunEvent } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { detectDivergence } from "../packages/core/src/proof/divergence.ts";
import { ProofRecorder } from "../packages/core/src/proof/recorder.ts";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { gateFixture } from "./forge-gate-helpers.ts";

let n = 0;
function criterion(
  command: string | undefined,
  status: ProofStatus,
  over: Partial<ProofCriterion> = {},
): ProofCriterion {
  n += 1;
  return {
    criterionId: `crit_${n}`,
    sessionId: "s1",
    text: command ? `Run ${command}` : "something",
    required: true,
    origin: "user",
    ...(command ? { verifier: { kind: "command" as const, command } } : {}),
    status,
    evidenceIds: [],
    ...over,
  };
}
const ledgerOf = (...criteria: ProofCriterion[]): ProofLedger => ({
  sessionId: "s1",
  criteria,
  evidence: [],
  divergences: [],
  generatedAt: "2026-10-14T10:00:00.000Z",
});
const kinds = (text: string, status: ProofStatus = "not_checked") =>
  detectDivergence(
    text,
    ledgerOf(
      criterion("pnpm test", status),
      criterion("pnpm typecheck", status),
      criterion("pnpm lint", status),
    ),
  )
    .map((d) => d.kind)
    .sort();

describe("detectDivergence: the claim is not backed by the ledger", () => {
  it("reports a 'tests pass' claim without a verified test criterion and alters nothing", () => {
    const test = criterion("pnpm test", "not_checked");
    const ledger = ledgerOf(test, criterion("pnpm lint", "verified"));
    const before = JSON.stringify(ledger);
    Object.freeze(ledger);
    for (const c of ledger.criteria) Object.freeze(c);

    const out = detectDivergence("Done. All tests pass.", ledger);

    expect(out).toEqual([
      {
        claim: "tests pass",
        kind: "test",
        expected: "verified",
        actualState: "not_checked",
        criterionId: test.criterionId,
      },
    ]);
    expect(JSON.stringify(ledger)).toBe(before);
  });

  it("reports a failed criterion with its real state", () => {
    const test = criterion("vitest run", "failed");
    expect(detectDivergence("The tests are passing now.", ledgerOf(test))).toMatchObject([
      { kind: "test", actualState: "failed", criterionId: test.criterionId },
    ]);
  });

  it("is silent when every equivalent criterion is verified or not applicable", () => {
    expect(detectDivergence("tests pass", ledgerOf(criterion("pnpm test", "verified")))).toEqual(
      [],
    );
    expect(
      detectDivergence(
        "tests pass",
        ledgerOf(criterion("pnpm test", "verified"), criterion("pnpm test:cli", "not_applicable")),
      ),
    ).toEqual([]);
  });

  it("with several equivalent criteria it reports each one that is not verified", () => {
    const ok = criterion("pnpm test", "verified");
    const bad = criterion("npm run test:cli", "failed");
    const manual = criterion("pnpm test:compiled", "manual_review");
    const out = detectDivergence("tests pass", ledgerOf(ok, bad, manual));
    expect(out.map((d) => [d.criterionId, d.actualState])).toEqual([
      [bad.criterionId, "failed"],
      [manual.criterionId, "manual_review"],
    ]);
  });

  it("a claim with no equivalent criterion is not_checked, without a criterion id", () => {
    const out = detectDivergence("lint is clean", ledgerOf(criterion("pnpm test", "verified")));
    expect(out).toEqual([
      { claim: "lint is clean", kind: "lint", expected: "verified", actualState: "not_checked" },
    ]);
  });

  it("D7: an empty ledger yields nothing, whatever the text claims", () => {
    expect(detectDivergence("tests pass, lint clean, typecheck ok", ledgerOf())).toEqual([]);
  });

  it("matches the equivalent criterion by verifier command or by its text", () => {
    const byText = criterion(undefined, "not_checked", { text: "Typecheck passes" });
    expect(detectDivergence("typecheck ok", ledgerOf(byText))).toMatchObject([
      { kind: "typecheck", criterionId: byText.criterionId },
    ]);
    for (const [cmd, kind] of [
      ["pnpm test", "test"],
      ["npm run test:unit", "test"],
      ["vitest run", "test"],
      ["pytest -q", "test"],
      ["go test ./...", "test"],
      ["tsc --noEmit", "typecheck"],
      ["pnpm typecheck", "typecheck"],
      ["biome check .", "lint"],
      ["eslint src", "lint"],
      ["pnpm lint", "lint"],
    ] as const) {
      const c = criterion(cmd, "not_checked");
      const text = { test: "tests pass", typecheck: "typecheck ok", lint: "lint clean" }[kind];
      expect(detectDivergence(text, ledgerOf(c)), cmd).toMatchObject([
        { kind, criterionId: c.criterionId },
      ]);
    }
  });
});

describe("detectDivergence: closed EN/ES claim patterns", () => {
  it.each([
    ["tests pass", ["test"]],
    ["All tests pass.", ["test"]],
    ["All the tests are passing", ["test"]],
    ["The unit tests passed", ["test"]],
    ["the test suite is green", ["test"]],
    ["Tests Pass", ["test"]],
    ["typecheck ok", ["typecheck"]],
    ["The typecheck is clean", ["typecheck"]],
    ["type check passes", ["typecheck"]],
    ["lint clean", ["lint"]],
    ["lint passes", ["lint"]],
    ["The linter is clean now", ["lint"]],
    ["typecheck, lint and tests all pass", ["lint", "test", "typecheck"]],
    ["los tests pasan", ["test"]],
    ["Todos los tests pasan correctamente", ["test"]],
    ["las pruebas pasan", ["test"]],
    ["los tests unitarios pasaron", ["test"]],
    ["los tests están en verde", ["test"]],
    ["el lint está limpio", ["lint"]],
    ["el lint pasa", ["lint"]],
    ["el typecheck pasa", ["typecheck"]],
    ["la verificación de tipos pasa", ["typecheck"]],
    ["typecheck, lint y tests pasan", ["lint", "test", "typecheck"]],
  ])("finds the claim in %j", (text, expected) => {
    expect(kinds(text)).toEqual(expected);
  });

  it("claims are unique per kind and reported in order of appearance", () => {
    const out = detectDivergence(
      "lint clean. Later: tests pass, and again tests pass.",
      ledgerOf(criterion("pnpm test", "failed"), criterion("pnpm lint", "failed")),
    );
    expect(out.map((d) => d.kind)).toEqual(["lint", "test"]);
  });

  it.each([
    "tests do not pass",
    "the tests fail",
    "the tests are failing",
    "I could not run the tests",
    "los tests no pasan",
    "los tests fallan",
    "if the tests pass we can merge",
    "once the tests pass, merge it",
    "when the lint is clean we ship",
    "make sure the tests pass",
    "to make the tests pass I changed it",
    "tests should pass",
    "I hope the tests pass",
    "cuando los tests pasen",
    "si los tests pasan, avísame",
    "asegúrate de que los tests pasan",
    "no sé si el lint pasa",
    "we need the typecheck to pass",
    "run the tests",
    "the test file was updated",
  ])("does not treat %j as a claim", (text) => {
    expect(kinds(text)).toEqual([]);
  });

  it("a negation in an earlier sentence does not hide a later claim", () => {
    expect(kinds("I did not touch the config. Tests pass.")).toEqual(["test"]);
    expect(kinds("No pude abrir el navegador. Los tests pasan.")).toEqual(["test"]);
  });

  it("ignores claims inside fenced code, inline code, quotes and block quotes", () => {
    expect(kinds("Output:\n```\n$ pnpm test\ntests pass\n```\nNothing else.")).toEqual([]);
    expect(kinds("~~~sh\nlint clean\n~~~")).toEqual([]);
    expect(kinds("It prints `tests pass` at the end.")).toEqual([]);
    expect(kinds('The script says "tests pass" even when they do not.')).toEqual([]);
    expect(kinds("The script says “typecheck ok” always.")).toEqual([]);
    expect(kinds("El script imprime «los tests pasan» siempre.")).toEqual([]);
    expect(kinds("> tests pass\nThat was the old output.")).toEqual([]);
  });

  it("a claim next to a quote or code block is still found", () => {
    expect(kinds('He wrote "ok". Tests pass.')).toEqual(["test"]);
    expect(kinds("```\nx\n```\nTests pass.")).toEqual(["test"]);
    expect(kinds('An unbalanced " quote then tests pass')).toEqual(["test"]);
  });

  it("is deterministic and bounded on hostile input", () => {
    const text = "Done: typecheck ok, tests pass.";
    const ledger = ledgerOf(
      criterion("pnpm test", "failed"),
      criterion("pnpm typecheck", "failed"),
    );
    expect(detectDivergence(text, ledger)).toEqual(detectDivergence(text, ledger));
    const started = Date.now();
    detectDivergence("tests, ".repeat(40_000), ledger);
    detectDivergence("`".repeat(100_000), ledger);
    detectDivergence('"'.repeat(100_000), ledger);
    detectDivergence("a".repeat(500_000), ledger);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("the runner announces divergences (display only)", () => {
  const fixtures: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const f of fixtures.splice(0)) await f.close();
  });
  async function finish(finalText: string, criteria: "none" | "test") {
    const events: RunEvent[] = [];
    const fx = await gateFixture({
      policy: { ...PERMISSION_MODE_TABLE.full.policy },
      finalText,
      onEvent: (e) => events.push(e),
      proof: (store) => new ProofRecorder(store.db),
    });
    fixtures.push(fx);
    const proof = new ProofStore(fx.store.db);
    const crit =
      criteria === "test"
        ? proof.addCriterion({
            sessionId: fx.session,
            text: "tests",
            origin: "user",
            verifier: { kind: "command", command: "pnpm test" },
          })
        : undefined;
    await fx.play([]);
    return { events, proof, fx, crit };
  }

  it("emits proof_divergence before run_completed and leaves the ledger untouched", async () => {
    const t = await finish("All tests pass.", "test");
    const types = t.events.map((e) => e.type);
    const divergence = t.events.find((e) => e.type === "proof_divergence");
    expect(divergence?.data).toEqual({
      claim: "tests pass",
      criterionId: t.crit?.criterionId,
      actual: "not_checked",
    });
    expect(types.indexOf("proof_divergence")).toBeLessThan(types.indexOf("run_completed"));
    expect(t.proof.ledger(t.fx.session).criteria[0]?.status).toBe("not_checked");
    expect(t.fx.store.messages(t.fx.session).at(-1)).toMatchObject({ text: "All tests pass." });
  });

  it("D7: without criteria nothing is emitted, whatever the answer claims", async () => {
    const t = await finish("All tests pass.", "none");
    expect(t.events.some((e) => e.type === "proof_divergence")).toBe(false);
  });

  it("an answer without claims emits nothing", async () => {
    const t = await finish("Refactored the module.", "test");
    expect(t.events.some((e) => e.type === "proof_divergence")).toBe(false);
  });
});
