import { posix } from "node:path";
import type { ContextSegmentKind, Message } from "@alisio/sdk";
import { type CallInfo, describeCall, parseObject, resultText } from "./util.ts";

/**
 * Usage ledger of the Context Governor (spec 012 phase 4, section 3.4). It measures, per tool
 * result, whether the agent later acted on the same file path. The numbers are advisory and
 * heuristic: they never drive elision, they are never persisted, and they hold no content (only
 * normalized paths in memory, never in a summary).
 *
 * Pure and deterministic: the summary depends only on the sequence of histories handed to `record`
 * and on the workspace.
 */

export interface UsageCounts {
  observed: number;
  used: number;
}

export interface UsageSummary {
  /** Attributable results the model saw in full in a request older than the latest one. */
  observed: number;
  /** Of those, the ones a later call acted on (same path; re-reads excluded). */
  used: number;
  byKind: Partial<Record<ContextSegmentKind, UsageCounts>>;
  /** Per tool name, keys sorted. */
  byTool: Record<string, UsageCounts>;
  /** Results with no path to match (bg_output, web results, writes, errors, shell output...). */
  unattributed: number;
  /** Attributable results seen only in the latest request: not decidable yet. */
  pending: number;
  /** Results the model only ever saw as an elision stub (`on` mode). */
  stubOnly: number;
  /** Calls that re-read a path whose earlier read is still in the ledger. */
  rereads: number;
  /** Entries dropped by the size cap. */
  evicted: number;
}

export interface UsageLedgerOptions {
  workspace: string;
  /** Entries kept (default 4096); the oldest are evicted first. */
  maxEntries?: number;
  /** Keys kept per entry (default 32). */
  maxKeysPerEntry?: number;
  /** Paths a tool declares for an input (`ToolDefinition.paths`); may throw. */
  pathsOf?: (tool: string, args: Record<string, unknown>) => string[] | undefined;
  /** Whether a tool is side-effect free: only those results can be attributed by declared paths. */
  isRead?: (tool: string) => boolean;
}

export const usedRatio = (c: UsageCounts): number | undefined =>
  c.observed ? c.used / c.observed : undefined;

const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_MAX_KEYS = 32;

