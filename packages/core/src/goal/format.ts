/**
 * English wording of goal states, reasons and waits, shared by the TUI and the text output of
 * the API commands. The web UI has its own EN/ES dictionaries for the same codes. Pure.
 */
import type { GoalAction, GoalInfo, GoalReason, GoalStatus, GoalWaiting } from "@alisio/sdk";
import { formatTokenCount } from "./budget.ts";

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  budget_limited: "Budget reached",
  complete: "Complete",
};

export const GOAL_WAITING_LABEL: Record<GoalWaiting, string> = {
  approval: "Waiting for permission",
  question: "Waiting for your answer",
  user_input: "Waiting for you to send or clear what you typed",
  plan_mode: "Waiting: plan mode is on (switch to the build agent)",
  background_tasks: "Waiting for background tasks",
};

const REASON_TEXT: Record<GoalReason, string> = {
  created: "Started",
  resumed: "Resumed",
  edited: "Objective edited",
  user_paused: "Paused by you",
  user_interrupt: "You interrupted the turn",
  model_complete: "The agent reports the goal complete",
  model_blocked: "The agent reports it cannot continue",
  policy_denied: "A permission was denied",
  run_error: "A turn failed",
  token_budget: "The token budget was reached",
  max_turns: "The turn limit was reached",
  max_wall: "The time limit was reached",
  no_progress: "No progress",
  restart: "Alisio restarted while the goal was running",
};

const DETAIL_TEXT: Record<string, string> = {
  repeated_reply: "the same reply repeated",
  no_tool_turns: "several turns without tool calls",
};

/** Why the goal is in its state, as one short sentence (empty when there is nothing to say). */
export function goalReasonText(goal: Pick<GoalInfo, "reason" | "detail">): string {
  if (!goal.reason) return "";
  const base = REASON_TEXT[goal.reason];
  if (!goal.detail) return base;
  return `${base}: ${DETAIL_TEXT[goal.detail] ?? goal.detail}`;
}

/** `45s`, `4m 12s`, `1h 05m`. */
export function formatGoalElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `12.3k / 50k tokens` or `12.3k tokens (no budget)`. */
export function goalTokensText(goal: Pick<GoalInfo, "tokensUsed" | "tokenBudget">): string {
  return goal.tokenBudget !== undefined
    ? `${formatTokenCount(goal.tokensUsed)} / ${formatTokenCount(goal.tokenBudget)} tokens`
    : `${formatTokenCount(goal.tokensUsed)} tokens (no budget)`;
}

const ACTION_HINT: Record<GoalAction, string> = {
  pause: "/goal pause",
  resume: "/goal resume",
  edit: "/goal edit",
  clear: "/goal clear",
  budget: "/goal budget=<n>",
};

/** The action hints of a state, e.g. `/goal pause · /goal edit · /goal clear`. */
export function goalActionHints(actions: readonly GoalAction[], budget = false): string {
  return actions
    .filter((action) => budget || action !== "budget")
    .map((action) => ACTION_HINT[action])
    .join(" · ");
}

/** `Active · 12.3k / 50k tokens · turn 3/50 · 4m 12s`. */
export function goalSummaryLine(goal: GoalInfo): string {
  return [
    GOAL_STATUS_LABEL[goal.status],
    goalTokensText(goal),
    `turn ${goal.turnsUsed}/${goal.maxTurns}`,
    formatGoalElapsed(goal.activeMs),
  ].join(" · ");
}

/** The status as Markdown (API commands and `/goal` with no arguments). */
export function formatGoalStatus(goal: GoalInfo): string {
  const lines = [
    `**Goal** · ${goalSummaryLine(goal)}`,
    "",
    `> ${goal.objective.replace(/\n/g, "\n> ")}`,
  ];
  const why = goal.waiting ? GOAL_WAITING_LABEL[goal.waiting] : goalReasonText(goal);
  if (why && !(goal.status === "active" && !goal.waiting)) lines.push("", why);
  if (goal.summary) lines.push("", `Agent's report: ${goal.summary}`);
  if (goal.evidence?.length)
    lines.push("", ...goal.evidence.map((item) => `- ${item.kind}: ${item.detail}`));
  const hints = goalActionHints(goal.actions, true);
  if (hints) lines.push("", hints);
  return lines.join("\n");
}
