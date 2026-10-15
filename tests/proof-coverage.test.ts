/**
 * Proof phase 7 (specs/011 3.1, 4, D2, D3, D6, D7): the opt-in `coverage` verifier. The parser and
 * the judge are pure and run over fixed sample outputs; the capture runs through the real runner,
 * gate and SQLite with a scripted provider and a scripted `shell`/`run_process`.
 */
import type { ProofVerifierSpec, RunEvent, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../packages/core/src/config.ts";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { validateCriteriaDrafts } from "../packages/core/src/plan/criteria.ts";
import { judgeCoverage, parseCoverage } from "../packages/core/src/proof/coverage.ts";
import { parseCriteriaInput } from "../packages/core/src/proof/export.ts";
import { ProofVerifierRegistry } from "../packages/core/src/proof/plugin-verifiers.ts";
import { ProofRecorder } from "../packages/core/src/proof/recorder.ts";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { verifyCriterion } from "../packages/core/src/proof/verify.ts";
import { effectTool, gateFixture } from "./forge-gate-helpers.ts";

const LCOV = (records: Array<[number, number]>) =>
  records
    .map(
      ([found, hit], i) =>
        `TN:\nSF:src/f${i}.ts\nLF:${found}\nLH:${hit}\nBRF:0\nBRH:0\nend_of_record`,
    )
    .join("\n");

const VITEST_TABLE = (all: string, lines = all) => `
 % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   ${all} |       75 |     100 |   ${lines} |
 src               |      10 |       10 |      10 |      10 |
  a.ts             |     100 |      100 |     100 |     100 |
  b.ts             |      50 |        0 |     100 |      50 | 3-5
-------------------|---------|----------|---------|---------|-------------------
`;

const PYTHON = (total: string) => `
Name              Stmts   Miss  Cover
-------------------------------------
pkg/__init__.py       2      0   100%
pkg/core.py         118     12    90%
-------------------------------------
TOTAL               120     12  ${total}
`;

describe("parseCoverage: sample outputs", () => {
  it("raw lcov: sums LH over LF across every record", () => {
    expect(
      parseCoverage(
        LCOV([
          [10, 10],
          [10, 5],
        ]),
      ),
    ).toEqual({ percent: 75, format: "lcov" });
  });

  it("lcov with nothing instrumented is not a percentage", () => {
    expect(parseCoverage(LCOV([[0, 0]]))).toBeUndefined();
  });

  it("lcov --summary text", () => {
    const out =
      "Summary coverage rate:\n  lines......: 85.7% (6 of 7 lines)\n  functions..: 100.0% (2 of 2 functions)\n";
    expect(parseCoverage(out)).toEqual({ percent: 85.7, format: "lcov-summary" });
  });

  it("vitest text table: the All files row, % Lines column, not the per-file rows", () => {
    expect(parseCoverage(VITEST_TABLE("85.71", "80.5"))).toEqual({
      percent: 80.5,
      format: "table",
    });
  });

  it("vitest text-summary", () => {
    const out = [
      "=============================== Coverage summary ===============================",
      "Statements   : 90% ( 9/10 )",
      "Branches     : 50% ( 1/2 )",
      "Functions    : 100% ( 2/2 )",
      "Lines        : 88.89% ( 8/9 )",
    ].join("\n");
    expect(parseCoverage(out)).toEqual({ percent: 88.89, format: "summary" });
  });

  it("coverage.py: the TOTAL row, not the per-file rows", () => {
    expect(parseCoverage(PYTHON("92%"))).toEqual({ percent: 92, format: "coverage.py" });
  });

  it("coverage.py with branch columns takes the last percentage of TOTAL", () => {
    const out = "Name Stmts Miss Branch BrPart Cover\nTOTAL 120 12 40 5 85%\n";
    expect(parseCoverage(out)).toEqual({ percent: 85, format: "coverage.py" });
  });

  it("pytest-cov: the Required line is not the result", () => {
    const out = `${PYTHON("91%")}\nRequired test coverage of 80% reached. Total coverage: 91.20%\n`;
    expect(parseCoverage(out)?.percent).toBe(91.2);
  });

  it("ignores ANSI colors", () => {
    expect(parseCoverage(PYTHON("\u001b[32m92%\u001b[0m"))?.percent).toBe(92);
  });

  it("edge values: 100% and 0%", () => {
    expect(parseCoverage(PYTHON("100%"))?.percent).toBe(100);
    expect(parseCoverage(PYTHON("0%"))?.percent).toBe(0);
    expect(parseCoverage(VITEST_TABLE("0", "0"))?.percent).toBe(0);
  });

  it("malformed or missing totals are not a percentage", () => {
    expect(parseCoverage("")).toBeUndefined();
    expect(parseCoverage("all tests passed\n42 files")).toBeUndefined();
    expect(parseCoverage("TOTAL 120 12 abc%")).toBeUndefined();
    expect(parseCoverage("TOTAL 120 12 150%")).toBeUndefined();
    // per-file rows alone (no overall row) never stand in for the total
    expect(parseCoverage("pkg/core.py 118 12 90%\npkg/b.py 2 0 100%")).toBeUndefined();
    expect(parseCoverage(VITEST_TABLE("85").replace("All files", "Some files"))).toBeUndefined();
  });
});

describe("judgeCoverage", () => {
  const spec = (minPercent: number): Extract<ProofVerifierSpec, { kind: "coverage" }> => ({
    kind: "coverage",
    command: "pnpm coverage",
    minPercent,
  });
  const run = (percent: string, minPercent: number, exitCode = 0) =>
    judgeCoverage(spec(minPercent), { exitCode, output: PYTHON(`${percent}%`) });

  it("below the threshold fails and says by how much", () => {
    const judged = run("72", 80);
    expect(judged.ok).toBe(false);
    expect(judged.summary).toMatch(/72%.*below.*80%/);
  });

  it("exactly at the threshold verifies", () => {
    expect(run("80", 80).ok).toBe(true);
    expect(run("100", 100).ok).toBe(true);
  });

  it("0% against a 0 threshold verifies; against anything else it fails", () => {
    expect(run("0", 0).ok).toBe(true);
    expect(run("0", 1).ok).toBe(false);
  });

  it("unparseable output fails with a clear reason, never verifies", () => {
    const judged = judgeCoverage(spec(0), { exitCode: 0, output: "done" });
    expect(judged.ok).toBe(false);
    expect(judged.summary).toMatch(/no coverage percentage/i);
  });

  it("a command that exits non-zero never verifies, whatever it printed", () => {
    const judged = run("95", 80, 1);
    expect(judged.ok).toBe(false);
    expect(judged.summary).toMatch(/exit(ed)? (code )?1/);
  });
});

describe("config: proof.coverage", () => {
  it("is disabled by default and strict", () => {
    const config = configSchema.parse({});
    expect(config.proof.coverage).toEqual({ enabled: false });
    expect(
      configSchema.parse({ proof: { coverage: { enabled: true } } }).proof.coverage.enabled,
    ).toBe(true);
    expect(() => configSchema.parse({ proof: { coverage: { enabled: true, x: 1 } } })).toThrow();
  });
});

describe("criteria input", () => {
  it("accepts a coverage verifier in drafts and user input, rejects bad shapes", () => {
    const ok = validateCriteriaDrafts([
      {
        text: "coverage",
        verifier: { kind: "coverage", command: "pnpm coverage", minPercent: 80 },
      },
    ]);
    expect(ok.accepted[0]?.verifier).toEqual({
      kind: "coverage",
      command: "pnpm coverage",
      minPercent: 80,
    });
    for (const verifier of [
      { kind: "coverage", minPercent: 80 },
      { kind: "coverage", command: "x" },
      { kind: "coverage", command: "x", minPercent: 101 },
      { kind: "coverage", command: "x", minPercent: -1 },
      { kind: "coverage", command: "x", minPercent: "80" },
    ])
      expect(validateCriteriaDrafts([{ text: "c", verifier }]).dropped).toHaveLength(1);
    const user = parseCriteriaInput(
      [{ text: "c", verifier: { kind: "coverage", command: "x", minPercent: 50 } }],
      { origin: "cli" },
    );
    expect(user.errors).toEqual([]);
    expect(user.criteria[0]?.verifier?.kind).toBe("coverage");
  });
});

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

function shellTool(name: "shell" | "run_process", out: { stdout?: string; exitCode?: number }) {
  return effectTool(name, "process", {
    async execute() {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stdout: out.stdout ?? "",
              stderr: "",
              exitCode: out.exitCode ?? 0,
              truncated: false,
            }),
          },
        ],
      };
    },
  });
}

