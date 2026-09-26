import { describe, expect, it } from "vitest";
import {
  initialQuestionState,
  type QuestionSpec,
  reduceQuestions,
  summarizeAnswers,
  truncateLabel,
} from "../packages/cli/src/tui/questions.ts";

const single: QuestionSpec = {
  header: "Style",
  question: "Which formatting style should we use?",
  options: [
    { label: "Tabs" },
    { label: "Spaces", recommended: true },
    { label: "Mixed", description: "Not recommended for this repo" },
  ],
};
const multi: QuestionSpec = {
  header: "Tools",
  question: "Which tools should the reviewer use?",
  multiSelect: true,
  options: [{ label: "Lint" }, { label: "Typecheck" }, { label: "Tests" }],
};

describe("initial state", () => {
  it("starts on the first question with the cursor on the recommended option", () => {
    const state = initialQuestionState([single, multi]);
    expect(state).toMatchObject({ index: 0, cursor: 1, done: false });
    expect(state.answers).toEqual([undefined, undefined]);
  });
  it("defaults the cursor to the first option when nothing is recommended", () => {
    expect(initialQuestionState([multi]).cursor).toBe(0);
  });
});

describe("navigation", () => {
  it("moves the cursor up and down, wrapping around (matching SelectList)", () => {
    let s = initialQuestionState([single]);
    ({ state: s } = reduceQuestions(s, { type: "down" }));
    expect(s.cursor).toBe(2);
    ({ state: s } = reduceQuestions(s, { type: "down" }));
    expect(s.cursor).toBe(0); // wrapped past the end
    ({ state: s } = reduceQuestions(s, { type: "up" }));
    expect(s.cursor).toBe(2); // wrapped past the start
  });
});

describe("single-select confirm", () => {
  it("records the focused option and advances to the next question", () => {
    let s = initialQuestionState([single, multi]);
    const r = reduceQuestions(s, { type: "confirm" });
    s = r.state;
    expect(r.effect).toBeUndefined();
    expect(s.index).toBe(1);
    expect(s.answers[0]).toEqual({ skipped: false, indices: [1] });
    expect(s.done).toBe(false);
  });
  it("emits submit with every answer on the last question", () => {
    let s = initialQuestionState([single]);
    const r = reduceQuestions(s, { type: "confirm" });
    expect(r.state.done).toBe(true);
    expect(r.effect).toEqual({ type: "submit", answers: [{ skipped: false, indices: [1] }] });
  });
  it("ignores toggle (Space/→) outside multiSelect mode", () => {
    const s0 = initialQuestionState([single]);
    const { state: s } = reduceQuestions(s0, { type: "toggle" });
    expect(s).toEqual(s0);
  });
});

describe("multi-select", () => {
  it("toggles options independently of cursor movement and confirms the toggled set", () => {
    let s = initialQuestionState([multi]);
    ({ state: s } = reduceQuestions(s, { type: "toggle" })); // toggle option 0
    ({ state: s } = reduceQuestions(s, { type: "down" }));
    ({ state: s } = reduceQuestions(s, { type: "down" }));
    ({ state: s } = reduceQuestions(s, { type: "toggle" })); // toggle option 2
    expect(s.toggled).toEqual(new Set([0, 2]));
    const r = reduceQuestions(s, { type: "confirm" });
    expect(r.effect).toEqual({ type: "submit", answers: [{ skipped: false, indices: [0, 2] }] });
  });
  it("allows confirming with nothing toggled (explicit empty answer, distinct from skip)", () => {
    const s = initialQuestionState([multi]);
    const r = reduceQuestions(s, { type: "confirm" });
    expect(r.effect).toEqual({ type: "submit", answers: [{ skipped: false, indices: [] }] });
  });
});

