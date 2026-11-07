/**
 * Context Governor promotion gate (specs/012, "Protocolo de la puerta de la Fase 6").
 *
 *   node --conditions=alisio-source --experimental-transform-types scripts/governor-gate.ts \
 *     --config gate.json [--threshold T] [--margin M]
 *
 * Reads the `runs.jsonl` files of the reliability lab (`alisio eval variants` writes
 * `<out>/<variant>/runs.jsonl`) and computes, per the protocol fixed on 2026-10-16:
 *   - the planned sample size per arm: n = ceil((1.645 + 0.8416)^2 * 2p(1-p) / M^2);
 *   - the Newcombe (hybrid Wilson, method 10) interval of p_on - p_off, one-sided 95 % lower bound;
 *   - the verdict per model (pass iff the lower bound is above -M) and its validity checks
 *     (the `off` arm, at the default limit, above 85 % as the negative control, at most 10 % error runs per arm, at least 30 judged runs);
 *   - the `cachedInput` check (PROPOSED criterion, pending owner approval, specs/012 D58): per
 *     model, the one-sided 95 % lower bound of mean(cached/input per run, on) - mean(... off) must be
 *     above -D, D being the allowed drop, an owner-set INPUT like T. Pending without D, or when an
 *     arm has fewer than 30 judged runs that reported cached tokens (the Lab leaves the field absent
 *     when the provider does not report it, and absent is never read as 0);
 *   - the overall decision: G1 >= T AND G2 AND G3 on every model AND no relevant cachedInput
 *     degradation. Anything else keeps the default `off`. There is no "inconclusive" state.
 *
 * T (the G1 threshold) is the owner's to set and is an INPUT: without it the script refuses to emit
 * a final G1 verdict, says so, and the gate is reported as not passed (final: false).
 *
 * G1 (token reduction) and G2 (invariants) are not computed from `runs.jsonl`: G1 is measured by
 * `scripts/governor-g1.ts` and G2 by the property tests. They are declared in the config file; a
 * missing one is pending, never a pass. `cachedInput` IS computed from the runs
 * (`measured.cachedInputTokens`, which the Lab records since protocol v2).
 *
 * Config file (paths relative to the file; an arm may be a list of files, concatenated, because the
 * chain-walk-rules tasks and the other tasks need different `--k` to fill an arm half and half):
 *   { "g1": {"reduction": 0.31, "basis": "estimated"}, "g2": "pass", "cachedInputMaxDrop": 0.05,
 *     "models": [{"id": "deepseek-flash", "pilotP": 0.9,
 *                 "off": "ds/default-off/runs.jsonl",
 *                 "on": "ds/default-on/runs.jsonl"}] }
 *
 * Exit codes: 0 passed, 1 decided and not passed, 2 not final (an input is missing, for example T
 * or the allowed cachedInput drop D), 3 usage or input error. Pure statistics: no network, no model.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { EvalRunRecord } from "@alisio/sdk";
import { wilsonInterval } from "../packages/core/src/eval/stats.ts";

// ---------------------------------------------------------------------------------------------
// Protocol parameters (fixed before measuring; changing them needs a new protocol version)
// ---------------------------------------------------------------------------------------------

/** z of the one-sided alpha = 0.05 test and z of 80 % power, as written in the protocol. */
export const Z_ALPHA = 1.645;
export const Z_POWER = 0.8416;
/** Exact z of the one-sided 95 % bound, used for the interval itself. */
export const Z_ONE_SIDED_95 = 1.6448536269514722;
export const DEFAULT_MARGIN = 0.1;
export const MIN_RUNS_PER_ARM = 30;
/** The `off` arm (the negative control, protocol v2) must be strictly above this rate. */
export const CONTROL_MIN_RATE = 0.85;
/** More error runs than this share of an arm invalidates the measurement. */
export const MAX_ERROR_RATE = 0.1;
export const MIN_MODELS = 2;
export const MIN_RULES_INSTANCES = 5;
/** Share of `chain-walk-rules-*` runs allowed in an arm ("equal parts": 50 % +- 10 pp). */
export const RULES_SHARE_RANGE = [0.4, 0.6] as const;
export const RULES_TASK_PREFIX = "chain-walk-rules-";

