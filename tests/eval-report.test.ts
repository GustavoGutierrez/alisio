/** Reliability lab Phase 3: aggregation of run records into a report (specs/010 5.2, D6, D7). */
import type { EvalReport } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  buildReport,
  EvalReportError,
  renderReportMarkdown,
} from "../packages/core/src/eval/report.ts";
import { sampleVariance, wilsonInterval } from "../packages/core/src/eval/stats.ts";
import { record, runsOf } from "./eval-helpers.ts";

const task = (report: EvalReport, id = "t1") => {
  const found = report.tasks.find((t) => t.taskId === id);
  if (!found) throw new Error(`no task ${id}`);
  return found;
};

describe("buildReport: per-task metrics (D6)", () => {
  it("computes the success rate with its Wilson interval, pass@k and pass^k", () => {
    const report = buildReport(runsOf("t1", ["pass", "pass", "pass", "fail", "fail"]));
    const t = task(report);
    const wilson = wilsonInterval(3, 5);
    expect(t.k).toBe(5);
    expect(t.successRate.value).toBeCloseTo(0.6, 10);
    expect(t.successRate.wilsonLow).toBeCloseTo(wilson.low, 10);
    expect(t.successRate.wilsonHigh).toBeCloseTo(wilson.high, 10);
    expect(t.passAtK).toBe(true);
    expect(t.passPowK).toBe(false);
  });

  it("passes pass^k only when every repetition passed", () => {
    const t = task(buildReport(runsOf("t1", ["pass", "pass", "pass"])));
    expect(t.passAtK).toBe(true);
    expect(t.passPowK).toBe(true);
  });

  it("computes median and sample variance of wall time, and variance of tokens", () => {
    const report = buildReport(runsOf("t1", ["pass", "fail", "pass", "pass"]));
    const t = task(report);
    // wall times 1000, 2000, 3000, 4000
    expect(t.measured.medianWallMs).toBe(2500);
    expect(t.measured.varianceWallMs).toBeCloseTo(
      sampleVariance([1000, 2000, 3000, 4000]) as number,
      6,
    );
    // tokens (input + output) 1100, 2100, 3100, 4100
    expect(t.measured.varianceTokens).toBeCloseTo(
      sampleVariance([1100, 2100, 3100, 4100]) as number,
      6,
    );
  });

  it("charges every judged run to the successes: tokens and wall time per success", () => {
    const t = task(buildReport(runsOf("t1", ["pass", "fail", "pass", "fail"])));
    // 2 successes; tokens 1100 + 2100 + 3100 + 4100 = 10400; wall 1000 + 2000 + 3000 + 4000 = 10000
    expect(t.measured.tokensPerSuccess).toBe(5200);
    expect(t.measured.wallMsPerSuccess).toBe(5000);
  });

  it("omits per-success figures when there is no success", () => {
    const t = task(buildReport(runsOf("t1", ["fail", "fail"])));
    expect(t.measured).not.toHaveProperty("tokensPerSuccess");
    expect(t.measured).not.toHaveProperty("wallMsPerSuccess");
  });

  it("omits token figures when a judged run did not report usage (never partial sums)", () => {
    const runs = runsOf("t1", ["pass", "pass", "pass"], (i) =>
      i === 1 ? { measured: { wallMs: 5000, turns: 1, toolCalls: 0 } } : {},
    );
    const t = task(buildReport(runs));
    expect(t.measured).not.toHaveProperty("tokensPerSuccess");
    // Same rule for the spread: a variance over the runs that happened to report would mislead.
    expect(t.measured).not.toHaveProperty("varianceTokens");
    expect(t.measured.wallMsPerSuccess).toBeCloseTo(9000 / 3, 6);
  });

  it("omits what needs more samples instead of inventing it (null from stats)", () => {
    const one = task(buildReport(runsOf("t1", ["pass"])));
    expect(one.measured.medianWallMs).toBe(1000);
    expect(one.measured).not.toHaveProperty("varianceWallMs");
    expect(one.measured).not.toHaveProperty("varianceTokens");
    const none = task(buildReport(runsOf("t1", ["error", "error"])));
    expect(none.k).toBe(0);
    expect(none.measured).toEqual({});
    expect(none.passAtK).toBe(false);
    expect(none.passPowK).toBe(false);
    expect(none.successRate).toEqual({ value: 0, wilsonLow: 0, wilsonHigh: 1 });
  });
});

