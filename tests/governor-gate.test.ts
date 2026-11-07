/**
 * `scripts/governor-gate.ts` (specs/012, Phase 6 gate protocol): sample size, Newcombe interval,
 * per-model verdict and the overall decision rule, over tables of known cases. Pure statistics and
 * `runs.jsonl` records; no model, no network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EvalRunRecord } from "@alisio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configSchema, loadVariantsFile, resolveVariants } from "../packages/core/src/index.ts";
import {
  decideGate,
  type GateInput,
  loadGateConfig,
  newcombeDifference,
  nonInferiorityLowerBound,
  parseRunsJsonl,
  requiredSampleSize,
  runGateCli,
  summarizeArm,
  verdictForModel,
} from "../scripts/governor-gate.ts";

const Z95_TWO_SIDED = 1.959963984540054;

let seq = 0;
function record(taskId: string, status: EvalRunRecord["status"]): EvalRunRecord {
  seq += 1;
  return {
    schemaVersion: 1,
    runId: `r${seq}`,
    suiteId: "long-context-stress",
    suiteVersion: "1.1.0",
    taskId,
    repetition: 0,
    seed: seq,
    harnessVersion: "0.8.0",
    configHash: "sha256:x",
    provider: "p",
    model: "m",
    mode: "live",
    startedAt: 0,
    endedAt: 1,
    status,
    verifiers: [],
    measured: {
      inputTokens: 1000,
      outputTokens: 10,
      cachedInputTokens: 600,
      wallMs: 1,
      turns: 1,
      toolCalls: 1,
    },
    incidents: [],
  };
}

/** An arm with the protocol's composition: half chain-walk-rules (5 instances), half the others. */
function arm(passes: number, fails: number, errors = 0): EvalRunRecord[] {
  const statuses: EvalRunRecord["status"][] = [
    ...Array<EvalRunRecord["status"]>(passes).fill("pass"),
    ...Array<EvalRunRecord["status"]>(fails).fill("fail"),
    ...Array<EvalRunRecord["status"]>(errors).fill("error"),
  ];
  const others = ["frozen-area-tickets", "order-ledger-reconcile", "sequential-config-edits"];
  // Interleave statuses across both halves so neither half carries all the failures.
  return statuses.map((status, i) =>
    record(
      i % 2 === 0
        ? `chain-walk-rules-0${(Math.floor(i / 2) % 5) + 1}`
        : (others[(i >> 1) % 3] as string),
      status,
    ),
  );
}

/** The same runs with a cached-input ratio per run (undefined = the provider did not report it). */
function withCached(
  runs: EvalRunRecord[],
  ratio: (i: number) => number | undefined,
): EvalRunRecord[] {
  return runs.map((r, i) => {
    const value = ratio(i);
    const { cachedInputTokens: _drop, ...rest } = r.measured;
    return {
      ...r,
      measured: {
        ...rest,
        ...(value === undefined ? {} : { cachedInputTokens: Math.round(value * 1000) }),
      },
    };
  });
}

describe("requiredSampleSize: n = ceil((1.645 + 0.8416)^2 * 2p(1-p) / M^2)", () => {
  // The values published in specs/012 (protocol table): [p, n at M = 10 pp, n at M = 15 pp].
  it.each([
    [0.85, 158, 71],
    [0.9, 112, 50],
    [0.95, 59, 27],
    [0.98, 25, 11],
  ])("p = %f gives %i per arm at M = 10 pp and %i at M = 15 pp", (p, at10, at15) => {
    expect(requiredSampleSize(p, 0.1)).toBe(at10);
    expect(requiredSampleSize(p, 0.15)).toBe(at15);
  });

  it("defaults to M = 10 pp", () => {
    expect(requiredSampleSize(0.9)).toBe(112);
  });

  it("applies the 30-runs-per-arm floor through minRuns, not in the formula", () => {
    expect(requiredSampleSize(0.98, 0.1)).toBe(25);
    expect(requiredSampleSize(0.98, 0.1, { floor: true })).toBe(30);
    expect(requiredSampleSize(0.85, 0.1, { floor: true })).toBe(158);
  });

  it.each([-0.1, 0, 1, 1.2, Number.NaN])("rejects p = %s (no variance to plan with)", (p) => {
    expect(() => requiredSampleSize(p)).toThrow(RangeError);
  });

  it.each([0, -0.1, 1, Number.NaN])("rejects M = %s", (m) => {
    expect(() => requiredSampleSize(0.9, m)).toThrow(RangeError);
  });
});

