/**
 * Glue every host (TUI, web server) needs and must not write twice: turning what a run did into
 * the controller's `GoalRunOutcome`, and the opt-in tools a goal run offers the model.
 */
import { GOAL_TOOLS } from "../core/opt-in.ts";
import { runStatsOf } from "../core/run-stats.ts";
import { RunTimeoutError } from "../core/timeout.ts";
import type { GoalRecord, GoalRunOutcome } from "./machine.ts";

/** What `runner.run` resolves with (the parts the goal needs). */
export interface RunSummary {
  text: string;
  status: string;
  usage: { input: number; output: number };
  toolCalls?: number;
}

/**
 * The outcome of one run. `cancelled` is whether the run's abort signal fired (the user stopped
 * it, or the host is shutting down); a failed run carries its error; a provider timeout is flagged
 * so the goal does not block on something the runner already retried.
 */
export function goalOutcome(input: {
  runId: string;
  startedAt: number;
  endedAt: number;
  cancelled: boolean;
  result?: RunSummary;
  error?: unknown;
}): GoalRunOutcome {
  const { result, error } = input;
  const failed = error !== undefined && !input.cancelled;
  // A run that threw still spent tokens (the runner remembers them against the error).
  const stats = error !== undefined ? runStatsOf(error) : undefined;
  return {
    runId: input.runId,
    status: input.cancelled
      ? "cancelled"
      : failed
        ? "failed"
        : result?.status === "turns-exceeded"
          ? "turns-exceeded"
          : "completed",
    ...(failed ? { error: error instanceof Error ? error.message : String(error) } : {}),
    ...(failed && error instanceof RunTimeoutError ? { timedOut: true } : {}),
    usage: result?.usage ?? stats?.usage ?? { input: 0, output: 0 },
    text: result?.text ?? "",
    toolCalls: result?.toolCalls ?? stats?.toolCalls ?? 0,
    startedAt: input.startedAt,
    durationMs: Math.max(0, input.endedAt - input.startedAt),
  };
}

/**
 * The opt-in tools a run of this session gets: the goal tools while the goal is `active` and the
 * agent is not the plan agent (a plan run never works on a goal).
 */
export function goalOptInTools(goal: GoalRecord | undefined, planMode: boolean): string[] {
  return goal?.status === "active" && !planMode ? [...GOAL_TOOLS] : [];
}