describe("buildReport: partial usage, compaction identity, notes", () => {
  it("treats a run with partial usage as not reported: no token figures, no cost", () => {
    const runs = runsOf("t1", ["pass", "pass", "pass"], (i) =>
      i === 1
        ? {
            measured: {
              inputTokens: 5,
              outputTokens: 5,
              usagePartial: true,
              wallMs: 5000,
              turns: 2,
              toolCalls: 0,
            },
          }
        : {},
    );
    const t = task(buildReport(runs, { rates: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } }));
    expect(t.measured).not.toHaveProperty("tokensPerSuccess");
    expect(t.measured).not.toHaveProperty("varianceTokens");
    expect(t).not.toHaveProperty("estimated");
  });

  it("carries the compaction identity of the runs into conditions", () => {
    const report = buildReport(
      runsOf("t1", ["pass", "pass"], () => ({ compactionHash: "sha256:cc" })),
    );
    expect(report.conditions.compactionHash).toBe("sha256:cc");
    expect(buildReport(runsOf("t1", ["pass"])).conditions).not.toHaveProperty("compactionHash");
  });

  it("refuses to aggregate runs measured under different compaction settings", () => {
    const runs = [
      ...runsOf("t1", ["pass"], () => ({ compactionHash: "sha256:a" })),
      ...runsOf("t2", ["pass"], () => ({ compactionHash: "sha256:b" })),
    ];
    expect(() => buildReport(runs)).toThrow(EvalReportError);
  });

  it("labels token metrics as main-loop tokens that exclude compaction calls (JSON and Markdown)", () => {
    const report = buildReport(runsOf("t1", ["pass", "pass"]), {
      rates: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
    });
    expect(report.notes?.join(" ")).toMatch(/main-loop tokens \(excludes compaction calls\)/);
    expect(report.notes?.join(" ")).toMatch(/cached|reasoning/i);
    const markdown = renderReportMarkdown(report);
    expect(markdown).toMatch(/main-loop tokens \(excludes compaction calls\)/);
    expect(markdown).toContain("estimate the noise");
    expect(markdown).not.toContain("bound the noise");
  });

  it("persists the variant id and overrides when given", () => {
    const report = buildReport(runsOf("t1", ["pass"]), {
      variant: { id: "b", overrides: { "compaction.threshold": 0.6 } },
    });
    expect(report.variant).toEqual({ id: "b", overrides: { "compaction.threshold": 0.6 } });
    expect(buildReport(runsOf("t1", ["pass"]))).not.toHaveProperty("variant");
  });
});

describe("buildReport: errored and budget runs", () => {
  it("excludes errored runs from rates and spreads and counts them", () => {
    const runs = [
      ...runsOf("t1", ["pass", "pass", "error"], (i) =>
        i === 2 ? { measured: { wallMs: 999_999, turns: 0, toolCalls: 0 } } : {},
      ),
      ...runsOf("t2", ["pass", "fail"]),
    ];
    const report = buildReport(runs);
    const t = task(report);
    expect(t.k).toBe(2);
    expect(t.errored).toBe(1);
    expect(t.successRate.value).toBe(1);
    expect(t.measured.medianWallMs).toBe(1500);
    expect(task(report, "t2")).not.toHaveProperty("errored");
    expect(report.summary).toEqual({
      tasks: 2,
      passed: 3,
      errored: 1,
      budgetExceeded: 0,
      runs: 5,
      failed: 1,
    });
    expect(report.runs).toHaveLength(5);
  });

  it("counts budget_exceeded as a non-pass, kept in the rate", () => {
    const report = buildReport(runsOf("t1", ["pass", "budget_exceeded", "pass", "pass", "pass"]));
    const t = task(report);
    expect(t.k).toBe(5);
    expect(t.successRate.value).toBeCloseTo(0.8, 10);
    expect(t.passPowK).toBe(false);
    expect(report.summary.budgetExceeded).toBe(1);
    expect(report.summary.passed).toBe(4);
  });
});

