import type { CompactionCheckpoint, CompletionRequest, Message, ModelProvider } from "@alisio/sdk";
import { z } from "zod";

/** Rough provider-agnostic estimate: ~4 characters per token. */
export function estimateTokens(value: string | Message[]): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

export function shouldCompact(used: number, window: number | undefined, threshold: number) {
  return !!window && window > 0 && used >= window * threshold;
}

/**
 * Declared context windows above this many tokens are treated as unknown for auto-compaction and
 * for the context bar: a `window * threshold` trigger would dwarf the char-budget fallback and
 * hide real pressure (e.g. an 8M-token window with a default 160k-char budget would never even
 * reach 2% before running out of space). Documented in docs/compaction.md.
 */
export const MAX_TRUSTED_WINDOW = 2_000_000;

export interface ContextBudget {
  /** Effective total in tokens the context bar and auto-compaction measure against. */
  total: number;
  /** What the total is derived from: the model window, or the char-budget fallback. */
  basis: "window" | "chars";
}

/**
 * The single effective budget shared by the runner's auto-compaction and the TUI context bar.
 * A known window (>= 1 token and <= MAX_TRUSTED_WINDOW) is used directly; otherwise the char
 * budget is converted to estimated tokens (about 4 characters per token) so the bar fills where
 * the char fallback actually compacts instead of showing an almost-empty bar next to an early
 * compaction (the DeepSeek ~1M-window vs 160k-char budget mismatch).
 */
export function effectiveContextBudget(
  window: number | undefined,
  maxContextChars: number,
): ContextBudget {
  if (window !== undefined && window > 0 && window <= MAX_TRUSTED_WINDOW)
    return { total: window, basis: "window" };
  return { total: Math.max(1, Math.round(maxContextChars / 4)), basis: "chars" };
}

/**
 * Whether to auto-compact before the next model call. Uses ONE effective budget: a known window
 * triggers at `used >= window * threshold`; an unknown or guard-bounded window falls back to the
 * char budget (`estimatedChars / 4 >= maxContextChars / 4`, keeping the old ~4-characters-per-token
 * protection). `used` (provider-reported when available) feeds the window branch and the context
 * bar; `estimatedChars` is the raw character count of the next request and feeds the fallback, so
 * a provider's token report can never push an unknown-window session into needless compaction.
 */
export function shouldCompactContext(
  used: number,
  estimatedChars: number,
  window: number | undefined,
  maxContextChars: number,
  threshold: number,
): boolean {
  const budget = effectiveContextBudget(window, maxContextChars);
  if (budget.basis === "window") return used >= budget.total * threshold;
  return estimatedChars / 4 >= budget.total;
}

export interface CompactionOptions {
  /** Recent user turns kept verbatim. */
  keepTurns?: number;
  /** Minimum trailing messages kept when falling back to a mid-turn boundary. */
  minKeepMessages?: number;
}
export interface CompactionPlan {
  cut: number;
  summarized: Message[];
  kept: Message[];
}

/**
 * Indexes where history can be split without separating an assistant tool call from its
 * results: every call before the index is answered before the index, and the kept part
 * does not start with a tool result.
 */
function boundaries(messages: Message[]): number[] | undefined {
  const open = new Set<string>();
  const valid: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (i > 0 && m.role !== "tool" && open.size === 0) valid.push(i);
    if (m.role === "assistant") for (const c of m.calls) open.add(c.id);
    if (m.role === "tool") open.delete(m.callId);
  }
  return open.size ? undefined : valid;
}