const rangeError = (message: string) => new RangeError(message);

// ---------------------------------------------------------------------------------------------
// Sample size
// ---------------------------------------------------------------------------------------------

function assertMargin(margin: number): void {
  if (!Number.isFinite(margin) || margin <= 0 || margin >= 1)
    throw rangeError(`The margin M must be in (0, 1), got ${margin}.`);
}

/**
 * Planned runs per arm, n = ceil((1.645 + 0.8416)^2 * 2p(1-p) / M^2), `p` being the success rate of
 * `off` in a pilot. `floor: true` applies the protocol's minimum of 30 runs per arm.
 */
export function requiredSampleSize(
  p: number,
  margin: number = DEFAULT_MARGIN,
  options: { floor?: boolean } = {},
): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1)
    throw rangeError(`The pilot success rate p must be in (0, 1) exclusive, got ${p}.`);
  assertMargin(margin);
  const raw = ((Z_ALPHA + Z_POWER) ** 2 * 2 * p * (1 - p)) / margin ** 2;
  // Guards the float residue of exact products (for example 24.0000000001 must not become 25).
  const n = Math.ceil(Number(raw.toFixed(9)));
  return options.floor ? Math.max(MIN_RUNS_PER_ARM, n) : n;
}

// ---------------------------------------------------------------------------------------------
// Newcombe interval
// ---------------------------------------------------------------------------------------------

export interface DifferenceInterval {
  diff: number;
  lower: number;
  upper: number;
}

/**
 * Newcombe (1998) method 10, the hybrid score interval for p1 - p2 of independent proportions:
 * built from the Wilson intervals (l_i, u_i) of each proportion,
 *   lower = d - sqrt((p1 - l1)^2 + (u2 - p2)^2),  upper = d + sqrt((u1 - p1)^2 + (p2 - l2)^2).
 * `z` is the normal quantile of the Wilson intervals (1.96 for two-sided 95 %, 1.645 for the
 * one-sided 95 % bound used by the gate).
 */
export function newcombeDifference(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
  z: number,
): DifferenceInterval {
  if (!Number.isInteger(n1) || !Number.isInteger(n2) || n1 < 1 || n2 < 1)
    throw rangeError(`Each arm needs at least one trial, got ${n1} and ${n2}.`);
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  // wilsonInterval validates the counts and throws RangeError.
  const w1 = wilsonInterval(x1, n1, z);
  const w2 = wilsonInterval(x2, n2, z);
  const diff = p1 - p2;
  return {
    diff,
    lower: Math.max(-1, diff - Math.sqrt((p1 - w1.low) ** 2 + (w2.high - p2) ** 2)),
    upper: Math.min(1, diff + Math.sqrt((w1.high - p1) ** 2 + (p2 - w2.low) ** 2)),
  };
}

export interface Counts {
  successes: number;
  n: number;
}

/** One-sided 95 % lower bound of p_on - p_off (the lower end of the two-sided 90 % interval). */
export function nonInferiorityLowerBound(on: Counts, off: Counts): number {
  return newcombeDifference(on.successes, on.n, off.successes, off.n, Z_ONE_SIDED_95).lower;
}

// ---------------------------------------------------------------------------------------------
// Arms and models
// ---------------------------------------------------------------------------------------------

export interface ArmSummary {
  /** Every run of the arm, errors included. */
  total: number;
  /** Runs that were judged (`pass`, `fail`, `budget_exceeded`): the denominator of the rate. */
  judged: number;
  successes: number;
  errored: number;
  /** errors / total. */
  errorRate: number;
  /** successes / judged; undefined with no judged run. */
  rate: number | undefined;
  /** Why this arm cannot back a verdict (empty when it can). */
  issues: string[];
}

export interface ArmOptions {
  /** Planned runs per arm (from the pilot); fewer judged runs invalidates the arm. */
  plannedRuns?: number;
}

const pct = (value: number) => `${(value * 100).toFixed(1)} %`;