describe("buildReport: measured and estimated are separate (D7)", () => {
  const json = (value: unknown) => JSON.stringify(value);

  it("without rates there is no costUsd and no estimated block anywhere", () => {
    const report = buildReport(runsOf("t1", ["pass", "pass", "fail"]));
    expect(json(report)).not.toContain("costUsd");
    expect(json(report)).not.toContain("estimated");
    expect(report).not.toHaveProperty("rates");
  });

  it("with rates, cost lives only in estimated and the rates are echoed", () => {
    const rates = { inputPerMTokUsd: 2, outputPerMTokUsd: 10 };
    const report = buildReport(runsOf("t1", ["pass", "fail"]), { rates });
    // run 0: 1000 in + 100 out = 0.002 + 0.001; run 1: 2000 in + 100 out = 0.004 + 0.001
    const t = task(report);
    expect(t.estimated?.costUsdPerSuccess).toBeCloseTo(0.008, 9);
    expect(report.rates).toEqual(rates);
    for (const metrics of report.tasks) {
      expect(Object.keys(metrics.measured).filter((key) => /cost|estimated/i.test(key))).toEqual(
        [],
      );
      expect(json(metrics.measured)).not.toContain("costUsd");
    }
  });

  it("omits the cost of a task whose judged runs did not all report usage", () => {
    const rates = { inputPerMTokUsd: 2, outputPerMTokUsd: 10 };
    const runs = runsOf("t1", ["pass", "pass"], (i) =>
      i === 1 ? { measured: { wallMs: 1, turns: 1, toolCalls: 0 } } : {},
    );
    expect(task(buildReport(runs, { rates })).estimated).toBeUndefined();
  });

  it("never reads a cost a record already carries when no rates were supplied", () => {
    const runs = runsOf("t1", ["pass", "pass"], () => ({ estimated: { costUsd: 9 } }));
    expect(json(buildReport(runs))).not.toContain("costUsd");
  });

  it("rejects negative or non-finite rates", () => {
    expect(() =>
      buildReport(runsOf("t1", ["pass"]), {
        rates: { inputPerMTokUsd: -1, outputPerMTokUsd: 1 },
      }),
    ).toThrow(EvalReportError);
  });
});

describe("buildReport: conditions", () => {
  it("records the conditions the runs share", () => {
    const report = buildReport(runsOf("t1", ["pass", "pass"]), { seedBase: 100, k: 5 });
    expect(report.suiteId).toBe("demo");
    expect(report.suiteVersion).toBe("1.0.0");
    expect(report.conditions).toEqual({
      harnessVersion: "0.6.0",
      configHash: "sha256:aaa",
      provider: "fake",
      model: "fake-model",
      mode: "live",
      k: 5,
      seedBase: 100,
    });
  });

  it.each([
    ["suiteId", { suiteId: "other" }],
    ["suiteVersion", { suiteVersion: "2.0.0" }],
    ["model", { model: "other-model" }],
    ["mode", { mode: "replay" as const }],
    ["provider", { provider: "other" }],
    ["harnessVersion", { harnessVersion: "0.7.0" }],
  ])("refuses to aggregate records with mixed %s", (field, change) => {
    const runs = [...runsOf("t1", ["pass"]), ...runsOf("t2", ["pass"], () => change)];
    expect(() => buildReport(runs)).toThrow(EvalReportError);
    expect(() => buildReport(runs)).toThrow(new RegExp(field));
  });

  it("refuses repetitions of one task measured under different configHash", () => {
    const runs = runsOf("t1", ["pass", "pass"], (i) =>
      i === 1 ? { configHash: "sha256:bbb" } : {},
    );
    expect(() => buildReport(runs)).toThrow(/configHash/);
  });

  it("accepts different configHash across tasks (policy and budget are per task) and derives a stable combined one", () => {
    const runs = [
      ...runsOf("t1", ["pass"], () => ({ configHash: "sha256:aaa" })),
      ...runsOf("t2", ["pass"], () => ({ configHash: "sha256:bbb" })),
    ];
    const a = buildReport(runs);
    const b = buildReport([...runs].reverse());
    expect(a.conditions.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.conditions.configHash).toBe(b.conditions.configHash);
    expect(task(a, "t1").configHash).toBe("sha256:aaa");
    expect(task(a, "t2").configHash).toBe("sha256:bbb");
    const same = buildReport([
      ...runsOf("t1", ["pass"], () => ({ configHash: "sha256:aaa" })),
      ...runsOf("t2", ["pass"], () => ({ configHash: "sha256:aaa" })),
    ]);
    expect(same.conditions.configHash).toBe("sha256:aaa");
  });

  it("refuses an empty set and a duplicated run id", () => {
    expect(() => buildReport([])).toThrow(EvalReportError);
    const one = record();
    expect(() => buildReport([one, one])).toThrow(/duplicate/i);
  });

  it("lists tasks sorted by id whatever order the runs arrived in", () => {
    const runs = [...runsOf("b", ["pass"]), ...runsOf("a", ["pass"]), ...runsOf("c", ["pass"])];
    expect(buildReport(runs).tasks.map((t) => t.taskId)).toEqual(["a", "b", "c"]);
  });

  it("defaults k to the largest repetition count and seedBase to the lowest seed", () => {
    const report = buildReport([
      ...runsOf("t1", ["pass", "pass", "error"], (i) => ({ seed: 50 + i })),
      ...runsOf("t2", ["pass"], () => ({ seed: 50 })),
    ]);
    expect(report.conditions.k).toBe(3);
    expect(report.conditions.seedBase).toBe(50);
  });
});

