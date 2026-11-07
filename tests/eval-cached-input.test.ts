/**
 * Provider `cachedInput` in the reliability lab (specs/012 protocol v2): usage turn events -> run
 * record (`measured.cachedInputTokens`) -> report aggregation (per task and per arm) -> compare.
 * The rule everywhere: absent means "the provider did not report it", never 0; no ratio is
 * computed from runs that did not report it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunRecord } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CassetteRecorder } from "../packages/core/src/eval/cassette.ts";
import {
  compareReports,
  parseReport,
  renderComparisonMarkdown,
} from "../packages/core/src/eval/compare.ts";
import {
  type InvokerPermissions,
  type RunTaskOptions,
  runTask,
} from "../packages/core/src/eval/engine.ts";
import { buildReport, renderReportMarkdown } from "../packages/core/src/eval/report.ts";
import { configSchema } from "../packages/core/src/index.ts";
import { makeSuite, record, type ScriptedTurn, scriptedProvider, task } from "./eval-helpers.ts";

const ALL: InvokerPermissions = { write: true, process: true, external: true, analysis: true };
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "eval-cached-test-")));
  mkdirSync(join(root, "runs"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function runWith(turns: ScriptedTurn[]): Promise<EvalRunRecord> {
  const t = task();
  const opts: RunTaskOptions = {
    suite: makeSuite(root, [t], { "a.txt": "hello\n" }),
    provider: scriptedProvider(turns),
    config: configSchema.parse({}),
    seed: 1,
    repetition: 0,
    invoker: ALL,
    tmpRoot: join(root, "runs"),
  };
  return (await runTask(t, opts)).record;
}
const read = { name: "read_file", args: { path: "a.txt" } };

describe("run record: measured.cachedInputTokens", () => {
  it("sums the cached tokens the provider reported on every turn", async () => {
    const r = await runWith([
      { calls: [read], usage: { input: 100, output: 5, cachedInput: 40 } },
      { text: "done", usage: { input: 150, output: 5, cachedInput: 120 } },
    ]);
    expect(r.measured.inputTokens).toBe(250);
    expect(r.measured.cachedInputTokens).toBe(160);
    expect(r.measured.cachedPartial).toBeUndefined();
  });

  it("keeps an explicit 0 from the provider (a report), distinct from no report", async () => {
    const r = await runWith([{ text: "done", usage: { input: 100, output: 5, cachedInput: 0 } }]);
    expect(r.measured.cachedInputTokens).toBe(0);
  });

  it("stays ABSENT (not 0) when the provider reports usage without cachedInput", async () => {
    const r = await runWith([{ text: "done", usage: { input: 100, output: 5 } }]);
    expect(r.measured.inputTokens).toBe(100);
    expect(r.measured).not.toHaveProperty("cachedInputTokens");
    expect(r.measured).not.toHaveProperty("cachedPartial");
  });

  it("stays absent when there is no usage at all", async () => {
    const r = await runWith([{ text: "done" }]);
    expect(r.measured).not.toHaveProperty("cachedInputTokens");
  });

  it("marks the sum partial when only SOME turns reported cachedInput", async () => {
    const r = await runWith([
      { calls: [read], usage: { input: 100, output: 5, cachedInput: 40 } },
      { text: "done", usage: { input: 150, output: 5 } },
    ]);
    expect(r.measured.cachedInputTokens).toBe(40);
    expect(r.measured.cachedPartial).toBe(true);
  });
});

describe("cassettes: cachedInput survives record and replay deterministically", () => {
  it("replays the recorded cached tokens, and a cassette without them replays without them", async () => {
    for (const cached of [40, undefined]) {
      const t = task();
      const base = (extra: Partial<RunTaskOptions>): RunTaskOptions => ({
        suite: makeSuite(root, [t], { "a.txt": "hello\n" }),
        config: configSchema.parse({}),
        seed: 1,
        repetition: 0,
        invoker: ALL,
        tmpRoot: join(root, "runs"),
        ...extra,
      });
      const recorder = new CassetteRecorder();
      const usage = {
        input: 100,
        output: 5,
        ...(cached === undefined ? {} : { cachedInput: cached }),
      };
      const live = (
        await runTask(
          t,
          base({
            mode: "record",
            cassette: recorder,
            provider: scriptedProvider([
              { calls: [read], usage },
              { text: "done", usage },
            ]),
          }),
        )
      ).record;
      const cassette = recorder.toCassette({
        suiteId: "demo",
        taskId: t.id,
        harnessVersion: live.harnessVersion,
        configHash: live.configHash,
        recordedAt: 0,
        provider: live.provider,
        model: live.model,
      });
      const replayed = (await runTask(t, base({ mode: "replay", cassette }))).record;
      expect(replayed.status).toBe("pass");
      expect(replayed.measured.cachedInputTokens).toBe(live.measured.cachedInputTokens);
      expect(live.measured.cachedInputTokens).toBe(cached === undefined ? undefined : cached * 2);
      if (cached === undefined) expect(replayed.measured).not.toHaveProperty("cachedInputTokens");
    }
  });
});

/** A judged run with the given input and cached tokens (cached undefined = not reported). */
const run = (
  taskId: string,
  input: number,
  cached: number | undefined,
  extra: Partial<EvalRunRecord> = {},
) =>
  record({
    taskId,
    measured: {
      inputTokens: input,
      outputTokens: 10,
      ...(cached === undefined ? {} : { cachedInputTokens: cached }),
      wallMs: 1000,
      turns: 2,
      toolCalls: 1,
    },
    ...extra,
  });

