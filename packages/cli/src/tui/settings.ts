/**
 * Pure settings-menu logic for the TUI: row building, filtering, value cycling, counter and
 * keyboard reduction. No terminal or pi-tui imports here — the `SettingsMenu` component in
 * `settings-menu.ts` is a thin shell over this module.
 *
 * Only settings Alisio actually supports are defined here. The row set is the honest, wired
 * list: every "setting" row maps to a real config key persisted through the atomic
 * `setConfigValue` writer (or the MCP consent path) and is applied to the running process.
 */
export type SettingValueType = "boolean" | "number" | "percent" | "enum";

export interface SettingRow {
  /** Config key (or MCP consent id) this row edits; navigation rows carry their action id. */
  id: string;
  label: string;
  description: string;
  /** Group the row belongs to; also matched by the filter ("type" of the row). */
  category: string;
  kind: "setting" | "navigation";
  /** Current raw value for setting rows (read live from the config at build time). */
  current?: unknown;
  /** Ordered candidate values cycled by Enter/Space; wraps around at the ends. */
  values?: unknown[];
  valueType?: SettingValueType;
  /** Displayed but not editable in this run (e.g. under `--read-only`). */
  readOnly?: boolean;
  /** Navigation target id for navigation rows; the host maps it to a concrete action. */
  action?: string;
}

export interface SettingsNavigationAction {
  id: string;
  label: string;
  description: string;
}

/** Ordered candidates of the `websearch.provider` enum, aligned exactly with the config schema. */
export const WEBSEARCH_PROVIDERS = [
  "searxng",
  "duckduckgo-instant",
  "duckduckgo-html",
  "tavily",
  "brave",
  "serpapi",
  "native",
] as const;

/**
 * The config surface the menu reads. A structural view of the loaded config: rows are built only
 * from the documented fields below, so unknown keys in a real config are ignored by construction.
 */
export interface SettingsConfigView {
  compaction: { auto: boolean; threshold: number; keepTurns: number; maxOutputTokens: number };
  context: { claudeMdFallback: boolean; maxBytes: number };
  limits: {
    maxTurns: number;
    /** Only present when the user set it; unset means "the model's declared limit, else 16384". */
    maxOutputTokens?: number | undefined;
    maxContextChars: number;
    timeoutMs: number;
  };
  tui: { paddingX: number; contentPaddingX: number; skillSlashCommands: boolean };
  mcp: { allow?: boolean };
  websearch: { provider?: (typeof WEBSEARCH_PROVIDERS)[number] };
  pluginHooks: { timeoutMs: number };
  analysis: {
    enabled: boolean;
    limits: { timeoutMs: number };
    retention: { jobsDays: number; intermediateDays: number; artifactsDays: number };
  };
  tasks: { enabled: boolean; maxPerSession: number; retentionDays: number };
  goal: {
    enabled: boolean;
    maxTurns: number;
    maxMinutes: number;
    repeatedReplyLimit: number;
    noToolTurnsLimit: number;
    blockedRepeats: number;
  };
}

export interface SettingsMenuInput {
  config: SettingsConfigView;
  /** Whether global MCP consent (`mcp.allow`) is persisted for this user right now. */
  mcpAllowPersisted: boolean;
  /** `--read-only` run: every row is shown but none can be changed. */
  readOnly: boolean;
}

/** The config view with the schema defaults; also the canonical fixture for tests. */
export const defaultConfig: SettingsConfigView = {
  compaction: { auto: true, threshold: 0.85, keepTurns: 2, maxOutputTokens: 16_000 },
  context: { claudeMdFallback: false, maxBytes: 32 * 1024 },
  limits: { maxTurns: 100, maxContextChars: 800_000, timeoutMs: 300_000 },
  tui: { paddingX: 1, contentPaddingX: 2, skillSlashCommands: true },
  mcp: { allow: false },
  websearch: { provider: undefined },
  pluginHooks: { timeoutMs: 15_000 },
  analysis: {
    enabled: true,
    limits: { timeoutMs: 120_000 },
    retention: { jobsDays: 30, intermediateDays: 7, artifactsDays: 0 },
  },
  tasks: { enabled: true, maxPerSession: 4, retentionDays: 7 },
  goal: {
    enabled: true,
    maxTurns: 50,
    maxMinutes: 120,
    repeatedReplyLimit: 3,
    noToolTurnsLimit: 3,
    blockedRepeats: 2,
  },
};

