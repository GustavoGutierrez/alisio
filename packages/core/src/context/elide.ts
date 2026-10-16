import type { Message } from "@alisio/sdk";
import { DEFAULT_READ_BYTES } from "../background/output.ts";
import { estimateTokens } from "../core/compaction.ts";
import {
  type CallInfo,
  describeCall,
  parseObject,
  resultText,
  segmentId,
  sha,
  stableStringify,
  WRITE_TOOLS,
} from "./util.ts";

/**
 * Deterministic elision by substitution (spec 012 phase 2). Pure functions over `Message[]`: they
 * never touch the persisted transcript, only compute what a request MAY send instead.
 */

/** Version of the elision rules. Bump it whenever a rule or a stub format changes. */
export const CONTEXT_POLICY_VERSION = 1;

export type ElisionReason = "superseded_read" | "stale_bg_output" | "duplicate_search";

export interface Elision {
  /** Index of the elided tool message in the projected history. */
  index: number;
  callId: string;
  /** Inventory id of the tool_result segment (same as `ContextSegment.id`). */
  segmentId: string;
  reason: ElisionReason;
  /** Call id of the EARLIEST later result that justifies the elision (stable under append). */
  witnessCallId: string;
  /** Token ESTIMATE saved (`estimateTokens` of the original text minus that of the stub). */
  tokensSaved: number;
}

export interface Projection {
  /** The input array itself when nothing is elided, else a copy with only elided entries replaced. */
  messages: Message[];
  elisions: Elision[];
  /** Estimate of the model-visible text of the history before and after the projection. */
  tokensBefore: number;
  tokensAfter: number;
  /** Messages `[0, boundary)` are eligible; the rest is sent as is until the next epoch. */
  boundary: number;
}

interface Entry {
  index: number;
  callId: string;
  call: CallInfo;
  text: string;
}

const READ_STUB_DEFAULT_START = 1;
const READ_STUB_DEFAULT_LIMIT = 200;
const HEAD_SHA = /^\{"path":"(?:[^"\\]|\\.)*","sha256":"([0-9a-f]{64})"/;

/** `sha256` of a read_file result, from the parsed JSON or (clipped results) from its head. */
function readSha(text: string): string | undefined {
  const value = parseObject(text)?.sha256;
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== undefined) return undefined;
  return HEAD_SHA.exec(text.slice(0, 4096))?.[1];
}

/** bg_output arguments with the tool's own defaults applied, as a comparison key. */
function bgKey(call: CallInfo): { id: string; offset: number; key: string } | undefined {
  const id = call.args?.id;
  if (typeof id !== "string") return undefined;
  const offset = typeof call.args?.offset === "number" ? call.args.offset : 0;
  const limit = typeof call.args?.limit === "number" ? call.args.limit : DEFAULT_READ_BYTES;
  return { id, offset, key: `${id}\0${offset}\0${limit}` };
}

/**
 * Hash of what a search found: the exit code and the ripgrep `match`/`context` lines. The summary
 * lines carry the elapsed time and would make identical searches look different. Text that is not
 * the expected shape is hashed as is.
 */
function searchHash(text: string): string {
  const out = parseObject(text);
  if (!out || typeof out.stdout !== "string" || typeof out.exitCode !== "number") return sha(text);
  const kept: string[] = [];
  for (const line of out.stdout.split("\n")) {
    if (line === "") continue;
    const event = parseObject(line);
    if (!event) return sha(text);
    if (event.type === "match" || event.type === "context") kept.push(line);
  }
  return sha(`${out.exitCode}\n${kept.join("\n")}`);
}

const searchKey = (e: Entry) =>
  `${e.call.args ? stableStringify(e.call.args) : e.call.arguments}\0${searchHash(e.text)}`;

/**
 * Which tool results a later result makes redundant, regardless of age. `witness` is the index of
 * the EARLIEST later result that proves it, so it never changes when messages are appended. Every
 * rule is existential ("some later result exists"), which is what makes the set grow monotonically.
 * Error results are neither candidates nor witnesses.
 */
export function elisionCandidates(
  messages: Message[],
): Map<number, { reason: ElisionReason; witness: number }> {
  return analyze(messages).candidates;
}

function analyze(messages: Message[]): {
  candidates: Map<number, { reason: ElisionReason; witness: number }>;
  entries: Map<number, Entry>;
} {
  const calls = new Map<string, CallInfo>();
  const entries: Entry[] = [];
  messages.forEach((m, index) => {
    if (m.role === "assistant") {
      for (const c of m.calls) calls.set(c.id, describeCall(c.name, c.arguments));
    } else if (m.role === "tool" && m.result.isError !== true) {
      const call = calls.get(m.callId);
      if (call) entries.push({ index, callId: m.callId, call, text: resultText(m) });
    }
  });

  const out = new Map<number, { reason: ElisionReason; witness: number }>();
  const byIndex = new Map(entries.map((e) => [e.index, e]));
  const byPath = new Map<string, Entry[]>();
  const byTask = new Map<string, Entry[]>();
  const bySearch = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.call.path) {
      const list = byPath.get(e.call.path) ?? [];
      list.push(e);
      byPath.set(e.call.path, list);
    } else if (e.call.name === "bg_output") {
      const id = bgKey(e.call)?.id;
      if (id !== undefined) byTask.set(id, [...(byTask.get(id) ?? []), e]);
    } else if (e.call.name === "search_text") {
      const key = searchKey(e);
      bySearch.set(key, [...(bySearch.get(key) ?? []), e]);
    }
  }

  for (const list of byPath.values()) {
    list.forEach((x, at) => {
      if (x.call.name !== "read_file") return;
      const shaX = readSha(x.text);
      const w = list.slice(at + 1).find((later) => {
        if (WRITE_TOOLS.has(later.call.name)) return true;
        if (later.call.name !== "read_file") return false;
        const shaW = readSha(later.text);
        return shaX !== undefined && shaW !== undefined && shaX !== shaW;
      });
      if (w) out.set(x.index, { reason: "superseded_read", witness: w.index });
    });
  }
  for (const list of byTask.values()) {
    list.forEach((x, at) => {
      const mine = bgKey(x.call);
      if (!mine) return;
      const emptyPoll = parseObject(x.text)?.text === "";
      const w = list
        .slice(at + 1)
        .find((later) => emptyPoll || bgKey(later.call)?.key === mine.key);
      if (w) out.set(x.index, { reason: "stale_bg_output", witness: w.index });
    });
  }
  for (const list of bySearch.values()) {
    list.forEach((x, at) => {
      const w = list[at + 1];
      if (w) out.set(x.index, { reason: "duplicate_search", witness: w.index });
    });
  }
  return { candidates: out, entries: byIndex };
}