describe("renderReportMarkdown", () => {
  const live = buildReport(runsOf("t1", ["pass", "pass", "pass", "pass", "pass"]));

  it("names the suite, version and mode in the header and says live is not deterministic", () => {
    const md = renderReportMarkdown(live);
    expect(md).toMatch(/^# .*demo/m);
    expect(md).toContain("1.0.0");
    expect(md).toMatch(/mode:? \*?\*?live/i);
    expect(md).toMatch(/not deterministic/i);
    expect(md).not.toMatch(/measures the harness, not the model/i);
  });

  it("states that replay measures the harness, not the model", () => {
    const replay = buildReport(runsOf("t1", ["pass"], () => ({ mode: "replay" as const })));
    const md = renderReportMarkdown(replay);
    expect(md).toMatch(/replay measures the harness, not the model/i);
    expect(md).not.toMatch(/not deterministic/i);
  });

  it("warns about low power when a task has fewer than 5 judged runs, not at 5", () => {
    expect(renderReportMarkdown(live)).not.toMatch(/low power/i);
    const few = buildReport(runsOf("t1", ["pass", "pass", "pass"]));
    const md = renderReportMarkdown(few);
    expect(md).toMatch(/low power/i);
    expect(md).toContain("t1");
    // Errored runs shrink the effective k.
    const errored = buildReport(runsOf("t1", ["pass", "pass", "pass", "pass", "pass", "error"]));
    expect(renderReportMarkdown(errored)).not.toMatch(/low power/i);
    const shrunk = buildReport(runsOf("t1", ["pass", "pass", "pass", "pass", "error"]));
    expect(renderReportMarkdown(shrunk)).toMatch(/low power/i);
  });

  it("renders separate Measured and Estimated sections", () => {
    const md = renderReportMarkdown(live);
    const measured = md.indexOf("## Measured");
    const estimated = md.indexOf("## Estimated");
    expect(measured).toBeGreaterThan(-1);
    expect(estimated).toBeGreaterThan(measured);
    expect(md.slice(estimated)).toMatch(/not computed|no rates/i);
    expect(md.slice(measured, estimated)).not.toMatch(/cost/i);
    expect(md).toContain("Wilson");
  });

  it("puts cost in the Estimated table when rates were supplied", () => {
    const rates = { inputPerMTokUsd: 2, outputPerMTokUsd: 10 };
    const md = renderReportMarkdown(buildReport(runsOf("t1", ["pass", "pass"]), { rates }));
    const estimated = md.slice(md.indexOf("## Estimated"));
    expect(estimated).toMatch(/\$0\.\d+/);
    expect(estimated).toContain("2");
    expect(md.slice(0, md.indexOf("## Estimated"))).not.toMatch(/\$0\./);
  });

  it("reports errored runs and escapes table cells", () => {
    const report = buildReport([...runsOf("a|b", ["pass", "error"])]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("a\\|b");
    expect(md).toMatch(/errored/i);
  });
});
