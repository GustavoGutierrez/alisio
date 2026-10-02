/**
 * Pure, pi-tui-free reducer of the plan review panel (`exit_plan`): three decisions and, for "Add
 * context", a one-line text field. Same convention as `questions.ts`: state + action ->
 * {state, effect}, fully testable without a terminal. Esc means "Skip for now" while choosing and
 * "back to the choices" while typing; Enter submits; an empty text never submits.
 */
import { type ConnectInputState, printableInput, reduceConnectInput } from "./connect-input.ts";

export interface PlanReviewOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
  /** Choosing it asks for free text first. */
  textInput?: boolean;
}

export interface PlanReviewState {
  options: PlanReviewOption[];
  cursor: number;
  mode: "choose" | "text";
  text: ConnectInputState;
  done: boolean;
}

export type PlanReviewAction =
  | { type: "up" | "down" | "confirm" | "escape" }
  | { type: "left" | "right" | "home" | "end" | "backspace" | "delete" }
  | { type: "insert"; text: string };

export interface PlanReviewEffect {
  type: "submit";
  /** The option value: `approve`, `skip` or `context`. */
  value: string;
  text?: string;
}

export const SKIP_VALUE = "skip";

export function initialPlanReviewState(options: PlanReviewOption[]): PlanReviewState {
  const recommended = options.findIndex((option) => option.recommended);
  return {
    options,
    cursor: recommended >= 0 ? recommended : 0,
    mode: "choose",
    text: { value: "", cursor: 0 },
    done: false,
  };
}

export function reducePlanReview(
  state: PlanReviewState,
  action: PlanReviewAction,
): { state: PlanReviewState; effect?: PlanReviewEffect } {
  if (state.done || !state.options.length) return { state };
  const option = state.options[state.cursor] as PlanReviewOption;
  if (state.mode === "text") {
    switch (action.type) {
      case "escape":
        return { state: { ...state, mode: "choose" } };
      case "confirm": {
        const text = state.text.value.trim();
        if (!text) return { state };
        return {
          state: { ...state, done: true },
          effect: { type: "submit", value: option.value, text },
        };
      }
      case "insert": {
        const text = printableInput(action.text);
        return text
          ? { state: { ...state, text: reduceConnectInput(state.text, { type: "insert", text }) } }
          : { state };
      }
      case "left":
      case "right":
      case "home":
      case "end":
      case "backspace":
      case "delete":
        return { state: { ...state, text: reduceConnectInput(state.text, { type: action.type }) } };
      default:
        return { state };
    }
  }
  switch (action.type) {
    case "up":
      return {
        state: {
          ...state,
          cursor: (state.cursor - 1 + state.options.length) % state.options.length,
        },
      };
    case "down":
      return { state: { ...state, cursor: (state.cursor + 1) % state.options.length } };
    case "confirm":
      if (option.textInput) return { state: { ...state, mode: "text" } };
      return { state: { ...state, done: true }, effect: { type: "submit", value: option.value } };
    case "escape":
      return { state: { ...state, done: true }, effect: { type: "submit", value: SKIP_VALUE } };
    default:
      return { state };
  }
}

/** The plan as the transcript shows it while the decision is pending. */
export function planTranscriptMarkdown(plan: {
  title: string;
  revision: number;
  markdown: string;
}): string {
  return `**Plan: ${plan.title}**${plan.revision > 1 ? ` (revision ${plan.revision})` : ""}\n\n${plan.markdown}`;
}
