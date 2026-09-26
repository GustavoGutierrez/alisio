import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { style } from "./theme.ts";

export type SkillSort = "name" | "source" | "tokens";
export interface SkillCatalogView {
  id: string;
  effectiveId: string;
  displayId: string;
  name: string;
  description: string;
  scope: "project" | "config" | "user" | "plugin";
  source: string;
  owner?: { id: string; name: string };
  manageable: boolean;
  locked: boolean;
  enabled: boolean;
  effective: boolean;
  shadowedBy?: string;
  approximateTokens: number;
}
export interface SkillManagerState {
  query: string;
  searching: boolean;
  sort: SkillSort;
  selectedId?: string;
  offset: number;
}
export interface SkillViewport {
  items: SkillCatalogView[];
  selected: number;
  offset: number;
  above: number;
  below: number;
}

export const initialSkillManagerState = (entries: SkillCatalogView[]): SkillManagerState => ({
  query: "",
  searching: false,
  sort: "name",
  selectedId: entries[0]?.id,
  offset: 0,
});

export function visibleSkills(entries: SkillCatalogView[], state: SkillManagerState) {
  const query = state.query.trim().toLowerCase();
  const filtered = query
    ? entries.filter((entry) =>
        `${entry.displayId} ${entry.description} ${entry.scope} ${entry.source} ${entry.owner?.name ?? ""}`
          .toLowerCase()
          .includes(query),
      )
    : [...entries];
  const byName = (a: SkillCatalogView, b: SkillCatalogView) =>
    a.displayId.localeCompare(b.displayId);
  filtered.sort((a, b) => {
    if (state.sort === "source")
      return a.source.localeCompare(b.source) || a.scope.localeCompare(b.scope) || byName(a, b);
    if (state.sort === "tokens") return b.approximateTokens - a.approximateTokens || byName(a, b);
    return byName(a, b);
  });
  return filtered;
}

export function retainSkillSelection(
  entries: SkillCatalogView[],
  state: SkillManagerState,
): SkillManagerState {
  const visible = visibleSkills(entries, state);
  if (visible.some((entry) => entry.id === state.selectedId)) return state;
  return { ...state, selectedId: visible[0]?.id, offset: 0 };
}

export function skillViewport(
  entries: SkillCatalogView[],
  state: SkillManagerState,
  capacity: number,
): SkillViewport {
  const visible = visibleSkills(entries, state);
  const selected = Math.max(
    0,
    visible.findIndex((entry) => entry.id === state.selectedId),
  );
  const size = Math.max(1, capacity);
  let offset = Math.max(0, Math.min(state.offset, Math.max(0, visible.length - size)));
  if (selected < offset) offset = selected;
  else if (selected >= offset + size) offset = selected - size + 1;
  const items = visible.slice(offset, offset + size);
  return {
    items,
    selected,
    offset,
    above: offset,
    below: Math.max(0, visible.length - offset - items.length),
  };
}

const SORTS: SkillSort[] = ["name", "source", "tokens"];
export const cycleSkillSort = (sort: SkillSort): SkillSort =>
  SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length] ?? "name";

export function moveSkillSelection(
  entries: SkillCatalogView[],
  state: SkillManagerState,
  move: "up" | "down" | "pageUp" | "pageDown" | "home" | "end",
  capacity: number,
): SkillManagerState {
  const visible = visibleSkills(entries, state);
  if (!visible.length) return { ...state, selectedId: undefined, offset: 0 };
  const current = Math.max(
    0,
    visible.findIndex((entry) => entry.id === state.selectedId),
  );
  const delta = Math.max(1, capacity - 1);
  const next =
    move === "home"
      ? 0
      : move === "end"
        ? visible.length - 1
        : Math.max(
            0,
            Math.min(
              visible.length - 1,
              current +
                (move === "up" ? -1 : move === "down" ? 1 : move === "pageUp" ? -delta : delta),
            ),
          );
  return { ...state, selectedId: visible[next]?.id };
}

const sourceLabel = (entry: SkillCatalogView) =>
  entry.locked ? "locked by plugin · plugin" : entry.scope === "config" ? "config" : entry.scope;
const marker = (entry: SkillCatalogView) => (!entry.effective ? "↳" : entry.enabled ? "✔" : "○");

