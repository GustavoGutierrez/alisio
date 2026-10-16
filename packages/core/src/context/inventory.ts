import type { Message } from "@alisio/sdk";
import { estimateTokens } from "../core/compaction.ts";
import { elisionCandidates } from "./elide.ts";
import type {
  ContextInventory,
  ContextSegment,
  ContextSegmentKind,
  Criticality,
  InventoryContext,
  InventoryTotal,
} from "./types.ts";
import { type CallInfo, describeCall, resultText, segmentId } from "./util.ts";

export { segmentId };

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
        const info = describeCall(c.name, c.arguments);
        calls.set(c.id, info);
        add(index, "tool_call", c.id, info.path ?? c.name, `${c.name} ${c.arguments}`);
      }
    } else {
      const text = resultText(m);
      const call = calls.get(m.callId);
      add(index, "tool_result", m.callId, call?.path ?? call?.name ?? "tool", text, {
        callId: m.callId,
        call,
        isError: m.result.isError === true,
        text,
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

/**
 * Assigns criticality and reason to every non-pinned draft (rules documented in spec 012 3.1).
 * What counts as redundant comes from `elisionCandidates`, the same predicate the projection uses,
 * so the explanation can never disagree with what `projectContext` elides.
 */
function classify(messages: Message[], drafts: Draft[]): void {
  const turnStart = lastTurnStart(messages);
  const results = drafts.filter((d) => d.result);
  const candidates = elisionCandidates(messages);
  const byIndex = new Map(results.map((d) => [d.index, d]));

  // Last tool_result per path (any outcome): the model's current view of that file.
  const lastForPath = new Map<string, Draft>();
  for (const d of results) {
    const path = d.result?.call?.path;
    if (path) lastForPath.set(path, d);
  }

  const redundancy = (d: Draft): string | undefined => {
    const c = candidates.get(d.index);
    const call = d.result?.call;
    if (!c || !call) return undefined;
    if (c.reason === "superseded_read") {
      const later = byIndex.get(c.witness)?.result?.call;
      return later && later.name !== "read_file"
        ? `superseded read: followed by ${later.name} on ${call.path}`
        : `superseded read: superseded by a later read of ${call.path} with a different sha256`;
    }
    if (c.reason === "stale_bg_output") return `older bg_output of task ${String(call.args?.id)}`;
    return "duplicate search_text with identical arguments and output";
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
      const redundant = redundancy(d);
      if (call?.path && lastForPath.get(call.path) === d)
        set("high", `latest result for ${call.path}`);
      else if (redundant) set("low", redundant);
      else set("normal", "ordinary tool result");
    } else if (s.kind === "user") set("normal", "user message (never elided)");
    else if (s.kind === "checkpoint") set("normal", "compaction checkpoint summary");
    else if (s.kind === "tool_call") set("normal", "tool call arguments are kept verbatim");
    else set("normal", "ordinary assistant text");
  }
}
