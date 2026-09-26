/**
 * Pure presentation logic for the TUI: formatting, command parsing and the reduction of
 * versioned runner events into a view model. No terminal or pi-tui imports here.
 */
import type { Message, RunEvent } from "@alisio/sdk";

export type Level = "ok" | "warn" | "danger";

const trimZero = (value: string) => value.replace(/\.0$/, "");
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? trimZero(k.toFixed(1)) : Math.round(k)}k`;
  }
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}
export function contextLevel(pct: number): Level {
  return pct < 60 ? "ok" : pct < 85 ? "warn" : "danger";
}
export function contextPercent(used: number, total: number | undefined): number | undefined {
  return total && total > 0 ? (used / total) * 100 : undefined;
}
export function formatContext(used: number, total: number | undefined, estimated: boolean) {
  const prefix = `${estimated ? "~" : ""}${formatTokens(used)} / `;
  const pct = contextPercent(used, total);
  return pct === undefined || !total
    ? `${prefix}unknown`
    : `${prefix}${formatTokens(total)} (${Math.round(pct)}%)`;
}
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}
export const textWidth = (text: string) => [...text].length;
export function truncatePlain(text: string, width: number): string {
  if (width <= 0) return "";
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, width - 1).join("")}…`;
}
export function shortenPath(path: string, home: string, max = 40): string {
  let display =
    home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
  if (textWidth(display) <= max) return display;
  const parts = display.split("/").filter(Boolean);
  display = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = `${parts[i]}${display ? `/${display}` : ""}`;
    if (textWidth(`…/${next}`) > max && display) break;
    display = next;
  }
  return truncatePlain(`…/${display}`, max);
}
/** Host (and port) only: never path, query, user info or credentials. */
export function hostOf(baseURL: string): string {
  try {
    return new URL(baseURL).host || "unknown";
  } catch {
    return "unknown";
  }
}
export const shortId = (id: string) => id.slice(0, 8);

export interface Segment {
  text: string;
  priority: number;
}
/** Keeps segments in order, dropping the lowest priority ones until the line fits. */
export function fitSegments<T extends Segment>(
  segments: T[],
  width: number,
  separator: string,
): T[] {
  const kept = [...segments];
  const total = () =>
    kept.reduce((sum, s) => sum + textWidth(s.text), 0) +
    Math.max(0, kept.length - 1) * textWidth(separator);
  while (kept.length > 1 && total() > width) {
    let lowest = 0;
    for (let i = 1; i < kept.length; i++)
      if ((kept[i]?.priority ?? 0) < (kept[lowest]?.priority ?? 0)) lowest = i;
    kept.splice(lowest, 1);
  }
  const only = kept[0];
  if (kept.length === 1 && only && textWidth(only.text) > width)
    kept[0] = { ...only, text: truncatePlain(only.text, width) };
  return kept;
}

export interface CommandSpec {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}
export const COMMANDS: CommandSpec[] = [
  { name: "help", description: "Show commands and keys" },
  { name: "model", description: "Switch model (list or set directly)", argumentHint: "[id]" },
  { name: "compact", description: "Summarize older history", argumentHint: "[focus]" },
  { name: "stats", description: "Session statistics" },
  { name: "clear", description: "Start a new session", aliases: ["new"] },
  { name: "sessions", description: "List recent sessions" },
  { name: "resume", description: "Resume a session by ID or prefix", argumentHint: "<id>" },
  { name: "tools", description: "List tools and permission state" },
  { name: "copy", description: "Copy the last assistant response to the clipboard" },
  { name: "exit", description: "Exit Alisio", aliases: ["quit"] },
];
/** Every TUI slash name (commands, aliases and routing prefixes); templates cannot take them. */
export function reservedCommandNames(): string[] {
  return [...COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]), "command", "skill"];
}
export function resolveCommand(name: string): string | undefined {
  const lower = name.toLowerCase();
  return COMMANDS.find((c) => c.name === lower || c.aliases?.includes(lower))?.name;
}
export function parseCommand(input: string): { name: string; args: string } | undefined {
  const match = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match?.[1]) return undefined;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

