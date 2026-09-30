import { describe, expect, it, vi } from "vitest";
import {
  defaultConfig,
  type SettingRow,
  type SettingsMenuInput,
  type SettingsNavigationAction,
  settingsMenuRows,
} from "../packages/cli/src/tui/settings.ts";
import { SettingsMenu } from "../packages/cli/src/tui/settings-menu.ts";

const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

const NAVIGATION: SettingsNavigationAction[] = [
  { id: "go-plugins", label: "Plugins", description: "Browse plugins" },
  { id: "go-mcp", label: "MCP servers", description: "Browse MCP servers" },
];

const input = (overrides: Partial<SettingsMenuInput> = {}): SettingsMenuInput => ({
  config: defaultConfig,
  mcpAllowPersisted: false,
  readOnly: false,
  ...overrides,
});

const menu = (overrides: Partial<SettingsMenuInput> = {}) => {
  const onChange = vi.fn();
  const onNavigate = vi.fn();
  const onCancel = vi.fn();
  const component = new SettingsMenu(
    "Settings",
    settingsMenuRows(input(overrides), NAVIGATION),
    onChange,
    onNavigate,
    onCancel,
    "Current: Example · model",
  );
  return { component, onChange, onNavigate, onCancel };
};

const rendered = (component: SettingsMenu) => stripAnsi(component.render(80).join("\n"));

describe("SettingsMenu", () => {
  it("renders a two-column list with aligned values, counter and footer description", () => {
    const { component } = menu();
    const text = rendered(component);
    expect(text).toContain("Settings");
    expect(text).toContain("Current: Example · model");
    expect(text).toContain("Auto-compact");
    expect(text).toContain("true"); // default compaction.auto
    expect(text).toContain("85%"); // default compaction.threshold
    expect(text).toContain("(1/18)");
    // Footer: description of the highlighted row is shown.
    expect(text).toContain("Summarize older history automatically");
    expect(text).toContain("Type to search · Enter/Space to change · Esc to cancel");
    // Navigation rows live at the bottom of the list: scroll to them.
    component.handleInput("\x1b[F");
    const bottom = rendered(component);
    expect(bottom).toContain("Plugins");
    expect(bottom).toContain("MCP servers");
  });

  it("aligns the value column across rows", () => {
    const { component } = menu();
    const lines = stripAnsi(component.render(80).join("\n")).split("\n");
    // Every setting row line ends with its value; the label column is padded to the widest label.
    const starts = lines
      .filter((line) => /\b(true|false|\d+%?)\s*$/.test(line.trim()))
      .map(
        (line) =>
          line.length - (line.trimEnd().match(/\b(true|false|\d+%?)\s*$/)?.[0]?.length ?? 0),
      );
    expect(starts.length).toBeGreaterThan(5);
    expect(new Set(starts).size).toBe(1);
  });

  it("Enter cycles the highlighted setting and reports the change", () => {
    const { component, onChange } = menu();
    component.handleInput("\r");
    expect(onChange).toHaveBeenCalledOnce();
    const [row, value] = onChange.mock.calls[0] as [SettingRow, unknown];
    expect(row.id).toBe("compaction.auto");
    expect(value).toBe(false);
    // The row's value column updates optimistically.
    expect(rendered(component)).toContain("false");
  });

  it("Space cycles too, but types a space into the filter once the filter is active", () => {
    const { component, onChange } = menu();
    component.handleInput(" ");
    expect(onChange).toHaveBeenCalledOnce();
    onChange.mockClear();
    component.handleInput("a"); // filter becomes "a"
    component.handleInput(" "); // now a space goes into the filter
    expect(onChange).not.toHaveBeenCalled();
    expect(rendered(component)).toContain("filter: a ");
  });

  it("cycles through every candidate and wraps at the end", () => {
    const { component, onChange } = menu();
    // Move to "Keep latest turns" (row index 2), then cycle 2 -> 3.
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    const [row, value] = onChange.mock.calls[0] as [SettingRow, unknown];
    expect(row.id).toBe("compaction.keepTurns");
    expect(value).toBe(3);
  });

  it("Esc cancels", () => {
    const { component, onCancel } = menu();
    component.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("navigates on a navigation row", () => {
    const { component, onNavigate } = menu();
    // Jump to the last row ("MCP servers": 11 = 12 rows - 1).
    component.handleInput("\x1b[F");
    component.handleInput("\r");
    expect(onNavigate).toHaveBeenCalledOnce();
    const row = onNavigate.mock.calls[0]?.[0];
    expect(row.id).toBe("go-mcp");
  });

  it("types to filter and re-selects the matching row", () => {
    const { component, onChange } = menu();
    component.handleInput("c");
    component.handleInput("l");
    component.handleInput("a");
    component.handleInput("u");
    component.handleInput("d");
    component.handleInput("e"); // filter "claude" -> exactly CLAUDE.md fallback
    const text = rendered(component);
    expect(text).toContain("filter: claude");
    expect(text).toContain("(1/1)");
    expect(text).toContain("CLAUDE.md fallback");
    component.handleInput("\r");
    const [row, value] = onChange.mock.calls[0] as [SettingRow, unknown];
    expect(row.id).toBe("context.claudeMdFallback");
    expect(value).toBe(true);
  });

  it("shows an empty state when nothing matches", () => {
    const { component, onChange } = menu();
    component.handleInput("z");
    component.handleInput("z"); // "zz" matches nothing
    const text = rendered(component);
    expect(text).toContain("No matching settings");
    expect(text).not.toContain("(1/");
    component.handleInput("\r");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the filter and re-selects the changed row after refresh", () => {
    const { component, onChange } = menu();
    component.handleInput("i");
    component.handleInput("n");
    component.handleInput("p");
    component.handleInput("u");
    component.handleInput("t"); // filter "input" -> only "Editor padding"
    component.handleInput("\r");
    expect(onChange).toHaveBeenCalledOnce();
    const [row, value] = onChange.mock.calls[0] as [SettingRow, unknown];
    expect(row.id).toBe("tui.paddingX");
    expect(value).toBe(2);
    // Simulate the host's refresh with the value applied (paddingX now 2).
    const refreshed = settingsMenuRows(
      {
        ...input(),
        config: {
          ...defaultConfig,
          tui: { paddingX: 2, contentPaddingX: 2, skillSlashCommands: true },
        },
      },
      NAVIGATION,
    );
    component.refresh(refreshed);
    const text = rendered(component);
    expect(text).toContain("filter: input");
    expect(text).toContain("(1/1)");
    expect(text).toContain("Editor padding");
  });

  it("marks all settings read-only under --read-only", () => {
    const { component, onChange } = menu({ readOnly: true });
    component.handleInput("\r");
    expect(onChange).not.toHaveBeenCalled();
  });
});
