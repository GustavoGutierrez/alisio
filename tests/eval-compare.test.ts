/** Reliability lab Phase 3: comparison of reports and of config variants (specs/010 D14, D15, O3). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalReport, EvalRunRecord } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compareReports,
  compareVariants,
  EvalCompareError,
  parseReport,
  renderComparisonMarkdown,
  renderVariantComparisonMarkdown,
} from "../packages/core/src/eval/compare.ts";
import { buildReport } from "../packages/core/src/eval/report.ts";
import {
  applyConfigOverrides,
  EvalVariantError,
  loadVariantsFile,
  resolveVariants,
} from "../packages/core/src/eval/variants.ts";
import { configSchema } from "../packages/core/src/index.ts";
import { runsOf } from "./eval-helpers.ts";

const outcomes = (passes: number, total: number): EvalRunRecord["status"][] =>
  Array.from({ length: total }, (_, i) => (i < passes ? "pass" : "fail"));

/** A report with one task `t1` that passed `passes` of `total` runs. */
function report(
  passes: number,
  total: number,
  change: Partial<EvalRunRecord> = {},
  taskId = "t1",
): EvalReport {
  return buildReport(runsOf(taskId, outcomes(passes, total), () => change));
}

const only = <T>(list: T[]): T => {
  if (list.length !== 1) throw new Error(`expected one element, got ${list.length}`);
  return list[0] as T;
};

