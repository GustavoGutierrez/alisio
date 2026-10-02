/**
 * `get_goal` and `update_goal`: the model's two handles on the session goal. Both are OPT-IN
 * tools (`core/opt-in.ts`): a run only sees them while its session has an `active` goal and the
 * agent is not the plan agent, so their descriptions cost no tokens anywhere else. The model can
 * only report the goal `complete` or `blocked`, with evidence; pausing, resuming, editing,
 * clearing and the budget belong to the user and have no tool.
 *
 * `effect: "internal"`: reporting changes Alisio's own bookkeeping, never the workspace.
 */
import { type GoalEvidence, textResult } from "@alisio/sdk";
import type { ToolRegistry } from "../core/registry.ts";
import { formatTokenCount } from "../goal/budget.ts";
import type { GoalRecord } from "../goal/machine.ts";
import type { GoalService } from "../goal/service.ts";
import { objectSchema } from "./standard.ts";

export const GET_GOAL_TOOL = "get_goal";
export const UPDATE_GOAL_TOOL = "update_goal";

const KINDS = ["file", "test", "log", "command", "denied", "other"] as const;
const MAX_EVIDENCE = 20;
const MAX_DETAIL = 1000;
const MAX_SUMMARY = 2000;

/** The model-facing state (no internals, nothing the model could use to widen anything). */
function brief(goal: GoalRecord): Record<string, unknown> {
  return {
    status: goal.status,
    ...(goal.reason ? { reason: goal.reason } : {}),
    objective: goal.objective,
    tokens_used: goal.tokensUsed,
    ...(goal.tokenBudget !== undefined
      ? {
          token_budget: goal.tokenBudget,
          tokens_left: Math.max(0, goal.tokenBudget - goal.tokensUsed),
        }
      : { token_budget: null }),
    turns_used: goal.turnsUsed,
    max_turns: goal.maxTurns,
    minutes_used: Math.round(goal.activeMs / 60_000),
    max_minutes: Math.round(goal.maxWallMs / 60_000),
  };
}

/** Parses the evidence list defensively (the schema is advisory for some providers). */
export function parseEvidence(raw: unknown): GoalEvidence[] | string {
  if (!Array.isArray(raw) || !raw.length) return "evidence must list at least one item.";
  if (raw.length > MAX_EVIDENCE) return `evidence has more than ${MAX_EVIDENCE} items.`;
  const items: GoalEvidence[] = [];
  for (const entry of raw) {
    const item = entry as { kind?: unknown; detail?: unknown };
    const detail = typeof item?.detail === "string" ? item.detail.trim() : "";
    if (!detail) return "every evidence item needs a detail (a path, a test name, a log line).";
    const kind = KINDS.find((candidate) => candidate === item.kind) ?? "other";
    items.push({ kind, detail: detail.slice(0, MAX_DETAIL) });
  }
  return items;
}

export function registerGoalTools(registry: ToolRegistry, deps: { goals: GoalService }): void {
  const { goals } = deps;
  const sessionOf = (session: string | undefined): string => {
    if (!session) throw new Error("The goal tools need a session.");
    return session;
  };
  registry.register({
    name: GET_GOAL_TOOL,
    effect: "internal",
    description:
      "Read the session goal: objective, status and what is left of its budget and caps.",
    inputSchema: objectSchema({}),
    async execute(_input, context) {
      const goal = goals.get(sessionOf(context.session));
      if (!goal) return textResult(JSON.stringify({ status: "none" }));
      return textResult(JSON.stringify(brief(goal)));
    },
  });
  registry.register({
    name: UPDATE_GOAL_TOOL,
    effect: "internal",
    description:
      "Report the session goal complete or blocked. Needs evidence (files, tests, logs, commands). " +
      "Use complete only when the objective is fully met and verified. A blocker must be reported " +
      "again next turn before the goal stops, unless it is a permission denial (evidence kind denied). " +
      "You cannot pause, resume, edit or clear the goal or change its budget.",
    inputSchema: objectSchema(
      {
        status: { enum: ["complete", "blocked"] },
        summary: { type: "string", minLength: 1, maxLength: MAX_SUMMARY },
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: MAX_EVIDENCE,
          items: objectSchema(
            { kind: { enum: [...KINDS] }, detail: { type: "string", maxLength: MAX_DETAIL } },
            ["kind", "detail"],
          ),
        },
      },
      ["status", "summary", "evidence"],
    ),
    async execute(input, context) {
      const sessionId = sessionOf(context.session);
      const status =
        input.status === "complete" || input.status === "blocked" ? input.status : undefined;
      if (!status)
        return textResult(
          JSON.stringify({ ok: false, error: "status must be complete or blocked." }),
        );
      const summary =
        typeof input.summary === "string" ? input.summary.trim().slice(0, MAX_SUMMARY) : "";
      if (!summary) return textResult(JSON.stringify({ ok: false, error: "summary is required." }));
      const evidence = parseEvidence(input.evidence);
      if (typeof evidence === "string")
        return textResult(JSON.stringify({ ok: false, error: evidence }));
      const result = goals.report(sessionId, context.runId, { status, summary, evidence });
      if (!result.ok) return textResult(JSON.stringify({ ok: false, error: result.message }));
      if (status === "complete")
        return textResult(
          JSON.stringify({
            ok: true,
            status: "complete",
            note: "The goal is complete. Give the user a short final summary.",
          }),
        );
      return textResult(
        JSON.stringify(
          result.stopped
            ? {
                ok: true,
                status: "blocked",
                note: "The goal is blocked and will not continue until the user resumes it. Tell the user what you need.",
              }
            : {
                ok: true,
                status: "active",
                note: `Blocker recorded. If it still stands next turn, report it again with fresh evidence (${result.needed ?? 2} consecutive turns in total); otherwise keep working. Budget left: ${
                  result.goal.tokenBudget !== undefined
                    ? formatTokenCount(
                        Math.max(0, result.goal.tokenBudget - result.goal.tokensUsed),
                      )
                    : "no token budget"
                }.`,
              },
        ),
      );
    },
  });
}
