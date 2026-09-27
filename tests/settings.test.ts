import { describe, expect, it } from "vitest";
import {
  cycleSettingValue,
  defaultConfig,
  filterSettingRows,
  formatSettingValue,
  initialSettingsMenuState,
  matchSettingRow,
  reduceSettingsInput,
  SETTINGS_DEFINITIONS,
  type SettingRow,
  type SettingsConfigView,
  type SettingsMenuInput,
  type SettingsNavigationAction,
  settingsCounter,
  settingsKeyAction,
  settingsMenuRows,
} from "../packages/cli/src/tui/settings.ts";

const config = (overrides: Partial<typeof defaultConfig> = {}): SettingsMenuInput["config"] => ({
  ...defaultConfig,
  ...overrides,
});

const input = (overrides: Partial<SettingsMenuInput> = {}): SettingsMenuInput => ({
  config: config(),
  mcpAllowPersisted: false,
  readOnly: false,
  ...overrides,
});

const NAVIGATION: SettingsNavigationAction[] = [
  { id: "go-plugins", label: "Plugins", description: "Browse plugins" },
  { id: "go-stats", label: "Statistics", description: "Session statistics" },
];

const rows = (overrides: Partial<SettingsMenuInput> = {}) =>
  settingsMenuRows(input(overrides), NAVIGATION);

describe("settings menu rows", () => {
  it("builds one row per real setting plus the navigation rows", () => {
    const all = rows();
    const settings = all.filter((row) => row.kind === "setting");
    expect(settings).toHaveLength(SETTINGS_DEFINITIONS.length);
    expect(settings.map((row) => row.id)).toEqual(SETTINGS_DEFINITIONS.map((def) => def.id));
    expect(all.filter((row) => row.kind === "navigation").map((row) => row.action)).toEqual([
      "go-plugins",
      "go-stats",
    ]);
  });

  it("reads every current value from the live config view", () => {
    const all = rows({
      config: config({
        compaction: { auto: false, threshold: 0.9, keepTurns: 0, maxOutputTokens: 12_000 },
        context: { claudeMdFallback: true, maxBytes: 65_536 },
        limits: {
          maxTurns: 10,
          maxOutputTokens: 8_192,
          maxContextChars: 240_000,
          timeoutMs: 120_000,
        },
        mcp: { allow: true },
        pluginHooks: { timeoutMs: 30_000 },
        tui: { paddingX: 2, skillSlashCommands: false },
        websearch: { provider: "tavily" },
      }),
      mcpAllowPersisted: true,
    });
    const byId = (id: string) => all.find((row) => row.id === id) as SettingRow;
    expect(byId("compaction.auto").current).toBe(false);
    expect(byId("compaction.threshold").current).toBe(0.9);
    expect(byId("compaction.keepTurns").current).toBe(0);
    expect(byId("compaction.maxOutputTokens").current).toBe(12_000);
    expect(byId("context.claudeMdFallback").current).toBe(true);
    // AGENTS.md max bytes is read raw (bytes).
    expect(byId("context.maxBytes").current).toBe(65_536);
    // Run timeout is displayed in seconds (120_000 ms -> 120 s).
    expect(byId("limits.timeoutMs").current).toBe(120);
    expect(byId("mcp.allow").current).toBe(true);
    expect(byId("limits.maxTurns").current).toBe(10);
    expect(byId("limits.maxOutputTokens").current).toBe(8_192);
    expect(byId("limits.maxContextChars").current).toBe(240_000);
    expect(byId("pluginHooks.timeoutMs").current).toBe(30_000);
    expect(byId("tui.paddingX").current).toBe(2);
    expect(byId("tui.skillSlashCommands").current).toBe(false);
    expect(byId("websearch.provider").current).toBe("tavily");
  });

  it("treats mcp.allow as unpersisted when the user has no saved consent", () => {
    expect(rows(input()).find((row) => row.id === "mcp.allow")?.current).toBe(false);
  });

  it("ignores unknown config keys: rows are only built from the documented surface", () => {
    const unknownConfig: SettingsConfigView & Record<string, unknown> = { ...config() };
    unknownConfig["telemetry"] = { enabled: true };
    (unknownConfig.compaction as unknown as Record<string, unknown>)["mermaidDiagrams"] = true;
    const all = settingsMenuRows({ ...input(), config: unknownConfig }, NAVIGATION);
    expect(all.some((row) => row.id === "telemetry.enabled")).toBe(false);
    expect(all.some((row) => row.id === "compaction.mermaidDiagrams")).toBe(false);
    expect(all.map((row) => row.id)).not.toContain("telemetry");
    // And no built row claims a value from a key the schema does not define.
    for (const row of all.filter((r) => r.kind === "setting"))
      expect(SETTINGS_DEFINITIONS.map((d) => d.id)).toContain(row.id);
  });

  it("marks every row read-only under --read-only", () => {
    const all = rows({ readOnly: true });
    for (const row of all.filter((row) => row.kind === "setting")) expect(row.readOnly).toBe(true);
  });
});