async function open(options: {
  enabled: boolean;
  stdout?: string;
  exitCode?: number;
  readonly?: boolean;
}) {
  const events: RunEvent[] = [];
  const tools: ToolDefinition[] = [shellTool("shell", options), shellTool("run_process", options)];
  const fx = await gateFixture({
    policy: options.readonly
      ? { write: false, process: false, external: false }
      : { ...PERMISSION_MODE_TABLE.full.policy },
    ...(options.readonly ? { approve: false as const } : {}),
    tools,
    onEvent: (e) => events.push(e),
    proof: (store) => new ProofRecorder(store.db, { coverage: () => options.enabled }),
  });
  fixtures.push(fx);
  const proof = new ProofStore(fx.store.db);
  const add = (minPercent: number, command = "pnpm coverage") =>
    proof.addCriterion({
      sessionId: fx.session,
      text: `coverage ≥ ${minPercent}%`,
      origin: "user",
      required: true,
      verifier: { kind: "coverage", command, minPercent },
    });
  return { fx, proof, events, add };
}

describe("coverage capture (disabled by default, opt-in)", () => {
  it("disabled: the command runs by the model but Proof records nothing; the criterion stays not_checked", async () => {
    const t = await open({ enabled: false, stdout: PYTHON("95%") });
    const c = t.add(80);
    await t.fx.play([{ name: "shell", arguments: { command: "pnpm coverage" } }]);
    const ledger = t.proof.ledger(t.fx.session);
    expect(ledger.evidence).toEqual([]);
    expect(ledger.criteria.find((x) => x.criterionId === c.criterionId)?.status).toBe(
      "not_checked",
    );
    expect(t.events.some((e) => e.type === "proof_updated")).toBe(false);
  });

  it("enabled: a low percentage is failed with evidence (D2/D3: run, call, hash, excerpt)", async () => {
    const t = await open({ enabled: true, stdout: PYTHON("72%") });
    const c = t.add(80);
    await t.fx.play([{ name: "shell", arguments: { command: "pnpm coverage" } }]);
    const ledger = t.proof.ledger(t.fx.session);
    expect(ledger.criteria[0]?.status).toBe("failed");
    const ev = ledger.evidence[0];
    expect(ev).toMatchObject({
      criterionId: c.criterionId,
      verifierKind: "coverage",
      ok: false,
      callId: "c1",
      exitCode: 0,
    });
    expect(ev?.runId).toBeTruthy();
    expect(ev?.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev?.commandFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ev?.excerpt).toMatch(/72%.*below.*80%/);
  });

  it("enabled: at or above the threshold verifies (run_process form too)", async () => {
    const t = await open({ enabled: true, stdout: PYTHON("80%") });
    t.add(80);
    await t.fx.play([{ name: "run_process", arguments: { command: "pnpm", args: ["coverage"] } }]);
    expect(t.proof.ledger(t.fx.session).criteria[0]?.status).toBe("verified");
  });

  it("enabled: unparseable output is failed with a reason, never verified", async () => {
    const t = await open({ enabled: true, stdout: "everything fine" });
    t.add(10);
    await t.fx.play([{ name: "shell", arguments: { command: "pnpm coverage" } }]);
    const ledger = t.proof.ledger(t.fx.session);
    expect(ledger.criteria[0]?.status).toBe("failed");
    expect(ledger.evidence[0]?.excerpt).toMatch(/no coverage percentage/i);
  });

  it("enabled: a different command produces nothing", async () => {
    const t = await open({ enabled: true, stdout: PYTHON("99%") });
    t.add(80);
    await t.fx.play([{ name: "shell", arguments: { command: "pnpm test" } }]);
    expect(t.proof.ledger(t.fx.session).evidence).toEqual([]);
  });

  it("credentials in the output are redacted in the excerpt", async () => {
    const t = await open({
      enabled: true,
      stdout: `${PYTHON("50%")}\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n`,
    });
    t.add(80);
    await t.fx.play([{ name: "shell", arguments: { command: "pnpm coverage" } }]);
    expect(t.proof.ledger(t.fx.session).evidence[0]?.excerpt).not.toContain("ghp_abcdef");
  });

  it("a model's text cannot create coverage evidence", async () => {
    const t = await open({ enabled: true, stdout: PYTHON("99%") });
    t.add(80);
    await t.fx.play([{ name: "shell", arguments: { command: "echo TOTAL 1 0 100%" } }]);
    expect(t.proof.ledger(t.fx.session).evidence).toEqual([]);
  });

  it("--read-only denies the process: the criterion stays not_checked", async () => {
    const t = await open({ enabled: true, stdout: PYTHON("99%"), readonly: true });
    t.add(80);
    await t.fx.play([{ name: "shell", arguments: { command: "pnpm coverage" } }]);
    expect(t.proof.ledger(t.fx.session).criteria[0]?.status).toBe("not_checked");
  });

  it("a session without criteria records nothing (D7)", async () => {
    const t = await open({ enabled: true, stdout: PYTHON("99%") });
    await t.fx.play([{ name: "shell", arguments: { command: "pnpm coverage" } }]);
    expect(t.proof.ledger(t.fx.session).evidence).toEqual([]);
  });
});

