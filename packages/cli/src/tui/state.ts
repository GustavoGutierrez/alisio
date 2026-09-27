/**
 * Pure presentation logic for the TUI: formatting, command parsing and the reduction of
 * versioned runner events into a view model. No terminal or pi-tui imports here.
 */
import type { Message, ModelInfo, RunEvent } from "@alisio/sdk";

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

/** Prefixes every model with its owning provider so identical model ids are never ambiguous. */
export function providerModelItems(provider: string, models: ModelInfo[], current?: string) {
  return models.map((model) => ({
    value: model.id,
    label: `${provider} · ${model.name ?? model.id}${model.id === current ? " (current)" : ""}`,
    ...(model.contextWindow
      ? { description: `${model.id} · ${formatTokens(model.contextWindow)} context` }
      : model.name
        ? { description: model.id }
        : {}),
  }));
}
export interface ProviderCatalogView {
  profile: string;
  provider: string;
  title: string;
  configuredModel: string;
  models: ModelInfo[];
  unavailable: boolean;
}
export interface ConfiguredProviderModelItem {
  value: string;
  label: string;
  description: string;
  unavailable: boolean;
}
export interface PluginCatalogView {
  id: string;
  name: string;
  description: string;
  categories: string[];
  builtin: boolean;
  source: string;
  status: "active" | "inactive" | "failed" | "restart-required";
  enabled: boolean;
  manageable: boolean;
  diagnostic?: string;
}
/** Text markers remain meaningful without color: [x] active, [ ] inactive, [!] failed, [*] pending. */
/** Group headings are derived from the primary category (or "General") of each plugin. */
export function pluginCatalogItems(entries: PluginCatalogView[]) {
  const marker = (entry: PluginCatalogView) =>
    entry.status === "active"
      ? "[x]"
      : entry.status === "inactive"
        ? "[ ]"
        : entry.status === "failed"
          ? "[!]"
          : "[*]";
  const grouped = new Map<string, PluginCatalogView[]>();
  for (const entry of entries) {
    const primary = entry.categories[0] ?? "General";
    grouped.set(primary, [...(grouped.get(primary) ?? []), entry]);
  }
  return [...grouped].flatMap(([title, group]) =>
    group.map((entry, index) => ({
      value: entry.id,
      label: `${index === 0 ? `${title} · ` : ""}${marker(entry)} ${entry.name} · ${entry.builtin ? "built-in" : entry.source}`,
      description: `${entry.status}${entry.categories.length ? ` · ${entry.categories.join(", ")}` : ""} · ${entry.description}`,
    })),
  );
}
export const pluginToggleNeedsConfirmation = (entry: PluginCatalogView): boolean => !entry.builtin;
export interface McpServerView {
  name: string;
  displayName: string;
  source: { kind: "global" | "project" | "explicit" | "builtin" | "plugin" };
  status:
    | "disabled"
    | "disconnected"
    | "connecting"
    | "connected"
    | "failed"
    | "needs-authentication"
    | "restart-required";
  enabled: boolean;
  runtimePermission: "granted" | "not-granted" | "read-only";
  counts: { tools: number };
}
const mcpSourceTitle = (kind: McpServerView["source"]["kind"]) =>
  ({
    global: "User",
    project: "Project",
    explicit: "Explicit",
    builtin: "Built-in",
    plugin: "Plugin",
  })[kind];
