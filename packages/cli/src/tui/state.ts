/**
 * Pure presentation logic for the TUI: formatting, command parsing and the reduction of
 * versioned runner events into a view model. No terminal or pi-tui imports here.
 */
import { CommandCatalog, describeOutputLimitSource } from "@alisio/core";
import type { Message, ModelInfo, RunEvent, ToolResult, TreeNode, UiBlock } from "@alisio/sdk";

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
/**
 * Reserved value prefix marking a non-selectable group-header row in picker item lists. It can
 * never collide with real entry ids (plugin ids, server names), which never start with "_".
 */
export const GROUP_HEADER_PREFIX = "__group:";
/** True when the item is a group header emitted under GROUP_HEADER_PREFIX (never selectable). */
export const isGroupHeader = (item: { value: string }): boolean =>
  item.value.startsWith(GROUP_HEADER_PREFIX);
/**
 * Nearest non-header index from `index` stepping `dir` (1 = down, -1 = up), wrapping at the
 * edges exactly like a plain list would, so navigation skips header rows in both directions and
 * never stops on one. Returns -1 for an empty list and `index` unchanged when every item is a
 * header (callers then treat it as "no move").
 */
export function skipGroupHeaders(
  items: readonly { value: string }[],
  index: number,
  dir: 1 | -1,
): number {
  const count = items.length;
  if (!count) return -1;
  let next = (index + dir + count) % count;
  for (let steps = 0; steps < count && next !== index; steps++) {
    if (!isGroupHeader(items[next]!)) return next;
    next = (next + dir + count) % count;
  }
  return index;
}
/**
 * The display sequence a picker should render for a filter: rows matching SelectList's own
 * prefix semantics, plus the group header of every group that still has at least one visible
 * row, in original order. Groups with no match emit no header.
 */
export function visibleGroupedItems(
  items: ReadonlyArray<{ value: string; label: string; description?: string }>,
  filter: string,
): Array<{ value: string; label: string; description?: string }> {
  const query = filter.toLowerCase();
  const visible: Array<{ value: string; label: string; description?: string }> = [];
  let header: { value: string; label: string; description?: string } | undefined;
  for (const item of items) {
    if (isGroupHeader(item)) {
      header = item;
      continue;
    }
    if (item.value.toLowerCase().startsWith(query)) {
      if (header) {
        visible.push(header);
        header = undefined;
      }
      visible.push(item);
    }
  }
  return visible;
}
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
  // Every group opens with its own non-selectable header row; plugin rows are indented under it.
  return [...grouped].flatMap(([title, group]) => [
    { value: `${GROUP_HEADER_PREFIX}${title}`, label: `${title} ›` },
    ...group.map((entry) => ({
      value: entry.id,
      label: `  ${marker(entry)} ${entry.name} · ${entry.builtin ? "built-in" : entry.source}`,
      description: `${entry.status}${entry.categories.length ? ` · ${entry.categories.join(", ")}` : ""} · ${entry.description}`,
    })),
  ]);
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

/** Built-ins only: plugin, template and skill commands are resolved against the live app. */
const BUILTIN_CATALOG = new CommandCatalog();
export interface CommandSpec {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}
/**
 * Built-in slash commands the TUI offers, derived from the core `CommandCatalog` (the TUI
 * surface of `BUILTIN_COMMANDS`). Kept as `COMMANDS` for compatibility.
 */
export const COMMANDS: CommandSpec[] = BUILTIN_CATALOG.list("tui")
  .filter((c) => c.source === "builtin")
  .map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    ...(c.aliases ? { aliases: c.aliases } : {}),
  }));
/** Every TUI slash name (commands, aliases and routing prefixes); templates cannot take them. */
export function reservedCommandNames(): string[] {
  return [...COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]), "command"];
}
export function resolveCommand(name: string): string | undefined {
  const found = BUILTIN_CATALOG.resolve(name);
  return found?.source === "builtin" && found.surfaces.includes("tui") ? found.name : undefined;
}
export function parseCommand(input: string): { name: string; args: string } | undefined {
  const match = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match?.[1]) return undefined;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

/** Reasoning-effort capability advertised by a model's catalog entry (`ModelInfo.effort`). */
export interface EffortCapability {
  supportedLevels: string[];
  defaultLevel?: string;
}
/**
 * The effective reasoning effort to send for a model: the persisted level when the model
 * supports it, otherwise the model's default level (silent fallback), and nothing when the
 * model advertises no effort levels at all.
 */
