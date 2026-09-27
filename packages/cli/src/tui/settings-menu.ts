/**
 * OpenCode-style settings menu for the TUI: two-column rows (name + current value), live
 * type-to-search, Enter/Space to change a setting (or navigate), Esc to leave, a `(n/total)`
 * counter and a footer with the highlighted row's description.
 *
 * This component is a thin shell: all decision logic (key decoding, filtering, cycling, counter)
 * lives in the pure `settings.ts` module, which is fully unit-tested without pi-tui.
 */
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
  filterSettingRows,
  formatSettingValue,
  initialSettingsMenuState,
  reduceSettingsInput,
  type SettingRow,
  type SettingsMenuState,
  settingsCounter,
  settingsKeyAction,
} from "./settings.ts";
import { style } from "./theme.ts";

const MAX_VISIBLE = 10;

const wrapText = (text: string, width: number): string[] => {
  const rows: string[] = [];
  let row = "";
  for (const word of text.split(/\s+/)) {
    if (row && [...`${row} ${word}`].length > width) {
      rows.push(row);
      row = word;
    } else row = row ? `${row} ${word}` : word;
  }
  if (row) rows.push(row);
  return rows;
};

export class SettingsMenu implements Component {
  private full: SettingRow[];
  private filtered: SettingRow[];
  private state: SettingsMenuState = initialSettingsMenuState();

  constructor(
    private title: string,
    rows: SettingRow[],
    /** A setting value changed: persist and apply it. The host re-refreshes on success/failure. */
    private onChange: (row: SettingRow, value: unknown) => void,
    /** A navigation row was activated (Enter/Space): route to its manager. */
    private onNavigate: (row: SettingRow) => void,
    /** Esc pressed: leave the menu (the host returns to the editor). */
    private onCancel: () => void,
    /** Optional dim lines under the title (e.g. the current provider/model). */
    private detail?: string,
  ) {
    this.full = rows;
    this.filtered = rows;
  }

  /** Rebuild rows from the live config after a write; keeps the filter and re-selects the row. */
  refresh(rows: SettingRow[]): void {
    const previous = this.filtered[this.state.selected]?.id;
    this.full = rows;
    this.filtered = filterSettingRows(rows, this.state.filter);
    const index = previous ? this.filtered.findIndex((row) => row.id === previous) : -1;
    this.state = { ...this.state, selected: index >= 0 ? index : 0 };
  }

  /** Update the displayed value of one row without rebuilding the whole list. */
  updateValue(id: string, value: unknown): void {
    for (const row of this.full) if (row.id === id) row.current = value;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const action = settingsKeyAction(data, this.state);
    const { state, effect } = reduceSettingsInput(this.state, action, this.filtered);
    this.state = state;
    // Re-apply the live filter so typing narrows the list before the next render/input.
    this.filtered = filterSettingRows(this.full, state.filter);
    switch (effect.type) {
      case "change":
        // Optimistically reflect the new value; the host refreshes from the config on success.
        effect.row.current = effect.value;
        this.onChange(effect.row, effect.value);
        break;
      case "navigate":
        this.onNavigate(effect.row);
        break;
      case "cancel":
        this.onCancel();
        break;
      case "none":
        break;
    }
  }

  render(width: number): string[] {
    const lines: string[] = [truncateToWidth(style.bold(style.yellow(this.title)), width)];
    if (this.detail?.trim())
      for (const line of wrapText(this.detail, Math.max(20, width - 2)))
        lines.push(truncateToWidth(style.dim(`  ${line}`), width));
    if (this.state.filter)
      lines.push(truncateToWidth(style.dim(`  filter: ${this.state.filter}`), width));
    const rows = this.filtered;
    if (!rows.length) {
      lines.push(
        truncateToWidth(
          style.yellow(this.full.length ? "  No matching settings" : "  No settings available"),
          width,
        ),
      );
      lines.push("");
      lines.push(truncateToWidth(style.dim("  Type to search · Esc to cancel"), width));
      return lines;
    }
    // Two-column layout: labels padded to the widest row (capped), values right beside them.
    const maxLabel = Math.min(36, Math.max(...rows.map((row) => [...row.label].length)));
    const start = Math.max(
      0,
      Math.min(this.state.selected - Math.floor(MAX_VISIBLE / 2), rows.length - MAX_VISIBLE),
    );
    const visible = rows.slice(start, start + MAX_VISIBLE);
    for (let i = 0; i < visible.length; i++) {
      const row = visible[i];
      if (!row) continue;
      const selected = start + i === this.state.selected;
      const label = row.label.padEnd(maxLabel);
      const value = row.kind === "setting" ? formatSettingValue(row, row.current) : "";
      const rendered = selected
        ? `${style.cyan("›")} ${style.bold(style.cyan(label))}${value ? `  ${style.bold(style.cyan(value))}` : ""}`
        : `  ${label}${value ? `  ${value}` : ""}`;
      lines.push(truncateToWidth(rendered, width));
    }
    lines.push(
      truncateToWidth(style.dim(`  ${settingsCounter(rows, this.state.selected)}`), width),
    );
    const selectedRow = rows[this.state.selected];
    if (selectedRow?.description) {
      lines.push("");
      for (const wrapped of wrapText(selectedRow.description, Math.max(20, width - 4)))
        lines.push(truncateToWidth(style.gray(`  ${wrapped}`), width));
      lines.push("");
    }
    lines.push(
      truncateToWidth(style.dim("  Type to search · Enter/Space to change · Esc to cancel"), width),
    );
    return lines;
  }
}
