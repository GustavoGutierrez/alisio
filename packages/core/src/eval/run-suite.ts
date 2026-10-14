/**
 * Runs a suite k times (specs/010 D6): plans the (task, repetition) pairs, refuses the whole batch
 * up front when a task is not allowed, then runs them one after another through `runTask` (which
 * itself serializes: the process environment it scopes is global). The caller resolves the
 * provider and the configuration; nothing here reads the network or the user's config.
 */

import type { EvalRunRecord, EvalTask, ModelProvider, RunEvent } from "@alisio/sdk";
import type { BuiltinPlugin } from "../application.ts";
import type { Config } from "../config.ts";
import type { RunOptions } from "../core/runner.ts";
import type { Cassette, CassetteRecorder } from "./cassette.ts";
import {
  checkTaskPolicy,
  type EvalApplication,
  type EvalRunMode,
  EvalRunRefusedError,
  type InvokerPermissions,
  runTask,
} from "./engine.ts";
import { interleaveVariants, planRuns } from "./plan.ts";
import type { LoadedSuite } from "./suite.ts";

export interface RunEvaluationOptions {
  suite: LoadedSuite;
  /** Required except in `replay` mode, where each task's cassette supplies the provider. */
  provider?: ModelProvider;
  /** `live` (default), `record` (a live run that also fills a recorder) or `replay` (from cassettes). */
  mode?: EvalRunMode;
  /** The recorder (record) or the recorded cassette (replay) of one task repetition. */
  cassetteFor?: (task: EvalTask, repetition: number) => CassetteRecorder | Cassette | undefined;
  /** Receives every RunEvent of every run (tests and tooling). */
  onEvent?: (event: RunEvent) => void;
  /** Variant overrides are already applied (they must be before the configuration is hashed). */
  config: Config;
  invoker: InvokerPermissions;
  /** Repetitions per task (a positive integer). */
  k: number;
  /** Plans the run order; each run gets `seedBase + repetition`. */
  seedBase: number;
  /** Subset of task ids (default: every task of the suite). */
  taskIds?: string[];
  allowSuiteFull?: boolean;
  keep?: boolean;
  builtins?: BuiltinPlugin[];
  resolveAgent?: (app: EvalApplication, agent: string) => RunOptions | Promise<RunOptions>;
  tmpRoot?: string;
  onRecord?: (record: EvalRunRecord, progress: { done: number; total: number }) => void;
}

export interface RunEvaluationResult {
  records: EvalRunRecord[];
  /** Run directories kept because of `keep`. */
  keptDirs: string[];
}

export interface RunVariantsOptions extends Omit<RunEvaluationOptions, "config" | "onRecord"> {
  /** Each variant's overrides are already applied to its `config`. */
  variants: Array<{ id: string; config: Config }>;
  onRecord?: (
    variantId: string,
    record: EvalRunRecord,
    progress: { done: number; total: number },
  ) => void;
}

/** Validates the options and plans the runs shared by every variant. */
function prepareRuns(options: Omit<RunEvaluationOptions, "config" | "onRecord">) {
  if (!Number.isInteger(options.k) || options.k < 1)
    throw new EvalRunRefusedError(`k must be a positive integer, got ${options.k}.`);
  const all = options.suite.suite.tasks;
  const selected = options.taskIds
    ? [...new Set(options.taskIds)].map((id) => {
        const found = all.find((t) => t.id === id);
        if (!found)
          throw new EvalRunRefusedError(
            `Unknown task "${id}" in suite "${options.suite.suite.suiteId}". Tasks: ${all.map((t) => t.id).join(", ")}.`,
          );
        return found;
      })
    : all;
  for (const task of selected)
    checkTaskPolicy(task, {
      invoker: options.invoker,
      ...(options.allowSuiteFull ? { allowSuiteFull: true } : {}),
    });
  const plan = planRuns(
    selected.map((t) => t.id),
    options.k,
    options.seedBase,
  );
  return { selected, plan };
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<RunEvaluationResult> {
  const { selected, plan } = prepareRuns(options);
  const records: EvalRunRecord[] = [];
  const keptDirs: string[] = [];
  for (const step of plan) {
    const task = selected.find((t) => t.id === step.taskId);
    if (!task) continue;
    const { record, keptDir } = await runOne(options, options.config, task, step.repetition);
    records.push(record);
    if (keptDir) keptDirs.push(keptDir);
    options.onRecord?.(record, { done: records.length, total: plan.length });
  }
  return { records, keptDirs };
}

/**
 * Runs several variants over the SAME plan, interleaved at each plan step (A,B then B,A ...)
 * instead of all of A and then all of B. The whole batch is refused up front like a single run.
 * Remaining drift: the runs of one step still happen one after another, so provider load can
 * change between A and B inside a step; interleaving spreads it, it does not control it.
 */
export async function runVariantEvaluations(
  options: RunVariantsOptions,
): Promise<Array<{ id: string } & RunEvaluationResult>> {
  const { selected, plan } = prepareRuns(options);
  const results = options.variants.map((variant) => ({
    id: variant.id,
    records: [] as EvalRunRecord[],
    keptDirs: [] as string[],
  }));
  const steps = interleaveVariants(
    plan,
    options.variants.map((v) => v.id),
  );
  let done = 0;
  for (const step of steps) {
    const task = selected.find((t) => t.id === step.taskId);
    const variant = options.variants.find((v) => v.id === step.variantId);
    const result = results.find((r) => r.id === step.variantId);
    if (!task || !variant || !result) continue;
    const { record, keptDir } = await runOne(options, variant.config, task, step.repetition);
    result.records.push(record);
    if (keptDir) result.keptDirs.push(keptDir);
    done += 1;
    options.onRecord?.(variant.id, record, { done, total: steps.length });
  }
  return results;
}

function runOne(
  options: Omit<RunEvaluationOptions, "onRecord" | "config">,
  config: Config,
  task: EvalTask,
  repetition: number,
) {
  return runTask(task, {
    suite: options.suite,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.cassetteFor ? cassetteOption(options.cassetteFor(task, repetition)) : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    config,
    seed: options.seedBase + repetition,
    repetition,
    invoker: options.invoker,
    ...(options.allowSuiteFull ? { allowSuiteFull: true } : {}),
    ...(options.keep ? { keep: true } : {}),
    ...(options.builtins ? { builtins: options.builtins } : {}),
    ...(options.resolveAgent ? { resolveAgent: options.resolveAgent } : {}),
    ...(options.tmpRoot ? { tmpRoot: options.tmpRoot } : {}),
  });
}

const cassetteOption = (cassette: CassetteRecorder | Cassette | undefined) =>
  cassette ? { cassette } : {};