/** Strictly ascending number sequence with exact step arithmetic (0.85 stays 0.85). */
function stepValues(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end + 1e-9; value += step) values.push(Number(value.toFixed(3)));
  return values;
}

interface SettingDefinition {
  id: string;
  label: string;
  category: string;
  description: string;
  valueType: SettingValueType;
  values: unknown[];
  read: (config: SettingsConfigView, mcpAllowPersisted: boolean) => unknown;
}

/**
 * Every real, wired setting the menu offers. `read` maps the live config to the current value;
 * the keys are exactly the ones `setConfigValue` accepts (`compaction.*`, `context.*`, `limits.*`,
 * `pluginHooks.timeoutMs`, `tui.*` and `websearch.provider`), and `mcp.allow` flows through the
 * application's consent path instead. `limits.timeoutMs` is displayed in seconds (the values are
 * seconds); the app host multiplies by 1000 before persisting the milliseconds.
 */
export const SETTINGS_DEFINITIONS: readonly SettingDefinition[] = [
  {
    id: "compaction.auto",
    label: "Auto-compact",
    category: "Compaction",
    valueType: "boolean",
    values: [false, true],
    read: (config) => config.compaction.auto,
    description:
      "Summarize older history automatically when context usage crosses the threshold. Off keeps history verbatim until you run /compact manually.",
  },
  {
    id: "compaction.threshold",
    label: "Compaction threshold",
    category: "Compaction",
    valueType: "percent",
    values: stepValues(0.5, 0.95, 0.05),
    read: (config) => config.compaction.threshold,
    description:
      "Share of the model context window that triggers auto-compaction (or of the char-budget fallback when the window is unknown). Applied from the next run.",
  },
  {
    id: "compaction.keepTurns",
    label: "Keep latest turns",
    category: "Compaction",
    valueType: "number",
    values: stepValues(0, 20, 1),
    read: (config) => config.compaction.keepTurns,
    description:
      "Recent user turns kept verbatim after an auto or manual compaction. 0 summarizes everything; the newest turns above the cap are kept intact.",
  },
  {
    id: "compaction.maxOutputTokens",
    label: "Compaction max output tokens",
    category: "Compaction",
    valueType: "number",
    values: [8_000, 12_000, 16_000, 24_000, 32_000],
    read: (config) => config.compaction.maxOutputTokens,
    description:
      "Output token budget for the summarizer call. A summary cut by this budget is kept as partial; raise it for very long sessions.",
  },
  {
    id: "context.claudeMdFallback",
    label: "CLAUDE.md fallback",
    category: "Context",
    valueType: "boolean",
    values: [false, true],
    read: (config) => config.context.claudeMdFallback,
    description:
      "Use a directory's CLAUDE.md when it has no AGENTS.md (agents.md convention). Loaded as project instructions from the next turn.",
  },
  {
    id: "context.maxBytes",
    label: "AGENTS.md max bytes",
    category: "Context",
    valueType: "number",
    // 4 KiB steps aligned to the default (32 KiB is on-grid); 1024 stays reachable by hand-edit.
    values: stepValues(4096, 1_048_576, 4096),
    read: (config) => config.context.maxBytes,
    description:
      "Total AGENTS.md bytes injected. The closest instruction files are kept up to this budget; raise it for very large repositories.",
  },
  {
    id: "websearch.provider",
    label: "Web search provider",
    category: "Web",
    valueType: "enum",
    values: [...WEBSEARCH_PROVIDERS],
    read: (config) => config.websearch.provider,
    description:
      "Backend used by websearch tools. Unset falls back to a plugin extension, then a public SearXNG instance; `native` runs search server-side and must be supported by the active provider.",
  },
  {
    id: "mcp.allow",
    label: "Remember MCP consent",
    category: "MCP",
    valueType: "boolean",
    values: [false, true],
    read: (_config, mcpAllowPersisted) => mcpAllowPersisted,
    description:
      "Persist process/network consent for MCP servers in your user configuration (mcp.allow). On: every start grants permission and auto-connects enabled servers; use /mcps to connect now. Off: revokes the persisted consent and disconnects servers.",
  },
  {
    id: "limits.maxTurns",
    label: "Max turns",
    category: "Limits",
    valueType: "number",
    values: [5, 10, 15, 20, 30, 50, 100],
    read: (config) => config.limits.maxTurns,
    description:
      "Maximum agent-loop turns per run. Reaching the limit ends the run softly: everything so far is kept and the session stays usable, so you can just say continue. Raise it for long read-heavy audits. Applied from the next run.",
  },
  {
    id: "limits.maxOutputTokens",
    label: "Agent max output tokens",
    category: "Limits",
    valueType: "number",
    values: [1_024, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536],
    // Unset: each request uses the model's declared limit (capped at 65536), else 16384.
    read: (config) => config.limits.maxOutputTokens ?? 16_384,
    description:
      "Per-call output token budget for agent turns. While you leave it unchanged, each request uses the output limit the model's catalog declares (capped at 65536), or 16384 when it declares none; a value set here always wins. A cut response shows a notice suggesting a higher value. Applied from the next run.",
  },
  {
    id: "limits.maxContextChars",
    label: "Context char budget",
    category: "Limits",
    valueType: "number",
    values: [80_000, 120_000, 160_000, 240_000, 320_000, 800_000],
    read: (config) => config.limits.maxContextChars,
    description:
      "Hard context limit in characters (instruction files + transcript + tool list) per run; the budget fallback that auto-compaction measures when the model window is unknown. Applied from the next run.",
  },
  {
    id: "limits.timeoutMs",
    label: "Run timeout",
    category: "Limits",
    valueType: "number",
    // Displayed in seconds; the app host multiplies by 1000 before persisting milliseconds.
    values: stepValues(30, 600, 30),
    read: (config) => config.limits.timeoutMs / 1000,
    description:
      "Per-run timeout. A run over the limit is aborted; raise it for very long autonomous tasks.",
  },
  {
    id: "pluginHooks.timeoutMs",
    label: "Plugin hook timeout",
    category: "Plugins",
    valueType: "number",
    values: stepValues(1000, 120_000, 1000),
    read: (config) => config.pluginHooks.timeoutMs,
    description:
      "Host-enforced plugin hook timeout. Hooks (compaction, session start/end) are aborted when they exceed it; raise it for plugins that summarize slowly.",
  },
  {
    id: "analysis.enabled",
    label: "Data analysis",
    category: "Data analysis",
    valueType: "boolean",
    values: [false, true],
    read: (config) => config.analysis.enabled,
    description:
      "Python analysis (python_run), downloadable artifacts and tabular data tools. Off removes them. Applies the next time Alisio starts.",
  },
  {
    id: "analysis.limits.timeoutMs",
    label: "Analysis timeout",
    category: "Data analysis",
    valueType: "number",
    // Displayed in seconds; the app host multiplies by 1000 before persisting milliseconds.
    values: [30, 60, 120, 300, 600, 900],
    read: (config) => config.analysis.limits.timeoutMs / 1000,
    description:
      "Maximum run time of one python_run call, in seconds. The model can ask for less, never more. Applied from the next call.",
  },
  {
    id: "analysis.retention.jobsDays",
    label: "Keep analysis jobs (days)",
    category: "Data analysis",
    valueType: "number",
    values: [0, 7, 14, 30, 60, 90, 180, 365],
    read: (config) => config.analysis.retention.jobsDays,
    description:
      "Logs and staging of an analysis job, its script once no artifact is ready, and datasets unused for this long. 0 never deletes them. Swept at most once a day.",
  },
  {
    id: "analysis.retention.intermediateDays",
    label: "Keep intermediates (days)",
    category: "Data analysis",
    valueType: "number",
    values: [0, 1, 3, 7, 14, 30, 60],
    read: (config) => config.analysis.retention.intermediateDays,
    description:
      "The scratch folder (work/) of an analysis job. 0 never deletes it. Swept at most once a day.",
  },
  {
    id: "analysis.retention.artifactsDays",
    label: "Expire artifacts after (days)",
    category: "Data analysis",
    valueType: "number",
    values: [0, 7, 30, 90, 180, 365, 730],
    read: (config) => config.analysis.retention.artifactsDays,
    description:
      "Artifacts older than this expire: their files are deleted and the card shows Expired (Rerun can recreate them). 0 keeps them forever.",
  },
  {
    id: "tasks.enabled",
    label: "Background tasks",
    category: "Background tasks",
    valueType: "boolean",
    values: [false, true],
    read: (config) => config.tasks.enabled,
    description:
      "The bg_run, bg_list, bg_output and bg_stop tools. They are not sandboxed and end when Alisio exits. Off removes them. Applies the next time Alisio starts.",
  },
  {
    id: "tasks.maxPerSession",
    label: "Live tasks per session",
    category: "Background tasks",
    valueType: "number",
    values: [1, 2, 4, 8, 16, 32],
    read: (config) => config.tasks.maxPerSession,
    description:
      "How many background tasks one session can have running at once. Applied from the next task.",
  },
  {
    id: "tasks.retentionDays",
    label: "Keep finished tasks (days)",
    category: "Background tasks",
    valueType: "number",
    values: [0, 1, 3, 7, 14, 30, 90],
    read: (config) => config.tasks.retentionDays,
    description:
      "Finished tasks and their output logs are deleted after this many days. 0 keeps them. Swept at most once a day.",
  },
  {
    id: "goal.enabled",
    label: "Session goals",
    category: "Goals",
    valueType: "boolean",
    values: [false, true],
    read: (config) => config.goal.enabled,
    description:
      "/goal: the agent keeps working on one objective, turn after turn, with hard limits. Off refuses new goals and stops continuing the current one.",
  },
  {
    id: "goal.maxTurns",
    label: "Goal turn limit",
    category: "Goals",
    valueType: "number",
    values: [10, 25, 50, 100, 200, 500],
    read: (config) => config.goal.maxTurns,
    description:
      "A goal pauses after this many turns (a turn is one run: the kickoff, a continuation or your own prompt). Applies to goals started afterwards.",
  },
  {
    id: "goal.maxMinutes",
    label: "Goal time limit (minutes)",
    category: "Goals",
    valueType: "number",
    values: [15, 30, 60, 120, 240, 480],
    read: (config) => config.goal.maxMinutes,
    description:
      "A goal pauses after this much time spent inside runs (time spent waiting for you or for background tasks does not count). Applies to goals started afterwards. Without a token budget, the turn and time limits are the only hard stops.",
  },
  {
    id: "goal.repeatedReplyLimit",
    label: "Pause after identical replies",
    category: "Goals",
    valueType: "number",
    values: [2, 3, 4, 5, 8],
    read: (config) => config.goal.repeatedReplyLimit,
    description:
      "A goal pauses (no_progress) after this many identical final replies in a row. The first repeat is logged and the next continuation carries a nudge.",
  },
  {
    id: "goal.noToolTurnsLimit",
    label: "Pause after turns without tools",
    category: "Goals",
    valueType: "number",
    values: [2, 3, 4, 5, 8],
    read: (config) => config.goal.noToolTurnsLimit,
    description:
      "A goal pauses (no_progress) after this many turns in a row in which the agent called no tool.",
  },
  {
    id: "goal.blockedRepeats",
    label: "Blocker reports needed",
    category: "Goals",
    valueType: "number",
    values: [1, 2, 3, 4],
    read: (config) => config.goal.blockedRepeats,
    description:
      "How many consecutive turns the agent must report the same blocker (with evidence) before the goal stops as blocked. A permission denial blocks at once.",
  },
  {
    id: "tui.paddingX",
    label: "Editor padding",
    category: "TUI",
    valueType: "number",
    values: [0, 1, 2, 3, 4],
    read: (config) => config.tui.paddingX,
    description:
      "Horizontal padding (columns) around the editor input box. Applied immediately to the current editor.",
  },
  {
    id: "tui.contentPaddingX",
    label: "Content inset",
    category: "TUI",
    valueType: "number",
    values: [0, 1, 2, 3, 4, 6, 8, 12],
    read: (config) => config.tui.contentPaddingX,
    description:
      "Horizontal inset (columns) on each side of the transcript content, keeping agent-written rows clear of the window borders. Clamped on narrow terminals so the content column stays usable. Applied immediately.",
  },
  {
    id: "tui.skillSlashCommands",
    label: "Skill slash commands",
    category: "TUI",
    valueType: "boolean",
    values: [false, true],
    read: (config) => config.tui.skillSlashCommands,
    description:
      "Offer effective skills as first-class `skill:<id>` editor autocomplete entries. Off hides those entries; the `/skills` manager and its argument completion stay available. Applied immediately to the editor.",
  },
];

