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

export async function summarize(
  provider: ModelProvider,
  request: {
    instructions: string;
    messages: Message[];
    focus?: string;
    model?: string;
    maxOutputTokens: number;
    signal: AbortSignal;
  },
): Promise<string> {
  const focus = request.focus?.trim()
    ? `\n\nAdditional focus requested by the user: ${request.focus.trim()}`
    : "";
  const text = await completeText(provider, {
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
  });
  if (!text) throw new Error("Summarizer returned an empty summary");
  return text;
}

/** Narrow provider-agnostic completion used by compaction and the plugin model service. */
export async function completeText(
  provider: ModelProvider,
  request: CompletionRequest & { signal: AbortSignal },
): Promise<string> {
  let text = "",
    completed = false;
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
  })) {
    request.signal.throwIfAborted();
    if (event.type === "completed") {
      completed = true;
      text = event.message.text || text;
    } else if (event.type === "text_delta") text += event.delta;
  }
  if (!completed) throw new Error("Completion ended without a completed response");
  return text.trim();
}

export function summaryMessage(body: string, replaced: number): Message {
  return {
    role: "user",
    summary: true,
    text: `[Checkpoint of ${replaced} earlier messages, generated by context compaction]\n\n${body}`,
  };
}