export function summarizeArm(records: EvalRunRecord[], options: ArmOptions = {}): ArmSummary {
  const total = records.length;
  const errored = records.filter((r) => r.status === "error").length;
  const judged = total - errored;
  const successes = records.filter((r) => r.status === "pass").length;
  const errorRate = total === 0 ? 0 : errored / total;
  const issues: string[] = [];
  if (total === 0) issues.push("the arm has no runs");
  if (errorRate > MAX_ERROR_RATE)
    issues.push(
      `${errored} of ${total} runs are errors (${pct(errorRate)}, over ${pct(MAX_ERROR_RATE)}): fix the cause and repeat the whole arm`,
    );
  if (total > 0 && judged < MIN_RUNS_PER_ARM)
    issues.push(`${judged} judged runs, fewer than the minimum of ${MIN_RUNS_PER_ARM} per arm`);
  if (options.plannedRuns !== undefined && total > 0 && judged < options.plannedRuns)
    issues.push(
      `${judged} judged runs, fewer than the ${options.plannedRuns} planned from the pilot (n is fixed in advance, no early stop)`,
    );
  if (total > 0) {
    const rules = records.filter((r) => r.taskId.startsWith(RULES_TASK_PREFIX));
    const instances = new Set(rules.map((r) => r.taskId)).size;
    if (instances < MIN_RULES_INSTANCES)
      issues.push(
        `${instances} chain-walk-rules instances, fewer than the required ${MIN_RULES_INSTANCES}`,
      );
    const share = rules.length / total;
    if (share < RULES_SHARE_RANGE[0] || share > RULES_SHARE_RANGE[1])
      issues.push(
        `chain-walk-rules is ${pct(share)} of the arm; the protocol asks for half chain-walk-rules and half the other tasks`,
      );
  }
  return {
    total,
    judged,
    successes,
    errored,
    errorRate,
    rate: judged === 0 ? undefined : successes / judged,
    issues,
  };
}

export interface ModelInput {
  id: string;
  /** Default limit (800 000 chars) with `context.governor: off`; also the negative control. */
  off: EvalRunRecord[];
  /** Default limit (800 000 chars) with `context.governor: on`. */
  on: EvalRunRecord[];
  /** Success rate of `off` in the pilot; plans the arm size. */
  pilotP?: number;
  margin?: number;
  /** D: allowed drop of the cached-input share, as a fraction (0.05 = 5 pp). Owner-set. */
  cachedInputMaxDrop?: number;
}

export interface CachedInputComparison {
  /** `pending` = it cannot be judged yet (no D, or an arm lacks reported cached tokens). */
  status: "pass" | "degraded" | "pending";
  reason?: string;
  maxDrop?: number;
  /** Judged runs per arm that reported cachedInput completely. */
  runsOff: number;
  runsOn: number;
  /** Pooled cached/input tokens of the reporting runs (for the report; the test uses run means). */
  ratioOff?: number;
  ratioOn?: number;
  /** Mean of the per-run cached/input ratios. */
  meanOff?: number;
  meanOn?: number;
  /** meanOn - meanOff. */
  difference?: number;
  /** One-sided 95 % Welch lower bound of the difference. */
  lowerBound?: number;
}

export interface ModelVerdict {
  id: string;
  /** False when the measurement cannot back a verdict (the model is not valid for the gate). */
  valid: boolean;
  /** True iff valid and the lower bound is strictly above -M. */
  passed: boolean;
  margin: number;
  off: ArmSummary;
  on: ArmSummary;
  /** p_on - p_off. */
  difference?: number;
  /** One-sided 95 % lower bound of p_on - p_off. */
  lowerBound?: number;
  cachedInput: CachedInputComparison;
  /** Runs per arm planned from `pilotP` (with the floor of 30); absent without a pilot. */
  requiredRunsPerArm?: number;
  reasons: string[];
}

/** Minimum judged runs per arm that must have reported cachedInput for the check to be judged. */
export const MIN_CACHED_REPORTING_RUNS = 30;

interface CachedReporters {
  ratios: number[];
  cached: number;
  input: number;
}