describe("filtering", () => {
  it("returns everything for an empty query", () => {
    const all = rows();
    expect(filterSettingRows(all, "")).toEqual(all);
  });

  it("matches by label, id (key), category and description, case-insensitively", () => {
    const all = rows();
    expect(matchSettingRow(all.find((r) => r.id === "compaction.auto")!, ["auto"])).toBe(true);
    expect(matchSettingRow(all.find((r) => r.id === "compaction.auto")!, ["compact"])).toBe(true);
    expect(matchSettingRow(all.find((r) => r.id === "limits.maxTurns")!, ["limits"])).toBe(true);
    expect(
      matchSettingRow(all.find((r) => r.id === "context.claudeMdFallback")!, ["claude", "md"]),
    ).toBe(true);
    // Description terms match too.
    expect(matchSettingRow(all.find((r) => r.id === "tui.paddingX")!, ["input", "box"])).toBe(true);
    // Navigation rows are searchable as well.
    expect(matchSettingRow(all.find((r) => r.id === "go-stats")!, ["statistics"])).toBe(true);
  });

  it("requires every whitespace-separated term to match", () => {
    const all = rows();
    expect(filterSettingRows(all, "limits loop").map((r) => r.id)).toEqual(["limits.maxTurns"]);
    expect(filterSettingRows(all, "limits bogus")).toEqual([]);
  });

  it("filters navigation rows by their own label/description", () => {
    const all = rows();
    expect(filterSettingRows(all, "statistics").map((r) => r.id)).toEqual(["go-stats"]);
  });
});

it("defaults max turns to 100 and keeps 100 a bounded candidate", () => {
  const row = rows().find((r) => r.id === "limits.maxTurns") as SettingRow;
  expect(row.current).toBe(100);
  expect(row.values?.at(-1)).toBe(100);
  // 101 is not an option: cycling moves a hand-edited value to a candidate (wraps to 5).
  expect(cycleSettingValue(row, 101)).toBe(5);
});