export function planCompaction(
  messages: Message[],
  options: CompactionOptions = {},
): CompactionPlan | undefined {
  const keepTurns = Math.max(0, options.keepTurns ?? 2),
    minKeep = Math.max(1, options.minKeepMessages ?? 4);
  const valid = boundaries(messages);
  if (!valid?.length) return undefined;
  // Turn starts: user messages at a safe boundary (the first message always is one).
  const turns = [
    ...(messages[0]?.role === "user" ? [0] : []),
    ...valid.filter((i) => messages[i]?.role === "user"),
  ];
  let cut = 0;
  if (keepTurns === 0) cut = messages.length;
  else if (turns.length > keepTurns) cut = turns.at(-keepTurns) ?? 0;
  // Fewer turns than requested: still keep the latest turn intact.
  else if (turns.length >= 2) cut = turns.at(-1) ?? 0;
  // Summarizing fewer than two messages gains nothing; inside one long turn, fall back to
  // the latest mid-turn boundary that keeps enough recent messages.
  if (cut < 2) {
    const fallback = valid.filter((i) => messages.length - i >= minKeep).at(-1);
    cut = fallback ?? 0;
  }
  if (cut < 2) return undefined;
  return { cut, summarized: messages.slice(0, cut), kept: messages.slice(cut) };
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}… [truncated]` : text;

/** Marker appended to message content cut by the context-budget reduction. */
export const TRUNCATION_MARKER = "… [truncated by context budget]";
/** Default per-message cap for kept tool result text after a failed compaction. */
export const MAX_TOOL_RESULT_CHARS = 8_000;
/** Default per-message cap for kept user/assistant text after a failed compaction. */
export const MAX_TEXT_CHARS = 16_000;

export interface MessageReductionOptions {
  /** Keep at most this many characters of text per tool result (default 8_000). */
  maxToolResultChars?: number;
  /** Keep at most this many characters per user/assistant text (default 16_000). */
  maxTextChars?: number;
}
export interface MessageReduction {
  messages: Message[];
  /** Number of messages whose content was truncated. */
  truncated: number;
}

/**
 * Cuts ONE message's content down to the given per-message caps. Returns the same reference when
 * nothing changes, so callers can detect a no-op by identity. See `reduceMessageSizes` for the
 * invariants (roles/callIds/boundaries untouched, summaries never truncated).
 */
function clampMessage(message: Message, maxToolResultChars: number, maxTextChars: number): Message {
  if (message.role === "user") {
    if (message.summary || message.text.length <= maxTextChars) return message;
    return { ...message, text: `${message.text.slice(0, maxTextChars)}\n${TRUNCATION_MARKER}` };
  }
  if (message.role === "assistant") {
    if (message.text.length <= maxTextChars) return message;
    return { ...message, text: `${message.text.slice(0, maxTextChars)}\n${TRUNCATION_MARKER}` };
  }
  let used = 0;
  let changed = false;
  const content = message.result.content.map((part) => {
    const room = maxToolResultChars - used;
    const text =
      room <= 0
        ? TRUNCATION_MARKER
        : part.text.length > room
          ? `${part.text.slice(0, room)}\n${TRUNCATION_MARKER}`
          : part.text;
    if (text !== part.text) {
      changed = true;
      used = maxToolResultChars;
    } else used += part.text.length;
    return { type: "text" as const, text };
  });
  return changed ? { ...message, result: { ...message.result, content } } : message;
}

/**
 * Cuts oversized retained content so the session fits the context-budget hard limit after a
 * compaction could not. Only message CONTENT changes (user/assistant `text` and the text parts
 * of tool results); roles, call IDs, order and message boundaries stay identical, so the
 * transcript remains valid and replayable and a tool call is never separated from its results.
 * Checkpoint summaries (`summary: true`) are bounded by design and never truncated.
 */
export function reduceMessageSizes(
  messages: Message[],
  options: MessageReductionOptions = {},
): MessageReduction {
  const maxToolResultChars = options.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS;
  const maxTextChars = options.maxTextChars ?? MAX_TEXT_CHARS;
  let truncated = 0;
  const reduced = messages.map((m) => {
    const cut = clampMessage(m, maxToolResultChars, maxTextChars);
    if (cut === m) return m;
    truncated++;
    return cut;
  });
  return truncated ? { messages: reduced, truncated } : { messages, truncated: 0 };
}

/** Descending per-round tool-result caps used by `reduceMessagesToBudget` by default. */
const DEFAULT_TOOL_CAP_ROUNDS = [MAX_TOOL_RESULT_CHARS, 4_096, 2_048, 1_024, 512];
/** Descending per-round user/assistant text caps used by `reduceMessagesToBudget` by default. */
const DEFAULT_TEXT_CAP_ROUNDS = [MAX_TEXT_CHARS, 8_192, 4_096, 2_048, 1_024];

/** A strictly descending cap sequence starting at `start`, followed by the smaller defaults. */
function capRounds(start: number, defaults: number[]): number[] {
  return [start, ...defaults.filter((c) => c < start)];
}

export interface BudgetReductionOptions extends MessageReductionOptions {
  /**
   * Descending per-round caps for tool result text, replacing the default
   * 8192 → 4096 → 2048 → 1024 → 512 sequence.
   */
  toolCapRounds?: number[];
  /**
   * Descending per-round caps for user/assistant text, replacing the default
   * 16384 → 8192 → 4096 → 2048 → 1024 sequence.
   */
  textCapRounds?: number[];
}

/**
 * Budget-based reduction: iteratively clips the LARGEST retained content (tool results in
 * practice, then long texts) in descending cap rounds until the serialized transcript fits
 * `targetChars` or the minimum caps are reached. Unlike `reduceMessageSizes` (which only clips
 * messages whose INDIVIDUAL size exceeds its cap), this also handles sessions with many MEDIUM
 * tool results (for example MCP outputs of a few thousand characters each) that stay under the
 * per-message caps but together exhaust the context budget.
 *
 * The invariants match `reduceMessageSizes`: only message content changes (roles, call IDs,
 * order and message boundaries stay identical, so a tool call is never separated from its
 * results), checkpoint summaries are never truncated, and every cut carries the
 * `… [truncated by context budget]` marker. Within a round the most expensive messages are
 * clipped first (ties by position), so the smallest number of changes achieves the target; the
 * order and the round caps make the result a deterministic total order of the input.
 */
export function reduceMessagesToBudget(
  messages: Message[],
  targetChars: number,
  options: BudgetReductionOptions = {},
): MessageReduction {
  const target = Math.max(1, Math.floor(targetChars));
  const toolCapRounds =
    options.toolCapRounds ??
    capRounds(options.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS, DEFAULT_TOOL_CAP_ROUNDS);
  const textCapRounds =
    options.textCapRounds ??
    capRounds(options.maxTextChars ?? MAX_TEXT_CHARS, DEFAULT_TEXT_CAP_ROUNDS);
  const rounds = Math.max(toolCapRounds.length, textCapRounds.length);
  // Working transcript; `messages` keeps the untouched originals for re-clipping each round.
  const working = [...messages];
  const sizeOf = (m: Message) => JSON.stringify(m).length;
  const sizes = working.map(sizeOf);
  // Serialized array length == sum of message lengths + n-1 commas + 2 brackets (+n+1 total).
  let size = sizes.reduce((a, b) => a + b, 0) + working.length + 1;
  if (size <= target) return { messages, truncated: 0 };
  const clipped = new Set<number>();
  for (let round = 0; round < rounds && size > target; round++) {
    const toolCap = toolCapRounds[Math.min(round, toolCapRounds.length - 1)];
    const textCap = textCapRounds[Math.min(round, textCapRounds.length - 1)];
    if (toolCap === undefined || textCap === undefined) break;
    let shrank = true;
    while (size > target && shrank) {
      shrank = false;
      // Largest (by current serialized size) clip-able message first; ties by position.
      let best = -1,
        bestSize = -1;
      for (let i = 0; i < working.length; i++) {
        const current = sizes[i];
        if (current === undefined || current <= bestSize) continue;
        const m = messages[i];
        if (!m) continue;
        const over =
          m.role === "user"
            ? !m.summary && m.text.length > textCap
            : m.role === "assistant"
              ? m.text.length > textCap
              : m.role === "tool" &&
                m.result.content.reduce((a, p) => a + p.text.length, 0) > toolCap;
        if (over) {
          best = i;
          bestSize = current;
        }
      }
      if (best < 0) break;
      const original = messages[best];
      const oldSize = sizes[best];
      if (!original || oldSize === undefined) break;
      // Re-clip from the ORIGINAL content so earlier markers are never embedded mid-result.
      const cut = clampMessage(original, toolCap, textCap);
      const newSize = sizeOf(cut);
      const delta = oldSize - newSize;
      sizes[best] = newSize;
      if (delta <= 0) continue; // already at this round's caps; no room to shrink further
      working[best] = cut;
      clipped.add(best);
      size -= delta;
      shrank = true;
    }
  }
  return clipped.size ? { messages: working, truncated: clipped.size } : { messages, truncated: 0 };
}

/**
 * Plain-text transcript used as summarizer input. Provider continuation data (for example
 * encrypted reasoning) is opaque and is intentionally not included.
 */
export function serializeForSummary(messages: Message[], maxItemChars = 4_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`${m.summary ? "PREVIOUS SUMMARY" : "USER"}: ${clip(m.text, maxItemChars)}`);
      // Attachments never reach the summarizer as bytes: only mime type and dimensions, as text.
      for (const a of m.attachments ?? [])
        lines.push(
          `ATTACHMENT: ${a.mimeType}${a.width && a.height ? ` ${a.width}x${a.height}` : ""}, ${a.bytes} bytes`,
        );
    } else if (m.role === "assistant") {
      if (m.text) lines.push(`ASSISTANT: ${clip(m.text, maxItemChars)}`);
      for (const c of m.calls)
        lines.push(`TOOL CALL ${c.id} ${c.name}: ${clip(c.arguments, maxItemChars)}`);
    } else {
      const text = m.result.content.map((c) => c.text).join("\n");
      lines.push(
        `TOOL RESULT ${m.callId}${m.result.isError ? " (error)" : ""}: ${clip(text, maxItemChars)}`,
      );
    }
  }
  return lines.join("\n");
}

const text = z.string().trim().max(4_000);
const list = z.array(text).max(40).default([]);
const checkpointSchema = z.object({
  goal: text.min(1),
  instructions: list,
  discoveries: list,
  accomplished: list,
  currentState: text.default(""),
  nextSteps: list,
  relevantFiles: list,
});

const section = (title: string, body: string | string[]) => {
  const content = Array.isArray(body)
    ? body.length
      ? body.map((b) => `- ${b}`).join("\n")
      : "- (none)"
    : body || "(none)";
  return `## ${title}\n${content}`;
};
export function renderCheckpoint(c: CompactionCheckpoint): string {
  return [
    section("Goal", c.goal),
    section("User instructions/constraints", c.instructions),
    section("Discoveries", c.discoveries),
    section("Accomplished", c.accomplished),
    section("Current state", c.currentState),
    section("Next steps", c.nextSteps),
    section("Relevant files", c.relevantFiles),
  ].join("\n\n");
}