describe("report: cachedInput per task and per arm", () => {
  it("computes sum and ratio over the runs that reported it, with the count", () => {
    const report = buildReport([run("t1", 1000, 600), run("t1", 3000, 600), run("t2", 2000, 1000)]);
    expect(report.summary.cachedInput).toEqual({
      tokens: 2200,
      inputTokens: 6000,
      ratio: 2200 / 6000,
      runsReporting: 3,
      runsJudged: 3,
    });
    const t1 = report.tasks.find((t) => t.taskId === "t1");
    expect(t1?.measured.cachedInputRatio).toBeCloseTo(1200 / 4000, 12);
    expect(t1?.measured.cachedInputRuns).toBe(2);
  });

  it("pools by tokens, not by averaging run ratios", () => {
    const report = buildReport([run("t1", 100, 100), run("t1", 9900, 0)]);
    expect(report.summary.cachedInput?.ratio).toBeCloseTo(100 / 10000, 12);
  });

  it("omits everything when no run reported it: no ratio, no zero", () => {
    const report = buildReport([run("t1", 1000, undefined), run("t1", 1000, undefined)]);
    expect(report.summary).not.toHaveProperty("cachedInput");
    expect(report.tasks[0]?.measured).not.toHaveProperty("cachedInputRatio");
    expect(report.tasks[0]?.measured).not.toHaveProperty("cachedInputRuns");
  });

  it("mixed arm: the ratio uses only the reporting runs and says how many did", () => {
    const report = buildReport([
      run("t1", 1000, 500),
      run("t1", 5000, undefined),
      run("t1", 1000, 100),
    ]);
    expect(report.summary.cachedInput).toMatchObject({
      tokens: 600,
      inputTokens: 2000,
      ratio: 0.3,
      runsReporting: 2,
      runsJudged: 3,
    });
  });

  it("ignores partial sums, partial usage and errored runs", () => {
    const report = buildReport([
      run("t1", 1000, 500),
      run("t1", 1000, 900, {
        measured: {
          inputTokens: 1000,
          outputTokens: 1,
          cachedInputTokens: 900,
          cachedPartial: true,
          wallMs: 1,
          turns: 1,
          toolCalls: 0,
        },
      }),
      run("t1", 1000, 900, {
        measured: {
          inputTokens: 1000,
          outputTokens: 1,
          usagePartial: true,
          cachedInputTokens: 900,
          wallMs: 1,
          turns: 1,
          toolCalls: 0,
        },
      }),
      run("t1", 1000, 900, { status: "error" }),
    ]);
    expect(report.summary.cachedInput).toMatchObject({
      tokens: 500,
      inputTokens: 1000,
      runsReporting: 1,
      runsJudged: 3,
    });
  });

  it("renders the measured figure in the Markdown and says when it is not reported", () => {
    const withIt = renderReportMarkdown(buildReport([run("t1", 1000, 250)]));
    expect(withIt).toContain("Cached input");
    expect(withIt).toContain("25%");
    const without = renderReportMarkdown(buildReport([run("t1", 1000, undefined)]));
    expect(without).toMatch(/Cached input.*not reported/i);
  });
});

describe("compare: cachedInput ratio is a plain delta", () => {
  const arm = (cached: number | undefined) =>
    buildReport([run("t1", 1000, cached), run("t1", 1000, cached)]);

  it("computes candidate minus baseline when both sides reported it", () => {
    const c = compareReports(arm(800), arm(400));
    const d = c.tasks[0]?.measured.cachedInputRatio;
    expect(d?.baseline).toBeCloseTo(0.8, 12);
    expect(d?.candidate).toBeCloseTo(0.4, 12);
    expect(d?.delta).toBeCloseTo(-0.4, 12);
    expect(renderComparisonMarkdown(c)).toContain("Cached input ratio");
  });

  it("computes nothing when either side did not report it", () => {
    expect(compareReports(arm(800), arm(undefined)).tasks[0]?.measured).not.toHaveProperty(
      "cachedInputRatio",
    );
  });

  it("survives a report.json round trip (additive fields are not stripped)", () => {
    const original = arm(300);
    const parsed = parseReport(JSON.parse(JSON.stringify(original)));
    expect(parsed.summary.cachedInput).toEqual(original.summary.cachedInput);
    expect(parsed.tasks[0]?.measured.cachedInputRatio).toBe(
      original.tasks[0]?.measured.cachedInputRatio,
    );
  });

  it("an old report without the fields still parses and compares", () => {
    const old = JSON.parse(JSON.stringify(arm(undefined)));
    expect(() => compareReports(parseReport(old), parseReport(old))).not.toThrow();
  });
});