describe("compareReports: compatibility (D14)", () => {
  it("rejects different suiteVersion with a typed error", () => {
    const error = (() => {
      try {
        compareReports(report(5, 5), report(5, 5, { suiteVersion: "2.0.0" }));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(EvalCompareError);
    expect((error as EvalCompareError).reason).toBe("suite_version");
    expect((error as Error).message).toMatch(/1\.0\.0/);
    expect((error as Error).message).toMatch(/2\.0\.0/);
  });

  it("rejects different suiteId", () => {
    expect(() => compareReports(report(5, 5), report(5, 5, { suiteId: "other" }))).toThrow(
      EvalCompareError,
    );
  });

  it("declares what changed between the two reports", () => {
    const a = report(5, 5);
    const b = report(5, 5, {
      configHash: "sha256:bbb",
      model: "other-model",
      harnessVersion: "0.7.0",
      mode: "replay",
    });
    const changed = compareReports(a, b).changed;
    expect(changed.map((c) => c.field).sort()).toEqual(
      ["configHash", "harnessVersion", "mode", "model"].sort(),
    );
    expect(changed.find((c) => c.field === "model")).toEqual({
      field: "model",
      baseline: "fake-model",
      candidate: "other-model",
    });
    expect(compareReports(a, report(5, 5)).changed).toEqual([]);
  });

  it("lists tasks present on one side only", () => {
    const a = buildReport([...runsOf("t1", outcomes(5, 5)), ...runsOf("t2", outcomes(5, 5))]);
    const b = buildReport([...runsOf("t1", outcomes(5, 5)), ...runsOf("t3", outcomes(5, 5))]);
    const c = compareReports(a, b);
    expect(c.tasks.map((t) => t.taskId)).toEqual(["t1"]);
    expect(c.onlyInBaseline).toEqual(["t2"]);
    expect(c.onlyInCandidate).toEqual(["t3"]);
  });
});

describe("compareReports: per-task deltas", () => {
  it("computes the success-rate delta and the delta of every measured metric", () => {
    const a = buildReport(runsOf("t1", outcomes(3, 5)));
    const b = buildReport(
      runsOf("t1", outcomes(5, 5), (i) => ({
        measured: {
          inputTokens: 500,
          outputTokens: 100,
          wallMs: 500 * (i + 1),
          turns: 1,
          toolCalls: 1,
        },
      })),
    );
    const t = only(compareReports(a, b).tasks);
    expect(t.successRate.baseline.value).toBeCloseTo(0.6, 10);
    expect(t.successRate.candidate.value).toBe(1);
    expect(t.successRate.delta).toBeCloseTo(0.4, 10);
    const median = t.measured.medianWallMs;
    expect(median?.baseline).toBe(3000);
    expect(median?.candidate).toBe(1500);
    expect(median?.delta).toBe(-1500);
    expect(t.measured.tokensPerSuccess?.delta).toBeDefined();
    expect(t.k).toEqual({ baseline: 5, candidate: 5 });
  });

  it("leaves out a metric that only one side could compute", () => {
    const a = buildReport(runsOf("t1", ["pass"]));
    const b = buildReport(runsOf("t1", ["pass", "pass", "pass"]));
    const t = only(compareReports(a, b).tasks);
    expect(t.measured).not.toHaveProperty("varianceWallMs");
    expect(t.measured).toHaveProperty("medianWallMs");
  });

  it("keeps measured and estimated apart and never compares costs under different rates", () => {
    const rates = { inputPerMTokUsd: 2, outputPerMTokUsd: 10 };
    const mk = (r: typeof rates) => buildReport(runsOf("t1", outcomes(5, 5)), { rates: r });
    const same = compareReports(mk(rates), mk(rates));
    const t = only(same.tasks);
    expect(JSON.stringify(t.measured)).not.toContain("cost");
    expect(t.estimated?.costUsdPerSuccess?.delta).toBeCloseTo(0, 12);
    const other = compareReports(mk(rates), mk({ ...rates, inputPerMTokUsd: 4 }));
    expect(only(other.tasks).estimated).toBeUndefined();
    expect(other.warnings.join(" ")).toMatch(/rates/i);
    const none = compareReports(report(5, 5), report(5, 5));
    expect(JSON.stringify(none)).not.toContain("costUsd");
    expect(only(none.tasks).estimated).toBeUndefined();
  });
});

describe("compareReports: verdicts (O3)", () => {
  it("labels overlapping Wilson intervals inconclusive and claims no direction", () => {
    // 4/5 [0.38, 0.96] and 5/5 [0.57, 1] overlap.
    const t = only(compareReports(report(4, 5), report(5, 5)).tasks).successRate;
    expect(t.overlap).toBe(true);
    expect(t.verdict).toBe("inconclusive");
    expect(t.delta).toBeCloseTo(0.2, 10);
  });

  it("claims an improvement only when k >= 5 on both sides and the intervals are disjoint", () => {
    // 0/10 [0, 0.28] and 10/10 [0.72, 1].
    const improved = only(compareReports(report(0, 10), report(10, 10)).tasks).successRate;
    expect(improved.overlap).toBe(false);
    expect(improved.verdict).toBe("improved");
    const regressed = only(compareReports(report(10, 10), report(0, 10)).tasks).successRate;
    expect(regressed.verdict).toBe("regressed");
  });

  it("warns low power and claims no direction below k=5, even with disjoint intervals", () => {
    // 4/4 [0.51, 1] and 0/4 [0, 0.49] do not overlap, but k=4.
    const comparison = compareReports(report(0, 4), report(4, 4));
    const t = only(comparison.tasks).successRate;
    expect(t.overlap).toBe(false);
    expect(only(comparison.tasks).lowPower).toBe(true);
    expect(t.verdict).toBe("low_power");
    expect(comparison.warnings.join(" ")).toMatch(/low power/i);
  });

  it("is low power when only one side has fewer than 5 judged runs", () => {
    const t = only(compareReports(report(0, 10), report(4, 4)).tasks);
    expect(t.lowPower).toBe(true);
    expect(t.successRate.verdict).not.toBe("improved");
  });

  it("treats intervals that merely touch as overlapping", () => {
    const comparison = compareReports(report(0, 10), report(0, 10));
    expect(only(comparison.tasks).successRate.verdict).toBe("inconclusive");
    expect(only(comparison.tasks).successRate.delta).toBe(0);
  });

  it("counts errored runs out of k, so they can make a comparison low power", () => {
    const a = buildReport(runsOf("t1", ["fail", "fail", "fail", "fail", "fail", "error"]));
    const b = buildReport(runsOf("t1", ["pass", "pass", "pass", "pass", "error"]));
    expect(only(compareReports(a, b).tasks).k).toEqual({ baseline: 5, candidate: 4 });
    expect(only(compareReports(a, b).tasks).lowPower).toBe(true);
  });
});

describe("renderComparisonMarkdown", () => {
  it("shows what changed, the verdicts and the low-power warning, and separates blocks", () => {
    const comparison = compareReports(report(4, 5), report(5, 5, { model: "m2" }));
    const md = stripNote(renderComparisonMarkdown(comparison));
    expect(md).toContain("demo");
    expect(md).toMatch(/model/);
    expect(md).toContain("m2");
    expect(md).toMatch(/inconclusive/i);
    expect(md).not.toMatch(/\bimproved\b/);
    expect(md.indexOf("## Measured")).toBeGreaterThan(-1);
    expect(md.indexOf("## Estimated")).toBeGreaterThan(md.indexOf("## Measured"));
    const low = stripNote(renderComparisonMarkdown(compareReports(report(0, 4), report(4, 4))));
    expect(low).toMatch(/low power/i);
    expect(low).not.toMatch(/\bimproved\b/);
  });

  it("prints improved/regressed only for conclusive comparisons", () => {
    const md = renderComparisonMarkdown(compareReports(report(0, 10), report(10, 10)));
    expect(md).toMatch(/\bimproved\b/);
  });

  it("warns that replay comparisons say nothing about the model", () => {
    const md = renderComparisonMarkdown(
      compareReports(
        report(5, 5, { mode: "replay" }),
        report(5, 5, { mode: "replay", configHash: "sha256:bbb" }),
      ),
    );
    expect(md).toMatch(/replay measures the harness, not the model/i);
  });
});

/** Markdown without the footnote, which names improved/regressed/inconclusive by definition. */
const stripNote = (md: string) => md.split("\n*improved/regressed")[0] as string;

const FOOTNOTE = (n: number, e: number, drift: string) =>
  `improved/regressed = 95% Wilson intervals disjoint with at least 5 judged runs per side. Conservative screen, not a significance test; 'inconclusive' is not 'no difference'. Assumes independent repetitions; ${drift}; no correction across ${n} tasks; ${e} runs excluded as infrastructure errors; seeds order runs only and do not reach the provider.`;

describe("compareReports: survivorship and comparability (review of Phase 3)", () => {
  it("returns no improved/regressed verdict when either side has errored runs", () => {
    const a = buildReport(runsOf("t1", [...outcomes(0, 10), "error"]));
    const b = buildReport(runsOf("t1", outcomes(10, 10)));
    const c = compareReports(a, b);
    const t = only(c.tasks);
    expect(t.errored).toEqual({ baseline: 1, candidate: 0 });
    expect(t.successRate.verdict).toBe("not comparable: errored runs");
    expect(c.errored).toEqual({ baseline: 1, candidate: 0 });
    expect(c.warnings.join(" ")).toMatch(/errored/i);
    const md = stripNote(renderComparisonMarkdown(c));
    expect(md).toContain("not comparable: errored runs");
    expect(md).not.toMatch(/\bimproved\b|\bregressed\b/);
  });

  it("returns a not-comparable verdict when the modes differ, and keeps the warning", () => {
    const c = compareReports(report(0, 10), report(10, 10, { mode: "replay" }));
    expect(only(c.tasks).successRate.verdict).toBe("not comparable: mode differs");
    expect(c.warnings.join(" ")).toMatch(/modes differ/i);
  });

  it("replay: no interval, no improved/regressed, only changed/unchanged per task", () => {
    const replay = (passes: number, change: Partial<EvalRunRecord> = {}) =>
      report(passes, 5, { mode: "replay", ...change });
    const same = only(compareReports(replay(5), replay(5)).tasks);
    expect(same.successRate.verdict).toBe("unchanged");
    expect(same.successRate.baseline.wilsonLow).toBeUndefined();
    expect(same.successRate.candidate.wilsonHigh).toBeUndefined();
    expect(same.replay).toEqual({
      baselinePass: true,
      candidatePass: true,
      passChanged: false,
      countsChanged: false,
    });
    const flipped = only(compareReports(replay(5), replay(0)).tasks);
    expect(flipped.successRate.verdict).toBe("changed");
    expect(flipped.replay?.passChanged).toBe(true);
    const counts = only(
      compareReports(
        replay(5),
        replay(5, {
          measured: { inputTokens: 1, outputTokens: 1, wallMs: 1, turns: 1, toolCalls: 1 },
        }),
      ).tasks,
    );
    expect(counts.replay?.countsChanged).toBe(true);
    expect(counts.successRate.verdict).toBe("changed");
    const md = stripNote(renderComparisonMarkdown(compareReports(replay(5), replay(0))));
    expect(md).not.toMatch(/inconclusive|regressed|\[\d/);
    expect(md).toContain("changed");
  });

  it("refuses token and cost deltas when the compaction settings differ", () => {
    const rates = { inputPerMTokUsd: 2, outputPerMTokUsd: 10 };
    const mk = (hash: string) =>
      buildReport(
        runsOf("t1", outcomes(5, 5), () => ({ compactionHash: hash })),
        { rates },
      );
    const c = compareReports(mk("sha256:a"), mk("sha256:b"));
    expect(c.tokenComparison).toBe("not comparable: compaction settings differ");
    const t = only(c.tasks);
    expect(t.measured).not.toHaveProperty("tokensPerSuccess");
    expect(t.measured).not.toHaveProperty("varianceTokens");
    expect(t.measured).toHaveProperty("medianWallMs");
    expect(t.estimated).toBeUndefined();
    expect(c.warnings.join(" ")).toMatch(/compaction/i);
    const same = compareReports(mk("sha256:a"), mk("sha256:a"));
    expect(same.tokenComparison).toBe("comparable");
    expect(only(same.tasks).measured).toHaveProperty("tokensPerSuccess");
    expect(only(same.tasks).estimated).toBeDefined();
  });

  it("warns, but compares tokens, when a report predates the compaction identity", () => {
    const old = buildReport(runsOf("t1", outcomes(5, 5)));
    const fresh = buildReport(runsOf("t1", outcomes(5, 5), () => ({ compactionHash: "sha256:a" })));
    const c = compareReports(old, fresh);
    expect(c.tokenComparison).toBe("comparable");
    expect(c.warnings.join(" ")).toMatch(/compaction.*unknown|unknown.*compaction/i);
  });

  it("flags a k mismatch: pass^k is only comparable at equal k", () => {
    const c = compareReports(report(5, 5), report(8, 8));
    expect(only(c.tasks).kMismatch).toBe(true);
    expect(c.warnings.join(" ")).toMatch(/pass\^k/);
    expect(only(compareReports(report(5, 5), report(5, 5)).tasks).kMismatch).toBe(false);
  });

  it("does not report a configHash change that only comes from a different task subset", () => {
    const withHashes = (ids: string[]) =>
      buildReport(
        ids.flatMap((id) => runsOf(id, outcomes(5, 5), () => ({ configHash: `sha256:${id}` }))),
      );
    const a = withHashes(["t1", "t2"]);
    const b = withHashes(["t1"]);
    expect(a.conditions.configHash).not.toBe(b.conditions.configHash);
    expect(compareReports(a, b).changed.map((x) => x.field)).not.toContain("configHash");
    const other = buildReport(runsOf("t1", outcomes(5, 5), () => ({ configHash: "sha256:zzz" })));
    expect(compareReports(a, other).changed.map((x) => x.field)).toContain("configHash");
  });

  it("words the What changed section for what is and is not hashed", () => {
    const md = renderComparisonMarkdown(compareReports(report(5, 5), report(5, 5)));
    expect(md).toContain("Nothing among the hashed conditions");
    expect(md).not.toContain("declared conditions");
    expect(md).toMatch(/built-in plugin options and provider endpoint settings are not hashed/i);
  });

  it("carries the verbatim footnote with N and E in every comparison Markdown", () => {
    const a = buildReport([
      ...runsOf("t1", [...outcomes(5, 5), "error"]),
      ...runsOf("t2", outcomes(5, 5)),
    ]);
    const b = buildReport([...runsOf("t1", outcomes(5, 5)), ...runsOf("t2", outcomes(5, 5))]);
    const md = renderComparisonMarkdown(compareReports(a, b));
    expect(md).toContain(
      FOOTNOTE(2, 1, "the two reports ran separately, so time drift is not controlled"),
    );
    const v = renderVariantComparisonMarkdown(
      compareVariants([
        { id: "a", report: a },
        { id: "b", report: b },
      ]),
    );
    expect(v).toContain(
      FOOTNOTE(2, 1, "variants ran interleaved but time drift is not fully controlled"),
    );
    expect(v).not.toContain("and seeds");
    expect(v).toMatch(/same tasks; seeds only order the plan/);
  });

  it("persists each variant's overrides in the comparison and the Markdown", () => {
    const c = compareVariants([
      { id: "a", report: report(5, 5), overrides: {} },
      { id: "b", report: report(5, 5), overrides: { "compaction.threshold": 0.6 } },
    ]);
    expect(c.baselineOverrides).toEqual({});
    expect(only(c.variants).overrides).toEqual({ "compaction.threshold": 0.6 });
    expect(renderVariantComparisonMarkdown(c)).toContain("compaction.threshold");
    const fromReport = compareVariants([
      {
        id: "a",
        report: buildReport(runsOf("t1", ["pass"]), { variant: { id: "a", overrides: { x: 1 } } }),
      },
      { id: "b", report: report(5, 5) },
    ]);
    expect(fromReport.baselineOverrides).toEqual({ x: 1 });
  });
});

describe("parseReport", () => {
  it("keeps the compaction identity, variant and notes of a report", () => {
    const built = buildReport(
      runsOf("t1", ["pass"], () => ({ compactionHash: "sha256:c" })),
      {
        variant: { id: "v", overrides: { a: 1 } },
      },
    );
    const parsed = parseReport(JSON.parse(JSON.stringify(built)));
    expect(parsed.conditions.compactionHash).toBe("sha256:c");
    expect(parsed.variant).toEqual({ id: "v", overrides: { a: 1 } });
    expect(parsed.notes).toEqual(built.notes);
  });

  it("accepts what buildReport produced and rejects other shapes with an actionable message", () => {
    const built = report(3, 5);
    expect(parseReport(JSON.parse(JSON.stringify(built)))).toEqual(built);
    expect(() => parseReport({ schemaVersion: 1 })).toThrow(/report/i);
    expect(() => parseReport("nope")).toThrow(/report/i);
    expect(() => parseReport({ ...built, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });
});

// ---------------------------------------------------------------------------------------------
// Variants (D15)
// ---------------------------------------------------------------------------------------------

describe("applyConfigOverrides", () => {
  const base = configSchema.parse({});

  it("applies a dotted key of the real schema without mutating the base", () => {
    const next = applyConfigOverrides(base, { "compaction.threshold": 0.6 });
    expect(next.compaction.threshold).toBe(0.6);
    expect(base.compaction.threshold).toBe(0.85);
    expect(next.compaction.keepTurns).toBe(base.compaction.keepTurns);
  });

  it("applies several keys and leaves an empty override list untouched", () => {
    const next = applyConfigOverrides(base, {
      "compaction.threshold": 0.5,
      "limits.maxTurns": 12,
    });
    expect(next.limits.maxTurns).toBe(12);
    expect(applyConfigOverrides(base, {})).toEqual(base);
  });

  it("rejects an unknown key and names it", () => {
    expect(() => applyConfigOverrides(base, { "compaction.treshold": 0.6 })).toThrow(
      EvalVariantError,
    );
    expect(() => applyConfigOverrides(base, { "compaction.treshold": 0.6 })).toThrow(
      /compaction\.treshold/,
    );
    expect(() => applyConfigOverrides(base, { "nothing.here": 1 })).toThrow(/nothing\.here/);
    expect(() => applyConfigOverrides(base, { "context.compactionThreshold": 0.6 })).toThrow(
      /context\.compactionThreshold/,
    );
  });

  it("points at the valid keys of the same section", () => {
    expect(() => applyConfigOverrides(base, { "compaction.treshold": 0.6 })).toThrow(/threshold/);
  });

  it("rejects a descent through a scalar and prototype keys", () => {
    expect(() => applyConfigOverrides(base, { "compaction.threshold.deep": 1 })).toThrow(
      /compaction\.threshold\.deep/,
    );
    expect(() => applyConfigOverrides(base, { "__proto__.polluted": 1 })).toThrow(EvalVariantError);
    expect(() => applyConfigOverrides(base, { "": 1 })).toThrow(EvalVariantError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a value the schema refuses and names the key", () => {
    expect(() => applyConfigOverrides(base, { "compaction.threshold": 5 })).toThrow(
      /compaction\.threshold/,
    );
    expect(() => applyConfigOverrides(base, { "compaction.threshold": "high" })).toThrow(
      /compaction\.threshold/,
    );
  });

  it("rejects keys the lab never measures (provider, plugins, MCP, paths)", () => {
    for (const key of ["provider.model", "plugins", "mcp.servers", "additionalDirectories"])
      expect(() => applyConfigOverrides(base, { [key]: 1 })).toThrow(
        new RegExp(key.replace(".", "\\.")),
      );
  });

  it("changes the written config, so a variant hashes differently", () => {
    const next = applyConfigOverrides(base, { "compaction.threshold": 0.6 });
    expect(JSON.stringify(next)).not.toBe(JSON.stringify(base));
  });
});

describe("variants file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-variants-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (value: unknown) => {
    const path = join(dir, "compare.json");
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const good = {
    suite: "demo",
    variants: [
      { id: "baseline", overrides: {} },
      { id: "early", overrides: { "compaction.threshold": 0.6 } },
    ],
  };

  it("loads a valid compare.json", () => {
    expect(loadVariantsFile(write(good))).toEqual(good);
  });

  it.each([
    ["not JSON", "{nope"],
    ["no suite", { variants: good.variants }],
    ["a single variant", { suite: "demo", variants: [good.variants[0]] }],
    [
      "a duplicate id",
      {
        suite: "demo",
        variants: [
          { id: "a", overrides: {} },
          { id: "a", overrides: {} },
        ],
      },
    ],
    [
      "an unsafe id",
      {
        suite: "demo",
        variants: [
          { id: "../x", overrides: {} },
          { id: "b", overrides: {} },
        ],
      },
    ],
    ["unknown top-level field", { ...good, extra: 1 }],
  ])("rejects %s with an actionable error", (_name, value) => {
    expect(() => loadVariantsFile(write(value))).toThrow(EvalVariantError);
  });

  it("reports a missing file", () => {
    mkdirSync(join(dir, "empty"));
    expect(() => loadVariantsFile(join(dir, "missing.json"))).toThrow(/missing\.json/);
  });

  it("resolves every variant against the real schema and rejects the bad one by id and key", () => {
    const base = configSchema.parse({});
    const resolved = resolveVariants(good, base);
    expect(resolved.map((v) => v.id)).toEqual(["baseline", "early"]);
    expect(resolved[1]?.config.compaction.threshold).toBe(0.6);
    expect(resolved[0]?.config).toEqual(base);
    const bad = {
      suite: "demo",
      variants: [
        { id: "baseline", overrides: {} },
        { id: "typo", overrides: { "compaction.treshold": 0.6 } },
      ],
    };
    expect(() => resolveVariants(bad, base)).toThrow(/typo/);
    expect(() => resolveVariants(bad, base)).toThrow(/compaction\.treshold/);
  });
});

describe("compareVariants", () => {
  it("compares every variant against the first one over the same tasks", () => {
    const two = (passes: number) =>
      buildReport([...runsOf("t1", outcomes(passes, 10)), ...runsOf("t2", outcomes(10, 10))]);
    const result = compareVariants([
      { id: "baseline", report: two(0) },
      { id: "early", report: two(10) },
    ]);
    expect(result.baselineId).toBe("baseline");
    const early = only(result.variants);
    expect(early.id).toBe("early");
    expect(early.comparison.tasks.map((t) => t.taskId)).toEqual(["t1", "t2"]);
    expect(early.comparison.tasks[0]?.successRate.delta).toBe(1);
    expect(early.comparison.tasks[0]?.successRate.verdict).toBe("improved");
    expect(early.comparison.tasks[1]?.successRate.delta).toBe(0);
    expect(early.comparison.tasks[1]?.successRate.verdict).toBe("inconclusive");
  });

  it("refuses variants of different suite versions", () => {
    expect(() =>
      compareVariants([
        { id: "a", report: report(5, 5) },
        { id: "b", report: report(5, 5, { suiteVersion: "9.0.0" }) },
      ]),
    ).toThrow(EvalCompareError);
  });

  it("renders one section per candidate variant", () => {
    const md = renderVariantComparisonMarkdown(
      compareVariants([
        { id: "baseline", report: report(5, 5) },
        { id: "early", report: report(5, 5, { configHash: "sha256:bbb" }) },
        { id: "late", report: report(2, 5, { configHash: "sha256:ccc" }) },
      ]),
    );
    expect(md).toContain("baseline");
    expect(md).toContain("early");
    expect(md).toContain("late");
    expect(md).toMatch(/inconclusive/i);
  });
});