/** Summarizer instructions: JSON checkpoint plus any extension-requested fields. */
export function checkpointInstructions(
  extraInstructions: string[] = [],
  fields: Record<string, string> = {},
): string {
  const extra = Object.entries(fields)
    .map(([name, description]) => `,\n "${name}": ${description}`)
    .join("");
  return [
    `You compress the history of a coding-agent session into a checkpoint that lets the agent
continue without the original messages. Reply with ONLY a JSON object (no prose):
{"checkpoint":{"goal":string,"instructions":string[],"discoveries":string[],"accomplished":string[],"currentState":string,"nextSteps":string[],"relevantFiles":string[]}${extra}}
"instructions" are the user's instructions and constraints. Keep file paths, symbols,
commands, tool call IDs and error messages exact. Do not invent facts. Be concise.`,
    ...extraInstructions.filter((x) => x.trim()),
  ].join("\n\n");
}

export interface CheckpointOutput {
  structured: boolean;
  checkpoint?: CompactionCheckpoint;
  /** Requested extension fields present in the JSON (unvalidated). */
  extracted: Record<string, unknown>;
  /** Rendered checkpoint, or the raw model text when the JSON was invalid. */
  text: string;
}
function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}
export function parseCheckpointOutput(raw: string, fields: string[] = []): CheckpointOutput {
  const fallback = { structured: false, extracted: {}, text: raw.trim() };
  let value: unknown;
  try {
    value = extractJson(raw);
  } catch {
    return fallback;
  }
  const parsed = z.object({ checkpoint: checkpointSchema }).passthrough().safeParse(value);
  if (!parsed.success) return fallback;
  const record = value as Record<string, unknown>;
  const extracted = Object.fromEntries(
    fields.filter((f) => f !== "checkpoint" && f in record).map((f) => [f, record[f]]),
  );
  const checkpoint = parsed.data.checkpoint;
  return { structured: true, checkpoint, extracted, text: renderCheckpoint(checkpoint) };
}