/** JSON text restricted to printable ASCII on one line, so a stub never needs escaping again. */
const quote = (value: unknown) =>
  (JSON.stringify(value) ?? "null").replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** The replacement text. It depends only on the elided call's arguments and its own result head. */
function stubFor(reason: ElisionReason, x: Entry): string {
  if (reason === "superseded_read") {
    const { startLine, limit } = x.call.args ?? {};
    const window =
      typeof startLine === "number" || typeof limit === "number"
        ? ` lines ${typeof startLine === "number" ? startLine : READ_STUB_DEFAULT_START}+${
            typeof limit === "number" ? limit : READ_STUB_DEFAULT_LIMIT
          }`
        : "";
    return `[elided: read_file ${quote(x.call.path)}@${(readSha(x.text) ?? "unknown").slice(0, 8)}${window}; re-read to view]`;
  }
  if (reason === "stale_bg_output") {
    const mine = bgKey(x.call);
    return `[elided: bg_output ${quote(mine?.id)} offset ${mine?.offset ?? 0}; a later bg_output covers it]`;
  }
  return `[elided: search_text ${quote(x.call.args?.pattern)}; identical to a later result]`;
}

/** Estimated tokens of everything a message puts in front of the model. */
function visibleTokens(m: Message): number {
  if (m.role === "tool") return estimateTokens(resultText(m));
  if (m.role === "user") return estimateTokens(m.text);
  return estimateTokens(m.calls.reduce((text, c) => `${text}\n${c.name} ${c.arguments}`, m.text));
}

/**
 * Projects the history a request would carry: tool results that a later result made redundant are
 * replaced by a one-line stub once they are `minAgeTurns` assistant messages old (counted inside the
 * eligible prefix). With `epochMessages` E > 0 only the prefix `floor(n / E) * E` is eligible, so the
 * projected history grows by appending between epochs and a provider prompt cache stays valid.
 */
export function projectContext(
  messages: Message[],
  o: { minAgeTurns: number; epochMessages: number },
): Projection {
  const n = messages.length;
  const epoch = Number.isFinite(o.epochMessages) ? Math.max(0, Math.floor(o.epochMessages)) : 0;
  const minAge = Number.isFinite(o.minAgeTurns) ? Math.max(1, Math.floor(o.minAgeTurns)) : 1;
  const boundary = epoch > 0 ? Math.floor(n / epoch) * epoch : n;
  const prefix = boundary === n ? messages : messages.slice(0, boundary);
  const { candidates, entries } = analyze(prefix);
  const tokensBefore = messages.reduce((t, m) => t + visibleTokens(m), 0);
  if (candidates.size === 0)
    return { messages, elisions: [], tokensBefore, tokensAfter: tokensBefore, boundary };

  // Assistant messages after each index, inside the prefix.
  const assistantsAfter = new Array<number>(boundary).fill(0);
  let seen = 0;
  for (let i = boundary - 1; i >= 0; i--) {
    assistantsAfter[i] = seen;
    if (prefix[i]?.role === "assistant") seen++;
  }

  const elisions: Elision[] = [];
  let projected: Message[] | undefined;
  for (const [index, c] of [...candidates].sort(([a], [b]) => a - b)) {
    if ((assistantsAfter[index] ?? 0) < minAge) continue;
    const x = entries.get(index);
    const m = prefix[index];
    const w = prefix[c.witness];
    if (!x || m?.role !== "tool" || w?.role !== "tool") continue;
    const text = x.text;
    const stub = stubFor(c.reason, x);
    // Size guard: a stub that is not shorter would cost more than it saves. It depends on the
    // elided entry alone, so it never makes a decision flip under append.
    if (stub.length >= text.length) continue;
    projected ??= messages.slice();
    projected[index] = { ...m, result: { ...m.result, content: [{ type: "text", text: stub }] } };
    elisions.push({
      index,
      callId: m.callId,
      segmentId: segmentId("tool_result", m.callId, text),
      reason: c.reason,
      witnessCallId: w.callId,
      tokensSaved: estimateTokens(text) - estimateTokens(stub),
    });
  }
  if (!projected)
    return { messages, elisions: [], tokensBefore, tokensAfter: tokensBefore, boundary };
  const saved = elisions.reduce((t, e) => t + e.tokensSaved, 0);
  return {
    messages: projected,
    elisions,
    tokensBefore,
    tokensAfter: tokensBefore - saved,
    boundary,
  };
}