describe("value display and cycling", () => {
  it("formats booleans, percents and numbers for the value column", () => {
    const byId = (id: string) => rows().find((row) => row.id === id) as SettingRow;
    expect(formatSettingValue(byId("compaction.auto"), true)).toBe("true");
    expect(formatSettingValue(byId("compaction.auto"), false)).toBe("false");
    expect(formatSettingValue(byId("compaction.threshold"), 0.85)).toBe("85%");
    expect(formatSettingValue(byId("limits.maxTurns"), 20)).toBe("20");
    expect(formatSettingValue(byId("compaction.maxOutputTokens"), 16_000)).toBe("16000");
  });

  it("toggles booleans and wraps", () => {
    const row = rows().find((r) => r.id === "compaction.auto") as SettingRow;
    expect(cycleSettingValue(row, true)).toBe(false);
    expect(cycleSettingValue(row, false)).toBe(true);
  });

  it("steps through numbers and wraps at the end", () => {
    const row = rows().find((r) => r.id === "compaction.keepTurns") as SettingRow;
    expect(cycleSettingValue(row, 2)).toBe(3);
    expect(cycleSettingValue(row, 20)).toBe(0);
    const threshold = rows().find((r) => r.id === "compaction.threshold") as SettingRow;
    expect(cycleSettingValue(threshold, 0.85)).toBe(0.9);
    expect(cycleSettingValue(threshold, 0.95)).toBe(0.5);
  });

  it("moves a hand-edited value to the next candidate at or above it", () => {
    const threshold = rows().find((r) => r.id === "compaction.threshold") as SettingRow;
    expect(cycleSettingValue(threshold, 0.87)).toBe(0.9);
    expect(cycleSettingValue(threshold, 0.35)).toBe(0.5);
    const turns = rows().find((r) => r.id === "limits.maxTurns") as SettingRow;
    expect(cycleSettingValue(turns, 12)).toBe(15);
    expect(cycleSettingValue(turns, 101)).toBe(5);
  });

  it("cycles an enum through every option and wraps at the end", () => {
    const row = rows().find((r) => r.id === "websearch.provider") as SettingRow;
    expect(row.valueType).toBe("enum");
    expect(row.values).toEqual([
      "searxng",
      "duckduckgo-instant",
      "duckduckgo-html",
      "tavily",
      "brave",
      "serpapi",
      "native",
    ]);
    expect(cycleSettingValue(row, undefined)).toBe("searxng"); // unset -> first option
    expect(cycleSettingValue(row, "searxng")).toBe("duckduckgo-instant");
    expect(cycleSettingValue(row, "duckduckgo-instant")).toBe("duckduckgo-html");
    expect(cycleSettingValue(row, "duckduckgo-html")).toBe("tavily");
    expect(cycleSettingValue(row, "tavily")).toBe("brave");
    expect(cycleSettingValue(row, "native")).toBe("searxng"); // wraps
    // A hand-edited unknown provider moves to the first offered candidate.
    expect(cycleSettingValue(row, "yahoo")).toBe("searxng");
  });

  it("steps number rows within the schema bounds and clamps hand-edited values", () => {
    const maxBytes = rows().find((r) => r.id === "context.maxBytes") as SettingRow;
    expect(formatSettingValue(maxBytes, 32_768)).toBe("32768");
    // 4 KiB steps: the default (32 KiB) advances to 36 KiB, and the top bound wraps to the first.
    expect(cycleSettingValue(maxBytes, 32_768)).toBe(36_864);
    expect(cycleSettingValue(maxBytes, 1_048_576)).toBe(4096);
    // A hand-edited value below the schema min moves to the first candidate (4 KiB).
    expect(cycleSettingValue(maxBytes, 700)).toBe(4096);
    // A hand-edited value between steps moves to the next candidate at or above it.
    expect(cycleSettingValue(maxBytes, 100_000)).toBe(102_400);
    // The offered values never violate the schema bounds.
    expect(Math.min(...(maxBytes.values as number[]))).toBeGreaterThanOrEqual(1024);
    expect(Math.max(...(maxBytes.values as number[]))).toBeLessThanOrEqual(1_048_576);

    const hook = rows().find((r) => r.id === "pluginHooks.timeoutMs") as SettingRow;
    expect(cycleSettingValue(hook, 15_000)).toBe(16_000); // 1 s steps
    expect(Math.min(...(hook.values as number[]))).toBeGreaterThanOrEqual(100);
    expect(Math.max(...(hook.values as number[]))).toBeLessThanOrEqual(120_000);

    const timeout = rows().find((r) => r.id === "limits.timeoutMs") as SettingRow;
    // Displayed in seconds: the default 5 min advances to 5 min 30 s.
    expect(cycleSettingValue(timeout, 300)).toBe(330);
    expect(formatSettingValue(timeout, 300)).toBe("300");
  });

  it("does not cycle read-only rows", () => {
    const all = rows({ readOnly: true });
    const row = all.find((r) => r.id === "compaction.auto") as SettingRow;
    expect(cycleSettingValue(row, true)).toBeUndefined();
  });

  it("never mutates the row's candidate list while cycling", () => {
    const row = rows().find((r) => r.id === "compaction.auto") as SettingRow;
    const before = [...(row.values ?? [])];
    cycleSettingValue(row, true);
    expect(row.current).toBe(true);
    expect(row.values).toEqual(before);
  });
});

describe("counter", () => {
  it("renders OpenCode-style (n/total)", () => {
    expect(settingsCounter(rows(), 0)).toBe("(1/17)");
    expect(settingsCounter(rows(), 16)).toBe("(17/17)");
  });
  it("is empty for an empty list and clamps out-of-range selections", () => {
    expect(settingsCounter([], 0)).toBe("");
    expect(settingsCounter(rows(), 99)).toBe("(17/17)");
    expect(settingsCounter(rows(), -3)).toBe("(1/17)");
  });
});

