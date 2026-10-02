/**
 * The `/goal` command line, parsed once for every surface (TUI, web, API). Pure.
 *
 *   /goal                         show the current goal
 *   /goal <objective> [budget=N]  create (or replace) the goal and start working on it
 *   /goal pause | resume | clear | help
 *   /goal edit [<objective>]      change the objective of the current goal
 *   /goal budget=50k              set the token budget of the current goal (budget=clear removes it)
 */
import { parseTokenBudget } from "./budget.ts";

/** The longest objective accepted, in characters (it is sent to the model on the kickoff). */
export const GOAL_OBJECTIVE_MAX = 4000;

export const GOAL_SUBCOMMANDS = ["pause", "resume", "edit", "clear", "help"] as const;

export type GoalCommand =
  | { type: "show" }
  | { type: "help" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" }
  /** `objective` is absent when the UI should ask for the new text. */
  | { type: "edit"; objective?: string }
  | { type: "budget"; tokens: number | null }
  | { type: "create"; objective: string; tokenBudget?: number }
  | { type: "error"; message: string };

const BUDGET_WORD = /^budget=(.*)$/i;

export const GOAL_USAGE =
  "Usage: /goal [<objective> [budget=50k]] | pause | resume | edit [<objective>] | clear | budget=<n|clear> | help";

/** Markdown help shown by `/goal help` (identical on every surface). */
export const GOAL_HELP = [
  "**/goal** keeps the agent working on one objective until it is done, blocked, paused or out of budget.",
  "",
  "- `/goal` shows the current goal.",
  "- `/goal <objective>` starts a goal (one per session; an existing goal is replaced after you confirm).",
  "- `/goal <objective> budget=50k` also sets a token budget (`50k`, `1.5M`, `250000`).",
  "- `/goal pause` stops the automatic continuation; `/goal resume` continues a paused or blocked goal.",
  "- `/goal edit <objective>` changes the objective; `/goal clear` removes the goal.",
  "- `/goal budget=50k` sets the token budget; `/goal budget=clear` (also `none`, `off`, `0`) removes it.",
  "",
  `The objective can be up to ${GOAL_OBJECTIVE_MAX} characters. Only you pause, resume, edit or clear a goal or change its budget; the agent marks it complete or blocked, with evidence.`,
  "The goal never widens permissions: approvals work as in a normal turn, and it never runs in plan mode.",
  "A goal without a token budget is limited only by its turn and time caps (`goal.maxTurns`, `goal.maxMinutes`).",
].join("\n");

/** Words of `args` split on whitespace, keeping the original spacing of the objective. */
export function parseGoalCommand(args: string): GoalCommand {
  const text = args.trim();
  if (!text) return { type: "show" };
  const words = text.split(/\s+/);
  // `budget=` words (anywhere) are options, never part of the objective.
  const budgets = words.filter((word) => BUDGET_WORD.test(word));
  if (budgets.length > 1)
    return { type: "error", message: "Give only one budget=: it appears more than once." };
  let tokens: number | null | undefined;
  if (budgets[0]) {
    const parsed = parseTokenBudget(BUDGET_WORD.exec(budgets[0])?.[1] ?? "");
    if (!parsed.ok) return { type: "error", message: parsed.error };
    tokens = parsed.tokens;
  }
  const rest = words.filter((word) => !BUDGET_WORD.test(word));
  const first = rest[0]?.toLowerCase();
  const subcommand = GOAL_SUBCOMMANDS.find((name) => name === first);
  if (!rest.length) return { type: "budget", tokens: tokens ?? null };
  if (subcommand) {
    if (tokens !== undefined)
      return {
        type: "error",
        message: `budget= goes with a new objective or alone (/goal budget=50k), not with /goal ${subcommand}.`,
      };
    if (subcommand === "edit") {
      const objective = text.slice(text.search(/\s/) + 1).trim();
      if (rest.length === 1) return { type: "edit" };
      return validateObjective(objective, (value) => ({ type: "edit", objective: value }));
    }
    if (rest.length > 1)
      return {
        type: "error",
        message: `/goal ${subcommand} takes no arguments. To start a goal whose objective begins with "${subcommand}", reword it.`,
      };
    return { type: subcommand };
  }
  // The objective keeps the user's own spacing and line breaks; only the budget word is removed.
  const objective = text
    .split(/(\s+)/)
    .filter((part) => !BUDGET_WORD.test(part))
    .join("")
    .trim();
  return validateObjective(objective, (value) => ({
    type: "create",
    objective: value,
    ...(typeof tokens === "number" ? { tokenBudget: tokens } : {}),
  }));
}

function validateObjective(objective: string, build: (value: string) => GoalCommand): GoalCommand {
  const error = objectiveError(objective);
  return error ? { type: "error", message: error } : build(objective.trim());
}

/** Why an objective is not acceptable (the same rule for the command and the API), if so. */
export function objectiveError(objective: string): string | undefined {
  const value = objective.trim();
  if (!value) return "The goal objective is empty.";
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    return "The goal objective contains control characters.";
  if (value.length > GOAL_OBJECTIVE_MAX)
    return `The goal objective is too long (${value.length} characters; the limit is ${GOAL_OBJECTIVE_MAX}).`;
  return undefined;
}