describe("newcombeDifference: hybrid score interval (Newcombe 1998, method 10)", () => {
  // Reference values from Newcombe RG (1998), "Interval estimation for the difference between
  // independent proportions: comparison of eleven methods", Statistics in Medicine 17:873-890,
  // Table II, method 10, two-sided 95 % (z = 1.959964):
  //   56/70 vs 48/80 -> (0.0524, 0.3339)
  //    9/10 vs  3/10 -> (0.1705, 0.8090)
  // Reproduced from the published table; the paper itself could not be re-fetched when this test
  // was written, so these four-decimal figures are the author's transcription of the table.
  it.each([
    [56, 70, 48, 80, 0.0524, 0.3339],
    [9, 10, 3, 10, 0.1705, 0.809],
  ])("%i/%i vs %i/%i gives (%f, %f)", (x1, n1, x2, n2, lower, upper) => {
    const ci = newcombeDifference(x1, n1, x2, n2, Z95_TWO_SIDED);
    expect(ci.lower).toBeCloseTo(lower, 4);
    expect(ci.upper).toBeCloseTo(upper, 4);
    expect(ci.diff).toBeCloseTo(x1 / n1 - x2 / n2, 12);
  });

  it("is antisymmetric: swapping the arms negates and reverses the interval", () => {
    const a = newcombeDifference(17, 40, 30, 45, 1.645);
    const b = newcombeDifference(30, 45, 17, 40, 1.645);
    expect(b.lower).toBeCloseTo(-a.upper, 12);
    expect(b.upper).toBeCloseTo(-a.lower, 12);
  });

  it("is symmetric around zero for identical arms and stays inside [-1, 1]", () => {
    const same = newcombeDifference(0, 20, 0, 20, Z95_TWO_SIDED);
    expect(same.lower).toBeCloseTo(-same.upper, 12);
    const extreme = newcombeDifference(10, 10, 0, 10, Z95_TWO_SIDED);
    expect(extreme.upper).toBe(1);
    expect(extreme.lower).toBeGreaterThan(0.5);
    const down = newcombeDifference(0, 10, 10, 10, Z95_TWO_SIDED);
    expect(down.lower).toBe(-1);
  });

  it("rejects counts that are not proportions", () => {
    expect(() => newcombeDifference(11, 10, 1, 10, 1.96)).toThrow(RangeError);
    expect(() => newcombeDifference(1, 0, 1, 10, 1.96)).toThrow(RangeError);
  });
});

describe("nonInferiorityLowerBound: one-sided 95 %", () => {
  it("uses z = 1.645, so it equals the lower end of the two-sided 90 % interval", () => {
    const bound = nonInferiorityLowerBound({ successes: 27, n: 30 }, { successes: 28, n: 30 });
    const ci90 = newcombeDifference(27, 30, 28, 30, 1.6448536269514722);
    expect(bound).toBeCloseTo(ci90.lower, 12);
  });
});

