/**
 * Comparison of two reliability reports and of config variants (specs/010 D7, D14, D15, O3).
 * Pure: no I/O.
 *
 * Statistical rules (the review of Phase 3 starts here):
 * - Only reports of the same `suiteId` AND `suiteVersion` are comparable (typed error otherwise).
 * - Success rates are compared through their 95 % Wilson intervals. The comparison is
 *   `inconclusive` when the closed intervals overlap (touching counts as overlap) and `low_power`
 *   when either side has fewer than 5 judged runs (`MIN_POWER_K`) even if the intervals are
 *   disjoint. `improved` / `regressed` appear only when both sides have k >= 5 and the intervals
 *   are disjoint. This is a conservative non-overlap rule, not a hypothesis test: it is stricter
 *   than a 5 % test, so it misses real differences instead of inventing them. No multiplicity
 *   correction is applied across tasks.
 * - No direction is claimed when the comparison is not like for like: either side has errored runs
 *   (the judged runs are then a filtered sample), the modes differ, or (replay) the repetitions
 *   are identical so an interval means nothing; replay reports get `changed` / `unchanged` only.
 * - Token and cost deltas are refused when the compaction settings differ: compaction calls are
 *   not in the measured tokens, so the two sides would not count the same work.
 * - Nothing is paired: the seed only orders the run plan and never reaches the provider, so the
 *   two sides are independent samples and the unpaired intervals are the model.
 * - Every other measured metric gets a plain delta (candidate - baseline) with no direction label:
 *   they have no interval here, so no claim is made about them.
 * - Deltas are computed inside `measured` and inside `estimated` and never across them. Costs are
 *   compared only when both reports carry the same rates.
 */

import { createHash } from "node:crypto";
import type { EvalRates, EvalReport, EvalTaskMetrics } from "@alisio/sdk";
import { z } from "zod";
import { MIN_POWER_K } from "./report.ts";

export class EvalCompareError extends Error {
  constructor(
    message: string,
    readonly reason: "suite_id" | "suite_version",
  ) {
    super(message);
    this.name = "EvalCompareError";
  }
}

export type Conditions = EvalReport["conditions"];
export type Verdict =
  | "improved"
  | "regressed"
  | "inconclusive"
  | "low_power"
  | "not comparable: errored runs"
  | "not comparable: mode differs"
  /** Replay only: the pass status or a measured count differs / does not. */
  | "changed"
  | "unchanged";

export type TokenComparison = "comparable" | "not comparable: compaction settings differ";

export interface MetricDelta {
  baseline: number;
  candidate: number;
  /** candidate - baseline */
  delta: number;
}

export interface Interval {
  value: number;
  /** Absent for replay reports: identical repetitions give an interval no meaning. */
  wilsonLow?: number;
  wilsonHigh?: number;
}

const CHANGED_FIELDS = ["configHash", "model", "harnessVersion", "mode", "provider"] as const;
const MEASURED_KEYS = [
  "medianWallMs",
  "varianceWallMs",
  "varianceTokens",
  "tokensPerSuccess",
  "wallMsPerSuccess",
] as const;
type MeasuredKey = (typeof MEASURED_KEYS)[number];

export interface TaskComparison {
  taskId: string;
  /** Judged runs on each side. */
  k: { baseline: number; candidate: number };
  /** Either side has fewer than 5 judged runs. */
  lowPower: boolean;
  /** The judged-run counts differ, so pass^k is not comparable between the two sides. */
  kMismatch: boolean;
  /** Runs excluded as infrastructure errors on each side. */
  errored: { baseline: number; candidate: number };
  successRate: {
    baseline: Interval;
    candidate: Interval;
    delta: number;
    /** Absent when no interval was compared (replay, or a mode mismatch). */
    overlap?: boolean;
    verdict: Verdict;
  };
  /** Only for two replay reports: deterministic changed/unchanged facts. */
  replay?: {
    baselinePass: boolean;
    candidatePass: boolean;
    passChanged: boolean;
    countsChanged: boolean;
  };
  passAtK: { baseline: boolean; candidate: boolean };
  passPowK: { baseline: boolean; candidate: boolean };
  /** Only the metrics both sides could compute. */
  measured: Partial<Record<MeasuredKey, MetricDelta>>;
  /** Present only when both reports carry the same rates and both could compute the cost. */
  estimated?: { costUsdPerSuccess?: MetricDelta };
}