export interface TextCompletion {
  text: string;
  /** Provider reported an output-token cut (finish "length"): text may be partial. */
  truncated: boolean;
}

export async function summarize(
  provider: ModelProvider,
  request: {
    instructions: string;
    messages: Message[];
    focus?: string;
    model?: string;
    maxOutputTokens: number;
    signal: AbortSignal;
    sessionId?: string;
  },
): Promise<TextCompletion> {
  const focus = request.focus?.trim()
    ? `\n\nAdditional focus requested by the user: ${request.focus.trim()}`
    : "";
  let completion: TextCompletion;
  try {
    completion = await completeTextWithMeta(provider, {
      system: request.instructions,
      messages: [
        {
          role: "user",
          text: `Checkpoint this session transcript.${focus}\n\n<transcript>\n${serializeForSummary(request.messages)}\n</transcript>`,
        },
      ],
      maxTokens: request.maxOutputTokens,
      signal: request.signal,
      ...(request.model ? { model: request.model } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });
  } catch (error) {
    // The adapters report an empty "length" cut with a message about max output tokens.
    if (!request.signal.aborted && String(error).includes("max output tokens"))
      throw new Error(
        "Compaction summary was cut off before any usable text was produced; raise compaction.maxOutputTokens",
      );
    throw error;
  }
  if (completion.truncated && !completion.text)
    throw new Error(
      "Compaction summary was cut off before any usable text was produced; raise compaction.maxOutputTokens",
    );
  if (!completion.text) throw new Error("Summarizer returned an empty summary");
  return completion;
}

/** Narrow provider-agnostic completion used by compaction and the plugin model service. */
export async function completeText(
  provider: ModelProvider,
  request: CompletionRequest & { signal: AbortSignal; sessionId?: string },
): Promise<string> {
  return (await completeTextWithMeta(provider, request)).text;
}

/** Like `completeText`, but also reports whether the provider cut the response by tokens. */
async function completeTextWithMeta(
  provider: ModelProvider,
  request: CompletionRequest & { signal: AbortSignal; sessionId?: string },
): Promise<TextCompletion> {
  let text = "",
    completed = false,
    truncated = false;
  for await (const event of provider.stream({
    instructions: request.system,
    messages: request.messages.map((m) =>
      m.role === "user"
        ? { role: "user" as const, text: m.text }
        : { role: "assistant" as const, text: m.text, calls: [] },
    ),
    tools: [],
    maxOutputTokens: request.maxTokens ?? 2048,
    signal: request.signal,
    ...(request.model ? { model: request.model } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  })) {
    request.signal.throwIfAborted();
    if (event.type === "completed") {
      completed = true;
      truncated = event.message.truncated === true;
      text = event.message.text || text;
    } else if (event.type === "text_delta") text += event.delta;
  }
  if (!completed) throw new Error("Completion ended without a completed response");
  return { text: text.trim(), truncated };
}

export function summaryMessage(body: string, replaced: number): Message {
  return {
    role: "user",
    summary: true,
    text: `[Checkpoint of ${replaced} earlier messages, generated by context compaction]\n\n${body}`,
  };
}