/**
 * Builds the full settings menu: the real, wired setting rows followed by the navigation rows the
 * host wires to the existing managers (`/model`, `/connect`, `/plugins`, `/skills`, `/mcps`, ...).
 * Under `--read-only` every setting row is marked read-only: nothing can be persisted.
 */
export function settingsMenuRows(
  input: SettingsMenuInput,
  navigation: SettingsNavigationAction[],
): SettingRow[] {
  const rows: SettingRow[] = [];
  for (const def of SETTINGS_DEFINITIONS) {
    rows.push({
      id: def.id,
      label: def.label,
      category: def.category,
      description: def.description,
      kind: "setting",
      current: def.read(input.config, input.mcpAllowPersisted),
      values: [...def.values],
      valueType: def.valueType,
      ...(input.readOnly ? { readOnly: true } : {}),
    });
  }
  rows.push(
    ...navigation.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      category: "Go to",
      kind: "navigation" as const,
      action: entry.id,
    })),
  );
  return rows;
}

/** Whether a row matches every whitespace-separated filter term, on label/id/category/description. */
export function matchSettingRow(row: SettingRow, terms: string[]): boolean {
  const haystack = [row.label, row.id, row.category, row.description].join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Filters rows by name, id, category (type) and description; an empty query returns everything. */
export function filterSettingRows(rows: SettingRow[], filter: string): SettingRow[] {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return rows;
  return rows.filter((row) => matchSettingRow(row, terms));
}

/** The value shown in the right-hand column of a setting row. */
export function formatSettingValue(row: SettingRow, value: unknown): string {
  if (row.valueType === "percent" && typeof value === "number")
    return `${Math.round(value * 100)}%`;
  if (row.valueType === "boolean") return value === true ? "true" : "false";
  return value === undefined || value === null ? "" : String(value);
}

/**
 * The next candidate after the current value in the row's ordered `values`, wrapping around.
 * A current value that is not in the list (hand-edited config) moves to the next candidate at or
 * above it for numbers, or wraps to the first candidate otherwise. Never mutates the row.
 */
export function cycleSettingValue(row: SettingRow, current: unknown): unknown | undefined {
  const values = row.values;
  if (!values?.length || row.readOnly) return undefined;
  const index = values.findIndex((value) => Object.is(value, current));
  if (index >= 0) return values[(index + 1) % values.length];
  if (typeof current === "number" && values.every((value) => typeof value === "number"))
    return values.find((value) => (value as number) >= current) ?? values[0];
  return values[0];
}

/** OpenCode-style `(n/total)` counter; empty when there are no rows to count. */
export function settingsCounter(rows: SettingRow[], selected: number): string {
  if (!rows.length) return "";
  const clamped = Math.min(Math.max(0, selected), rows.length - 1);
  return `(${clamped + 1}/${rows.length})`;
}

export interface SettingsMenuState {
  /** Live type-to-search filter (matched against name, id, category and description). */
  filter: string;
  /** Index into the FILTERED row list. */
  selected: number;
}

export const initialSettingsMenuState = (): SettingsMenuState => ({ filter: "", selected: 0 });

/**
 * Normalized keyboard actions for the settings menu, decoded from raw terminal input with plain
 * string matching so the logic stays testable without pi-tui. The component just forwards
 * `handleInput(data)` here and maps the resulting effect to its callbacks.
 */
export type SettingsKeyAction =
  | { kind: "move"; direction: "up" | "down" | "start" | "end" | "pageUp" | "pageDown" }
  | { kind: "type"; char: string }
  | { kind: "backspace" }
  /** Enter, or Space while the filter is empty (Space with an active filter types a space). */
  | { kind: "change" }
  | { kind: "cancel" }
  | { kind: "ignore" };

const PAGE_SIZE = 10;

export function settingsKeyAction(data: string, state: SettingsMenuState): SettingsKeyAction {
  if (!data) return { kind: "ignore" };
  if (data === "\x1b" || data === "\x1b[") return { kind: "cancel" };
  if (data === "\r" || data === "\n") return { kind: "change" };
  if (data === " " && !state.filter) return { kind: "change" };
  if (data === "\x1b[A") return { kind: "move", direction: "up" };
  if (data === "\x1b[B") return { kind: "move", direction: "down" };
  if (data === "\x1b[H" || data === "\x1b[1~") return { kind: "move", direction: "start" };
  if (data === "\x1b[F" || data === "\x1b[4~") return { kind: "move", direction: "end" };
  if (data === "\x1b[5~") return { kind: "move", direction: "pageUp" };
  if (data === "\x1b[6~") return { kind: "move", direction: "pageDown" };
  if (data === "\x7f" || data === "\b" || data === "\x08" || data === "\x1b[3~")
    return { kind: "backspace" };
  if (data.length === 1 && data >= " " && data <= "~") return { kind: "type", char: data };
  return { kind: "ignore" };
}

export type SettingsMenuEffect =
  | { type: "change"; row: SettingRow; value: unknown }
  | { type: "navigate"; row: SettingRow }
  | { type: "cancel" }
  | { type: "none" };

/**
 * Pure keyboard reducer over the menu state. `rows` is the current FILTERED list (navigation rows
 * and settings rows alike); Enter/Space changes a setting or navigates, Esc cancels, typing
 * filters, Backspace edits the filter, and movement keys move/clamp the selection.
 */
export function reduceSettingsInput(
  state: SettingsMenuState,
  action: SettingsKeyAction,
  rows: SettingRow[],
): { state: SettingsMenuState; effect: SettingsMenuEffect } {
  switch (action.kind) {
    case "cancel":
      return { state, effect: { type: "cancel" } };
    case "change": {
      const row = rows[state.selected];
      if (!row) return { state, effect: { type: "none" } };
      if (row.kind === "navigation") return { state, effect: { type: "navigate", row } };
      const value = cycleSettingValue(row, row.current);
      if (value === undefined) return { state, effect: { type: "none" } };
      return { state, effect: { type: "change", row, value } };
    }
    case "type": {
      const filter = `${state.filter}${action.char}`;
      return { state: { filter, selected: 0 }, effect: { type: "none" } };
    }
    case "backspace": {
      const filter = state.filter.slice(0, -1);
      return {
        state: { filter, selected: 0 },
        effect: { type: "none" },
      };
    }
    case "move": {
      if (!rows.length) return { state, effect: { type: "none" } };
      const last = rows.length - 1;
      const selected =
        action.direction === "up"
          ? state.selected === 0
            ? last
            : state.selected - 1
          : action.direction === "down"
            ? state.selected === last
              ? 0
              : state.selected + 1
            : action.direction === "start"
              ? 0
              : action.direction === "end"
                ? last
                : action.direction === "pageUp"
                  ? Math.max(0, state.selected - PAGE_SIZE)
                  : Math.min(last, state.selected + PAGE_SIZE);
      return { state: { ...state, selected }, effect: { type: "none" } };
    }
    case "ignore":
      return { state, effect: { type: "none" } };
  }
}