/** Judged runs that reported cached input completely; unreported is not zero. */
function cachedReporters(records: EvalRunRecord[]): CachedReporters {
  const ratios: number[] = [];
  let cached = 0;
  let input = 0;
  for (const r of records) {
    const m = r.measured;
    if (
      r.status === "error" ||
      m.cachedInputTokens === undefined ||
      m.cachedPartial ||
      m.usagePartial ||
      m.inputTokens === undefined ||
      m.inputTokens <= 0
    )
      continue;
    ratios.push(m.cachedInputTokens / m.inputTokens);
    cached += m.cachedInputTokens;
    input += m.inputTokens;
  }
  return { ratios, cached, input };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const variance = (values: number[]) => {
  const m = mean(values);
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
};

/**
 * PROPOSED criterion (specs/012 D58, pending owner approval): the cached share of `on` is not
 * relevantly worse than that of `off` iff the one-sided 95 % lower bound of the difference of the
 * per-run mean ratios is strictly above -D. Per-run ratios (not pooled tokens) because runs are
 * the independent units; a Welch normal bound is justified by at least 30 reporting runs per arm.
 */
export function compareCachedInput(
  off: EvalRunRecord[],
  on: EvalRunRecord[],
  maxDrop: number | undefined,
): CachedInputComparison {
  if (maxDrop !== undefined && (!(maxDrop > 0) || maxDrop >= 1))
    throw rangeError(`The allowed cachedInput drop D must be in (0, 1), got ${maxDrop}.`);
  const a = cachedReporters(off);
  const b = cachedReporters(on);
  const base: CachedInputComparison = {
    status: "pending",
    ...(maxDrop === undefined ? {} : { maxDrop }),
    runsOff: a.ratios.length,
    runsOn: b.ratios.length,
    ...(a.input > 0 ? { ratioOff: a.cached / a.input } : {}),
    ...(b.input > 0 ? { ratioOn: b.cached / b.input } : {}),
  };
  const lacking = [
    ["off", a.ratios.length],
    ["on", b.ratios.length],
  ].filter(([, n]) => (n as number) < MIN_CACHED_REPORTING_RUNS);
  if (lacking.length > 0)
    return {
      ...base,
      reason: lacking.every(([, n]) => n === 0)
        ? "no run reported cachedInput in either arm (the provider did not report it)"
        : `${lacking.map(([name, n]) => `${name} arm: ${n}`).join(", ")} judged runs reported cachedInput, fewer than the ${MIN_CACHED_REPORTING_RUNS} needed`,
    };
  const meanOff = mean(a.ratios);
  const meanOn = mean(b.ratios);
  const difference = meanOn - meanOff;
  const se = Math.sqrt(variance(a.ratios) / a.ratios.length + variance(b.ratios) / b.ratios.length);
  const lowerBound = difference - Z_ONE_SIDED_95 * se;
  const stats = { ...base, meanOff, meanOn, difference, lowerBound };
  if (maxDrop === undefined)
    return {
      ...stats,
      reason: "D (the allowed drop of the cached-input share) is not set: the owner fixes it",
    };
  return { ...stats, status: lowerBound > -maxDrop ? "pass" : "degraded" };
}

export function verdictForModel(input: ModelInput): ModelVerdict {
  const margin = input.margin ?? DEFAULT_MARGIN;
  assertMargin(margin);
  const requiredRunsPerArm =
    input.pilotP === undefined
      ? undefined
      : requiredSampleSize(input.pilotP, margin, { floor: true });
  const armOptions: ArmOptions =
    requiredRunsPerArm === undefined ? {} : { plannedRuns: requiredRunsPerArm };
  const off = summarizeArm(input.off, armOptions);
  const on = summarizeArm(input.on, armOptions);

  const reasons: string[] = [];
  for (const [name, arm] of [
    ["off", off],
    ["on", on],
  ] as const) {
    for (const issue of arm.issues) reasons.push(`${input.id}: ${name} arm: ${issue}`);
  }
  if (off.rate === undefined || off.rate <= CONTROL_MIN_RATE)
    reasons.push(
      `${input.id}: the off arm (negative control) succeeds ${off.rate === undefined ? "never measured" : pct(off.rate)}, it must be above ${pct(CONTROL_MIN_RATE)} (not a valid model for the gate)`,
    );
  const valid = reasons.length === 0;

  let lowerBound: number | undefined;
  let difference: number | undefined;
  if (on.judged > 0 && off.judged > 0) {
    const ci = newcombeDifference(
      on.successes,
      on.judged,
      off.successes,
      off.judged,
      Z_ONE_SIDED_95,
    );
    lowerBound = ci.lower;
    difference = ci.diff;
  }
  const passed = valid && lowerBound !== undefined && lowerBound > -margin;
  if (valid && !passed)
    reasons.push(
      lowerBound === undefined
        ? `${input.id}: no judged runs to compare`
        : `${input.id}: G3 not passed: the lower bound of p_on - p_off is ${(lowerBound * 100).toFixed(1)} pp, not above -${(margin * 100).toFixed(0)} pp`,
    );
  return {
    id: input.id,
    valid,
    passed,
    margin,
    off,
    on,
    ...(difference === undefined ? {} : { difference }),
    ...(lowerBound === undefined ? {} : { lowerBound }),
    cachedInput: compareCachedInput(input.off, input.on, input.cachedInputMaxDrop),
    ...(requiredRunsPerArm === undefined ? {} : { requiredRunsPerArm }),
    reasons,
  };
}

// ---------------------------------------------------------------------------------------------
// Overall decision
// ---------------------------------------------------------------------------------------------

export interface G1Input {
  /** Fraction of input tokens saved by `on` against `off` (0.31 = 31 %). */
  reduction: number;
  /** Whether the figure comes from provider `usage` or from the token estimator. */
  basis: "measured" | "estimated";
}

export interface GateInput {
  margin?: number;
  /** T: owner-set minimum reduction of G1. Unset until the owner decides. */
  threshold?: number;
  g1?: G1Input;
  /** G2: invariants hold (property tests and criteria 1 to 4 of section 10). */
  g2?: "pass" | "fail";
  /** D: allowed drop of the cached-input share per model (fraction). Owner-set, unset until then. */
  cachedInputMaxDrop?: number;
  models: ModelInput[];
}

export interface G1Verdict {
  status: "passed" | "not_passed" | "refused";
  reason?: string;
  reduction?: number;
  basis?: G1Input["basis"];
  threshold?: number;
}

export interface GateDecision {
  outcome: "passed" | "not_passed";
  passed: boolean;
  /** False when an input is missing (T, G2, cachedInput, G1): the gate cannot be settled yet. */
  final: boolean;
  /** Inputs the gate is waiting for. */
  pending: string[];
  /** What to do with the default: always `off` unless the gate passed. */
  defaultGovernor: "off" | "promotable";
  margin: number;
  reasons: string[];
  g1: G1Verdict;
  g2: "pass" | "fail" | "pending";
  /** All models pass / any degraded / otherwise pending. */
  cachedInput: { status: "pass" | "degraded" | "pending"; maxDrop?: number };
  models: ModelVerdict[];
}

export function decideGate(input: GateInput): GateDecision {
  const margin = input.margin ?? DEFAULT_MARGIN;
  assertMargin(margin);
  if (input.threshold !== undefined && (!(input.threshold > 0) || input.threshold > 1))
    throw rangeError(`The threshold T must be a fraction in (0, 1], got ${input.threshold}.`);
  if (
    input.cachedInputMaxDrop !== undefined &&
    !(input.cachedInputMaxDrop > 0 && input.cachedInputMaxDrop < 1)
  )
    throw rangeError(
      `The allowed cachedInput drop D must be in (0, 1), got ${input.cachedInputMaxDrop}.`,
    );
  if (input.g1 !== undefined && !Number.isFinite(input.g1.reduction))
    throw rangeError("g1.reduction must be a finite number.");

  const pending: string[] = [];
  const reasons: string[] = [];

  let g1: G1Verdict;
  if (input.threshold === undefined) {
    pending.push("T");
    g1 = {
      status: "refused",
      reason:
        "T is not set: the owner has not fixed the G1 threshold, so no final G1 verdict is emitted.",
      ...(input.g1 ? { reduction: input.g1.reduction, basis: input.g1.basis } : {}),
    };
  } else if (input.g1 === undefined) {
    pending.push("G1");
    g1 = { status: "refused", reason: "No G1 measurement was given.", threshold: input.threshold };
  } else {
    const ok = input.g1.reduction >= input.threshold;
    g1 = {
      status: ok ? "passed" : "not_passed",
      reduction: input.g1.reduction,
      basis: input.g1.basis,
      threshold: input.threshold,
    };
    if (!ok)
      reasons.push(
        `G1 not passed: reduction ${pct(input.g1.reduction)} (${input.g1.basis}) is below T = ${pct(input.threshold)}`,
      );
  }

  if (input.g2 === undefined) pending.push("G2");
  else if (input.g2 === "fail") reasons.push("G2 not passed: the invariants check failed");
  if (input.cachedInputMaxDrop === undefined) pending.push("cachedInputMaxDrop");

  const models = input.models.map((m) =>
    verdictForModel({
      margin,
      ...(input.cachedInputMaxDrop === undefined
        ? {}
        : { cachedInputMaxDrop: input.cachedInputMaxDrop }),
      ...m,
    }),
  );
  for (const model of models) {
    if (model.cachedInput.status === "degraded")
      reasons.push(
        `${model.id}: cachedInput degraded: the lower bound of the cached share difference (on - off) is ${((model.cachedInput.lowerBound ?? 0) * 100).toFixed(1)} pp, not above -${((input.cachedInputMaxDrop ?? 0) * 100).toFixed(1)} pp`,
      );
    else if (model.cachedInput.status === "pending" && input.cachedInputMaxDrop !== undefined) {
      pending.push(`cachedInput:${model.id}`);
      reasons.push(`${model.id}: cachedInput pending: ${model.cachedInput.reason ?? "no data"}`);
    }
  }
  const cachedStatus: GateDecision["cachedInput"]["status"] = models.some(
    (m) => m.cachedInput.status === "degraded",
  )
    ? "degraded"
    : models.length > 0 && models.every((m) => m.cachedInput.status === "pass")
      ? "pass"
      : "pending";
  if (models.length < MIN_MODELS)
    reasons.push(
      `G3 needs at least two models of different providers or families, got ${models.length}`,
    );
  for (const model of models) reasons.push(...model.reasons);

  const passed =
    pending.length === 0 &&
    reasons.length === 0 &&
    g1.status === "passed" &&
    input.g2 === "pass" &&
    cachedStatus === "pass" &&
    models.length >= MIN_MODELS &&
    models.every((m) => m.passed);
  for (const item of pending) reasons.push(`pending input: ${item}`);

  return {
    outcome: passed ? "passed" : "not_passed",
    passed,
    final: pending.length === 0,
    pending,
    defaultGovernor: passed ? "promotable" : "off",
    margin,
    reasons,
    g1,
    g2: input.g2 ?? "pending",
    cachedInput: {
      status: cachedStatus,
      ...(input.cachedInputMaxDrop === undefined ? {} : { maxDrop: input.cachedInputMaxDrop }),
    },
    models,
  };
}

// ---------------------------------------------------------------------------------------------
// runs.jsonl and the CLI
// ---------------------------------------------------------------------------------------------

/** Parses a Lab `runs.jsonl`; names the line of a record that is not JSON or lacks a status. */
export function parseRunsJsonl(text: string): EvalRunRecord[] {
  const out: EvalRunRecord[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`runs.jsonl line ${index + 1} is not valid JSON.`);
    }
    const status = (value as { status?: unknown } | null)?.status;
    const taskId = (value as { taskId?: unknown } | null)?.taskId;
    if (
      typeof taskId !== "string" ||
      (status !== "pass" && status !== "fail" && status !== "budget_exceeded" && status !== "error")
    )
      throw new Error(`runs.jsonl line ${index + 1} is not a run record (taskId/status).`);
    out.push(value as EvalRunRecord);
  });
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads the gate config file and the `runs.jsonl` files it names. */
export function loadGateConfig(path: string): GateInput {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read the gate config "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(raw) || !Array.isArray(raw.models))
    throw new Error(`The gate config "${path}" needs a "models" array.`);
  const base = dirname(resolve(path));
  const loadOne = (file: string, label: string): EvalRunRecord[] => {
    try {
      return parseRunsJsonl(readFileSync(resolve(base, file), "utf8"));
    } catch (error) {
      throw new Error(
        `${label} (${file}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  // An arm may be split over several files (the rules tasks and the others run with different k).
  const load = (files: unknown, label: string): EvalRunRecord[] => {
    const list = typeof files === "string" ? [files] : files;
    if (!Array.isArray(list) || list.length === 0 || list.some((f) => typeof f !== "string"))
      throw new Error(`The gate config lacks the path "${label}" (a file or a list of files).`);
    return list.flatMap((file) => loadOne(file as string, label));
  };
  const models = raw.models.map((entry, i): ModelInput => {
    if (!isRecord(entry) || typeof entry.id !== "string")
      throw new Error(`models[${i}] needs a string "id".`);
    return {
      id: entry.id,
      off: load(entry.off, `${entry.id}.off`),
      on: load(entry.on, `${entry.id}.on`),
      ...(typeof entry.pilotP === "number" ? { pilotP: entry.pilotP } : {}),
    };
  });
  const g1 = raw.g1;
  const g2 = raw.g2;
  return {
    models,
    ...(isRecord(g1) &&
    typeof g1.reduction === "number" &&
    (g1.basis === "measured" || g1.basis === "estimated")
      ? { g1: { reduction: g1.reduction, basis: g1.basis } }
      : {}),
    ...(g2 === "pass" || g2 === "fail" ? { g2 } : {}),
    ...(typeof raw.cachedInputMaxDrop === "number"
      ? { cachedInputMaxDrop: raw.cachedInputMaxDrop }
      : {}),
    ...(typeof raw.threshold === "number" ? { threshold: raw.threshold } : {}),
    ...(typeof raw.margin === "number" ? { margin: raw.margin } : {}),
  };
}

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE = `Usage: governor-gate.ts --config FILE [--threshold T] [--margin M]

Computes the Phase 6 gate of specs/012 from the Lab runs.jsonl files named in FILE.
  --threshold T  G1 threshold (fraction, for example 0.3). Owner-set; without it no final verdict.
  --margin M     Non-inferiority margin as a fraction (default 0.10 = 10 pp)
  --cached-drop D  Allowed drop of the cached-input share, on vs off (fraction, for example 0.05).
                 Owner-set; without it the cachedInput check stays pending.
Exit codes: 0 passed, 1 not passed, 2 not final (an input such as T or D is missing), 3 usage error.
`;

export async function runGateCli(argv: string[], io: CliIo): Promise<number> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        config: { type: "string" },
        threshold: { type: "string" },
        margin: { type: "string" },
        "cached-drop": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    if (!values.config) throw new Error("Pass --config FILE.");
    const number = (flag: string, text: string) => {
      const value = Number(text);
      if (!Number.isFinite(value)) throw new Error(`${flag} must be a number, got "${text}".`);
      return value;
    };
    const input = loadGateConfig(resolve(values.config));
    if (values.threshold !== undefined) input.threshold = number("--threshold", values.threshold);
    if (values.margin !== undefined) input.margin = number("--margin", values.margin);
    if (values["cached-drop"] !== undefined)
      input.cachedInputMaxDrop = number("--cached-drop", values["cached-drop"]);
    const decision = decideGate(input);
    io.out(`${JSON.stringify(decision, null, 2)}\n`);
    if (!decision.final) {
      const what = decision.pending
        .map((p) =>
          p === "T"
            ? "T is not set (the owner fixes the G1 threshold)"
            : p === "cachedInputMaxDrop"
              ? "cachedInputMaxDrop is not set (the owner fixes the allowed cachedInput drop)"
              : p.startsWith("cachedInput:")
                ? `${p.slice(12)}: not enough runs reported cachedInput`
                : `${p} is missing`,
        )
        .join("; ");
      io.err(
        `governor-gate: no final verdict: ${what}. The gate is reported as not passed; the default stays off.\n`,
      );
      return 2;
    }
    return decision.passed ? 0 : 1;
  } catch (error) {
    io.err(`governor-gate: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runGateCli(process.argv.slice(2), {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
  }).then((code) => process.exit(code));
}
