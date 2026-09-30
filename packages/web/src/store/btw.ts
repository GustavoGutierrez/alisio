/**
 * Pure model of the `/btw` side panel (never part of the transcript): intercepting `/btw` in the
 * composer, the pending question, the answer and browsing the session's earlier side answers.
 */
import type { CommandDescriptor, SideQuestionEntry } from "@alisio/sdk";
import { parseSlash } from "./composer.ts";

export const BTW_USAGE = "Usage: /btw <question>";

export interface BtwState {
  sessionId: string;
  entries: SideQuestionEntry[];
  /** Entry on screen (ignored while `pending`, on an error or on the usage line). */
  index: number;
  /** A question waiting for its answer. */
  pending?: { question: string; startedAt: number };
  /** Why the last question failed. */
  error?: { question: string; message: string };
  /** `/btw` without a question and without history: the panel shows the usage line. */
  usage?: boolean;
}

/**
 * `{question}` when `text` runs the built-in `/btw` (by name or alias, as the palette resolves
 * commands), else undefined. The question is empty for `/btw` alone.
 */
export function sideQuestionOf(
  text: string,
  commands: CommandDescriptor[],
): { question: string } | undefined {
  const slash = parseSlash(text);
  if (!slash) return undefined;
  const name = slash.name.toLowerCase();
  const known = commands.find(
    (c) => c.source === "builtin" && (c.name === name || c.aliases?.includes(name)),
  );
  return known?.name === "btw" ? { question: slash.args } : undefined;
}

/** The panel for `/btw` alone: the newest entry, or the usage line when there is none. */
export function browseSideQuestions(sessionId: string, entries: SideQuestionEntry[]): BtwState {
  return entries.length
    ? { sessionId, entries, index: entries.length - 1 }
    : { sessionId, entries, index: 0, usage: true };
}

export function pendingSideQuestion(
  sessionId: string,
  entries: SideQuestionEntry[],
  question: string,
  now = Date.now(),
): BtwState {
  return {
    sessionId,
    entries,
    index: Math.max(0, entries.length - 1),
    pending: { question, startedAt: now },
  };
}

/** The answer arrived: show it as the newest entry of the (refreshed) history. */
export function answeredSideQuestion(state: BtwState, entries: SideQuestionEntry[]): BtwState {
  return { sessionId: state.sessionId, entries, index: Math.max(0, entries.length - 1) };
}

export function failedSideQuestion(state: BtwState, message: string): BtwState {
  const { pending: _pending, ...rest } = state;
  return { ...rest, error: { question: state.pending?.question ?? "", message } };
}

/** One step through the history (`-1` earlier, `+1` later), clamped; ignored while pending. */
export function stepSideQuestion(state: BtwState, step: -1 | 1): BtwState {
  if (state.pending || !state.entries.length) return state;
  // Leaving an error goes back to the stored entries (the newest first).
  const from = state.error ? state.entries.length : state.index;
  const index = Math.min(state.entries.length - 1, Math.max(0, from + step));
  if (index === state.index && !state.error) return state;
  return { sessionId: state.sessionId, entries: state.entries, index };
}

/** The entry on screen, if any. */
export function currentSideQuestion(state: BtwState): SideQuestionEntry | undefined {
  return state.pending || state.error || state.usage ? undefined : state.entries[state.index];
}

/** Whether ←/→ can move from the current state. */
export function sideQuestionMoves(state: BtwState): { earlier: boolean; later: boolean } {
  if (state.pending || !state.entries.length) return { earlier: false, later: false };
  if (state.error) return { earlier: true, later: false };
  return { earlier: state.index > 0, later: state.index < state.entries.length - 1 };
}