describe("verifyCriterion on demand", () => {
  const deps = (t: Awaited<ReturnType<typeof open>>, enabled: boolean) => ({
    store: t.proof,
    registry: new ProofVerifierRegistry(),
    db: t.fx.store.db,
    coverage: () => enabled,
    callTool: async (_sessionId: string, name: string, input: Record<string, unknown>) => {
      const [out] = await t.fx.play([{ name, arguments: input }]);
      return {
        callId: "c1",
        runId: "r",
        result: { content: [{ type: "text" as const, text: out?.text ?? "" }] },
      };
    },
  });

  it("disabled: never runs the command and says why", async () => {
    const t = await open({ enabled: false, stdout: PYTHON("99%") });
    const c = t.add(80);
    let called = false;
    const d = { ...deps(t, false), callTool: async () => ((called = true), undefined as never) };
    const outcome = await verifyCriterion(d, {
      sessionId: t.fx.session,
      criterionId: c.criterionId,
      workspace: t.fx.root,
    });
    expect(called).toBe(false);
    expect(outcome).toMatchObject({ status: "not_checked", reason: "coverage_disabled" });
  });

  it("enabled: runs the configured command under the gate and the recorder judges it", async () => {
    const t = await open({ enabled: true, stdout: PYTHON("60%") });
    const c = t.add(80);
    const outcome = await verifyCriterion(deps(t, true), {
      sessionId: t.fx.session,
      criterionId: c.criterionId,
      workspace: t.fx.root,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.evidenceId).toBeTruthy();
  });
});