function parseArgs(args: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(args);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
export function summarizeToolArgs(name: string, args: string): string {
  const input = parseArgs(args);
  if (!input) return truncatePlain(oneLine(args), 120);
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  let text: string;
  if (name === "run_process") {
    const rest = Array.isArray(input.args) ? input.args.map(String) : [];
    text = [str("command"), ...rest].join(" ");
  } else if (name === "search_text")
    text = `"${str("pattern")}"${str("path") ? ` in ${str("path")}` : ""}`;
  else {
    const key = ["path", "command", "name", "query", "pattern", "url", "title"].find((k) => str(k));
    text = key ? str(key) : Object.keys(input).length ? JSON.stringify(input) : "";
  }
  return truncatePlain(oneLine(text), 120);
}

export interface DiffLine {
  sign: "+" | "-";
  text: string;
}
export interface EditSummary {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}
const splitLines = (text: string) => {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
};
function diffLines(before: string[], after: string[]): DiffLine[] {
  if (before.length * after.length > 250_000)
    return [
      ...before.map((text) => ({ sign: "-" as const, text })),
      ...after.map((text) => ({ sign: "+" as const, text })),
    ];
  const n = before.length,
    m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        before[i] === after[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, lcs[i]?.[j + 1] ?? 0);
  const out: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      i++;
      j++;
    } else if (j >= m || (i < n && (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)))
      out.push({ sign: "-", text: before[i++] ?? "" });
    else out.push({ sign: "+", text: after[j++] ?? "" });
  }
  return out;
}
export function editSummary(name: string, args: string): EditSummary | undefined {
  if (name !== "edit_file" && name !== "write_file") return undefined;
  const input = parseArgs(args);
  if (!input) return undefined;
  const path = typeof input.path === "string" ? input.path : "";
  const lines =
    name === "write_file"
      ? splitLines(String(input.content ?? "")).map((text) => ({ sign: "+" as const, text }))
      : diffLines(splitLines(String(input.oldText ?? "")), splitLines(String(input.newText ?? "")));
  return {
    path,
    added: lines.filter((l) => l.sign === "+").length,
    removed: lines.filter((l) => l.sign === "-").length,
    lines,
  };
}

export type ToolStatus = "running" | "approval" | "ok" | "error";
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; reasoning: string; done: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: string;
      summary: string;
      status: ToolStatus;
      durationMs?: number;
      preview?: string;
    }
  | { kind: "notice"; text: string }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };
export interface Stats {
  input: number;
  output: number;
  cached: number;
  turns: number;
  runs: number;
  tools: Record<string, { calls: number; errors: number }>;
  models: string[];
  lastRunMs?: number;
  startedAt: number;
}
export interface ViewState {
  items: TranscriptItem[];
  streaming: boolean;
  compacting: boolean;
  model: string;
  /** Context size in tokens: provider-reported, or estimated (`~`). */
  context?: { used: number; estimated: boolean };
  runStartedAt?: number;
  stats: Stats;
}
export function initialViewState(model: string, now = Date.now()): ViewState {
  return {
    items: [],
    streaming: false,
    compacting: false,
    model,
    stats: {
      input: 0,
      output: 0,
      cached: 0,
      turns: 0,
      runs: 0,
      tools: {},
      models: [model],
      startedAt: now,
    },
  };
}
export function addItem(state: ViewState, item: TranscriptItem): ViewState {
  return { ...state, items: [...state.items, item] };
}
const withModel = (stats: Stats, model: unknown): Stats =>
  typeof model === "string" && model && !stats.models.includes(model)
    ? { ...stats, models: [...stats.models, model] }
    : stats;
