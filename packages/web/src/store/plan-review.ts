/**
 * Plan review (`exit_plan`) helpers of the web UI. Pure: which pending interaction is a plan
 * review, what each decision sends back to the server and which label a decision shows.
 * The decision travels over the normal interaction route as `{plan: <value>}` plus, for
 * "Add context", the free text under `"plan:text"` (see `PLAN_TEXT_KEY` in core).
 */
import type { PendingInteraction, PlanReview, Question } from "@alisio/sdk";
import type { MessageKey } from "../i18n/en.ts";

export type PlanChoice = "approve" | "skip" | "context";

export interface PlanReviewView {
  question: Question;
  plan: PlanReview;
}

/** The plan review of a pending interaction, or undefined for any other interaction. */
export function planReviewOf(interaction: PendingInteraction): PlanReviewView | undefined {
  const request = interaction.request;
  if (request.kind !== "questions" || !request.plan || request.questions.length !== 1)
    return undefined;
  const question = request.questions[0];
  return question ? { question, plan: request.plan } : undefined;
}

/** The answer object for a decision (`text` only travels with "Add context"). */
export function planAnswer(
  question: Pick<Question, "id">,
  choice: PlanChoice,
  text?: string,
): Record<string, string> {
  const trimmed = (text ?? "").trim();
  return choice === "context" && trimmed
    ? { [question.id]: choice, [`${question.id}:text`]: trimmed }
    : { [question.id]: choice === "context" ? "skip" : choice };
}

/** Option labels are localized by value; an unknown option keeps the label the server sent. */
export const OPTION_LABELS: Record<PlanChoice, MessageKey> = {
  approve: "plan.option.approve",
  skip: "plan.option.skip",
  context: "plan.option.context",
};
export const OPTION_HINTS: Record<PlanChoice, MessageKey> = {
  approve: "plan.option.approve.hint",
  skip: "plan.option.skip.hint",
  context: "plan.option.context.hint",
};
export const isPlanChoice = (value: string): value is PlanChoice => value in OPTION_LABELS;

/** The Markdown of an `exit_plan` call (its `plan` argument), once the JSON is complete. */
export function planFromArguments(args: string): { title?: string; plan: string } | undefined {
  try {
    const parsed = JSON.parse(args) as { title?: unknown; plan?: unknown };
    if (typeof parsed.plan !== "string" || !parsed.plan) return undefined;
    return {
      plan: parsed.plan,
      ...(typeof parsed.title === "string" && parsed.title ? { title: parsed.title } : {}),
    };
  } catch {
    return undefined;
  }
}