export interface EvalComparison {
  schemaVersion: 1;
  suiteId: string;
  suiteVersion: string;
  baseline: Conditions;
  candidate: Conditions;
  /** Conditions that differ between the two reports (`configHash` over the SHARED tasks only). */
  changed: Array<{ field: (typeof CHANGED_FIELDS)[number]; baseline: string; candidate: string }>;
  /** Runs excluded as infrastructure errors on each side (every task, shared or not). */
  errored: { baseline: number; candidate: number };
  /** Whether token and cost deltas were computed (they need equal compaction settings). */
  tokenComparison: TokenComparison;
  tasks: TaskComparison[];
  onlyInBaseline: string[];
  onlyInCandidate: string[];
  warnings: string[];
}

const delta = (baseline: number, candidate: number): MetricDelta => ({
  baseline,
  candidate,
  delta: candidate - baseline,
});

const TOKEN_KEYS: readonly MeasuredKey[] = ["varianceTokens", "tokensPerSuccess"];

interface TaskContext {
  sameRates: boolean;
  tokensComparable: boolean;
  modeDiffers: boolean;
  replay: boolean;
}

function compareTask(a: EvalTaskMetrics, b: EvalTaskMetrics, ctx: TaskContext): TaskComparison {
  const lowPower = a.k < MIN_POWER_K || b.k < MIN_POWER_K;
  const difference = b.successRate.value - a.successRate.value;
  const erroredA = a.errored ?? 0;
  const erroredB = b.errored ?? 0;

  const measured: TaskComparison["measured"] = {};
  for (const key of MEASURED_KEYS) {
    if (!ctx.tokensComparable && TOKEN_KEYS.includes(key)) continue;
    const before = a.measured[key];
    const after = b.measured[key];
    if (before !== undefined && after !== undefined) measured[key] = delta(before, after);
  }
  const costBefore = a.estimated?.costUsdPerSuccess;
  const costAfter = b.estimated?.costUsdPerSuccess;

  const replayFacts =
    ctx.replay && !ctx.modeDiffers
      ? {
          baselinePass: a.passPowK,
          candidatePass: b.passPowK,
          passChanged: a.passPowK !== b.passPowK || difference !== 0,
          countsChanged:
            ctx.tokensComparable &&
            (a.measured.tokensPerSuccess !== b.measured.tokensPerSuccess ||
              a.measured.varianceTokens !== b.measured.varianceTokens),
        }
      : undefined;

  let overlap: boolean | undefined;
  let verdict: Verdict;
  const withWilson = !replayFacts;
  if (withWilson)
    overlap =
      a.successRate.wilsonLow <= b.successRate.wilsonHigh &&
      b.successRate.wilsonLow <= a.successRate.wilsonHigh;
  if (ctx.modeDiffers) verdict = "not comparable: mode differs";
  else if (erroredA > 0 || erroredB > 0) verdict = "not comparable: errored runs";
  else if (replayFacts)
    verdict = replayFacts.passChanged || replayFacts.countsChanged ? "changed" : "unchanged";
  else if (overlap) verdict = "inconclusive";
  else if (lowPower) verdict = "low_power";
  else verdict = difference > 0 ? "improved" : "regressed";

  const side = (m: EvalTaskMetrics): Interval =>
    withWilson ? { ...m.successRate } : { value: m.successRate.value };
  return {
    taskId: a.taskId,
    k: { baseline: a.k, candidate: b.k },
    lowPower,
    kMismatch: a.k !== b.k,
    errored: { baseline: erroredA, candidate: erroredB },
    successRate: {
      baseline: side(a),
      candidate: side(b),
      delta: difference,
      ...(overlap === undefined ? {} : { overlap }),
      verdict,
    },
    ...(replayFacts ? { replay: replayFacts } : {}),
    passAtK: { baseline: a.passAtK, candidate: b.passAtK },
    passPowK: { baseline: a.passPowK, candidate: b.passPowK },
    measured,
    ...(ctx.sameRates && ctx.tokensComparable && costBefore !== undefined && costAfter !== undefined
      ? { estimated: { costUsdPerSuccess: delta(costBefore, costAfter) } }
      : {}),
  };
}