export class SkillsManager implements Component {
  private entries: SkillCatalogView[];
  private state: SkillManagerState;
  private width = 80;
  private height: () => number;
  private pending = false;
  constructor(options: {
    entries: SkillCatalogView[];
    height: () => number;
    onClose: () => void;
    onToggle: (id: string, enabled: boolean) => Promise<SkillCatalogView>;
    onError: (error: unknown) => void;
    onChanged: (message: string) => void;
    requestRender: () => void;
  }) {
    this.entries = options.entries;
    this.state = initialSkillManagerState(this.entries);
    this.height = options.height;
    this.onClose = options.onClose;
    this.onToggle = options.onToggle;
    this.onError = options.onError;
    this.onChanged = options.onChanged;
    this.requestRender = options.requestRender;
  }
  private onClose: () => void;
  private onToggle: (id: string, enabled: boolean) => Promise<SkillCatalogView>;
  private onError: (error: unknown) => void;
  private onChanged: (message: string) => void;
  private requestRender: () => void;
  invalidate(): void {}
  private capacity() {
    return Math.max(1, this.height() - 12);
  }
  private selected() {
    return visibleSkills(this.entries, this.state).find(
      (entry) => entry.id === this.state.selectedId,
    );
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.onClose();
    if (this.state.searching) {
      if (matchesKey(data, Key.backspace)) this.state.query = this.state.query.slice(0, -1);
      else if (matchesKey(data, Key.enter)) this.state.searching = false;
      else if (data.length === 1 && data >= " " && data <= "~") this.state.query += data;
      this.state = retainSkillSelection(this.entries, this.state);
      this.requestRender();
      return;
    }
    const capacity = this.capacity();
    let move: Parameters<typeof moveSkillSelection>[2] | undefined;
    if (matchesKey(data, Key.up) || /^\x1b\[<64;/.test(data)) move = "up";
    else if (matchesKey(data, Key.down) || /^\x1b\[<65;/.test(data)) move = "down";
    else if (data === "\x1b[5~") move = "pageUp";
    else if (data === "\x1b[6~") move = "pageDown";
    else if (["\x1b[H", "\x1b[1~"].includes(data)) move = "home";
    else if (["\x1b[F", "\x1b[4~"].includes(data)) move = "end";
    if (move) this.state = moveSkillSelection(this.entries, this.state, move, capacity);
    else if (data === "/") this.state = { ...this.state, searching: true };
    else if (data === "t") {
      this.state = retainSkillSelection(this.entries, {
        ...this.state,
        sort: cycleSkillSort(this.state.sort),
        offset: 0,
      });
    } else if ((matchesKey(data, Key.enter) || data === " ") && !this.pending) {
      const selected = this.selected();
      if (selected?.manageable && !selected.locked && selected.effective) {
        this.pending = true;
        void this.onToggle(selected.id, !selected.enabled)
          .then((updated) => {
            this.entries = this.entries.map((entry) => (entry.id === updated.id ? updated : entry));
            this.onChanged(`${updated.displayId}: ${updated.enabled ? "enabled" : "disabled"}.`);
          })
          .catch(this.onError)
          .finally(() => {
            this.pending = false;
            this.requestRender();
          });
      }
    }
    this.requestRender();
  }
  render(width: number): string[] {
    this.width = width;
    const state = retainSkillSelection(this.entries, this.state);
    this.state = state;
    const viewport = skillViewport(this.entries, state, this.capacity());
    this.state.offset = viewport.offset;
    const all = visibleSkills(this.entries, state);
    const selected = this.selected();
    const fit = (line: string) => truncateToWidth(line, Math.max(1, width));
    const lines = [
      fit(style.bold(style.yellow("Skills"))),
      fit(
        style.dim(
          `${all.length}/${this.entries.length} · sort: ${state.sort} · enter/space to cycle, / to search, t to sort, Esc to close`,
        ),
      ),
      fit(
        state.searching || state.query
          ? `Search: ${state.query}${state.searching ? "▏" : ""}`
          : "Search: —",
      ),
    ];
    if (viewport.above) lines.push(fit(style.dim(`↑ ${viewport.above} more above`)));
    for (const entry of viewport.items) {
      const active = entry.id === state.selectedId;
      const text = `${marker(entry)} ${entry.displayId}   ${sourceLabel(entry)} · ~${entry.approximateTokens} tok`;
      lines.push(fit(active ? `\x1b[7m${text}\x1b[27m` : text));
    }
    if (viewport.below) lines.push(fit(style.dim(`↓ ${viewport.below} more below`)));
    if (!viewport.items.length) lines.push(fit(style.dim("No skills match this search.")));
    if (selected) {
      const status = !selected.effective
        ? `shadowed by ${selected.shadowedBy ?? "a higher-precedence skill"}`
        : selected.enabled
          ? "effective · enabled"
          : "effective · disabled";
      const action = selected.locked
        ? `Locked by plugin ${selected.owner?.name ?? selected.owner?.id ?? "owner"}; use /plugins to manage it.`
        : selected.effective
          ? `${this.pending ? "Saving…" : "Enter/Space"} ${selected.enabled ? "disables" : "enables"} this skill for this project.`
          : "This lower-precedence copy cannot be toggled independently.";
      lines.push(fit(style.bold(selected.displayId)));
      lines.push(
        ...wrapTextWithAnsi(selected.description, Math.max(1, width)).slice(0, 2).map(fit),
      );
      lines.push(
        fit(
          style.dim(
            `Source: ${sourceLabel(selected)} · Scope: ${selected.scope} · ~${selected.approximateTokens} tokens`,
          ),
        ),
      );
      lines.push(fit(style.dim(`Status: ${status}`)));
      lines.push(fit(style.dim(action)));
    }
    return lines.slice(0, Math.max(4, this.height()));
  }
}
