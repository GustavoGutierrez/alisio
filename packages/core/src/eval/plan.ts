/** Deterministic run planning of the reliability lab (specs/010 D6, D15). Pure. */

/** Deterministic PRNG in [0, 1) (same algorithm as `scripts/bench/lib.ts`). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlannedRun {
  taskId: string;
  repetition: number;
}

/**
 * Every (task, repetition) pair exactly once, in a seeded order so provider drift over time is not
 * correlated with one task. The same task ids, k and seed always give the same plan, whatever order
 * the ids were listed in: the variants of a comparison run the same plan.
 */
export function planRuns(taskIds: string[], k: number, seed: number): PlannedRun[] {
  const plan = [...taskIds]
    .sort()
    .flatMap((taskId) => Array.from({ length: k }, (_, repetition) => ({ taskId, repetition })));
  const random = mulberry32(seed);
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [plan[i], plan[j]] = [plan[j] as PlannedRun, plan[i] as PlannedRun];
  }
  return plan;
}

export interface VariantStep extends PlannedRun {
  variantId: string;
  /** Index of the plan step this run belongs to (every variant runs each step). */
  step: number;
}

/**
 * Expands a plan so every variant runs EVERY plan step, one after another, instead of all of A and
 * then all of B. The starting variant rotates with the step (A,B then B,A for two variants) so no
 * variant systematically goes first. This spreads provider drift over time across the variants
 * and keeps the same tasks, repetitions and seeds for each; it does not remove the drift (runs
 * still happen at different moments) and nothing is paired.
 */
export function interleaveVariants(plan: PlannedRun[], variantIds: string[]): VariantStep[] {
  const n = variantIds.length;
  return plan.flatMap((run, step) =>
    variantIds.map((_, offset) => ({
      variantId: variantIds[(step + offset) % n] as string,
      taskId: run.taskId,
      repetition: run.repetition,
      step,
    })),
  );
}
