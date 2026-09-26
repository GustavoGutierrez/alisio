/**
 * Pure, pi-tui-free reducer for the interactive question panel (`ask_user_question` / `/ask`).
 * Mirrors the `panel.ts` convention: state+action -> {state, effect}, fully unit-testable without
 * a TTY. Navigation wraps around (matching pi-tui's `SelectList`), never clamps. The question
 * specs are carried inside the state itself (set once by `initialQuestionState`) so the reducer
 * and the rendering component both stay self-contained from `state` alone.
 */

export interface QuestionOptionSpec {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface QuestionSpec {
  header: string;
  question: string;
  multiSelect?: boolean;
  options: QuestionOptionSpec[];
}

/** One question's recorded answer: which option indices, and whether it was skipped (Esc). */
export interface QuestionAnswer {
  skipped: boolean;
  indices: number[];
}

export interface QuestionPanelState {
  questions: QuestionSpec[];
  index: number;
  cursor: number;
  done: boolean;
  answers: Array<QuestionAnswer | undefined>;
  toggled: Set<number>;
}

export type QuestionAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "toggle" }
  | { type: "confirm" }
  | { type: "back" }
  | { type: "skip" };

export interface QuestionSubmitEffect {
  type: "submit";
  answers: Array<QuestionAnswer | undefined>;
}

export interface ReduceResult {
  state: QuestionPanelState;
  effect?: QuestionSubmitEffect;
}

const recommendedIndex = (spec: QuestionSpec): number => {
  const i = spec.options.findIndex((o) => o.recommended);
  return i >= 0 ? i : 0;
};

/**
 * Cursor/toggled to show when navigating (back/forward) into a question, restoring any prior
 * answer. A question with no prior answer starts with its recommended (or first) option already
 * highlighted; for a multi-select question that also means pre-toggled, so confirming without
 * touching anything records a deliberate choice rather than an accidental empty one. A skipped
 * prior answer restores to that same untouched default rather than remembering the empty choice.
 * `initialQuestionState` (the very first question of a fresh batch) intentionally does not
 * pre-toggle, so an explicit empty multi-select confirm stays distinguishable from skip there too.
 */
const restore = (spec: QuestionSpec, prior: QuestionAnswer | undefined) => {
  if (!prior || prior.skipped)
    return {
      cursor: recommendedIndex(spec),
      toggled: new Set<number>(prior ? [] : [recommendedIndex(spec)]),
    };
  return { cursor: prior.indices[0] ?? recommendedIndex(spec), toggled: new Set(prior.indices) };
};

export function initialQuestionState(questions: QuestionSpec[]): QuestionPanelState {
  const first = questions[0];
  return {
    questions,
    index: 0,
    cursor: first ? recommendedIndex(first) : 0,
    done: false,
    answers: questions.map(() => undefined),
    toggled: new Set<number>(),
  };
}

function advance(state: QuestionPanelState, answer: QuestionAnswer): ReduceResult {
  const answers = state.answers.slice();
  answers[state.index] = answer;
  const nextIndex = state.index + 1;
  if (nextIndex >= state.questions.length) {
    const done: QuestionPanelState = { ...state, answers, done: true };
    return { state: done, effect: { type: "submit", answers } };
  }
  const nextSpec = state.questions[nextIndex] as QuestionSpec;
  const { cursor, toggled } = restore(nextSpec, answers[nextIndex]);
  return { state: { ...state, index: nextIndex, cursor, toggled, answers, done: false } };
}

export function reduceQuestions(state: QuestionPanelState, action: QuestionAction): ReduceResult {
  if (state.done) return { state };
  const spec = state.questions[state.index] as QuestionSpec;
  switch (action.type) {
    case "up": {
      const cursor = (state.cursor - 1 + spec.options.length) % spec.options.length;
      return { state: { ...state, cursor } };
    }
    case "down": {
      const cursor = (state.cursor + 1) % spec.options.length;
      return { state: { ...state, cursor } };
    }
    case "toggle": {
      if (!spec.multiSelect) return { state };
      const toggled = new Set(state.toggled);
      if (toggled.has(state.cursor)) toggled.delete(state.cursor);
      else toggled.add(state.cursor);
      return { state: { ...state, toggled } };
    }
    case "confirm": {
      const indices = spec.multiSelect ? [...state.toggled].sort((a, b) => a - b) : [state.cursor];
      return advance(state, { skipped: false, indices });
    }
    case "skip":
      return advance(state, { skipped: true, indices: [] });
    case "back": {
      if (state.index === 0) return { state };
      const prevIndex = state.index - 1;
      const prevSpec = state.questions[prevIndex] as QuestionSpec;
      const { cursor, toggled } = restore(prevSpec, state.answers[prevIndex]);
      return { state: { ...state, index: prevIndex, cursor, toggled, done: false } };
    }
    default:
      return { state };
  }
}

export function truncateLabel(text: string, max = 50): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function summarizeAnswers(
  questions: QuestionSpec[],
  answers: Array<QuestionAnswer | undefined>,
): string {
  const lines = questions.map((spec, index) => {
    const answer = answers[index];
    if (!answer || answer.skipped) return `**${spec.header}:** _Skipped_`;
    if (answer.indices.length === 0) return `**${spec.header}:** _None selected_`;
    const chosen = answer.indices
      .map((i) => spec.options[i]?.label ?? "")
      .filter(Boolean)
      .map((label) => truncateLabel(label))
      .join(", ");
    return `**${spec.header}:** ${chosen}`;
  });
  return lines.join("\n");
}
