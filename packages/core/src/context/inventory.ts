import { createHash } from "node:crypto";
import type { Message } from "@alisio/sdk";
import { estimateTokens } from "../core/compaction.ts";
import type {
  ContextInventory,
  ContextSegment,
  ContextSegmentKind,
  Criticality,
  InventoryContext,
  InventoryTotal,
} from "./types.ts";

const KINDS: ContextSegmentKind[] = [
  "system",
  "instructions",
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "checkpoint",
  "invariant",
  "memory",
  "other",
];
const CRITICALITIES: Criticality[] = ["pinned", "high", "normal", "low"];
/** Tools whose `path` argument names the file the call reads or changes. */
const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file"]);
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const segmentId = (kind: string, key: string | number, content: string) =>
  sha(`${kind}\0${key}\0${sha(content)}`).slice(0, 12);

interface CallInfo {
  name: string;
  arguments: string;
  /** Parsed JSON arguments when they form an object, else undefined. */
  args?: Record<string, unknown>;
  path?: string;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Key-order independent serialization, so equal arguments compare equal. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const resultText = (m: Extract<Message, { role: "tool" }>) =>
  m.result.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");

interface Draft {
  segment: ContextSegment;
  /** Index of the source message (-1 for context-provided segments). */
  index: number;
  /** For tool_result segments, the data the criticality rules need. */
  result?: {
    callId: string;
    call: CallInfo | undefined;
    isError: boolean;
    text: string;
    sha256: string | undefined;
  };
}

/**
 * Builds the explainable inventory of a message history: one segment per user message, assistant
 * text, tool call and tool result, plus one pinned segment per entry of `ctx`.
 *
 * Pure and deterministic. `tokens` are ESTIMATES from the shared `estimateTokens` heuristic
 * (about 4 characters per token), never provider-reported usage.
 *
 * "Last turn" means the last assistant message, every message after it (the tool results that
 * answer its calls) and any trailing user message. With no assistant message yet it is the last
 * user message alone. Everything in the last turn is `high`; this is what makes the history safe
 * to elide later without touching what the model is working on right now.
 */
export function buildInventory(messages: Message[], ctx: InventoryContext = {}): ContextInventory {
  const calls = new Map<string, CallInfo>();
  const drafts: Draft[] = [];
  const add = (
    index: number,
    kind: ContextSegmentKind,
    key: string | number,
    origin: string,
    content: string,
    extra?: Draft["result"],
  ) => {
    drafts.push({
      index,
      ...(extra ? { result: extra } : {}),
      segment: {
        id: segmentId(kind, key, content),
        kind,
        origin,
        tokens: estimateTokens(content),
        criticality: "normal",
      },
    });
  };

  const pinned = (kind: ContextSegmentKind, origin: string, items: string[], why: string) =>
    items.forEach((text, i) => {
      add(-1, kind, i, origin, text);
      const d = drafts.at(-1);
      if (d) {
        d.segment.criticality = "pinned";
        d.segment.reason = why;
      }
    });
  pinned("invariant", "invariants", ctx.invariants ?? [], "invariant that must survive compaction");
  pinned(
    "checkpoint",
    "checkpoint",
    ctx.checkpointInstructions ?? [],
    "instruction carried by the latest checkpoint",
  );
  pinned("instructions", "goal", ctx.goal ? [ctx.goal] : [], "active goal text");

  messages.forEach((m, index) => {
    if (m.role === "user") {
      add(
        index,
        m.summary ? "checkpoint" : "user",
        index,
        m.summary ? "checkpoint" : "user",
        m.text,
      );
    } else if (m.role === "assistant") {
      if (m.text || m.calls.length === 0) add(index, "assistant", index, "assistant", m.text);
      for (const c of m.calls) {
        const args = parseObject(c.arguments);
        const path =
          PATH_TOOLS.has(c.name) && typeof args?.path === "string" ? args.path : undefined;
        calls.set(c.id, {
          name: c.name,
          arguments: c.arguments,
          ...(args ? { args } : {}),
          ...(path ? { path } : {}),
        });
        add(index, "tool_call", c.id, path ?? c.name, `${c.name} ${c.arguments}`);
      }
    } else {
      const text = resultText(m);
      const call = calls.get(m.callId);
      const sha256 = parseObject(text)?.sha256;
      add(index, "tool_result", m.callId, call?.path ?? call?.name ?? "tool", text, {
        callId: m.callId,
        call,
        isError: m.result.isError === true,
        text,
        sha256: typeof sha256 === "string" ? sha256 : undefined,
      });
    }
  });

  classify(messages, drafts);

  const segments = drafts.map((d) => d.segment);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { count: 0, tokens: 0 }])) as Record<
    ContextSegmentKind,
    InventoryTotal
  >;
  const byCriticality = Object.fromEntries(
    CRITICALITIES.map((c) => [c, { count: 0, tokens: 0 }]),
  ) as Record<Criticality, InventoryTotal>;
  let totalTokens = 0;
  for (const s of segments) {
    totalTokens += s.tokens;
    byKind[s.kind].count++;
    byKind[s.kind].tokens += s.tokens;
    byCriticality[s.criticality].count++;
    byCriticality[s.criticality].tokens += s.tokens;
  }
  return { segments, totalTokens, byKind, byCriticality };
}

