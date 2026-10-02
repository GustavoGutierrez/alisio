/**
 * `/goal` in the terminal. Pure logic first (what a typed command does, the picker, the bar), then
 * the `GoalBar` component. The goal itself (state machine, caps, breakers, the one-continuation
 * claim) lives in `@alisio/core`; this module only decides what to SHOW and which action a command
 * means, so it can be tested without a terminal.
 */
import {
  formatGoalElapsed,
  formatGoalStatus,
  GOAL_HELP,
  GOAL_STATUS_LABEL,
  GOAL_USAGE,
  GOAL_WAITING_LABEL,
  type GoalCommand,
  goalActionHints,
  goalReasonText,
  goalTokensText,
} from "@alisio/core";
import type { GoalInfo } from "@alisio/sdk";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { style } from "./theme.ts";

/** What a typed `/goal …` means, given the session's current goal. */
export type GoalPlan =
  | { kind: "say"; text: string; tone: "info" | "notice" }
  /** `/goal` with a goal: the action picker. */
  | { kind: "picker" }
  /** `/goal <objective>` over an existing goal: ask before replacing it. */
  | { kind: "confirm-replace"; objective: string; tokenBudget?: number }
  | { kind: "create"; objective: string; tokenBudget?: number }
  | { kind: "act"; action: "pause" | "resume" | "clear" }
  | { kind: "edit"; objective: string }
  /** `/goal edit` without text: put the current objective in the editor to change it. */
  | { kind: "edit-prefill"; text: string }
  | { kind: "budget"; tokens: number | null };

export const NO_GOAL_TEXT = "This session has no goal. Start one with /goal <objective>.";
export const GOALS_OFF_TEXT = "Goals are turned off (goal.enabled).";

export function planGoalCommand(
  command: GoalCommand,
  context: { goal: GoalInfo | undefined; enabled: boolean },
): GoalPlan {
  const { goal } = context;
  const say = (text: string, tone: "info" | "notice" = "notice"): GoalPlan => ({
    kind: "say",
    text,
    tone,
  });
  switch (command.type) {
    case "error":
      return say(`${command.message}\n${GOAL_USAGE}`);
    case "help":
      return say(GOAL_HELP, "info");
    case "show":
      if (!goal) return say(`${NO_GOAL_TEXT}\n${GOAL_USAGE}`);
      return { kind: "picker" };
    case "create":
      if (!context.enabled) return say(GOALS_OFF_TEXT);
      return goal
        ? {
            kind: "confirm-replace",
            objective: command.objective,
            ...(command.tokenBudget ? { tokenBudget: command.tokenBudget } : {}),
          }
        : {
            kind: "create",
            objective: command.objective,
            ...(command.tokenBudget ? { tokenBudget: command.tokenBudget } : {}),
          };
    case "pause":
    case "resume":
    case "clear":
      return goal ? { kind: "act", action: command.type } : say(NO_GOAL_TEXT);
    case "edit":
      if (!goal) return say(NO_GOAL_TEXT);
      return command.objective === undefined
        ? { kind: "edit-prefill", text: `/goal edit ${goal.objective}` }
        : { kind: "edit", objective: command.objective };
    case "budget":
      return goal ? { kind: "budget", tokens: command.tokens } : say(NO_GOAL_TEXT);
  }
}

export interface GoalPickerItem {
  value: "status" | "pause" | "resume" | "edit" | "budget" | "clear" | "help";
  label: string;
  description: string;
}

/** The rows of `/goal` ("Start or manage the current Session Goal") for a goal in this state. */
export function goalPickerItems(goal: GoalInfo): GoalPickerItem[] {
  const items: GoalPickerItem[] = [
    {
      value: "status",
      label: "Show status",
      description: "Objective, usage and the agent's report",
    },
  ];
  if (goal.actions.includes("pause"))
    items.push({
      value: "pause",
      label: "Pause",
      description: "Stop continuing automatically (the current turn finishes)",
    });
  if (goal.actions.includes("resume"))
    items.push({
      value: "resume",
      label: "Resume",
      description:
        goal.reason === "max_turns" || goal.reason === "max_wall"
          ? "Continue with one more allowance of the limit that stopped it"
          : "Continue working on the goal",
    });
  items.push({ value: "edit", label: "Edit objective…", description: "Change the objective text" });
  items.push({
    value: "budget",
    label: goal.status === "budget_limited" ? "Raise budget…" : "Set token budget…",
    description: "e.g. 50k or 1.5M; budget=clear removes it",
  });
  items.push({
    value: "clear",
    label: "Clear goal",
    description: "Remove the goal from this session",
  });
  items.push({ value: "help", label: "Help", description: "Syntax and budget examples" });
  return items;
}

/** The editor text a picker row leaves for the user to finish (`undefined` = act at once). */
export function goalPickerPrefill(
  value: GoalPickerItem["value"],
  goal: GoalInfo,
): string | undefined {
  if (value === "edit") return `/goal edit ${goal.objective}`;
  if (value === "budget")
    return `/goal budget=${goal.tokenBudget !== undefined ? goal.tokenBudget : ""}`;
  return undefined;
}

export type GoalTone = "ok" | "warn" | "danger" | "done";

export function goalTone(goal: GoalInfo): GoalTone {
  switch (goal.status) {
    case "active":
      return "ok";
    case "complete":
      return "done";
    case "blocked":
      return "danger";
    default:
      return "warn";
  }
}

/** The one or two lines of the bar, unstyled; `width` only decides how the objective is cut. */
export function goalBarText(goal: GoalInfo): { head: string; detail: string } {
  const label = GOAL_STATUS_LABEL[goal.status];
  const why = goal.waiting
    ? GOAL_WAITING_LABEL[goal.waiting]
    : goal.status === "active"
      ? ""
      : goalReasonText(goal);
  const parts = [
    goalTokensText(goal),
    `turn ${goal.turnsUsed}/${goal.maxTurns}`,
    formatGoalElapsed(goal.activeMs),
    ...(why ? [why] : []),
    goalActionHints(goal.actions),
  ].filter(Boolean);
  return {
    head: `◎ Goal · ${label} · ${goal.objective.replace(/\s+/g, " ").trim()}`,
    detail: `  ${parts.join(" · ")}`,
  };
}

const TONE_STYLE: Record<GoalTone, (text: string) => string> = {
  ok: style.cyan,
  warn: style.yellow,
  danger: style.red,
  done: style.green,
};

/** The goal bar above the editor: nothing without a goal, two lines with one. */
export class GoalBar implements Component {
  constructor(private readonly goal: () => GoalInfo | undefined) {}
  invalidate(): void {}
  render(width: number): string[] {
    const goal = this.goal();
    if (!goal) return [];
    const { head, detail } = goalBarText(goal);
    const paint = TONE_STYLE[goalTone(goal)];
    return [
      truncateToWidth(style.bold(paint(head)), width),
      truncateToWidth(style.dim(detail), width),
    ];
  }
}

/** One transcript line when a goal stops by itself (the bar shows the same, but scrolls away). */
export function goalStopNotice(goal: GoalInfo): string | undefined {
  if (goal.status === "active") return undefined;
  const base = `Goal ${GOAL_STATUS_LABEL[goal.status].toLowerCase()}`;
  const why = goalReasonText(goal);
  const next =
    goal.status === "paused" || goal.status === "blocked"
      ? " · /goal resume to continue"
      : goal.status === "budget_limited"
        ? " · /goal budget=<n> to raise it"
        : "";
  return `${base}${why ? `: ${why}` : ""}${next}`;
}

export { formatGoalStatus };
