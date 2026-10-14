/**
 * Aggregation of run records into a reliability report (specs/010 5.2, D6, D7) and its Markdown
 * rendering. Pure: no I/O.
 *
 * What the numbers mean (the review of Phase 3 starts here):
 * - A run that ended `error` is infrastructure, not a repetition of the task. It is excluded from
 *   every rate and spread and counted in `errored`. `k` of a task is its number of JUDGED runs
 *   (`pass`, `fail`, `budget_exceeded`); `budget_exceeded` is a non-pass that stays in the rate.
 * - `successRate` is passes / judged runs with a 95 % Wilson interval. `passAtK` is "at least one
 *   judged run passed", `passPowK` "every judged run passed" (false with no judged run).
 * - Spreads (median, variance) use the judged runs; the sample variance has n - 1 in the divisor.
 * - `tokensPerSuccess` / `wallMsPerSuccess` / `costUsdPerSuccess` are the TOTAL spent over all
 *   judged runs (failures included) divided by the number of successes. Token and cost totals are
 *   computed only when every judged run reported usage: a partial sum would understate them.
 * - `measured` (provider usage, wall time) and `estimated` (money from caller-supplied rates)
 *   never share a field. Without rates no cost is computed and no `estimated` key exists.
 */

import { createHash } from "node:crypto";
import type { EvalRates, EvalReport, EvalRunRecord, EvalTaskMetrics } from "@alisio/sdk";
import { median, passAtK, passPowK, sampleVariance, wilsonInterval } from "./stats.ts";

/** Fewest judged runs per task below which no improvement is claimed (specs/010 O3). */
export const MIN_POWER_K = 5;

/** Runs cannot be aggregated into one report (mixed conditions, duplicates, bad rates...). */
export class EvalReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalReportError";
  }
}

export interface BuildReportOptions {
  /** USD per million tokens. Without them no cost is computed (nothing is guessed). */
  rates?: EvalRates;
  /** Seed the runs were planned from (default: the lowest `seed` among the records). */
  seedBase?: number;
  /** Repetitions requested per task (default: the most records any one task has). */
  k?: number;
  /** The variant these runs are (`eval variants`): kept in the report with its overrides. */
  variant?: { id: string; overrides: Record<string, unknown> };
}

/** What the token figures are and are not (they feed `tokensPerSuccess`, spreads and cost). */
export const REPORT_NOTES = [
  "Token figures are main-loop tokens (excludes compaction calls): the summarizer calls of context compaction are not counted.",
  "Estimated cost is derived from those tokens at flat input/output rates; it ignores cached-input and reasoning-token pricing.",
] as const;

/** Main-loop tokens of a run; undefined when usage is missing or only some turns reported it. */
const tokensOf = (run: EvalRunRecord): number | undefined =>
  run.measured.inputTokens !== undefined &&
  run.measured.outputTokens !== undefined &&
  !run.measured.usagePartial
    ? run.measured.inputTokens + run.measured.outputTokens
    : undefined;