describe("key decoding and input reduction", () => {
  const initial = initialSettingsMenuState();

  it("decodes standard terminal sequences without pi-tui", () => {
    expect(settingsKeyAction("\x1b", initial)).toEqual({ kind: "cancel" });
    expect(settingsKeyAction("\r", initial)).toEqual({ kind: "change" });
    expect(settingsKeyAction("\n", initial)).toEqual({ kind: "change" });
    expect(settingsKeyAction(" ", initial)).toEqual({ kind: "change" });
    expect(settingsKeyAction("\x1b[A", initial)).toEqual({ kind: "move", direction: "up" });
    expect(settingsKeyAction("\x1b[B", initial)).toEqual({ kind: "move", direction: "down" });
    expect(settingsKeyAction("\x1b[H", initial)).toEqual({ kind: "move", direction: "start" });
    expect(settingsKeyAction("\x1b[4~", initial)).toEqual({ kind: "move", direction: "end" });
    expect(settingsKeyAction("\x1b[5~", initial)).toEqual({ kind: "move", direction: "pageUp" });
    expect(settingsKeyAction("\x1b[6~", initial)).toEqual({ kind: "move", direction: "pageDown" });
    expect(settingsKeyAction("\x7f", initial)).toEqual({ kind: "backspace" });
    expect(settingsKeyAction("m", initial)).toEqual({ kind: "type", char: "m" });
    expect(settingsKeyAction("\x13", initial)).toEqual({ kind: "ignore" });
  });

  it("types a space into the filter once the filter is active", () => {
    const active = { ...initial, filter: "compaction" };
    expect(settingsKeyAction(" ", active)).toEqual({ kind: "type", char: " " });
  });

  it("Esc cancels", () => {
    const { effect } = reduceSettingsInput(initial, { kind: "cancel" }, rows());
    expect(effect).toEqual({ type: "cancel" });
  });

  it("Enter/Space changes a setting and cycles its value", () => {
    const all = rows();
    const row = all.find((r) => r.id === "compaction.auto") as SettingRow;
    const result = reduceSettingsInput(initial, { kind: "change" }, [row]);
    expect(result.effect).toEqual({ type: "change", row, value: false });
    // The row's current value only updates when the host applies the change.
    expect(row.current).toBe(true);
  });

  it("Enter/Space on a navigation row navigates", () => {
    const all = rows();
    const nav = all.find((r) => r.id === "go-plugins") as SettingRow;
    const result = reduceSettingsInput(initial, { kind: "change" }, [nav]);
    expect(result.effect).toEqual({ type: "navigate", row: nav });
  });

  it("does nothing on Empty rows or read-only settings", () => {
    expect(reduceSettingsInput(initial, { kind: "change" }, []).effect).toEqual({ type: "none" });
    const readOnly = rows({ readOnly: true }).filter((r) => r.kind === "setting");
    expect(reduceSettingsInput(initial, { kind: "change" }, readOnly).effect).toEqual({
      type: "none",
    });
  });

  it("typing filters and resets selection; backspace restores the previous results", () => {
    const all = rows();
    let state = initial;
    const typed = reduceSettingsInput(state, { kind: "type", char: "k" }, all);
    expect(typed.state.filter).toBe("k");
    expect(typed.state.selected).toBe(0);
    expect(filterSettingRows(all, "latest").map((r) => r.id)).toEqual(["compaction.keepTurns"]);
    state = typed.state;
    const dropped = reduceSettingsInput(state, { kind: "backspace" }, all);
    expect(dropped.state.filter).toBe("");
    expect(dropped.state.selected).toBe(0);
  });

  it("moves, wraps and clamps the selection", () => {
    const all = rows();
    const move = (state: typeof initial, direction: "up" | "down" | "start" | "end") =>
      reduceSettingsInput(state, { kind: "move", direction }, all).state;
    expect(move(initial, "down").selected).toBe(1);
    expect(move({ filter: "", selected: all.length - 1 }, "down").selected).toBe(0);
    expect(move({ filter: "", selected: 0 }, "up").selected).toBe(all.length - 1);
    expect(move(initial, "end").selected).toBe(all.length - 1);
    expect(move({ filter: "", selected: 5 }, "start").selected).toBe(0);
    expect(
      reduceSettingsInput(initial, { kind: "move", direction: "pageDown" }, all).state.selected,
    ).toBe(10);
    expect(
      reduceSettingsInput({ filter: "", selected: 11 }, { kind: "move", direction: "pageUp" }, all)
        .state.selected,
    ).toBe(1);
    expect(reduceSettingsInput(initial, { kind: "move", direction: "down" }, []).state).toBe(
      initial,
    );
  });
});