function appendAssistant(state: ViewState, field: "text" | "reasoning", delta: string): ViewState {
  const last = state.items.at(-1);
  if (last?.kind === "assistant" && !last.done)
    return {
      ...state,
      items: [...state.items.slice(0, -1), { ...last, [field]: last[field] + delta }],
    };
  return addItem(state, {
    kind: "assistant",
    text: field === "text" ? delta : "",
    reasoning: field === "reasoning" ? delta : "",
    done: false,
  });
}
function updateTool(
  state: ViewState,
  id: unknown,
  update: Partial<Extract<TranscriptItem, { kind: "tool" }>>,
): ViewState {
  const index = state.items.findLastIndex((i) => i.kind === "tool" && i.id === id);
  const item = state.items[index];
  if (index < 0 || item?.kind !== "tool") return state;
  const items = [...state.items];
  items[index] = { ...item, ...update };
  return { ...state, items };
}
export function reduceEvent(state: ViewState, event: RunEvent): ViewState {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const at = Date.parse(event.timestamp);
  switch (event.type) {
    case "run_started":
      return {
        ...state,
        streaming: true,
        runStartedAt: at,
        stats: withModel({ ...state.stats, runs: state.stats.runs + 1 }, d.model),
      };
    case "text_delta":
      return appendAssistant(state, "text", String(d.delta ?? ""));
    case "reasoning_delta":
      return appendAssistant(state, "reasoning", String(d.delta ?? ""));
    case "turn_completed": {
      const usage = d.usage as
        | { input?: number; output?: number; cachedInput?: number }
        | undefined;
      const last = state.items.at(-1);
      const items =
        last?.kind === "assistant" && !last.done
          ? [...state.items.slice(0, -1), { ...last, done: true }]
          : state.items;
      const stats = withModel({ ...state.stats, turns: state.stats.turns + 1 }, d.model);
      if (!usage) return { ...state, items, stats };
      return {
        ...state,
        items,
        context: { used: (usage.input ?? 0) + (usage.output ?? 0), estimated: false },
        stats: {
          ...stats,
          input: stats.input + (usage.input ?? 0),
          output: stats.output + (usage.output ?? 0),
          cached: stats.cached + (usage.cachedInput ?? 0),
        },
      };
    }
    case "tool_started":
      return addItem(state, {
        kind: "tool",
        id: String(d.id ?? ""),
        name: String(d.name ?? "tool"),
        args: typeof d.arguments === "string" ? d.arguments : "",
        summary: summarizeToolArgs(
          String(d.name ?? ""),
          typeof d.arguments === "string" ? d.arguments : "",
        ),
        status: "running",
      });
    case "approval_requested":
      return updateTool(state, d.id, { status: "approval" });
    case "approval_resolved":
      return updateTool(state, d.id, { status: "running" });
    case "tool_completed": {
      const name = String(d.name ?? "tool");
      const current = state.stats.tools[name] ?? { calls: 0, errors: 0 };
      const next = updateTool(state, d.id, {
        status: d.isError ? "error" : "ok",
        ...(typeof d.durationMs === "number" ? { durationMs: d.durationMs } : {}),
        ...(typeof d.preview === "string" ? { preview: d.preview } : {}),
      });
      return {
        ...next,
        stats: {
          ...next.stats,
          tools: {
            ...next.stats.tools,
            [name]: { calls: current.calls + 1, errors: current.errors + (d.isError ? 1 : 0) },
          },
        },
      };
    }
    case "run_completed":
    case "run_failed":
    case "run_cancelled": {
      const ended = {
        ...state,
        streaming: false,
        compacting: false,
        stats: {
          ...state.stats,
          ...(state.runStartedAt !== undefined ? { lastRunMs: at - state.runStartedAt } : {}),
        },
      };
      if (event.type === "run_failed")
        return addItem(ended, { kind: "error", text: String(d.error ?? "Run failed") });
      if (event.type === "run_cancelled") {
        const reason = String(d.error ?? "cancelled");
        return addItem(ended, {
          kind: "notice",
          text: reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`,
        });
      }
      return ended;
    }
    case "compaction_started":
      return { ...state, compacting: true };
    case "compaction_completed": {
      const reports = Object.values((d.plugins ?? {}) as Record<string, { summary?: unknown }>)
        .map((r) => (typeof r?.summary === "string" ? r.summary : ""))
        .filter(Boolean);
      const checkpoint =
        typeof d.summarizedTokens === "number" && typeof d.checkpointTokens === "number"
          ? ` · checkpoint ~${formatTokens(d.summarizedTokens)} → ~${formatTokens(d.checkpointTokens)} tokens`
          : "";
      return addItem(
        {
          ...state,
          compacting: false,
          context: { used: Number(d.after ?? 0), estimated: true },
        },
        {
          kind: "notice",
          text: [
            `Context compacted (${String(d.reason ?? "manual")}): ${String(d.replaced ?? 0)} messages summarized, ~${formatTokens(Number(d.before ?? 0))} → ~${formatTokens(Number(d.after ?? 0))} tokens${checkpoint}`,
            ...reports,
          ].join("\n"),
        },
      );
    }
    case "plugin_hook_failed":
      return addItem(state, {
        kind: "notice",
        text: `Plugin ${String(d.source ?? "?")} ${String(d.hook ?? "hook")} failed: ${String(d.error ?? "unknown error")} (continued without it)`,
      });
    case "session_context_injected":
      return addItem(state, {
        kind: "notice",
        text: `Context injected by ${((d.sources as string[] | undefined) ?? ["plugin"]).join(", ")} (~${formatTokens(Number(d.tokens ?? 0))} tokens)`,
      });
    case "compaction_skipped":
      return addItem(
        { ...state, compacting: false },
        { kind: "notice", text: `Compaction skipped: ${String(d.detail ?? "nothing to compact")}` },
      );
    case "compaction_failed":
      return addItem(
        { ...state, compacting: false },
        { kind: "error", text: `Compaction failed: ${String(d.error ?? "unknown error")}` },
      );
    case "model_changed":
      return {
        ...state,
        model: String(d.model ?? state.model),
        stats: withModel(state.stats, d.model),
        items: [
          ...state.items,
          {
            kind: "notice",
            text: `Model: ${String(d.previous ?? "?")} → ${String(d.model ?? "?")}`,
          },
        ],
      };
    default:
      return state;
  }
}

export function lastAssistantText(items: TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "assistant" && item.text.trim()) return item.text;
  }
  return undefined;
}

/** Rebuilds transcript items from persisted history (used by /resume). */
export function itemsFromHistory(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const results = new Map<string, Extract<Message, { role: "tool" }>>();
  for (const m of messages) if (m.role === "tool") results.set(m.callId, m);
  for (const m of messages) {
    if (m.role === "user")
      items.push(
        m.summary ? { kind: "info", text: m.text } : { kind: "user", text: m.display ?? m.text },
      );
    else if (m.role === "assistant") {
      if (m.text) items.push({ kind: "assistant", text: m.text, reasoning: "", done: true });
      for (const c of m.calls) {
        const r = results.get(c.id);
        items.push({
          kind: "tool",
          id: c.id,
          name: c.name,
          args: c.arguments,
          summary: summarizeToolArgs(c.name, c.arguments),
          status: r?.result.isError ? "error" : "ok",
          preview: r?.result.content
            .map((x) => x.text)
            .join("\n")
            .slice(0, 2_000),
        });
      }
    }
  }
  return items;
}