/** Group headings are generated only for sources that actually registered servers. */
export function mcpServerItems(entries: McpServerView[]) {
  const marker = (status: McpServerView["status"]) =>
    ({
      disabled: "[ ]",
      disconnected: "[-]",
      connecting: "[…]",
      connected: "[x]",
      failed: "[!]",
      "needs-authentication": "[?]",
      "restart-required": "[*]",
    })[status];
  const grouped = new Map<string, McpServerView[]>();
  for (const entry of entries) {
    const title = mcpSourceTitle(entry.source.kind);
    grouped.set(title, [...(grouped.get(title) ?? []), entry]);
  }
  return [...grouped].flatMap(([title, servers]) =>
    servers.map((entry, index) => ({
      value: entry.name,
      label: `${index === 0 ? `${title} · ` : ""}${marker(entry.status)} ${entry.displayName}`,
      description: `configured ${entry.enabled ? "enabled" : "disabled"} · permission ${entry.runtimePermission} · ${entry.status}${entry.status === "connected" ? ` · ${entry.counts.tools} tool${entry.counts.tools === 1 ? "" : "s"} loaded` : " · 0 tools loaded"}`,
    })),
  );
}
export interface McpToolView {
  name: string;
  effectiveName?: string;
  title?: string;
  description?: string;
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
}
export function mcpToolItems(tools: McpToolView[]) {
  return tools.map((tool) => {
    const flags = [
      tool.annotations?.readOnly === true ? "read-only" : undefined,
      tool.annotations?.destructive === true ? "destructive" : undefined,
      tool.annotations?.openWorld === true ? "open-world" : undefined,
    ].filter(Boolean);
    return {
      value: tool.effectiveName ?? tool.name,
      label: tool.title
        ? `${tool.title} · ${tool.name}${tool.effectiveName && tool.effectiveName !== tool.name ? ` → ${tool.effectiveName}` : ""}`
        : tool.effectiveName && tool.effectiveName !== tool.name
          ? `${tool.name} → ${tool.effectiveName}`
          : tool.name,
      description: [...flags, tool.description].filter(Boolean).join(" · ") || "No description",
    };
  });
}
/** Builds one filterable list while retaining provider/profile ownership in each opaque value. */
export function configuredProviderModelItems(
  catalogs: ProviderCatalogView[],
  current?: { provider: string; model: string },
): ConfiguredProviderModelItem[] {
  const items: ConfiguredProviderModelItem[] = [];
  for (const catalog of catalogs) {
    if (catalog.unavailable) {
      items.push({
        value: JSON.stringify({ profile: catalog.profile }),
        label: `${catalog.title} · unavailable`,
        description: `${catalog.provider} · catalog refresh failed`,
        unavailable: true,
      });
      continue;
    }
    const models = catalog.models.length
      ? catalog.models
      : catalog.configuredModel
        ? [{ id: catalog.configuredModel }]
        : [];
    for (const model of models)
      items.push({
        value: JSON.stringify({
          profile: catalog.profile,
          provider: catalog.provider,
          model: model.id,
        }),
        label: `${catalog.title} · ${model.name ?? model.id}${
          catalog.provider === current?.provider && model.id === current.model ? " (current)" : ""
        }`,
        description: `${model.id.startsWith(`${catalog.provider}/`) ? model.id : `${catalog.provider}/${model.id}`}${
          model.contextWindow ? ` · ${formatTokens(model.contextWindow)} context` : ""
        }`,
        unavailable: false,
      });
  }
  return items;
}
export function contextLevel(pct: number, compactionAt = 85): Level {
  // Warning band starts a quarter below the auto-compaction point; danger is exactly there.
  const warn = Math.max(0, compactionAt - 25);
  return pct < warn ? "ok" : pct < compactionAt ? "warn" : "danger";
}
export function contextPercent(used: number, total: number | undefined): number | undefined {
  return total && total > 0 ? (used / total) * 100 : undefined;
}
/** The effective total the context bar measures against, and what it is derived from. */
export interface ContextBudget {
  /** Effective total in tokens: the model's context window, or absent when it is unknown. */
  total?: number;
  /** Basis of the total: the model's context window, or unknown (no fabricated total). */
  basis: "window" | "unknown";
  /** Percentage of `total` at which the engine auto-compacts; the bar turns red there. */
  compactionAt: number;
}
export function formatContext(
  used: number,
  total: number | undefined,
  estimated: boolean,
  basis?: "window" | "unknown",
) {
  const prefix = `${estimated ? "~" : ""}${formatTokens(used)} / `;
  // Honest unknown: the model window could not be known, so the bar shows `?` instead of a
  // fabricated total or percentage.
  if (basis === "unknown") return `${prefix}?`;
  const pct = contextPercent(used, total);
  if (pct === undefined || !total) return `${prefix}unknown`;
  return `${prefix}${formatTokens(total)} (${Math.round(pct)}%)`;
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
  { name: "connect", description: "Configure a provider and choose its active model" },
  {
    name: "model",
    description: "Switch provider and model",
    aliases: ["models"],
  },
  { name: "compact", description: "Summarize older history", argumentHint: "[focus]" },
  { name: "stats", description: "Session statistics" },
  { name: "clear", description: "Start a new session", aliases: ["new"] },
  { name: "sessions", description: "List recent sessions" },
  { name: "resume", description: "Resume a session by ID or prefix", argumentHint: "<id>" },
  { name: "tools", description: "List tools and permission state" },
  {
    name: "plugins",
    description: "Browse and manage project plugins",
    aliases: ["plugin"],
  },
  {
    name: "skills",
    description: "Browse and manage effective skills",
    aliases: ["skill"],
  },
  { name: "mcp", description: "Browse and manage MCP servers" },
  {
    name: "settings",
    description: "Open the settings menu",
    aliases: ["prefs"],
  },
  { name: "copy", description: "Copy the last assistant response to the clipboard" },
  {
    name: "ask",
    description: "Ask the agent to turn your question into a multiple-choice ask_user_question",
    argumentHint: "<question>",
  },
  { name: "exit", description: "Exit Alisio", aliases: ["quit"] },
];
/** Every TUI slash name (commands, aliases and routing prefixes); templates cannot take them. */
export function reservedCommandNames(): string[] {
  return [...COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]), "command"];
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