const sameRates = (a: EvalRates | undefined, b: EvalRates | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.inputPerMTokUsd === b.inputPerMTokUsd &&
  a.outputPerMTokUsd === b.outputPerMTokUsd;

/** Compares `candidate` against `baseline`; throws `EvalCompareError` for different suites. */
export function compareReports(baseline: EvalReport, candidate: EvalReport): EvalComparison {
  if (baseline.suiteId !== candidate.suiteId)
    throw new EvalCompareError(
      `Cannot compare different suites: baseline is "${baseline.suiteId}", candidate is "${candidate.suiteId}".`,
      "suite_id",
    );
  if (baseline.suiteVersion !== candidate.suiteVersion)
    throw new EvalCompareError(
      `Cannot compare different suite versions of "${baseline.suiteId}": baseline is ${baseline.suiteVersion}, candidate is ${candidate.suiteVersion}. A changed fixture or verifier changes what is measured; rerun both on the same version.`,
      "suite_version",
    );

  const candidateTasks = new Map(candidate.tasks.map((t) => [t.taskId, t]));
  const baselineIds = new Set(baseline.tasks.map((t) => t.taskId));
  const rates = sameRates(baseline.rates, candidate.rates);
  const modeDiffers = baseline.conditions.mode !== candidate.conditions.mode;
  const compactionA = baseline.conditions.compactionHash;
  const compactionB = candidate.conditions.compactionHash;
  const compactionDiffers =
    compactionA !== undefined && compactionB !== undefined && compactionA !== compactionB;
  const context: TaskContext = {
    sameRates: rates,
    tokensComparable: !compactionDiffers,
    modeDiffers,
    replay: baseline.conditions.mode === "replay" && candidate.conditions.mode === "replay",
  };
  const tasks = baseline.tasks.flatMap((t) => {
    const other = candidateTasks.get(t.taskId);
    return other ? [compareTask(t, other, context)] : [];
  });

  const warnings: string[] = [];
  const weak = tasks.filter((t) => t.lowPower).map((t) => t.taskId);
  if (weak.length > 0 && !context.replay)
    warnings.push(
      `Low power: ${weak.join(", ")} ${weak.length === 1 ? "has" : "have"} fewer than ${MIN_POWER_K} judged runs on at least one side; no improvement or regression is claimed for ${weak.length === 1 ? "it" : "them"}.`,
    );
  const erroredTasks = tasks.filter((t) => t.errored.baseline > 0 || t.errored.candidate > 0);
  if (erroredTasks.length > 0)
    warnings.push(
      `Errored runs (infrastructure failures excluded from the rates) on ${erroredTasks.map((t) => `${t.taskId} (base ${t.errored.baseline} / cand ${t.errored.candidate})`).join(", ")}: the judged runs are a filtered sample, so no improvement or regression is claimed for ${erroredTasks.length === 1 ? "it" : "them"}. Fix the cause and rerun.`,
    );
  const mismatched = tasks.filter((t) => t.kMismatch).map((t) => t.taskId);
  if (mismatched.length > 0)
    warnings.push(
      `Different k between the sides on ${mismatched.join(", ")}: pass^k is only comparable at equal k.`,
    );
  if (baseline.rates && candidate.rates && !rates)
    warnings.push("The two reports were estimated with different rates: costs are not compared.");
  if (modeDiffers)
    warnings.push(
      `The modes differ (${baseline.conditions.mode} vs ${candidate.conditions.mode}): replay measures the harness, not the model, so these are different kinds of measurement; no improvement or regression is claimed.`,
    );
  if (compactionDiffers)
    warnings.push(
      "The compaction settings differ between the reports: token and cost deltas are not computed, because compaction calls are not in the measured main-loop tokens.",
    );
  else if ((compactionA === undefined) !== (compactionB === undefined))
    warnings.push(
      "The compaction settings of one report are unknown (it predates the compaction identity): token and cost deltas assume they are equal.",
    );

  const shared = baseline.tasks
    .map((t) => t.taskId)
    .filter((id) => candidateTasks.has(id))
    .sort();
  const hashA = sharedConfigHash(baseline, shared);
  const hashB = sharedConfigHash(candidate, shared);
  const valueOf = (
    field: (typeof CHANGED_FIELDS)[number],
    r: EvalReport,
    shared: string | undefined,
  ) => (field === "configHash" ? (shared ?? r.conditions.configHash) : r.conditions[field]);
  return {
    schemaVersion: 1,
    suiteId: baseline.suiteId,
    suiteVersion: baseline.suiteVersion,
    baseline: baseline.conditions,
    candidate: candidate.conditions,
    changed: CHANGED_FIELDS.flatMap((field) => {
      const before = valueOf(field, baseline, hashA);
      const after = valueOf(field, candidate, hashB);
      return before === after ? [] : [{ field, baseline: before, candidate: after }];
    }),
    errored: { baseline: baseline.summary.errored, candidate: candidate.summary.errored },
    tokenComparison: compactionDiffers
      ? "not comparable: compaction settings differ"
      : "comparable",
    tasks,
    onlyInBaseline: baseline.tasks.map((t) => t.taskId).filter((id) => !candidateTasks.has(id)),
    onlyInCandidate: candidate.tasks.map((t) => t.taskId).filter((id) => !baselineIds.has(id)),
    warnings,
  };
}

/**
 * The `configHash` of a report restricted to `ids`: the hash every shared task has, or the hash of
 * the sorted pairs (the scheme `buildReport` uses). `undefined` when a task carries no hash, so
 * the caller falls back to the report-level condition. Comparing only the SHARED tasks keeps a
 * subset run (`--tasks`) from looking like a configuration change.
 */
function sharedConfigHash(report: EvalReport, ids: string[]): string | undefined {
  if (ids.length === 0) return undefined;
  const byId = new Map(report.tasks.map((t) => [t.taskId, t.configHash]));
  const pairs = ids.map((id) => [id, byId.get(id)] as const);
  if (pairs.some(([, hash]) => hash === undefined)) return undefined;
  const distinct = new Set(pairs.map(([, hash]) => hash));
  if (distinct.size === 1) return pairs[0]?.[1];
  return `sha256:${createHash("sha256").update(JSON.stringify(pairs)).digest("hex")}`;
}

// ---------------------------------------------------------------------------------------------
// Variants (D15)
// ---------------------------------------------------------------------------------------------

export interface VariantComparison {
  suiteId: string;
  suiteVersion: string;
  baselineId: string;
  /** The config overrides each variant ran with (what the variants file declared). */
  baselineOverrides: Record<string, unknown>;
  variants: Array<{ id: string; overrides: Record<string, unknown>; comparison: EvalComparison }>;
}

const overridesOf = (v: { report: EvalReport; overrides?: Record<string, unknown> }) =>
  v.overrides ?? v.report.variant?.overrides ?? {};

/** Compares every variant after the first against the first (the baseline). */
export function compareVariants(
  variants: Array<{ id: string; report: EvalReport; overrides?: Record<string, unknown> }>,
): VariantComparison {
  const [baseline, ...rest] = variants;
  if (!baseline || rest.length === 0)
    throw new EvalCompareError("Comparing variants needs at least two reports.", "suite_id");
  return {
    suiteId: baseline.report.suiteId,
    suiteVersion: baseline.report.suiteVersion,
    baselineId: baseline.id,
    baselineOverrides: overridesOf(baseline),
    variants: rest.map((v) => ({
      id: v.id,
      overrides: overridesOf(v),
      comparison: compareReports(baseline.report, v.report),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Report files
// ---------------------------------------------------------------------------------------------

const intervalSchema = z.object({
  value: z.number(),
  wilsonLow: z.number(),
  wilsonHigh: z.number(),
});
const reportSchema = z.object({
  schemaVersion: z.literal(1, { error: "unsupported schemaVersion (expected 1)" }),
  suiteId: z.string(),
  suiteVersion: z.string(),
  conditions: z.object({
    harnessVersion: z.string(),
    configHash: z.string(),
    provider: z.string(),
    model: z.string(),
    mode: z.enum(["live", "replay"]),
    k: z.number(),
    seedBase: z.number(),
    compactionHash: z.string().optional(),
  }),
  variant: z.object({ id: z.string(), overrides: z.record(z.string(), z.unknown()) }).optional(),
  notes: z.array(z.string()).optional(),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      k: z.number(),
      successRate: intervalSchema,
      passAtK: z.boolean(),
      passPowK: z.boolean(),
      errored: z.number().optional(),
      configHash: z.string().optional(),
      measured: z.object({
        medianWallMs: z.number().optional(),
        varianceWallMs: z.number().optional(),
        varianceTokens: z.number().optional(),
        tokensPerSuccess: z.number().optional(),
        wallMsPerSuccess: z.number().optional(),
      }),
      estimated: z.object({ costUsdPerSuccess: z.number().optional() }).optional(),
    }),
  ),
  runs: z.array(z.string()),
  summary: z.object({
    tasks: z.number(),
    passed: z.number(),
    errored: z.number(),
    budgetExceeded: z.number(),
    runs: z.number().optional(),
    failed: z.number().optional(),
  }),
  rates: z.object({ inputPerMTokUsd: z.number(), outputPerMTokUsd: z.number() }).optional(),
});

/** Validates the parsed JSON of a `report.json`; throws an actionable `Error` otherwise. */
export function parseReport(value: unknown): EvalReport {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at "${issue.path.join(".")}"` : "";
    throw new Error(
      `Not a valid reliability report (report.json written by \`alisio eval run\`): ${issue?.message ?? "invalid"}${where}.`,
    );
  }
  return parsed.data as EvalReport;
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const percent = (value: number) => `${Math.round(value * 1000) / 10}%`;
const signed = (value: number, format: (v: number) => string) =>
  `${value > 0 ? "+" : value < 0 ? "-" : ""}${format(Math.abs(value))}`;
const points = (value: number) => `${Math.round(value * 1000) / 10} pp`;
const interval = (i: Interval, k: number) =>
  k === 0
    ? "n/a"
    : i.wilsonLow === undefined || i.wilsonHigh === undefined
      ? percent(i.value)
      : `${percent(i.value)} [${percent(i.wilsonLow)}, ${percent(i.wilsonHigh)}]`;
const VERDICT_TEXT: Record<Verdict, string> = {
  improved: "improved",
  regressed: "regressed",
  inconclusive: "inconclusive (intervals overlap)",
  low_power: "low power (k<5, no claim)",
  "not comparable: errored runs": "not comparable: errored runs",
  "not comparable: mode differs": "not comparable: mode differs",
  changed: "changed",
  unchanged: "unchanged",
};
const METRIC_LABEL: Record<MeasuredKey, string> = {
  medianWallMs: "Median wall (ms)",
  varianceWallMs: "Wall variance (ms^2)",
  varianceTokens: "Token variance (main-loop tokens)",
  tokensPerSuccess: "Tokens per success (main-loop tokens, excludes compaction calls)",
  wallMsPerSuccess: "Wall per success (ms)",
};
const number = (value: number) => String(Math.round(value * 1000) / 1000);

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function body(c: EvalComparison, level: string): string[] {
  const lines: string[] = [
    `- Baseline: \`${c.baseline.model}\`, mode ${c.baseline.mode}, harness ${c.baseline.harnessVersion}, config \`${c.baseline.configHash}\``,
    `- Candidate: \`${c.candidate.model}\`, mode ${c.candidate.mode}, harness ${c.candidate.harnessVersion}, config \`${c.candidate.configHash}\``,
    "",
    `${level} What changed`,
    "",
    c.changed.length === 0
      ? "Nothing among the hashed conditions (configHash, model, harnessVersion, mode, provider)."
      : table(
          ["Condition", "Baseline", "Candidate"],
          c.changed.map((x) => [x.field, `\`${cell(x.baseline)}\``, `\`${cell(x.candidate)}\``]),
        ),
    "",
    "> Built-in plugin options and provider endpoint settings are not hashed: a change in either does not show up here.",
    "",
  ];
  if (c.baseline.mode === "replay" || c.candidate.mode === "replay")
    lines.push(
      "> Replay measures the harness, not the model: a replay comparison says nothing about model quality.",
      "",
    );
  for (const warning of c.warnings) lines.push(`> ${warning}`, "");
  if (c.onlyInBaseline.length > 0)
    lines.push(`Only in the baseline (not compared): ${c.onlyInBaseline.join(", ")}`, "");
  if (c.onlyInCandidate.length > 0)
    lines.push(`Only in the candidate (not compared): ${c.onlyInCandidate.join(", ")}`, "");
  const replayOnly = c.baseline.mode === "replay" && c.candidate.mode === "replay";
  lines.push(
    `${level} Success rate`,
    "",
    replayOnly
      ? "Replay repeats an identical recording, so no interval is computed: each task is reported as changed or unchanged (pass status and measured counts)."
      : "Wilson 95% intervals. A direction is claimed only with k>=5 on both sides, disjoint intervals and no errored runs; otherwise it stays inconclusive or not comparable.",
    "",
    table(
      [
        "Task",
        "k (base / cand)",
        "Errored (base / cand)",
        "Baseline",
        "Candidate",
        "Delta",
        "Verdict",
      ],
      c.tasks.map((t) => [
        cell(t.taskId),
        `${t.k.baseline} / ${t.k.candidate}${t.kMismatch ? " (k differs)" : ""}`,
        `${t.errored.baseline} / ${t.errored.candidate}`,
        interval(t.successRate.baseline, t.k.baseline),
        interval(t.successRate.candidate, t.k.candidate),
        signed(t.successRate.delta, points),
        VERDICT_TEXT[t.successRate.verdict],
      ]),
    ),
    "",
    `${level} Measured`,
    "",
    c.tokenComparison === "comparable"
      ? "Deltas are candidate minus baseline over provider-reported usage and wall time. Token figures are main-loop tokens (excludes compaction calls). They carry no verdict."
      : "Deltas are candidate minus baseline over wall time. Token deltas are not compared: not comparable: compaction settings differ (compaction calls are not in the main-loop tokens). They carry no verdict.",
    "",
  );
  const measuredRows = c.tasks.flatMap((t) =>
    MEASURED_KEYS.flatMap((key) => {
      const d = t.measured[key];
      return d
        ? [
            [
              cell(t.taskId),
              METRIC_LABEL[key],
              number(d.baseline),
              number(d.candidate),
              signed(d.delta, number),
            ],
          ]
        : [];
    }),
  );
  lines.push(
    measuredRows.length === 0
      ? "No metric could be computed on both sides."
      : table(["Task", "Metric", "Baseline", "Candidate", "Delta"], measuredRows),
    "",
    `${level} Estimated`,
    "",
  );
  const estimatedRows = c.tasks.flatMap((t) => {
    const d = t.estimated?.costUsdPerSuccess;
    return d
      ? [
          [
            cell(t.taskId),
            `$${d.baseline.toFixed(4)}`,
            `$${d.candidate.toFixed(4)}`,
            signed(d.delta, (v) => `$${v.toFixed(4)}`),
          ],
        ]
      : [];
  });
  lines.push(
    estimatedRows.length === 0
      ? "Not compared: the reports carry no cost estimate, were estimated with different rates, or differ in compaction settings."
      : table(["Task", "Cost per success (base)", "Candidate", "Delta"], estimatedRows),
  );
  return lines;
}

/** The footnote every comparison Markdown carries (statistical limits, stated once, verbatim). */
function footnote(tasks: number, errored: number, drift: string): string {
  return `*improved/regressed = 95% Wilson intervals disjoint with at least 5 judged runs per side. Conservative screen, not a significance test; 'inconclusive' is not 'no difference'. Assumes independent repetitions; ${drift}; no correction across ${tasks} tasks; ${errored} runs excluded as infrastructure errors; seeds order runs only and do not reach the provider.*`;
}

/** Markdown of a comparison: what changed, verdicts, then Measured and Estimated apart. */
export function renderComparisonMarkdown(c: EvalComparison): string {
  const note = footnote(
    c.tasks.length,
    c.errored.baseline + c.errored.candidate,
    "the two reports ran separately, so time drift is not controlled",
  );
  return `${[`# Comparison: ${c.suiteId} ${c.suiteVersion}`, "", ...body(c, "##"), "", note].join("\n")}\n`;
}

/** Markdown of a variants comparison: one section per candidate variant against the baseline. */
export function renderVariantComparisonMarkdown(v: VariantComparison): string {
  const overrides = (o: Record<string, unknown>) =>
    Object.keys(o).length === 0
      ? "no overrides"
      : Object.entries(o)
          .map(([key, value]) => `\`${key}\` = \`${JSON.stringify(value)}\``)
          .join(", ");
  const lines = [
    `# Variants: ${v.suiteId} ${v.suiteVersion}`,
    "",
    `Baseline variant: \`${v.baselineId}\` (${overrides(v.baselineOverrides)}). Each section compares one variant against it, over the same tasks; seeds only order the plan, nothing is paired, and the unpaired intervals are independent.`,
    "",
  ];
  for (const { id, overrides: own, comparison } of v.variants)
    lines.push(
      `## ${id} vs ${v.baselineId}`,
      "",
      `Overrides of \`${id}\`: ${overrides(own)}.`,
      "",
      ...body(comparison, "###"),
      "",
    );
  const first = v.variants[0]?.comparison;
  const errored =
    (first?.errored.baseline ?? 0) +
    v.variants.reduce((n, x) => n + x.comparison.errored.candidate, 0);
  const tasks = v.variants.reduce((n, x) => n + x.comparison.tasks.length, 0);
  lines.push(
    footnote(tasks, errored, "variants ran interleaved but time drift is not fully controlled"),
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
