/**
 * TUI side of the plan review (Phase 2): the decision panel logic (options, Esc = skip, the
 * free-text mode, Enter submits), the panel as the terminal drives it, the plan printed in the
 * transcript and the Shift+Tab cycle staying blocked while a review is pending.
 */
import { PLAN_OPTIONS } from "@alisio/core";
import { describe, expect, it } from "vitest";
import { PlanReviewPanel } from "../packages/cli/src/tui/components.ts";
import { shiftTabDecision } from "../packages/cli/src/tui/modes.ts";
import {
  initialPlanReviewState,
  type PlanReviewAction,
  type PlanReviewEffect,
  type PlanReviewOption,
  planTranscriptMarkdown,
  reducePlanReview,
} from "../packages/cli/src/tui/plan-review.ts";

const options: PlanReviewOption[] = PLAN_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
  ...(o.recommended ? { recommended: true } : {}),
  ...(o.textInput ? { textInput: true } : {}),
}));
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

function run(actions: PlanReviewAction[]) {
  let state = initialPlanReviewState(options);
  let effect: PlanReviewEffect | undefined;
  for (const action of actions) {
    const next = reducePlanReview(state, action);
    state = next.state;
    effect = next.effect ?? effect;
  }
  return { state, effect };
}
const typed = (text: string): PlanReviewAction[] =>
  Array.from(text).map((char) => ({ type: "insert", text: char }));

describe("plan review reducer", () => {
  it("offers the three decisions with the recommended one under the cursor", () => {
    const state = initialPlanReviewState(options);
    expect(state.options.map((o) => o.label)).toEqual([
      "Agree and start implementation",
      "Skip for now",
      "Add context",
    ]);
    expect(state.cursor).toBe(0);
    expect(state.mode).toBe("choose");
  });

  it("Enter on the first option approves", () => {
    expect(run([{ type: "confirm" }]).effect).toEqual({ type: "submit", value: "approve" });
  });

  it("moves with wrap-around and confirms Skip for now", () => {
    expect(run([{ type: "down" }, { type: "confirm" }]).effect).toEqual({
      type: "submit",
      value: "skip",
    });
    expect(run([{ type: "up" }, { type: "confirm" }]).state.mode).toBe("text");
  });

  it("Esc while choosing is Skip for now", () => {
    expect(run([{ type: "down" }, { type: "down" }, { type: "escape" }]).effect).toEqual({
      type: "submit",
      value: "skip",
    });
  });

  it("Add context asks for text; Enter sends it; the answer carries the typed text", () => {
    const { state, effect } = run([
      { type: "down" },
      { type: "down" },
      { type: "confirm" },
      ...typed("Cover Windows too"),
      { type: "confirm" },
    ]);
    expect(effect).toEqual({ type: "submit", value: "context", text: "Cover Windows too" });
    expect(state.done).toBe(true);
  });

  it("an empty or blank context never submits", () => {
    const { effect, state } = run([
      { type: "up" },
      { type: "confirm" },
      ...typed("   "),
      { type: "confirm" },
    ]);
    expect(effect).toBeUndefined();
    expect(state.mode).toBe("text");
    expect(state.done).toBe(false);
  });

  it("Esc in the text field returns to the choices without skipping or losing the text", () => {
    const back = run([{ type: "up" }, { type: "confirm" }, ...typed("later"), { type: "escape" }]);
    expect(back.effect).toBeUndefined();
    expect(back.state.mode).toBe("choose");
    expect(back.state.text.value).toBe("later");
    const again = reducePlanReview(back.state, { type: "confirm" }).state;
    expect(again.mode).toBe("text");
    expect(again.text.value).toBe("later");
  });

  it("edits the text (cursor keys, backspace) and strips paste framing and control characters", () => {
    const { effect } = run([
      { type: "up" },
      { type: "confirm" },
      { type: "insert", text: "\x1b[200~abd\x1b[201~" },
      { type: "left" },
      { type: "insert", text: "c" },
      { type: "end" },
      { type: "backspace" },
      { type: "confirm" },
    ]);
    expect(effect).toEqual({ type: "submit", value: "context", text: "abc" });
  });

  it("ignores everything once decided", () => {
    const done = run([{ type: "confirm" }]).state;
    expect(reducePlanReview(done, { type: "down" })).toEqual({ state: done });
    expect(reducePlanReview(done, { type: "confirm" }).effect).toBeUndefined();
  });
});