/** Minimal structural view of a skill for slash autocompletion (subset of the core catalog entry). */
export interface SkillCompletionEntry {
  id: string;
  name: string;
  displayId: string;
  description: string;
  /** Catalog scope of the skill: user | project | config | plugin (drives the [u]/[p]/[c]/[l] marker). */
  scope?: string;
  enabled: boolean;
  locked: boolean;
  effective: boolean;
}
export interface SlashCompletionItem {
  value: string;
  label: string;
  description?: string;
}
export const SKILL_COMPLETION_DESCRIPTION_LIMIT = 80;
/** Status hint prefixes (no color): shadowed < disabled < locked states shown by /skills. */
const skillStatus = (skill: SkillCompletionEntry): string | undefined =>
  !skill.effective
    ? "shadowed"
    : !skill.enabled
      ? "disabled"
      : skill.locked
        ? "locked by plugin"
        : undefined;
/**
 * OpenCode-style scope marker for a skill's slash entry, mirroring the catalog scopes the /skills
 * manager shows: user, project, config and plugin (plugin skills are locked by their owner plugin).
 */
export const skillScopeMarker = (skill: SkillCompletionEntry): string | undefined => {
  const marker = ({ user: "[u]", project: "[p]", config: "[c]", plugin: "[l]" } as const)[
    skill.scope as "user" | "project" | "config" | "plugin"
  ];
  return marker ?? (skill.scope ? `[${skill.scope}]` : undefined);
};
/**
 * Description for a skill's first-class `skill:<id>` slash entry: scope marker, status hint, then
 * the skill description truncated to the shared limit. The marker and status are prepended before
 * truncating, so they survive the cap just like the /skills argument completions.
 */
export function skillSlashDescription(skill: SkillCompletionEntry): string {
  const marker = skillScopeMarker(skill);
  const status = skillStatus(skill);
  if (!marker && !status)
    return truncatePlain(skill.description, SKILL_COMPLETION_DESCRIPTION_LIMIT);
  return truncatePlain(
    `${[marker, status].filter(Boolean).join(" ")}${status ? " · " : " "}${skill.description}`,
    SKILL_COMPLETION_DESCRIPTION_LIMIT,
  );
}
/**
 * Suggested completions for `/skills <prefix>`: every entry the /skills manager shows, filtered by
 * prefix (case-insensitive) on name or description. Selecting a suggestion only fills the argument;
 * submitting still opens the skills manager.
 */