describe("summarizeArm", () => {
  it("excludes errors from the rate and counts them against the 10 % limit", () => {
    const summary = summarizeArm(arm(36, 4, 5));
    expect(summary).toMatchObject({ total: 45, judged: 40, successes: 36, errored: 5 });
    expect(summary.rate).toBeCloseTo(0.9, 12);
    expect(summary.errorRate).toBeCloseTo(5 / 45, 12);
    expect(summary.issues.some((i) => i.includes("errors"))).toBe(true);
  });

  it("accepts errors up to 10 % of the arm and refuses more", () => {
    const summary = summarizeArm(arm(54, 6, 6)); // 6 / 66 < 10 %
    expect(summary.issues.filter((i) => i.includes("errors"))).toEqual([]);
    const edge = summarizeArm(arm(45, 5, 5)); // 5 / 55 = 9.09 %
    expect(edge.issues.filter((i) => i.includes("errors"))).toEqual([]);
    const over = summarizeArm(arm(45, 5, 6)); // 6 / 56 = 10.7 %
    expect(over.issues.some((i) => i.includes("errors"))).toBe(true);
  });

  it("flags an arm below 30 judged runs", () => {
    expect(summarizeArm(arm(25, 4)).issues.some((i) => i.includes("30"))).toBe(true);
    expect(summarizeArm(arm(26, 4)).issues.filter((i) => i.includes("30"))).toEqual([]);
  });

  it("flags an arm below the planned n when one is given", () => {
    const summary = summarizeArm(arm(55, 5), { plannedRuns: 112 });
    expect(summary.issues.some((i) => i.includes("112"))).toBe(true);
  });

  it("flags fewer than 5 chain-walk-rules instances and an unbalanced composition", () => {
    const onlyOthers = Array.from({ length: 40 }, () => record("frozen-area-tickets", "pass"));
    const issues = summarizeArm(onlyOthers).issues.join(" | ");
    expect(issues).toContain("chain-walk-rules");
    expect(issues).toContain("half");
  });

  it("counts budget_exceeded as a judged non-pass", () => {
    const runs = [
      ...arm(35, 0),
      ...Array.from({ length: 5 }, () => record("order-ledger-reconcile", "budget_exceeded")),
    ];
    expect(summarizeArm(runs)).toMatchObject({ judged: 40, successes: 35 });
  });

  it("an empty arm is invalid, with no rate", () => {
    const summary = summarizeArm([]);
    expect(summary.rate).toBeUndefined();
    expect(summary.issues.length).toBeGreaterThan(0);
  });
});

describe("verdictForModel", () => {
  const base = { id: "deepseek-flash", margin: 0.1 };

  it("passes when the lower bound is above -M and the off arm is a valid control", () => {
    const v = verdictForModel({
      ...base,
      off: arm(108, 12),
      on: arm(106, 14),
    });
    expect(v.valid).toBe(true);
    expect(v.passed).toBe(true);
    expect(v.lowerBound).toBeGreaterThan(-0.1);
  });

  it("does not pass when the interval is wide: 30/30 vs 27/30 cannot exclude -10 pp", () => {
    const v = verdictForModel({ ...base, off: arm(30, 0), on: arm(27, 3) });
    expect(v.valid).toBe(true);
    expect(v.lowerBound).toBeLessThan(-0.1);
    expect(v.passed).toBe(false);
  });

  it("does not pass a clear regression", () => {
    const v = verdictForModel({ ...base, off: arm(90, 10), on: arm(70, 30) });
    expect(v.passed).toBe(false);
    expect(v.lowerBound).toBeLessThan(-0.1);
  });

  it("is strict at the boundary: a lower bound exactly -M does not pass", () => {
    // Force the bound to be reported against a margin equal to it.
    const first = verdictForModel({
      ...base,
      off: arm(90, 10),
      on: arm(80, 20),
    });
    const edge = verdictForModel({
      ...base,
      margin: first.lowerBound === undefined ? 0 : -first.lowerBound,
      off: arm(90, 10),
      on: arm(80, 20),
    });
    expect(edge.passed).toBe(false);
  });

  it("invalidates the model when the off arm (the negative control) is not above 85 %", () => {
    const v = verdictForModel({ ...base, off: arm(34, 6), on: arm(36, 4) });
    // 34/40 = 85.0 %, not strictly above.
    expect(v.valid).toBe(false);
    expect(v.passed).toBe(false);
    expect(v.reasons.join(" ")).toContain("85");
  });

  it("accepts an off arm just above 85 %", () => {
    const v = verdictForModel({ ...base, off: arm(35, 5), on: arm(36, 4) });
    expect(v.valid).toBe(true);
  });

  it("invalidates the model when an arm has more than 10 % errors, even if the bound clears", () => {
    const v = verdictForModel({
      ...base,
      off: arm(36, 4),
      on: arm(36, 4, 10),
    });
    expect(v.valid).toBe(false);
    expect(v.passed).toBe(false);
  });

  it("computes nothing from an arm with no judged runs", () => {
    const v = verdictForModel({ ...base, off: arm(36, 4), on: [] });
    expect(v.lowerBound).toBeUndefined();
    expect(v.passed).toBe(false);
  });

  it("reports the planned n for a pilot p and holds the arms to it", () => {
    const v = verdictForModel({
      ...base,
      pilotP: 0.9,
      off: arm(36, 4),
      on: arm(36, 4),
    });
    expect(v.requiredRunsPerArm).toBe(112);
    expect(v.valid).toBe(false);
    expect(v.reasons.join(" ")).toContain("112");
  });
});

