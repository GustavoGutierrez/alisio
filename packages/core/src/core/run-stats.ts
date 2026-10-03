/**
 * What a run that FAILED had already spent. `runner.run` resolves with its usage and tool-call
 * count, but a run that throws (a provider error, a timeout, the token-budget guard) loses them;
 * the goal controller still needs them (a run stopped by its own token cap must count as spent,
 * not as an error). The runner remembers them against the thrown error, outside of it (a
 * WeakMap), so no error object is changed.
 */
export interface RunStats {
  usage: { input: number; output: number };
  toolCalls: number;
  /** Active time of the run (waits for a person excluded). */
  activeMs?: number;
}

const STATS = new WeakMap<object, RunStats>();

export function attachRunStats(error: unknown, stats: RunStats): void {
  if (error && typeof error === "object") STATS.set(error, stats);
}

export function runStatsOf(error: unknown): RunStats | undefined {
  return error && typeof error === "object" ? STATS.get(error) : undefined;
}