export function skillCompletions(
  catalog: SkillCompletionEntry[],
  prefix: string,
  limit = 20,
): SlashCompletionItem[] {
  const query = prefix.trim().toLowerCase();
  const items = query
    ? catalog.filter((skill) =>
        [skill.displayId, skill.name, skill.description].join(" ").toLowerCase().includes(query),
      )
    : catalog;
  return items.slice(0, limit).map((skill) => {
    const status = skillStatus(skill);
    return {
      value: skill.id,
      label: skill.displayId,
      description: truncatePlain(
        status ? `${status} · ${skill.description}` : skill.description,
        SKILL_COMPLETION_DESCRIPTION_LIMIT,
      ),
    };
  });
}

export interface SlashCompletionSource {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}
export interface SlashCompletionContext {
  /** Live session rows for `/resume`: already filtered to the typed prefix and mapped. */
  sessions?: (prefix: string) => SlashCompletionItem[];
  /** Effective skill catalog backing `/skills` (the same entries the skills manager shows). */
  skills: SkillCompletionEntry[];
}
function argumentCompletionsFor(source: SlashCompletionSource, context: SlashCompletionContext) {
  const sessions = context.sessions;
  if (source.name === "resume" && sessions)
    return {
      getArgumentCompletions: (prefix: string) => sessions(prefix).slice(0, 20),
    };
  if (source.name === "skills")
    return {
      getArgumentCompletions: (prefix: string) => skillCompletions(context.skills, prefix, 20),
    };
  return {};
}
/**
 * Builds the editor slash-autocomplete command list. Aliases get their own entries with the same
 * description and argument completions, because the provider matches commands by fuzzy name.
 * Effective skills are appended as first-class `skill:<id>` entries so `/ski…`, `/skill:b…` and
 * even `/branch…` all surface them; submitting already routes `skill:` commands to skill load, so
 * selecting an entry only needs to insert the command name. `options.skillEntries: false` gates
 * ONLY those standalone `skill:` entries (e.g. the `tui.skillSlashCommands` toggle): the `/skills`
 * manager and its argument completion keep working, since `context.skills` still feeds both.
 */
export interface SlashCompletionOptions {
  /** Include first-class `skill:<id>` entries for effective skills (default true). */
  skillEntries?: boolean;
}
export function slashCompletionCommands(
  sources: SlashCompletionSource[],
  context: SlashCompletionContext,
  options: SlashCompletionOptions = {},
) {
  const entries = sources.flatMap((source) => {
    const entry = (name: string) => ({
      name,
      description: source.description,
      ...(source.argumentHint ? { argumentHint: source.argumentHint } : {}),
      ...argumentCompletionsFor(source, context),
    });
    return [
      entry(source.name),
      ...(source.aliases ?? []).filter((a) => a !== source.name).map(entry),
    ];
  });
  if (options.skillEntries !== false)
    for (const skill of context.skills)
      entries.push({
        name: `skill:${skill.id}`,
        description: skillSlashDescription(skill),
      });
  return entries;
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
      const partial = d.partial
        ? " · partial: the summary was cut by max output tokens; consider raising compaction.maxOutputTokens"
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
            `Context compacted (${String(d.reason ?? "manual")}): ${String(d.replaced ?? 0)} messages summarized, ~${formatTokens(Number(d.before ?? 0))} → ~${formatTokens(Number(d.after ?? 0))} tokens${checkpoint}${partial}`,
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
    case "response_truncated":
      return addItem(state, {
        kind: "notice",
        text: "Response cut by max output tokens — the answer may be incomplete. Raise limits.maxOutputTokens to allow longer answers.",
      });
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