describe("cachedInput: pre-registered non-inferiority of the cached share (proposal, owner sets D)", () => {
  const base = { id: "deepseek-flash", margin: 0.1 };
  const arms = (off: (i: number) => number | undefined, on: (i: number) => number | undefined) => ({
    off: withCached(arm(108, 12), off),
    on: withCached(arm(108, 12), on),
  });

  it("compares per-run cached/input ratios of on vs off with a one-sided 95 % Welch bound", () => {
    // off 0.60 on every run, on 0.58 on every run: no variance, so the bound is the difference.
    const v = verdictForModel({
      ...base,
      cachedInputMaxDrop: 0.05,
      ...arms(
        () => 0.6,
        () => 0.58,
      ),
    });
    expect(v.cachedInput?.status).toBe("pass");
    expect(v.cachedInput?.difference).toBeCloseTo(-0.02, 12);
    expect(v.cachedInput?.lowerBound).toBeCloseTo(-0.02, 12);
    expect(v.cachedInput).toMatchObject({ runsOff: 120, runsOn: 120 });
    expect(v.cachedInput?.ratioOff).toBeCloseTo(0.6, 12);
    expect(v.cachedInput?.ratioOn).toBeCloseTo(0.58, 12);
  });

  it("is degraded when the lower bound is not above -D (strict, like G3)", () => {
    const tight = verdictForModel({
      ...base,
      cachedInputMaxDrop: 0.02,
      ...arms(
        () => 0.6,
        () => 0.58,
      ),
    });
    expect(tight.cachedInput?.status).toBe("degraded");
    const looser = verdictForModel({
      ...base,
      cachedInputMaxDrop: 0.0201,
      ...arms(
        () => 0.6,
        () => 0.58,
      ),
    });
    expect(looser.cachedInput?.status).toBe("pass");
  });

  it("run-to-run noise widens the bound: the same mean drop can stop passing", () => {
    const noisy = (i: number) => (i % 2 === 0 ? 0.2 : 0.96); // mean 0.58, sd ~0.38
    const v = verdictForModel({ ...base, cachedInputMaxDrop: 0.05, ...arms(() => 0.6, noisy) });
    expect(v.cachedInput?.difference).toBeCloseTo(-0.02, 2);
    expect(v.cachedInput?.lowerBound as number).toBeLessThan(-0.05);
    expect(v.cachedInput?.status).toBe("degraded");
  });

  it("an increase of the cached share never counts as degradation", () => {
    const v = verdictForModel({
      ...base,
      cachedInputMaxDrop: 0.05,
      ...arms(
        () => 0.5,
        () => 0.7,
      ),
    });
    expect(v.cachedInput?.status).toBe("pass");
  });

  it("is pending without the allowed drop D (the owner has not set it)", () => {
    const v = verdictForModel({
      ...base,
      ...arms(
        () => 0.6,
        () => 0.6,
      ),
    });
    expect(v.cachedInput?.status).toBe("pending");
    expect(v.cachedInput?.reason).toContain("D");
  });

  it("is pending when an arm reported no cachedInput at all (absent is not zero)", () => {
    const v = verdictForModel({
      ...base,
      cachedInputMaxDrop: 0.05,
      ...arms(
        () => 0.6,
        () => undefined,
      ),
    });
    expect(v.cachedInput?.status).toBe("pending");
    expect(v.cachedInput?.reason).toMatch(/did not report|no run reported/i);
  });

  it("is pending when fewer than 30 judged runs of an arm reported it", () => {
    const v = verdictForModel({
      ...base,
      cachedInputMaxDrop: 0.05,
      ...arms(
        () => 0.6,
        (i) => (i < 29 ? 0.6 : undefined),
      ),
    });
    expect(v.cachedInput?.status).toBe("pending");
    expect(v.cachedInput?.reason).toContain("30");
  });

  it("does not count partial or errored runs as reporters", () => {
    const off = withCached(arm(108, 12, 12), () => 0.6);
    const on = withCached(arm(108, 12, 12), () => 0.6).map((r) =>
      r.status === "error" ? { ...r, measured: { ...r.measured, cachedInputTokens: 0 } } : r,
    );
    const v = verdictForModel({ ...base, cachedInputMaxDrop: 0.05, off, on });
    expect(v.cachedInput).toMatchObject({ runsOff: 120, runsOn: 120 });
  });
});