export function effectiveEffort(
  persisted: string | undefined,
  capability: EffortCapability | undefined,
): string | undefined {
  if (!capability?.supportedLevels?.length) return undefined;
  if (persisted && capability.supportedLevels.includes(persisted)) return persisted;
  return capability.defaultLevel;
}
/** Validates a `/effort <level>` argument against the active model; returns an error or nothing. */
export function validateEffortLevel(
  level: string,
  capability: EffortCapability | undefined,
): string | undefined {
  if (!capability?.supportedLevels?.length)
    return "This model does not advertise reasoning effort levels, so no effort is sent to it.";
  if (!capability.supportedLevels.includes(level))
    return `Unsupported effort level "${level}". Supported levels: ${capability.supportedLevels.join(", ")}.`;
  return undefined;
}
export function effortPickerItems(
  capability: EffortCapability,
  active: string | undefined,
): Array<{ value: string; label: string; description?: string }> {
  const items = capability.supportedLevels.map((level) => ({
    value: level,
    label: [
      level,
      level === active ? "(current)" : undefined,
      level === capability.defaultLevel ? "(default)" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    ...(level === capability.defaultLevel ? { description: "The model's own default" } : {}),
  }));
  return [
    ...items,
    {
      value: "!clear",
      label: "Auto · provider default",
      description: "Clear the saved effort; the provider uses its own default",
    },
  ];
}

/** Role of a status-line identity part; the renderer maps each role to a distinct color. */
export type IdentityRole = "agent" | "model" | "provider" | "effort";
export interface IdentityPart extends Segment {
  role: IdentityRole;
}
export interface IdentityInput {
  agent: string;
  model: string;
  provider?: string;
  effort?: string;
}
/**
 * The ordered identity parts for the status line below the editor:
 * `agent: <name> · <model> · <provider> · <effort>`, with the effort part omitted when the
 * active model advertises no supported levels (`effort === undefined`). Colors are applied by
 * the renderer per role; this module stays terminal-free and testable.
 */
export function identityParts(input: IdentityInput): IdentityPart[] {
  const parts: IdentityPart[] = [
    { text: `agent: ${input.agent}`, priority: 10, role: "agent" },
    { text: input.model || "not connected", priority: 9, role: "model" },
  ];
  if (input.provider) parts.push({ text: input.provider, priority: 8, role: "provider" });
  if (input.effort) parts.push({ text: input.effort, priority: 7, role: "effort" });
  return parts;
}
/** Drops the lowest-priority identity parts until the line fits `width`; truncates the survivor. */
export function fitIdentityParts(input: IdentityInput, width: number): IdentityPart[] {
  return fitSegments(identityParts(input), width, " · ");
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
/** Capability kind of a tool call; drives grouping labels and batch display. */
export type ToolKind = "read" | "write" | "process" | "mcp" | "internal" | "other";
export type TranscriptItem =
  | {
      kind: "user";
      text: string;
    }
  | {
      kind: "assistant";
      text: string;
      reasoning: string;
      done: boolean;
      /** Epoch ms of the first reasoning delta; with `reasoningDoneAt` it approximates the thinking interval. */
      reasoningStartedAt?: number;
      /** Epoch ms of the last reasoning delta (the end of the visible thought section). */
      reasoningDoneAt?: number;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: string;
      summary: string;
      status: ToolStatus;
      durationMs?: number;
      preview?: string;
      /** Structured block rendered natively by the TUI (from a `{type:"ui"}` result part). */
      ui?: UiBlock;
      /** Base64 image rendered inline by the TUI when the terminal supports it (from a `{type:"image"}` part). */
      image?: { mimeType: string; data: string };
      /** Effect-derived kind (grouping label); name-heuristic fallback for replayed history. */
      toolKind?: ToolKind;
      /** Exit code derived safely from the JSON preview when the tool reports one (run_process/shell/search_text). */
      exitCode?: number;
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
  /** The runner is sending a silent request again (`request_retry`); cleared by any output. */
  retry?: { attempt: number; of: number };
  /** The response was cut by the output limit and is requested again (`truncation_recovery`). */
  recovery?: { attempt: number; of: number };
  model: string;
  /** Context size in tokens: provider-reported, or estimated (`~`). */
  context?: { used: number; estimated: boolean };
  runStartedAt?: number;
  /** Epoch ms of the latest event of the live run (any type); undefined when no run is live. */
  lastEventAt?: number;
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
/**
 * Streaming assistant items stamp the thinking interval: the first reasoning delta records
 * `reasoningStartedAt` and every later one refreshes `reasoningDoneAt`, so a completed thought
 * section can show a `Thought · 2.9s` duration. The stamp stops once text arrives (the model
 * moved on to the answer), so the duration measures the visible reasoning span, never the turn.
 */
const withReasoningStamp = (
  item: Extract<TranscriptItem, { kind: "assistant" }>,
  field: "text" | "reasoning",
  at: number,
): Extract<TranscriptItem, { kind: "assistant" }> => {
  if (field !== "reasoning" || item.text) return item;
  return { ...item, reasoningStartedAt: item.reasoningStartedAt ?? at, reasoningDoneAt: at };
};
function appendAssistant(
  state: ViewState,
  field: "text" | "reasoning",
  delta: string,
  at = Date.now(),
): ViewState {
  const last = state.items.at(-1);
  if (last?.kind === "assistant" && !last.done)
    return {
      ...state,
      items: [
        ...state.items.slice(0, -1),
        withReasoningStamp({ ...last, [field]: last[field] + delta }, field, at),
      ],
    };
  return addItem(
    state,
    withReasoningStamp(
      {
        kind: "assistant",
        text: field === "text" ? delta : "",
        reasoning: field === "reasoning" ? delta : "",
        done: false,
      },
      field,
      at,
    ),
  );
}
/** Approximated thinking interval of a completed reasoning section, when the events carried timestamps. */
export function reasoningDurationMs(item: {
  reasoningStartedAt?: number;
  reasoningDoneAt?: number;
}): number | undefined {
  const { reasoningStartedAt, reasoningDoneAt } = item;
  if (reasoningStartedAt === undefined || reasoningDoneAt === undefined) return undefined;
  return Math.max(0, reasoningDoneAt - reasoningStartedAt);
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
  const next = reduceEventItems(state, event);
  const terminal =
    event.type === "run_completed" ||
    event.type === "run_failed" ||
    event.type === "run_cancelled" ||
    event.type === "run_turns_exceeded";
  if (terminal) {
    const { lastEventAt: _ended, retry: _retry, recovery: _recovery, ...rest } = next;
    return rest;
  }
  return { ...next, lastEventAt: Date.parse(event.timestamp) || Date.now() };
}
/** No event for this long: the footer says how long the run has been quiet. */
export const QUIET_MS = 15_000;
/** No event for this long: the footer marks the run as possibly stuck. */
export const STALLED_MS = 60_000;
/** A short, safe label from tool arguments: a title or a file name, never commands or URLs. */
function shortArg(args: string): string {
  const input = parseArgs(args);
  if (!input) return "";
  const first = Array.isArray(input.inputs) ? (input.inputs[0] as Record<string, unknown>) : {};
  const value = [input.title, input.fileName, input.path, input.file_path, first?.path].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  if (!value) return "";
  return truncatePlain(
    oneLine(value.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? ""),
    40,
  );
}
export interface RunPhase {
  label: string;
  /** Silence is expected here (the user's turn, or a sub-agent working in its own session). */
  silentByDesign: boolean;
}
/** What the live run is doing, from the transcript items and flags the events already update. */
export function runPhase(view: ViewState): RunPhase {
  if (view.compacting) return { label: "compacting context", silentByDesign: false };
  if (view.retry)
    return {
      label: `the model did not respond; retrying (${view.retry.attempt}/${view.retry.of})`,
      silentByDesign: false,
    };
  if (view.recovery)
    return {
      label: `the response was cut off; retrying in smaller steps (${view.recovery.attempt}/${view.recovery.of})`,
      silentByDesign: false,
    };
  const tool = view.items.findLast(
    (i) => i.kind === "tool" && i.status !== "ok" && i.status !== "error",
  );
  if (tool?.kind === "tool") {
    const name = tool.name.replace(/^p_[0-9a-f]{10}_/, "");
    const arg = shortArg(tool.args);
    const detail = arg ? ` (${arg})` : "";
    if (tool.status === "approval")
      return {
        label: `waiting for your approval: ${humanizeToolName(name)}`,
        silentByDesign: true,
      };
    if (name === "ask_user_question")
      return { label: "waiting for your answer", silentByDesign: true };
    if (name === "task" || name === "task_wait")
      return { label: "a sub-agent is working", silentByDesign: true };
    if (name === "python_run") return { label: `running Python${detail}`, silentByDesign: false };
    if (name === "data_inspect" || name === "data_query")
      return { label: `reading your data${detail}`, silentByDesign: false };
    if (name === "artifact_create")
      return { label: `publishing the artifact${detail}`, silentByDesign: false };
    return { label: `running ${humanizeToolName(name)}${detail}`, silentByDesign: false };
  }
  const last = view.items.at(-1);
  if (last?.kind === "assistant" && !last.done)
    return {
      label: last.text ? "writing the answer" : "thinking",
      silentByDesign: false,
    };
  return { label: "waiting for the model", silentByDesign: false };
}
/** Milliseconds of silence worth reporting (0 when the run is busy, or silent by design). */
export function quietFor(view: ViewState, now: number): number {
  if (view.lastEventAt === undefined || runPhase(view).silentByDesign) return 0;
  const idle = Math.max(0, now - view.lastEventAt);
  return idle >= QUIET_MS ? idle : 0;
}
/** What the retried request produced (or the end of the turn) ends the retry label. */
const RETRY_ENDERS = new Set([
  "text_delta",
  "reasoning_delta",
  "turn_completed",
  "tool_started",
  "compaction_started",
]);
function reduceEventItems(state: ViewState, event: RunEvent): ViewState {
  if ((state.retry || state.recovery) && RETRY_ENDERS.has(event.type)) {
    const { retry: _retry, recovery: _recovery, ...rest } = state;
    return reduceEventItems(rest, event);
  }
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
      return appendAssistant(state, "text", String(d.delta ?? ""), at);
    case "reasoning_delta":
      return appendAssistant(state, "reasoning", String(d.delta ?? ""), at);
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
    case "tool_started": {
      const name = String(d.name ?? "tool");
      return addItem(state, {
        kind: "tool",
        id: String(d.id ?? ""),
        name,
        args: typeof d.arguments === "string" ? d.arguments : "",
        summary: summarizeToolArgs(
          String(d.name ?? ""),
          typeof d.arguments === "string" ? d.arguments : "",
        ),
        status: "running",
        toolKind: toolKindOf(name, typeof d.effect === "string" ? d.effect : undefined),
      });
    }
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
        ...exitCodePart(d.preview),
        ...(isUiBlock(d.ui) ? { ui: d.ui } : {}),
        ...(isImagePart(d.image) ? { image: d.image } : {}),
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
    case "run_cancelled":
    case "run_turns_exceeded": {
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
      if (event.type === "run_turns_exceeded")
        return addItem(ended, {
          kind: "notice",
          text: "Turn limit reached — the answer may be incomplete. Continue with another prompt or raise limits.maxTurns (/settings → Max turns).",
        });
      if (event.type === "run_cancelled") {
        const reason = String(d.error ?? "cancelled");
        return addItem(ended, {
          kind: "notice",
          text: reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`,
        });
      }
      return ended;
    }
    case "truncation_recovery":
      return { ...state, recovery: { attempt: Number(d.attempt) || 1, of: Number(d.of) || 1 } };
    case "request_retry":
      return { ...state, retry: { attempt: Number(d.attempt) || 1, of: Number(d.of) || 1 } };
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
        text: `Response cut by max output tokens${
          typeof d.maxOutputTokens === "number"
            ? ` (${d.maxOutputTokens} tokens, ${describeOutputLimitSource(d.source as "user" | "model" | "default" | undefined)})`
            : ""
        } — the answer may be incomplete. Raise limits.maxOutputTokens (/settings → Agent max output tokens) to allow longer answers.`,
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

/**
 * True when a printable key should copy the last assistant response instead of typing: bound to
 * `c`/`y` (and uppercase) on an EMPTY editor line, while no autocomplete is showing and no turn
 * is running — the same "empty input" convention Enter and Ctrl+D already use. A non-empty input
 * never triggers, so typing `c` or `y` mid-message is unaffected.
 */
export function editorCopyKey(
  data: string,
  input: { text: string; autocomplete: boolean; busy: boolean },
): boolean {
  return (
    (data === "c" || data === "C" || data === "y" || data === "Y") &&
    input.text === "" &&
    !input.autocomplete &&
    !input.busy
  );
}

/** True when an unknown event value is a `Node` of a tree UI block. */
export function isTreeNode(value: unknown): value is TreeNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string") return false;
  if (record.meta !== undefined && typeof record.meta !== "string") return false;
  if (record.children !== undefined && !Array.isArray(record.children)) return false;
  return record.children === undefined || (record.children as unknown[]).every(isTreeNode);
}

/** True when an unknown event value is an Alisio `UiBlock` (validated defensively). */
export function isUiBlock(value: unknown): value is UiBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  switch (block.kind) {
    case "artifact": {
      const a = block.artifact as Record<string, unknown> | undefined;
      return (
        !!a &&
        typeof a === "object" &&
        typeof a.id === "string" &&
        typeof a.fileName === "string" &&
        typeof a.kind === "string" &&
        typeof a.bytes === "number" &&
        typeof a.status === "string"
      );
    }
    case "table":
      return (
        Array.isArray(block.columns) &&
        (block.columns as unknown[]).every((c) => typeof c === "string") &&
        Array.isArray(block.rows) &&
        (block.rows as unknown[]).every(
          (r) => Array.isArray(r) && (r as unknown[]).every((c) => typeof c === "string"),
        ) &&
        (block.caption === undefined || typeof block.caption === "string")
      );
    case "key-value":
      return (
        Array.isArray(block.entries) &&
        (block.entries as unknown[]).every(
          (e) =>
            Array.isArray(e) &&
            e.length === 2 &&
            typeof e[0] === "string" &&
            typeof e[1] === "string",
        ) &&
        (block.caption === undefined || typeof block.caption === "string")
      );
    case "tree":
      return Array.isArray(block.nodes) && (block.nodes as unknown[]).every(isTreeNode);
    case "code":
      return (
        typeof block.code === "string" &&
        (block.lang === undefined || typeof block.lang === "string") &&
        (block.caption === undefined || typeof block.caption === "string")
      );
    case "markdown":
      return typeof block.text === "string";
    case "diff":
      return optionalStrings(block, ["path", "patch", "before", "after", "lang", "caption"]);
    case "terminal":
      return (
        typeof block.output === "string" &&
        optionalStrings(block, ["command", "cwd"]) &&
        optionalNumbers(block, ["exitCode", "durationMs"]) &&
        (block.truncated === undefined || typeof block.truncated === "boolean")
      );
    case "mermaid":
      return typeof block.source === "string" && optionalStrings(block, ["title"]);
    case "math":
      return (
        typeof block.latex === "string" &&
        (block.display === undefined || typeof block.display === "boolean")
      );
    case "json":
      return (
        "value" in block &&
        optionalNumbers(block, ["collapsedDepth"]) &&
        optionalStrings(block, ["caption"])
      );
    case "test-results":
      return (
        optionalStrings(block, ["framework"]) &&
        optionalNumbers(block, ["durationMs"]) &&
        Array.isArray(block.suites) &&
        (block.suites as unknown[]).every(
          (suite) =>
            isRecord(suite) &&
            typeof suite.name === "string" &&
            optionalStrings(suite, ["file"]) &&
            Array.isArray(suite.cases) &&
            (suite.cases as unknown[]).every(
              (c) =>
                isRecord(c) &&
                typeof c.name === "string" &&
                TEST_STATUSES.has(c.status as string) &&
                optionalStrings(c, ["error"]) &&
                optionalNumbers(c, ["durationMs", "line"]),
            ),
        )
      );
    case "progress":
      return (
        optionalStrings(block, ["title"]) &&
        Array.isArray(block.steps) &&
        (block.steps as unknown[]).every(
          (step) =>
            isRecord(step) &&
            typeof step.label === "string" &&
            PROGRESS_STATUSES.has(step.status as string) &&
            optionalStrings(step, ["detail"]),
        )
      );
    default:
      return false;
  }
}
const TEST_STATUSES = new Set(["passed", "failed", "skipped", "todo"]);
const PROGRESS_STATUSES = new Set(["pending", "running", "completed", "failed", "cancelled"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const optionalStrings = (record: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => record[key] === undefined || typeof record[key] === "string");
const optionalNumbers = (record: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => record[key] === undefined || typeof record[key] === "number");

/** True when an unknown event value is a `{type:"image"}`-style part (mime + base64 data). */
export function isImagePart(value: unknown): value is { mimeType: string; data: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.mimeType === "string" && typeof record.data === "string";
}

/**
 * Display blocks the standard tools attach for the web UI only (spec §8.6): the TUI already
 * shows the same content from the text (output rows, exit line), so rendering them would repeat it.
 */
const WEB_ONLY_UI: Record<string, UiBlock["kind"]> = {
  write_file: "diff",
  edit_file: "diff",
  shell: "terminal",
  run_process: "terminal",
};

/** Rich (ui/image) parts of a persisted tool result, if any. */
export function richPartsOf(
  result: ToolResult | undefined,
  toolName?: string,
): {
  ui?: UiBlock;
  image?: { mimeType: string; data: string };
} {
  if (!result) return {};
  const skip =
    toolName !== undefined && Object.hasOwn(WEB_ONLY_UI, toolName)
      ? WEB_ONLY_UI[toolName]
      : undefined;
  const ui = result.content.find((part) => part.type === "ui" && part.block.kind !== skip);
  const image = result.content.find((part) => part.type === "image");
  return {
    ...(ui?.type === "ui" ? { ui: ui.block } : {}),
    ...(image?.type === "image" ? { image: { mimeType: image.mimeType, data: image.data } } : {}),
  };
}

// ============================================================================
// Tool presentation model — the pure extension point for transcript display.
// Everything the TUI renders beyond a plain `TranscriptItem` is a
// `TranscriptEntry`, and anything collapsible declares a `FoldCandidate` here,
// so the renderer, the keybinding and (optionally) mouse clicks stay consistent
// without importing pi-tui. Future block kinds hook in by extending these
// shapes, never by special-casing components.
// ============================================================================

/** Words keyed by their canonical upper-case spelling that stay acronyms when humanized. */
const ACRONYM_WORDS = new Set([
  "MCP",
  "HTTP",
  "HTTPS",
  "URL",
  "API",
  "CLI",
  "JSON",
  "CSV",
  "XML",
  "HTML",
  "SQL",
  "SQLITE",
  "DNS",
  "SSH",
  "IP",
  "ID",
  "DB",
  "UI",
  "OS",
  "IDE",
  "TUI",
  "PNG",
  "SVG",
  "PDF",
  "YAML",
  "TOML",
  "2FA",
  "V2",
]);
/**
 * `read_file` → `Read File`, `search_text` → `Search Text`, `mcp_devforge_time_diff` →
 * `MCP · Devforge Time Diff`. Splits on `_`/`-`/`.`/spaces, keeps known acronyms (MCP, HTTP…)
 * and bare numeric suffixes (`read_file_2` → `Read File 2`). The machine name stays available
 * dimmed in grouped detail rows and in the `/tools` and `/stats` reports.
 */
export function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  let rest = trimmed;
  let prefix = "";
  const mcp = /^mcp_/i.exec(rest);
  if (mcp) {
    prefix = "MCP · ";
    rest = rest.slice(mcp[0].length);
  }
  const words = rest
    .split(/[_\-. /]+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (ACRONYM_WORDS.has(upper)) return upper;
      if (/^\d+$/.test(upper)) return upper;
      return `${word[0]?.toUpperCase() ?? ""}${word.slice(1).toLowerCase()}`;
    });
  return words.length ? `${prefix}${words.join(" ")}` : trimmed;
}

/** Verb and count noun used by grouped batch rows per tool kind. */
export const TOOL_KIND_VERB: Record<ToolKind, string> = {
  read: "Explored",
  write: "Edited",
  process: "Ran",
  mcp: "Queried",
  internal: "Ran",
  other: "Called",
};
export const TOOL_KIND_WORD: Record<ToolKind, string> = {
  read: "reads",
  write: "files",
  process: "commands",
  mcp: "calls",
  internal: "tasks",
  other: "calls",
};
/**
 * Capability kind of a tool call. Live events carry the registry `effect` (exact); replayed
 * history falls back to conservative name heuristics. `mcp_*` is always the mcp kind.
 */
export function toolKindOf(name: string, effect?: string): ToolKind {
  if (name.startsWith("mcp_")) return "mcp";
  switch (effect) {
    case "read":
    case "write":
    case "process":
    case "internal":
      return effect;
    default:
      break;
  }
  if (/^(read|search|list|git|context|ask|web|fetch)_/.test(name)) return "read";
  if (/^(write|edit|append|delete|rename|move|mkdir|patch)_/.test(name)) return "write";
  if (/^(run|shell|execute)/.test(name)) return "process";
  if (name === "task" || name.startsWith("task_")) return "internal";
  return "other";
}

/** Terminal-preview caps for collapsed rows (same values the renderer always used). */
export const OUTPUT_PREVIEW_LINES_OK = 3;
export const OUTPUT_PREVIEW_LINES_ERROR = 6;
export const previewLinesFor = (status: ToolStatus): number =>
  status === "error" ? OUTPUT_PREVIEW_LINES_ERROR : OUTPUT_PREVIEW_LINES_OK;
/** Preview rows as the renderer shows them: blank lines dropped, tabs kept for the caller to expand. */
export const previewRows = (preview: string): string[] =>
  preview.split("\n").filter((line) => line.trim());
/** True when the preview exceeds the collapsed cap (the row becomes a collapsible "output"). */
export function previewTruncated(preview: string | undefined, status: ToolStatus): boolean {
  return !!preview && previewRows(preview).length > previewLinesFor(status);
}

/**
 * Exit code derived safely from a text preview. `run_process`/`shell`/`search_text` return
 * `{stdout, stderr, exitCode, truncated}` JSON; read-effect tools may carry an appended
 * `\n<instructions>…` block, retried on the JSON prefix. Any other shape yields nothing.
 */
export function exitCodeOf(preview: string | undefined): number | undefined {
  if (!preview) return undefined;
  const codeOf = (text: string): number | undefined => {
    try {
      const value: unknown = JSON.parse(text);
      const code =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).exitCode
          : undefined;
      return typeof code === "number" ? code : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = codeOf(preview);
  if (direct !== undefined) return direct;
  const cut = preview.indexOf("\n<instructions>");
  if (cut > 0) return codeOf(preview.slice(0, cut));
  return undefined;
}
const exitCodePart = (preview: unknown): { exitCode: number } | {} => {
  if (typeof preview !== "string") return {};
  const code = exitCodeOf(preview);
  return code === undefined ? {} : { exitCode: code };
};

/** Renderable view of one tool call (singleton row, or a member of a grouped batch). */
export interface ToolItemView {
  id: string;
  /** Machine name (kept for dimmed detail display). */
  name: string;
  /** Humanized display name. */
  humanName: string;
  kind: ToolKind;
  summary: string;
  status: ToolStatus;
  durationMs?: number;
  preview?: string;
  ui?: UiBlock;
  image?: { mimeType: string; data: string };
  exitCode?: number;
}
/** A batch of consecutive same-kind, finished tool calls rendered as ONE collapsible row. */
export interface GroupedTool {
  /** Id of the first member call (stable fold key while the batch grows). */
  id: string;
  members: ToolItemView[];
  kind: ToolKind;
  /** Aggregate: `error` when any member failed, else `ok` (members are all terminal). */
  status: ToolStatus;
  /** Sum of member durations. */
  totalMs: number;
  /** Header name: the shared humanized tool name, or the kind verb for mixed batches. */
  label: string;
  /** Count noun matching `label` (`reads`, `files`, `commands`…). */
  word: string;
}
/** Everything the transcript renders: a plain item, or one grouped batch row. */
export type TranscriptEntry = TranscriptItem | { kind: "group"; group: GroupedTool };

export function toolItemView(item: Extract<TranscriptItem, { kind: "tool" }>): ToolItemView {
  return {
    id: item.id,
    name: item.name,
    humanName: humanizeToolName(item.name),
    kind: item.toolKind ?? toolKindOf(item.name),
    summary: item.summary,
    status: item.status,
    ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    ...(item.preview !== undefined ? { preview: item.preview } : {}),
    ...(item.ui ? { ui: item.ui } : {}),
    ...(item.image ? { image: item.image } : {}),
    ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
  };
}

/**
 * Consecutive tool calls of the same kind whose statuses are ALL terminal (ok/error) merge into
 * one `group` entry; running/approval calls always stay singleton so their spinner and live state
 * stay visible. A kind change splits the run (`read` never merges with `shell`). Order is
 * preserved; every entry carries its index within `items` (fold keys for assistant items need
 * it). One linear pass — called on state changes only, never per frame.
 */
export function groupToolEntries(
  items: TranscriptItem[],
): Array<{ entry: TranscriptEntry; at: number }> {
  const out: Array<{ entry: TranscriptEntry; at: number }> = [];
  let run: Array<{ item: Extract<TranscriptItem, { kind: "tool" }>; at: number }> = [];
  let runKind: ToolKind | undefined;
  const flush = () => {
    if (!run.length) return;
    const views = run.map((r) => toolItemView(r.item));
    const first = views[0];
    const groupable =
      views.length > 1 &&
      first !== undefined &&
      views.every((v) => v.kind === runKind) &&
      views.every((v) => v.status === "ok" || v.status === "error");
    if (groupable) {
      const sameName = views.every((v) => v.name === first.name);
      out.push({
        entry: {
          kind: "group",
          group: {
            id: first.id,
            members: views,
            kind: first.kind,
            status: views.some((v) => v.status === "error") ? "error" : "ok",
            totalMs: views.reduce((sum, v) => sum + (v.durationMs ?? 0), 0),
            label: sameName ? first.humanName : TOOL_KIND_VERB[first.kind],
            word: TOOL_KIND_WORD[first.kind],
          },
        },
        at: run[0]?.at ?? 0,
      });
    } else {
      for (const r of run) out.push({ entry: r.item, at: r.at });
    }
    run = [];
    runKind = undefined;
  };
  items.forEach((item, at) => {
    if (item.kind === "tool") {
      const kind = item.toolKind ?? toolKindOf(item.name);
      if (runKind === undefined) {
        runKind = kind;
        run.push({ item, at });
      } else if (runKind === kind) {
        run.push({ item, at });
      } else {
        flush();
        runKind = kind;
        run.push({ item, at });
      }
    } else {
      flush();
      out.push({ entry: item, at });
    }
  });
  flush();
  return out;
}

/** Content identity of a group (fold/diff purposes): member ids, statuses and durations. */
export function groupIdentity(group: GroupedTool): string {
  return `${group.id}|${group.members.length}|${group.members
    .map((m) => `${m.id}:${m.status}:${m.durationMs ?? ""}`)
    .join(",")}`;
}

export type FoldableKind = "reasoning" | "group" | "output";
/** A collapsible region of the transcript and how to address it (fold key, toggle target). */
export interface FoldCandidate {
  /** Stable key for the fold state map (`a:` assistant index, `g:`/`t:` tool ids). */
  key: string;
  kind: FoldableKind;
  /** Running/live content defaults expanded; finished reasoning, batches and long output collapse. */
  defaultExpanded: boolean;
}

/** Cap for the reasoning text when expanded; longer sections show a truncation note. */
export const REASONING_EXPAND_MAX_LINES = 40;

/**
 * The fold contract of one transcript entry: nothing (not collapsible), or a candidate with its
 * default state. `at` is the entry's index within the ORIGINAL items array (assistant fold keys
 * are stable because transcript items are append-only).
 */
export function foldCandidateOf(entry: TranscriptEntry, at: number): FoldCandidate | undefined {
  if (entry.kind === "assistant") {
    const reasoning = entry.reasoning.trim();
    if (!reasoning || !(entry.done || entry.text)) return undefined;
    return { key: `a:${at}`, kind: "reasoning", defaultExpanded: false };
  }
  if (entry.kind === "group")
    return { key: `g:${entry.group.id}`, kind: "group", defaultExpanded: false };
  if (entry.kind === "tool") {
    if (entry.status === "running" || entry.status === "approval") return undefined;
    // Rich blocks keep their native rendering (tables/trees/images are already bounded);
    // only plain text output folds when it exceeds the collapsed cap.
    if (entry.ui || entry.image) return undefined;
    if (previewTruncated(entry.preview, entry.status))
      return { key: `t:${entry.id}`, kind: "output", defaultExpanded: false };
    return undefined;
  }
  return undefined;
}

/** Stable key of a transcript entry (used by the component sync to reuse row instances). */
export function entryKeyOf(entry: TranscriptEntry, at: number): string {
  switch (entry.kind) {
    case "assistant":
      return `a:${at}`;
    case "group":
      return `g:${entry.group.id}`;
    case "tool":
      return `t:${entry.id}`;
    case "user":
      return `u:${at}`;
    case "notice":
      return `n:${at}`;
    case "info":
      return `i:${at}`;
    case "error":
      return `e:${at}`;
  }
}

/** Every fold candidate of the transcript in display order; the keybinding targets the last one. */
export function foldCandidates(items: TranscriptItem[]): FoldCandidate[] {
  const candidates: FoldCandidate[] = [];
  for (const { entry, at } of groupToolEntries(items)) {
    const candidate = foldCandidateOf(entry, at);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/**
 * True when a printable key should toggle the nearest collapsible transcript row instead of
 * typing: bound to `x`/`X` on an EMPTY editor line (no autocomplete), the same "empty input"
 * convention Enter, Ctrl+D and `c`/`y` already use. Unlike copy, it also works while a turn runs
 * (the nearest candidate may still exist mid-stream). A non-empty input never triggers.
 */
export function foldToggleKey(
  data: string,
  input: { text: string; autocomplete: boolean },
): boolean {
  return (data === "x" || data === "X") && input.text === "" && !input.autocomplete;
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
        const preview = r?.result.content
          .filter((p) => p.type === "text")
          .map((x) => x.text)
          .join("\n")
          .slice(0, 2_000);
        items.push({
          kind: "tool",
          id: c.id,
          name: c.name,
          args: c.arguments,
          summary: summarizeToolArgs(c.name, c.arguments),
          status: r?.result.isError ? "error" : "ok",
          preview,
          toolKind: toolKindOf(c.name),
          ...exitCodePart(preview),
          ...richPartsOf(r?.result, c.name),
        });
      }
    }
  }
  return items;
}