describe("skip (Esc)", () => {
  it("marks only the current question skipped and advances, never aborting the batch", () => {
    let s = initialQuestionState([single, multi]);
    const r1 = reduceQuestions(s, { type: "skip" });
    s = r1.state;
    expect(r1.effect).toBeUndefined();
    expect(s.answers[0]).toEqual({ skipped: true, indices: [] });
    expect(s.index).toBe(1);
    const r2 = reduceQuestions(s, { type: "confirm" });
    expect(r2.effect).toEqual({
      type: "submit",
      answers: [
        { skipped: true, indices: [] },
        { skipped: false, indices: [0] },
      ],
    });
  });
  it("skipping the last question still emits submit", () => {
    const r = reduceQuestions(initialQuestionState([single]), { type: "skip" });
    expect(r.state.done).toBe(true);
    expect(r.effect).toEqual({ type: "submit", answers: [{ skipped: true, indices: [] }] });
  });
});

describe("back navigation", () => {
  it("returns to the previous question restoring its prior answer, without erasing it", () => {
    let s = initialQuestionState([single, multi]);
    ({ state: s } = reduceQuestions(s, { type: "down" })); // cursor -> Mixed (index 2)
    ({ state: s } = reduceQuestions(s, { type: "confirm" })); // answers[0] = index 2, move to q2
    ({ state: s } = reduceQuestions(s, { type: "back" }));
    expect(s.index).toBe(0);
    expect(s.cursor).toBe(2); // restored, not reset to the recommended default
    expect(s.answers[0]).toEqual({ skipped: false, indices: [2] }); // not erased by going back
  });
  it("restores an empty toggled set when returning to a skipped question", () => {
    let s = initialQuestionState([single, multi]);
    ({ state: s } = reduceQuestions(s, { type: "skip" }));
    ({ state: s } = reduceQuestions(s, { type: "toggle" })); // toggle on q2 before going back
    ({ state: s } = reduceQuestions(s, { type: "back" }));
    expect(s.index).toBe(0);
    expect(s.toggled).toEqual(new Set());
  });
  it("is a no-op on the first question", () => {
    const s0 = initialQuestionState([single]);
    const { state: s } = reduceQuestions(s0, { type: "back" });
    expect(s).toEqual(s0);
  });
  it("lets the user change an earlier answer and re-confirm forward", () => {
    let s = initialQuestionState([single]);
    ({ state: s } = reduceQuestions(s, { type: "confirm" })); // recommended (index 1), done
    expect(s.done).toBe(true);
  });
});

describe("after done", () => {
  it("ignores further actions once the batch is complete", () => {
    const done = reduceQuestions(initialQuestionState([single]), { type: "confirm" }).state;
    const r = reduceQuestions(done, { type: "down" });
    expect(r.state).toBe(done);
    expect(r.effect).toBeUndefined();
  });
});

describe("answered summary", () => {
  it("truncates long labels with a trailing ellipsis", () => {
    expect(truncateLabel("short")).toBe("short");
    const long = "x".repeat(60);
    const truncated = truncateLabel(long, 20);
    expect(truncated).toHaveLength(20);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.startsWith("x".repeat(19))).toBe(true);
  });

  it("renders one line per question with the header and the chosen label(s)", () => {
    const text = summarizeAnswers(
      [single, multi],
      [
        { skipped: false, indices: [1] },
        { skipped: false, indices: [0, 2] },
      ],
    );
    expect(text).toContain("**Style:** Spaces");
    expect(text).toContain("**Tools:** Lint, Tests");
  });
  it("marks a skipped question distinctly and an empty multi-select as none selected", () => {
    const text = summarizeAnswers(
      [single, multi],
      [
        { skipped: true, indices: [] },
        { skipped: false, indices: [] },
      ],
    );
    expect(text).toContain("**Style:** _Skipped_");
    expect(text).toContain("**Tools:** _None selected_");
  });
  it("truncates a long chosen label in the summary", () => {
    const longOption: QuestionSpec = {
      header: "Plan",
      question: "q",
      options: [{ label: "y".repeat(80) }],
    };
    const text = summarizeAnswers([longOption], [{ skipped: false, indices: [0] }]);
    expect(text).toContain("…");
    expect(text).not.toContain("y".repeat(80));
  });
});
