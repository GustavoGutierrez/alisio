/**
 * Pure state of the TUI `/btw` panel: a pending side question, its answer, and browsing earlier
 * answers of the session. The panel lives in the picker slot and never touches the transcript.
 *
 * Keys: ←/→ earlier/later answer, ↑/↓ (and PgUp/PgDn) scroll a long answer, Esc cancels a pending
 * question or closes the panel.
 */
import type { SideQuestionEntry } from "@alisio/sdk";
import { scrollWindow } from "./scroll.ts";

export const BTW_USAGE = "Usage: /btw <question>";
export const BTW_DESCRIPTION =
  "Ask a side question about the current session without adding to the conversation.";

export interface BtwState {
  entries: SideQuestionEntry[];
  /** Index of the entry on screen (ignored while `pending`). */
  index: number;
  /** A question waiting for its answer. */
  pending?: { question: string; startedAt: number };
  /** Why the last question failed (shown until the user navigates). */
  error?: { question: string; message: string };
  /** First answer line on screen. */
  scroll: number;
}
export type BtwAction =
  | { type: "prev" }
  | { type: "next" }
  | { type: "scroll"; lines: number }
  | { type: "answered"; entries: SideQuestionEntry[] }
  | { type: "failed"; message: string };

/** The browser for `/btw` without a question: the newest entry, or undefined when none. */
export function btwBrowser(entries: SideQuestionEntry[]): BtwState | undefined {
  return entries.length ? { entries, index: entries.length - 1, scroll: 0 } : undefined;
}
/** The panel while `question` is being answered (earlier entries stay browsable afterwards). */
export function btwPending(
  entries: SideQuestionEntry[],
  question: string,
  now = Date.now(),
): BtwState {
  return {
    entries,
    index: Math.max(0, entries.length - 1),
    pending: { question, startedAt: now },
    scroll: 0,
  };
}

export function reduceBtw(state: BtwState, action: BtwAction): BtwState {
  switch (action.type) {
    case "prev":
    case "next": {
      if (state.pending || !state.entries.length) return state;
      const step = action.type === "prev" ? -1 : 1;
      // Leaving an error shows the stored entries again (the newest first).
      const from = state.error ? state.entries.length : state.index;
      const index = Math.min(state.entries.length - 1, Math.max(0, from + step));
      if (index === state.index && !state.error) return state;
      return { entries: state.entries, index, scroll: 0 };
    }
    case "scroll":
      return { ...state, scroll: Math.max(0, state.scroll + action.lines) };
    case "answered":
      return {
        entries: action.entries,
        index: Math.max(0, action.entries.length - 1),
        scroll: 0,
      };
    case "failed": {
      const { pending: _pending, ...rest } = state;
      return {
        ...rest,
        error: { question: state.pending?.question ?? "", message: action.message },
        scroll: 0,
      };
    }
  }
}

/** The entry on screen, if the panel is not pending or showing an error. */
export function btwCurrent(state: BtwState): SideQuestionEntry | undefined {
  return state.pending || state.error ? undefined : state.entries[state.index];
}
/** "2/5" for the entry on screen; empty while pending or on an error. */
export function btwPosition(state: BtwState): string {
  return btwCurrent(state) ? `${state.index + 1}/${state.entries.length}` : "";
}
/** Footer hints for the current state. */
export function btwHints(state: BtwState, overflow: boolean): string {
  if (state.pending) return "Esc cancel";
  const current = btwCurrent(state);
  const hints = [
    ...(state.entries.length > 1 || (state.error && state.entries.length)
      ? ["←/→ earlier/later"]
      : []),
    ...(overflow ? ["↑/↓ scroll"] : []),
    "Esc close",
  ];
  return current || state.error ? hints.join(" · ") : "Esc close";
}
/** "model · 12 in · 3 out tokens" for an entry. */
export function btwUsageLine(entry: SideQuestionEntry): string {
  return `${entry.model} · ${entry.usage.input} in · ${entry.usage.output} out tokens${entry.truncated ? " · truncated" : ""}`;
}
/** The visible slice of `lines` for `scroll` (clamped) and whether more lines exist. */
export const btwWindow = scrollWindow;