function lastTurnStart(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "assistant") return i;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
  return 0;
}

/** Assigns criticality and reason to every non-pinned draft (rules documented in spec 012 3.1). */
function classify(messages: Message[], drafts: Draft[]): void {
  const turnStart = lastTurnStart(messages);
  const results = drafts.filter((d) => d.result);

  // Last tool_result per path (any outcome): the model's current view of that file.
  const lastForPath = new Map<string, Draft>();
  for (const d of results) {
    const path = d.result?.call?.path;
    if (path) lastForPath.set(path, d);
  }

  // Older bg_output of the same task, and duplicate search_text (same arguments and output).
  const lastBg = new Map<string, Draft>();
  const lastSearch = new Map<string, Draft>();
  const searchKey = (d: Draft) => {
    const call = d.result?.call;
    if (call?.name !== "search_text") return undefined;
    const args = call.args ? stableStringify(call.args) : call.arguments;
    return `${args}\0${sha(d.result?.text ?? "")}`;
  };
  for (const d of results) {
    const call = d.result?.call;
    if (call?.name === "bg_output" && typeof call.args?.id === "string")
      lastBg.set(call.args.id, d);
    const key = searchKey(d);
    if (key) lastSearch.set(key, d);
  }

  // Superseded reads: a later read with a different sha256, or a later successful write/edit.
  const supersededRead = (d: Draft): string | undefined => {
    const call = d.result?.call;
    if (call?.name !== "read_file" || !call.path || d.result?.isError) return undefined;
    let latestRead: Draft | undefined;
    for (const later of results) {
      if (later.index <= d.index || later.result?.call?.path !== call.path || later.result.isError)
        continue;
      if (WRITE_TOOLS.has(later.result.call.name))
        return `followed by ${later.result.call.name} on ${call.path}`;
      if (later.result.call.name === "read_file") latestRead = later;
    }
    const a = d.result?.sha256;
    const b = latestRead?.result?.sha256;
    return a && b && a !== b
      ? `superseded by a later read of ${call.path} with a different sha256`
      : undefined;
  };

  for (const d of drafts) {
    const s = d.segment;
    if (s.criticality === "pinned") continue;
    const set = (criticality: Criticality, reason: string) => {
      s.criticality = criticality;
      s.reason = reason;
    };
    const inLastTurn = d.index >= turnStart;
    if (s.kind === "tool_result" && inLastTurn && d.result?.isError)
      set("high", "error result in the last turn");
    else if (inLastTurn) set("high", "part of the last turn");
    else if (s.kind === "tool_result") {
      const call = d.result?.call;
      const superseded = supersededRead(d);
      if (call?.path && lastForPath.get(call.path) === d)
        set("high", `latest result for ${call.path}`);
      else if (superseded) set("low", `superseded read: ${superseded}`);
      else if (
        call?.name === "bg_output" &&
        typeof call.args?.id === "string" &&
        lastBg.get(call.args.id) !== d
      )
        set("low", `older bg_output of task ${call.args.id}`);
      else if (searchKey(d) && lastSearch.get(searchKey(d) ?? "") !== d)
        set("low", "duplicate search_text with identical arguments and output");
      else set("normal", "ordinary tool result");
    } else if (s.kind === "user") set("normal", "user message (never elided)");
    else if (s.kind === "checkpoint") set("normal", "compaction checkpoint summary");
    else if (s.kind === "tool_call") set("normal", "tool call arguments are kept verbatim");
    else set("normal", "ordinary assistant text");
  }
}