describe("decideGate", () => {
  const goodModel = (id: string) => ({
    id,
    off: arm(108, 12),
    on: arm(108, 12),
  });
  const complete: GateInput = {
    margin: 0.1,
    threshold: 0.2,
    g1: { reduction: 0.35, basis: "estimated" },
    g2: "pass",
    cachedInputMaxDrop: 0.05,
    models: [goodModel("deepseek-flash"), goodModel("mimo-v2.6-flash")],
  };

  it("passes only when G1 >= T, G2 and G3 hold on every model and cachedInput did not degrade", () => {
    const d = decideGate(complete);
    expect(d.passed).toBe(true);
    expect(d.final).toBe(true);
    expect(d.outcome).toBe("passed");
    expect(d.pending).toEqual([]);
  });

  it("accepts G1 exactly at T", () => {
    expect(decideGate({ ...complete, g1: { reduction: 0.2, basis: "measured" } }).passed).toBe(
      true,
    );
  });

  it.each([
    ["G1 below T", { g1: { reduction: 0.19, basis: "estimated" as const } }, "G1"],
    ["G2 failed", { g2: "fail" as const }, "G2"],
    [
      "cachedInput degraded on one model",
      {
        models: [
          goodModel("deepseek-flash"),
          {
            id: "mimo-v2.6-flash",
            off: arm(108, 12),
            on: withCached(arm(108, 12), () => 0.3),
          },
        ],
      },
      "cachedInput",
    ],
    [
      "one model fails G3",
      {
        models: [
          goodModel("deepseek-flash"),
          { id: "mimo-v2.6-flash", off: arm(108, 12), on: arm(84, 36) },
        ],
      },
      "mimo-v2.6-flash",
    ],
    [
      "one model is invalid",
      {
        models: [
          goodModel("deepseek-flash"),
          { id: "mimo-v2.6-flash", off: arm(60, 60), on: arm(60, 60) },
        ],
      },
      "mimo-v2.6-flash",
    ],
  ])("does not pass when %s, and says why", (_name, patch, mention) => {
    const d = decideGate({ ...complete, ...patch });
    expect(d.passed).toBe(false);
    expect(d.outcome).toBe("not_passed");
    expect(d.final).toBe(true);
    expect(d.reasons.join(" ")).toContain(mention);
  });

  it("a model whose arms never reported cachedInput leaves the gate pending, not passed", () => {
    const d = decideGate({
      ...complete,
      models: [
        goodModel("deepseek-flash"),
        {
          id: "mimo-v2.6-flash",
          off: withCached(arm(108, 12), () => undefined),
          on: withCached(arm(108, 12), () => undefined),
        },
      ],
    });
    expect(d.passed).toBe(false);
    expect(d.final).toBe(false);
    expect(d.pending).toContain("cachedInput:mimo-v2.6-flash");
    expect(d.cachedInput.status).toBe("pending");
  });

  it("needs at least two models", () => {
    const d = decideGate({ ...complete, models: [goodModel("deepseek-flash")] });
    expect(d.passed).toBe(false);
    expect(d.reasons.join(" ")).toContain("two models");
  });

  it("refuses a final G1 verdict while T is unset, and the gate is not passed", () => {
    const { threshold: _t, ...noT } = complete;
    const d = decideGate(noT);
    expect(d.g1.status).toBe("refused");
    expect(d.g1.reason).toContain("T");
    expect(d.passed).toBe(false);
    expect(d.final).toBe(false);
    expect(d.pending).toContain("T");
    // The measured reduction is still reported, it is just not judged.
    expect(d.g1.reduction).toBe(0.35);
  });

  it("treats missing G2 or cachedInput evidence as pending, never as pass", () => {
    const { g2: _g2, cachedInputMaxDrop: _c, ...partial } = complete;
    const d = decideGate(partial);
    expect(d.passed).toBe(false);
    expect(d.final).toBe(false);
    expect(d.pending).toEqual(expect.arrayContaining(["G2", "cachedInputMaxDrop"]));
  });

  it("has no inconclusive state: an ambiguous interval is reported as not passed", () => {
    const d = decideGate({
      ...complete,
      models: [
        goodModel("deepseek-flash"),
        { id: "mimo-v2.6-flash", off: arm(30, 0), on: arm(27, 3) },
      ],
    });
    expect(["passed", "not_passed"]).toContain(d.outcome);
    expect(d.outcome).toBe("not_passed");
  });

  it("rejects an invalid margin or threshold", () => {
    expect(() => decideGate({ ...complete, margin: 0 })).toThrow(RangeError);
    expect(() => decideGate({ ...complete, threshold: 1.5 })).toThrow(RangeError);
  });
});

