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