/** Estimated cost of one run from caller-supplied rates; undefined without reported usage. */
export function estimateRunCost(run: EvalRunRecord, rates: EvalRates): number | undefined {
  const { inputTokens, outputTokens, usagePartial } = run.measured;
  if (inputTokens === undefined || outputTokens === undefined || usagePartial) return undefined;
  return (inputTokens * rates.inputPerMTokUsd + outputTokens * rates.outputPerMTokUsd) / 1_000_000;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function assertRates(rates: EvalRates): void {
  for (const [name, value] of Object.entries(rates))
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new EvalReportError(
        `Rate ${name} must be a finite number of USD per million tokens, not negative (got ${value}).`,
      );
}

/** Fails when `field` takes more than one value across `records`. */
function assertUniform(records: EvalRunRecord[], field: keyof EvalRunRecord, hint: string): void {
  const values = [...new Set(records.map((r) => String(r[field])))];
  if (values.length > 1)
    throw new EvalReportError(
      `Cannot aggregate runs measured under different ${field}: ${values.map((v) => `"${v}"`).join(", ")}. ${hint}`,
    );
}

function taskMetrics(
  taskId: string,
  runs: EvalRunRecord[],
  rates: EvalRates | undefined,
): EvalTaskMetrics {
  const judged = runs.filter((r) => r.status !== "error");
  const errored = runs.length - judged.length;
  const successes = judged.filter((r) => r.status === "pass").length;
  const wilson = wilsonInterval(successes, judged.length);
  const wallTimes = judged.map((r) => r.measured.wallMs);
  const tokenSamples = judged.flatMap((r) => {
    const tokens = tokensOf(r);
    return tokens === undefined ? [] : [tokens];
  });
  const allReportedUsage = judged.length > 0 && tokenSamples.length === judged.length;

  const medianWallMs = median(wallTimes);
  const varianceWallMs = sampleVariance(wallTimes);
  // Same rule as tokensPerSuccess: a spread over the runs that happened to report would mislead.
  const varianceTokens = allReportedUsage ? sampleVariance(tokenSamples) : null;
  const measured: EvalTaskMetrics["measured"] = {
    ...(medianWallMs === null ? {} : { medianWallMs }),
    ...(varianceWallMs === null ? {} : { varianceWallMs }),
    ...(varianceTokens === null ? {} : { varianceTokens }),
    ...(successes > 0 && allReportedUsage
      ? { tokensPerSuccess: sum(tokenSamples) / successes }
      : {}),
    ...(successes > 0 ? { wallMsPerSuccess: sum(wallTimes) / successes } : {}),
  };

  const costs = rates ? judged.map((r) => estimateRunCost(r, rates)) : [];
  const costKnown = rates !== undefined && successes > 0 && costs.every((c) => c !== undefined);
  const hashes = [...new Set(runs.map((r) => r.configHash))];

  return {
    taskId,
    k: judged.length,
    successRate: {
      value: judged.length === 0 ? 0 : successes / judged.length,
      wilsonLow: wilson.low,
      wilsonHigh: wilson.high,
    },
    passAtK: passAtK(judged.map((r) => r.status === "pass")),
    passPowK: passPowK(judged.map((r) => r.status === "pass")),
    ...(errored > 0 ? { errored } : {}),
    ...(hashes.length === 1 ? { configHash: hashes[0] as string } : {}),
    measured,
    ...(costKnown ? { estimated: { costUsdPerSuccess: sum(costs as number[]) / successes } } : {}),
  };
}

/**
 * Report over `records`, which must come from one suite version, one model, one mode and one
 * provider/harness version. `configHash` also covers each task's own policy and budget, so it may
 * differ between tasks but never between repetitions of one task; the report's
 * `conditions.configHash` is then the hash of the sorted `taskId -> configHash` pairs (equal to the
 * shared value when every task has the same one).
 */
export function buildReport(
  records: EvalRunRecord[],
  options: BuildReportOptions = {},
): EvalReport {
  const first = records[0];
  if (!first) throw new EvalReportError("Cannot build a report from zero runs.");
  if (options.rates) assertRates(options.rates);

  const ids = new Set<string>();
  for (const run of records) {
    if (ids.has(run.runId))
      throw new EvalReportError(`Duplicate run ${run.runId}: a run can be aggregated only once.`);
    ids.add(run.runId);
  }
  const hint = "Aggregate runs of one configuration; compare two reports with `eval compare`.";
  for (const field of [
    "suiteId",
    "suiteVersion",
    "model",
    "mode",
    "provider",
    "harnessVersion",
    "compactionHash",
  ] as const)
    assertUniform(records, field, hint);

  const byTask = new Map<string, EvalRunRecord[]>();
  for (const run of records) {
    const group = byTask.get(run.taskId);
    if (group) group.push(run);
    else byTask.set(run.taskId, [run]);
  }
  for (const [taskId, runs] of byTask)
    assertUniform(
      runs,
      "configHash",
      `Repetitions of task "${taskId}" must share one configuration.`,
    );

  const sorted = [...byTask].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const tasks = sorted.map(([taskId, runs]) => taskMetrics(taskId, runs, options.rates));
  const taskHashes = sorted.map(
    ([taskId, runs]) => [taskId, (runs[0] as EvalRunRecord).configHash] as const,
  );
  const distinct = new Set(taskHashes.map(([, hash]) => hash));
  const configHash =
    distinct.size === 1
      ? (taskHashes[0] as readonly [string, string])[1]
      : `sha256:${createHash("sha256").update(JSON.stringify(taskHashes)).digest("hex")}`;

  const count = (status: EvalRunRecord["status"]) =>
    records.filter((r) => r.status === status).length;
  return {
    schemaVersion: 1,
    suiteId: first.suiteId,
    suiteVersion: first.suiteVersion,
    conditions: {
      harnessVersion: first.harnessVersion,
      configHash,
      provider: first.provider,
      model: first.model,
      mode: first.mode,
      k: options.k ?? Math.max(...[...byTask.values()].map((runs) => runs.length)),
      seedBase: options.seedBase ?? Math.min(...records.map((r) => r.seed)),
      ...(first.compactionHash ? { compactionHash: first.compactionHash } : {}),
    },
    ...(options.variant
      ? { variant: { id: options.variant.id, overrides: { ...options.variant.overrides } } }
      : {}),
    notes: [...REPORT_NOTES],
    tasks,
    runs: records.map((r) => r.runId),
    summary: {
      tasks: tasks.length,
      passed: count("pass"),
      errored: count("error"),
      budgetExceeded: count("budget_exceeded"),
      runs: records.length,
      failed: count("fail"),
    },
    ...(options.rates ? { rates: { ...options.rates } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;
const seconds = (ms: number) => `${(Math.round(ms / 10) / 100).toFixed(2)} s`;
const count = (value: number) => Math.round(value).toLocaleString("en-US");
const optional = (value: number | undefined, format: (v: number) => string) =>
  value === undefined ? "-" : format(value);
const sd = (variance: number | undefined, format: (v: number) => string) =>
  variance === undefined ? "-" : format(Math.sqrt(variance));

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/** Tasks whose judged runs fall below the power threshold. */
export function lowPowerTasks(report: EvalReport): EvalTaskMetrics[] {
  return report.tasks.filter((t) => t.k < MIN_POWER_K);
}

/** Markdown of a report: conditions, warnings, then Measured and Estimated as separate sections. */
export function renderReportMarkdown(report: EvalReport): string {
  const { conditions: c } = report;
  const lines: string[] = [
    `# Reliability report: ${report.suiteId} ${report.suiteVersion}`,
    "",
    `- Suite: \`${report.suiteId}\` version \`${report.suiteVersion}\``,
    `- Mode: **${c.mode}**`,
    `- Provider / model: \`${c.provider}\` / \`${c.model}\``,
    `- Harness version: \`${c.harnessVersion}\``,
    `- Configuration hash: \`${c.configHash}\``,
    `- Repetitions per task (k): ${c.k}; seed base: ${c.seedBase}`,
    "",
  ];
  lines.push(
    c.mode === "replay"
      ? "> Replay measures the harness, not the model: the provider answers come from a recording, so this says nothing about model quality."
      : "> Live is not deterministic: the model can answer differently on every run. Repetitions and Wilson intervals estimate the noise; they do not remove it.",
    "",
  );
  const weak = lowPowerTasks(report);
  if (weak.length > 0)
    lines.push(
      `> **Low power:** ${weak.map((t) => `${t.taskId} (k=${t.k})`).join(", ")} ${
        weak.length === 1 ? "has" : "have"
      } fewer than ${MIN_POWER_K} judged runs. The intervals are wide; do not read an improvement or a regression from these numbers.`,
      "",
    );
  const { summary: s } = report;
  lines.push(
    `Runs: ${s.runs ?? report.runs.length} (passed ${s.passed}, failed ${s.failed ?? "-"}, budget exceeded ${s.budgetExceeded}, errored ${s.errored}). Errored runs are infrastructure failures: they are excluded from every rate and spread below.`,
    "",
    "## Measured",
    "",
    "Provider-reported usage and wall time. Success is passes over judged runs, with a 95% Wilson interval; sd is the square root of the sample variance. Token figures are main-loop tokens (excludes compaction calls).",
    "",
    table(
      [
        "Task",
        "k",
        "Success [Wilson 95%]",
        "pass@k",
        "pass^k",
        "Errored",
        "Median wall",
        "Wall sd",
        "Tokens sd",
        "Tokens / success",
        "Wall / success",
      ],
      report.tasks.map((t) => [
        cell(t.taskId),
        String(t.k),
        t.k === 0
          ? "n/a"
          : `${percent(t.successRate.value)} [${percent(t.successRate.wilsonLow)}, ${percent(t.successRate.wilsonHigh)}]`,
        t.passAtK ? "yes" : "no",
        t.passPowK ? "yes" : "no",
        String(t.errored ?? 0),
        optional(t.measured.medianWallMs, seconds),
        sd(t.measured.varianceWallMs, seconds),
        sd(t.measured.varianceTokens, count),
        optional(t.measured.tokensPerSuccess, count),
        optional(t.measured.wallMsPerSuccess, seconds),
      ]),
    ),
    "",
    "## Estimated",
    "",
  );
  if (!report.rates)
    lines.push("Not computed: no rates were supplied, and Alisio does not guess prices.");
  else {
    lines.push(
      `Derived from the measured main-loop tokens (excludes compaction calls) at ${report.rates.inputPerMTokUsd} USD per million input tokens and ${report.rates.outputPerMTokUsd} USD per million output tokens (rates supplied by the caller). Cached-input and reasoning-token pricing are ignored. A task shows "-" when a run did not report usage on every turn or nothing succeeded.`,
      "",
      table(
        ["Task", "Cost per success (USD)"],
        report.tasks.map((t) => [
          cell(t.taskId),
          optional(t.estimated?.costUsdPerSuccess, (v) => `$${v.toFixed(4)}`),
        ]),
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