describe("plan review panel as the terminal drives it", () => {
  const header = {
    title: "Add a flag",
    revision: 1,
    artifactId: "art_1",
    question: "Plan complete. What would you like to do?",
  };
  const panel = (onSubmit: (effect: PlanReviewEffect) => void, revision = 1) =>
    new PlanReviewPanel(options, { ...header, revision }, onSubmit, "Add context for the plan");

  it("renders the title, the three exact options, the artifact and the keys", () => {
    const text = panel(() => {})
      .render(80)
      .map(strip)
      .join("\n");
    expect(text).toContain("Plan complete. What would you like to do?");
    expect(text).toContain("❯ Agree and start implementation");
    expect(text).toContain("Skip for now");
    expect(text).toContain("Add context");
    expect(text).toContain("art_1");
    expect(text).toContain("Esc skip for now");
  });

  it("Enter approves, once: a second Enter after the decision does nothing", () => {
    const effects: PlanReviewEffect[] = [];
    const p = panel((effect) => effects.push(effect));
    p.handleInput(ENTER);
    p.handleInput(ENTER);
    expect(effects).toEqual([{ type: "submit", value: "approve" }]);
  });

  it("Esc skips", () => {
    const effects: PlanReviewEffect[] = [];
    panel((effect) => effects.push(effect)).handleInput(ESC);
    expect(effects).toEqual([{ type: "submit", value: "skip" }]);
  });

  it("types free text after Add context and submits it with Enter", () => {
    const effects: PlanReviewEffect[] = [];
    const p = panel((effect) => effects.push(effect), 2);
    p.handleInput(UP); // wraps to "Add context"
    p.handleInput(ENTER);
    expect(p.render(80).map(strip).join("\n")).toContain("Enter send");
    for (const char of "use pnpm") p.handleInput(char);
    expect(p.render(80).map(strip).join("\n")).toContain("use pnpm");
    p.handleInput(ENTER);
    expect(effects).toEqual([{ type: "submit", value: "context", text: "use pnpm" }]);
    expect(p.render(80).map(strip).join("\n")).toContain("revision 2");
  });

  it("arrow keys move between the options", () => {
    const effects: PlanReviewEffect[] = [];
    const p = panel((effect) => effects.push(effect));
    p.handleInput(DOWN);
    p.handleInput(ENTER);
    expect(effects).toEqual([{ type: "submit", value: "skip" }]);
  });
});

describe("plan in the transcript and the agent cycle", () => {
  it("prints the whole plan with its title (and the revision from the second one)", () => {
    expect(
      planTranscriptMarkdown({ title: "Flag", revision: 1, markdown: "# Plan\n1. Do it" }),
    ).toBe("**Plan: Flag**\n\n# Plan\n1. Do it");
    expect(planTranscriptMarkdown({ title: "Flag", revision: 3, markdown: "x" })).toContain(
      "(revision 3)",
    );
  });

  it("Shift+Tab never cycles while a review is pending: the run is busy and the panel owns the keys", () => {
    const SHIFT_TAB = "\x1b[Z";
    // The plan run is still running: blocked with a hint when no panel has the focus ...
    expect(
      shiftTabDecision(SHIFT_TAB, {
        busy: true,
        picker: false,
        autocomplete: false,
        panelFocused: false,
      }),
    ).toMatchObject({ type: "blocked" });
    // ... and with the review panel open (the picker slot) the key is left to the panel.
    expect(
      shiftTabDecision(SHIFT_TAB, {
        busy: true,
        picker: true,
        autocomplete: false,
        panelFocused: false,
      }),
    ).toEqual({ type: "ignore" });
    const effects: PlanReviewEffect[] = [];
    const p = new PlanReviewPanel(options, { title: "t", revision: 1, question: "q" }, (e) =>
      effects.push(e),
    );
    p.handleInput(SHIFT_TAB);
    expect(effects).toEqual([]);
  });
});
