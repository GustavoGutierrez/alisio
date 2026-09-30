/**
 * `/btw` side questions: a question about a session answered by one separate, tool-less model
 * call that sees the session's active history, without becoming part of the conversation.
 *
 * Guarantees: nothing is written to `messages`, `tool_calls`, `runs`, the durable `events` or the
 * session usage, and the session lock is never claimed, so a side question may run while a run
 * is active (it has its own abort signal). The only thing persisted is this service's own
 * history, in `plugin_state` under the reserved namespace `core:btw` (plugin ids cannot contain
 * `:`, so no plugin can read or overwrite it), keyed by session id and capped to the newest
 * `SIDE_QUESTION_HISTORY_LIMIT` entries.
 */
import type { Message, SideQuestionEntry } from "@alisio/sdk";
import { serializeForSummary } from "../core/compaction.ts";
import type { AgentRunner } from "../core/runner.ts";

export type { SideQuestionEntry };
/** `plugin_state.plugin` value of the side-question history (never a valid plugin id). */
export const SIDE_QUESTIONS_NAMESPACE = "core:btw";
export const SIDE_QUESTION_HISTORY_LIMIT = 20;
export const SIDE_QUESTION_MAX_CHARS = 4_000;
/** The line every surface prints for `/btw` without a question and without any history. */
export const SIDE_QUESTION_USAGE = "Usage: /btw <question>";
export const SIDE_QUESTION_DESCRIPTION =
  "Ask a side question about the current session without adding to the conversation.";
/** Per-message clip of the transcript the side call sees (as in compaction summaries). */
const MAX_ITEM_CHARS = 4_000;

export const SIDE_QUESTION_INSTRUCTIONS = [
  "The user is asking a quick side question (/btw) about the session transcript below.",
  "It is NOT part of the conversation: answer it directly and concisely from the transcript and",
  "your general knowledge. You have no tools in this reply, so do not take or promise any",
  "action, do not continue the task and do not call tools; if the transcript does not contain",
  "the answer, say so briefly.",
].join(" ");

interface StateStore {
  getState(plugin: string, key: string): unknown;
  setState(plugin: string, key: string, value: unknown): void;
}
export interface SideQuestionsOptions {
  runner: Pick<AgentRunner, "sideContext">;
  /** Where the history lives (the SQLite store's `plugin_state`). */
  state: StateStore;
  now?: () => number;
  id?: () => string;
}

/**
 * The transcript lines for the side call, newest kept first: when the whole history does not fit
 * `budget` characters, the oldest messages are dropped (and counted in a leading marker). The
 * newest message alone is clipped from its start if it is still too large.
 */
export function sideTranscript(messages: Message[], budget: number): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Message;
    const text = serializeForSummary([message], MAX_ITEM_CHARS);
    if (used + text.length + 1 > budget) {
      if (lines.length) omitted = i + 1;
      else {
        // Even the newest message alone is too large: keep its end (the most recent part).
        lines.push(text.slice(Math.max(0, text.length - budget)));
        omitted = i;
      }
      break;
    }
    lines.unshift(text);
    used += text.length + 1;
  }
  if (omitted > 0) lines.unshift(`[${omitted} earlier messages omitted to fit the context budget]`);
  return lines.join("\n");
}

const isEntry = (value: unknown): value is SideQuestionEntry =>
  !!value &&
  typeof value === "object" &&
  typeof (value as SideQuestionEntry).id === "string" &&
  typeof (value as SideQuestionEntry).question === "string" &&
  typeof (value as SideQuestionEntry).answer === "string";

export class SideQuestions {
  private readonly now: () => number;
  private readonly newId: () => string;
  constructor(private readonly options: SideQuestionsOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.id ?? (() => crypto.randomUUID());
  }
  /** The session's side questions, oldest first (newest last). */
  history(sessionId: string): SideQuestionEntry[] {
    let stored: unknown;
    try {
      stored = this.options.state.getState(SIDE_QUESTIONS_NAMESPACE, sessionId);
    } catch {
      return [];
    }
    return Array.isArray(stored) ? stored.filter(isEntry) : [];
  }
  /**
   * Answers `question` about the session with one tool-less call of the session's model and
   * records it in the history. Throws on an empty or oversized question, on cancellation (the
   * signal's reason) and on provider failures (nothing is recorded then).
   */
  async ask(
    sessionId: string,
    question: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<SideQuestionEntry> {
    const text = question.trim();
    if (!text) throw new Error(SIDE_QUESTION_USAGE);
    if (text.length > SIDE_QUESTION_MAX_CHARS)
      throw new Error(`Side questions are limited to ${SIDE_QUESTION_MAX_CHARS} characters`);
    const side = await this.options.runner.sideContext(sessionId);
    const signal = AbortSignal.any([
      AbortSignal.timeout(side.timeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    const instructions = `${side.instructions}\n\n${SIDE_QUESTION_INSTRUCTIONS}`;
    // The request must fit both the char budget and (when known) the model window, leaving room
    // for the answer; ~3 chars per token keeps a conservative margin over the usual ~4.
    const windowChars = side.contextWindow
      ? Math.max(0, side.contextWindow - side.maxOutputTokens) * 3
      : Number.POSITIVE_INFINITY;
    const budget = Math.max(
      2_000,
      Math.min(side.maxContextChars, windowChars) - instructions.length - text.length - 200,
    );
    const transcript = sideTranscript(side.messages, budget);
    const prompt = transcript
      ? `<transcript>\n${transcript}\n</transcript>\n\nSide question: ${text}`
      : `(The session has no messages yet.)\n\nSide question: ${text}`;
    let answer = "";
    let completed = false;
    let truncated = false;
    let usage = { input: 0, output: 0 };
    try {
      for await (const event of side.provider.stream({
        instructions,
        messages: [{ role: "user", text: prompt }],
        tools: [],
        maxOutputTokens: side.maxOutputTokens,
        signal,
        model: side.model,
        sessionId,
        ...(side.reasoningEffort ? { reasoningEffort: side.reasoningEffort } : {}),
      })) {
        signal.throwIfAborted();
        if (event.type === "text_delta") answer += event.delta;
        else if (event.type === "completed") {
          completed = true;
          truncated = event.message.truncated === true;
          answer = event.message.text || answer;
          if (event.usage) usage = { input: event.usage.input, output: event.usage.output };
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw new Error(
        `Side question failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    signal.throwIfAborted();
    if (!completed) throw new Error("Side question failed: the provider did not complete");
    answer = answer.trim();
    if (!answer) throw new Error("Side question failed: the model returned an empty answer");
    const entry: SideQuestionEntry = {
      id: this.newId(),
      question: text,
      answer,
      model: side.model,
      usage,
      createdAt: this.now(),
      ...(truncated ? { truncated: true } : {}),
    };
    const next = [...this.history(sessionId), entry].slice(-SIDE_QUESTION_HISTORY_LIMIT);
    this.options.state.setState(SIDE_QUESTIONS_NAMESPACE, sessionId, next);
    return entry;
  }
}

/** Plain Markdown for one entry (`position` is 1-based): readline, API callers and `/btw`. */
export function formatSideQuestion(
  entry: SideQuestionEntry,
  position: number,
  total: number,
): string {
  return [
    `**btw ${position}/${total}** · ${entry.question.replace(/\s+/g, " ")}`,
    "",
    entry.answer,
    "",
    `_${entry.model} · ${entry.usage.input} in · ${entry.usage.output} out tokens${entry.truncated ? " · truncated" : ""}_`,
  ].join("\n");
}
