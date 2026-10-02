/**
 * Pure, pi-tui-free reducer of the plan review panel (`exit_plan`): three decisions and, for "Add
 * context", a one-line text field. Same convention as `questions.ts`: state + action ->
 * {state, effect}, fully testable without a terminal. Esc means "Skip for now" while choosing and
 * "back to the choices" while typing; Enter submits; an empty text never submits.
 */
import type { PlanDiagramInfo } from "@alisio/sdk";
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

/** Lines of Mermaid source the terminal shows per diagram (the full source is in the folder). */
export const DIAGRAM_SOURCE_LINES = 8;

/**
 * What the terminal shows for a plan's diagrams, as Markdown for the transcript: per diagram its
 * title, purpose, the plan section it illustrates, its explanation and the Mermaid source capped
 * to a few lines (no attempt to draw it), then where the plan folder is and how to open it.
 * Empty when the plan has no diagrams.
 */
export function planDiagramsMarkdown(plan: {
  revision: number;
  diagrams?: PlanDiagramInfo[];
  /** Display path of the plan folder on disk (absent when the plan could not be saved). */
  folder?: string;
}): string {
  const diagrams = plan.diagrams ?? [];
  if (!diagrams.length) return "";
  const blocks = diagrams.map((diagram, index) => {
    const lines = diagram.mermaid.split("\n");
    const shown = lines.slice(0, DIAGRAM_SOURCE_LINES);
    const more = lines.length - shown.length;
    const change =
      plan.revision > 1 && diagram.status !== "unchanged"
        ? ` · ${diagram.status === "new" ? "new" : "updated"} in revision ${plan.revision}`
        : "";
    const section = diagram.section ? ` · section: ${diagram.section}` : "";
    return [
      `**${index + 1}. ${diagram.title}** · ${diagram.type}${section}${change}`,
      diagram.explanation,
      "",
      "```mermaid",
      ...shown,
      "```",
      ...(more > 0
        ? [`_… ${more} more line${more === 1 ? "" : "s"} in diagrams/${diagram.id}.mmd_`]
        : []),
    ].join("\n");
  });
  return [
    `**Diagrams (${diagrams.length})** · drawn in the web plan viewer; the terminal shows their source`,
    ...blocks,
    plan.folder
      ? `Plan folder: \`${plan.folder}\` (plan.md, plan.json, diagrams/*.mmd). Open it from /artifacts.`
      : "The plan folder could not be saved, so these diagrams are only shown here.",
  ].join("\n\n");
}