/** POSIX-normalized, workspace-relative when inside it, no `./`, no trailing `/`, case kept. */
export function normalizePath(path: string, workspace: string): string {
  let p = posix.normalize(path);
  const ws = posix.normalize(workspace).replace(/\/+$/, "");
  if (ws && p === ws) return ".";
  if (ws && p.startsWith(`${ws}/`)) p = p.slice(ws.length + 1);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

type PathsOf = UsageLedgerOptions["pathsOf"];

function declaredPaths(call: CallInfo, pathsOf: PathsOf): string[] {
  if (!call.args || !pathsOf) return [];
  try {
    return (pathsOf(call.name, call.args) ?? []).filter((p) => typeof p === "string");
  } catch {
    return [];
  }
}

const unique = (items: string[], max: number) => [...new Set(items)].slice(0, max);

/**
 * Keys that identify what a tool result is about, or undefined when it cannot be attributed.
 * `read_file`: its path. `list_files`: the listed files. `search_text`: the paths of the ripgrep
 * `match` lines (the `path` argument, often ".", is ignored). Other tools only through `isRead`
 * plus their declared `paths` (done by the ledger).
 */
export function attributionKeys(
  call: CallInfo,
  text: string,
  workspace: string,
  pathsOf?: PathsOf,
  maxKeys = DEFAULT_MAX_KEYS,
): string[] | undefined {
  let found: string[] = [];
  if (call.name === "read_file") {
    if (typeof call.args?.path === "string") found = [call.args.path];
  } else if (call.name === "list_files") {
    const files = parseObject(text)?.files;
    if (Array.isArray(files)) found = files.filter((f): f is string => typeof f === "string");
  } else if (call.name === "search_text") {
    const stdout = parseObject(text)?.stdout;
    if (typeof stdout === "string") {
      for (const line of stdout.split("\n")) {
        if (!line.includes('"match"')) continue;
        const event = parseObject(line);
        const data =
          event?.type === "match" ? (event.data as { path?: { text?: unknown } }) : undefined;
        if (typeof data?.path?.text === "string") found.push(data.path.text);
      }
    }
  } else {
    found = declaredPaths(call, pathsOf);
  }
  const keys = unique(
    found.map((p) => normalizePath(p, workspace)),
    maxKeys,
  );
  return keys.length > 0 ? keys : undefined;
}

/** What a later call names: its `path` argument, its declared paths and, for processes, the command. */
export function referencedPaths(
  call: CallInfo,
  workspace: string,
  pathsOf?: PathsOf,
): { paths: string[]; command?: string } {
  const raw = [...(typeof call.args?.path === "string" ? [call.args.path] : [])];
  raw.push(...declaredPaths(call, pathsOf));
  const paths = unique(
    raw.map((p) => normalizePath(p, workspace)),
    DEFAULT_MAX_KEYS,
  );
  if (call.name !== "run_process" && call.name !== "shell") return { paths };
  const args = call.args?.args;
  const command = [
    typeof call.args?.command === "string" ? call.args.command : "",
    ...(Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : []),
  ]
    .filter(Boolean)
    .join(" ");
  return { paths, ...(command ? { command } : {}) };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Heuristic: the key as a whole word of the command, delimited by whitespace, quotes and `=:(),;`. */
const inCommand = (command: string, key: string) =>
  command.includes(key) &&
  new RegExp(`(^|[\\s"'=:(])${escapeRegExp(key)}($|[\\s"'):,;])`).test(command);

interface Entry {
  callId: string;
  tool: string;
  observedAt: number;
  stubOnly: boolean;
  keys: string[];
  used: boolean;
}

export class UsageLedger {
  private readonly workspace: string;
  private readonly maxEntries: number;
  private readonly maxKeys: number;
  private readonly pathsOf: PathsOf;
  private readonly isRead: (tool: string) => boolean;
  /** Insertion order is eviction order. */
  private readonly entries = new Map<string, Entry>();
  /** key -> call ids of the entries that carry it. */
  private readonly index = new Map<string, Set<string>>();
  private readonly retired = new Set<string>();
  private seenCalls = new Set<string>();
  private latest = 0;
  private reread = 0;
  private evictedCount = 0;

  constructor(options: UsageLedgerOptions) {
    this.workspace = options.workspace;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxKeys = Math.max(1, options.maxKeysPerEntry ?? DEFAULT_MAX_KEYS);
    this.pathsOf = options.pathsOf;
    this.isRead = options.isRead ?? (() => true);
  }

  /** Number of seams recorded; the runner numbers the next one `seams + 1`. */
  get seams(): number {
    return this.latest;
  }

  /**
   * Feeds the history of one model request. `request` must grow on every call; `stubbed` holds the
   * call ids whose result the model got as an elision stub in this request.
   */
  record(request: number, history: Message[], stubbed: ReadonlySet<string>): void {
    this.latest = Math.max(this.latest, request);
    const calls = new Map<string, CallInfo>();
    const fresh: Array<{ id: string; call: CallInfo }> = [];
    const results: Array<Extract<Message, { role: "tool" }>> = [];
    for (const m of history) {
      if (m.role === "assistant") {
        for (const c of m.calls) {
          const info = describeCall(c.name, c.arguments);
          calls.set(c.id, info);
          if (!this.seenCalls.has(c.id)) fresh.push({ id: c.id, call: info });
        }
      } else if (m.role === "tool") results.push(m);
    }
    // (1) Credit the calls that are new at this seam against what was observed before it.
    for (const { id, call } of fresh) this.credit(id, call, request);
    this.seenCalls = new Set(calls.keys());
    // (2) Add the results not seen yet.
    for (const m of results) {
      if (this.entries.has(m.callId) || this.retired.has(m.callId)) continue;
      const call = calls.get(m.callId);
      const isError = m.result.isError === true;
      let keys: string[] | undefined;
      if (call && !isError && (this.isRead(call.name) || call.name === "read_file"))
        keys = attributionKeys(call, resultText(m), this.workspace, this.pathsOf, this.maxKeys);
      this.add({
        callId: m.callId,
        tool: call?.name ?? "tool",
        observedAt: request,
        stubOnly: stubbed.has(m.callId),
        keys: keys ?? [],
        used: false,
      });
    }
  }

  private add(entry: Entry): void {
    this.entries.set(entry.callId, entry);
    for (const key of entry.keys) {
      const ids = this.index.get(key) ?? new Set<string>();
      ids.add(entry.callId);
      this.index.set(key, ids);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
      this.evictedCount++;
    }
  }

  private drop(callId: string): void {
    const entry = this.entries.get(callId);
    if (!entry) return;
    this.entries.delete(callId);
    for (const key of entry.keys) {
      const ids = this.index.get(key);
      ids?.delete(callId);
      if (ids?.size === 0) this.index.delete(key);
    }
    this.retired.add(callId);
    if (this.retired.size > this.maxEntries) {
      const first = this.retired.values().next().value;
      if (first !== undefined) this.retired.delete(first);
    }
  }

  private credit(callId: string, call: CallInfo, request: number): void {
    const { paths, command } = referencedPaths(call, this.workspace, this.pathsOf);
    const hit = new Set<string>();
    for (const path of paths) for (const id of this.index.get(path) ?? []) hit.add(id);
    if (command)
      for (const [key, ids] of this.index) {
        if (inCommand(command, key) || inCommand(command, `${this.workspace}/${key}`))
          for (const id of ids) hit.add(id);
      }
    let counted = false;
    for (const id of hit) {
      const entry = this.entries.get(id);
      if (!entry || entry.observedAt >= request || entry.callId === callId || entry.stubOnly)
        continue;
      if (call.name === "read_file" && entry.tool === "read_file") {
        // A re-read of the same path is the model checking again, not acting on it.
        counted ||= true;
        continue;
      }
      entry.used = true;
    }
    if (counted) this.reread++;
  }

  summary(): UsageSummary {
    const byTool = new Map<string, UsageCounts>();
    let observed = 0;
    let used = 0;
    let unattributed = 0;
    let pending = 0;
    let stubOnly = 0;
    for (const e of this.entries.values()) {
      if (e.stubOnly) stubOnly++;
      else if (e.keys.length === 0) unattributed++;
      else if (e.observedAt >= this.latest) pending++;
      else {
        const counts = byTool.get(e.tool) ?? { observed: 0, used: 0 };
        counts.observed++;
        observed++;
        if (e.used) {
          counts.used++;
          used++;
        }
        byTool.set(e.tool, counts);
      }
    }
    const sorted = [...byTool].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      observed,
      used,
      byKind: observed > 0 || pending > 0 ? { tool_result: { observed, used } } : {},
      byTool: Object.fromEntries(sorted),
      unattributed,
      pending,
      stubOnly,
      rereads: this.reread,
      evicted: this.evictedCount,
    };
  }
}