describe("parseRunsJsonl", () => {
  it("reads one record per line and ignores blank lines", () => {
    const text = `${JSON.stringify(record("a", "pass"))}\n\n${JSON.stringify(record("b", "fail"))}\n`;
    expect(parseRunsJsonl(text).map((r) => r.status)).toEqual(["pass", "fail"]);
  });

  it("names the line of a malformed record and of a record without a status", () => {
    expect(() => parseRunsJsonl("{nope")).toThrow(/line 1/);
    expect(() => parseRunsJsonl(`${JSON.stringify(record("a", "pass"))}\n{"taskId":"x"}`)).toThrow(
      /line 2/,
    );
  });
});

describe("loadGateConfig: an arm may be split over several runs.jsonl files", () => {
  it("concatenates the files of an arm (the rules tasks and the other tasks run separately)", () => {
    const dir = mkdtempSync(join(tmpdir(), "governor-gate-cfg-"));
    try {
      const file = (name: string, runs: EvalRunRecord[]) => {
        writeFileSync(join(dir, name), `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`);
        return name;
      };
      const rules = arm(10, 0).filter((r) => r.taskId.startsWith("chain-walk-rules-"));
      const others = arm(10, 0).filter((r) => !r.taskId.startsWith("chain-walk-rules-"));
      const split = [file("rules.jsonl", rules), file("others.jsonl", others)];
      writeFileSync(
        join(dir, "gate.json"),
        JSON.stringify({
          models: [{ id: "m", off: split, on: file("one.jsonl", arm(4, 0)) }],
        }),
      );
      const [model] = loadGateConfig(join(dir, "gate.json")).models;
      expect(model?.off).toHaveLength(rules.length + others.length);
      expect(model?.on).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the variants file of the live run (specs/012-context-governor-v1-fase6-compare.json)", () => {
  const path = resolve(import.meta.dirname, "../specs/012-context-governor-v1-fase6-compare.json");

  it("names the two arms of protocol v2 and every override is valid config", () => {
    const file = loadVariantsFile(path);
    expect(file.suite).toBe("long-context-stress");
    expect(file.variants.map((v) => v.id)).toEqual(["default-off", "default-on"]);
    const resolved = resolveVariants(file, configSchema.parse({}));
    const by = Object.fromEntries(resolved.map((v) => [v.id, v.config]));
    for (const id of ["default-off", "default-on"]) {
      expect(by[id]?.limits.maxContextChars).toBe(800_000);
    }
    expect(by["default-off"]?.context.governor).toBe("off");
    expect(by["default-on"]?.context.governor).toBe("on");
    // The shipped elision settings are untouched: no lowered epochMessages (owner decision, v2).
    expect(by["default-on"]?.context.elide.epochMessages).toBe(32);
  });
});

describe("runGateCli", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "governor-gate-test-"));
    mkdirSync(dir, { recursive: true });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, runs: EvalRunRecord[]): string {
    const path = join(dir, name);
    writeFileSync(path, `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return path;
  }
  function config(extra: Record<string, unknown> = {}): string {
    const model = (id: string) => ({
      id,
      off: write(`${id}-off.jsonl`, arm(108, 12)),
      on: write(`${id}-on.jsonl`, arm(108, 12)),
    });
    const path = join(dir, `gate-${Object.keys(extra).join("-") || "base"}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        g1: { reduction: 0.3, basis: "estimated" },
        g2: "pass",
        cachedInputMaxDrop: 0.05,
        models: [model("a"), model("b")],
        ...extra,
      }),
    );
    return path;
  }
  const run = async (args: string[]) => {
    const io = { out: "", err: "" };
    const code = await runGateCli(args, {
      out: (t) => void (io.out += t),
      err: (t) => void (io.err += t),
    });
    return { code, ...io };
  };

  it("exits 0 and prints the JSON decision when the gate passes", async () => {
    const { code, out } = await run(["--config", config(), "--threshold", "0.2"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ outcome: "passed", passed: true });
  });

  it("refuses a final G1 verdict without T: non-zero exit and a message that says so", async () => {
    const { code, out, err } = await run(["--config", config()]);
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ final: false, passed: false });
    expect(err).toContain("T is not set");
  });

  it("exits 1 when the gate is decided and not passed", async () => {
    const { code } = await run(["--config", config({ g2: "fail" }), "--threshold", "0.2"]);
    expect(code).toBe(1);
  });

  it("reports an unreadable file or bad config as a usage error (exit 3) without a stack", async () => {
    const missing = await run(["--config", join(dir, "nope.json")]);
    expect(missing.code).toBe(3);
    expect(missing.err).toContain("governor-gate:");
    expect(missing.err).not.toContain("at ");
  });

  it("takes the allowed cachedInput drop from --cached-drop, and without it the gate is pending", async () => {
    const { cachedInputMaxDrop: _d, ...noDrop } = JSON.parse(
      readFileSync(config(), "utf8"),
    ) as Record<string, unknown>;
    const path = join(dir, "gate-no-drop.json");
    writeFileSync(path, JSON.stringify(noDrop));
    const without = await run(["--config", path, "--threshold", "0.2"]);
    expect(without.code).toBe(2);
    expect(without.err).toContain("cachedInputMaxDrop");
    const withFlag = await run(["--config", path, "--threshold", "0.2", "--cached-drop", "0.05"]);
    expect(withFlag.code).toBe(0);
  });

  it("takes M from the flag", async () => {
    const wide = await run(["--config", config(), "--threshold", "0.2", "--margin", "0.01"]);
    expect(JSON.parse(wide.out).margin).toBe(0.01);
    expect(wide.code).toBe(1);
  });
});
