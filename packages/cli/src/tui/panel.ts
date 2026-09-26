/**
 * Pure focus/navigation reducer for plugin tree panels (e.g. the agent tree) and the read-only
 * child session view. Three focus modes:
 * - editor: normal typing; Ctrl+X, or ↓ on an empty editor, focuses the panel.
 * - panel: plain arrows move/expand/collapse, Enter opens, Esc/Tab return to the editor.
 *   Ctrl+X then ↓ within the chord window opens the first agent directly.
 * - view: a child's read-only conversation; ↑ parent, ↓ first child, ←/→ siblings, Esc back.
 * Ctrl+K cancels the selected/viewed node (confirmation when it has descendants).
 */
import type { PanelNode } from "@alisio/sdk";

export interface PanelState {
  focus: "editor" | "panel" | "view";
  selected?: string;
  viewing?: string;
  collapsed: Set<string>;
  chordUntil?: number;
  confirm?: { id: string; count: number };
}
export type PanelAction =
  | { type: "ctrlX"; now: number }
  | { type: "key"; key: string; now: number; editorEmpty?: boolean };
export type PanelEffect =
  | { type: "open"; sessionId: string }
  | { type: "close-view" }
  | { type: "cancel"; id: string };
export const CHORD_MS = 800;
export const initialPanelState = (): PanelState => ({ focus: "editor", collapsed: new Set() });

export interface Row {
  node: PanelNode;
  depth: number;
  hasChildren: boolean;
}
const childrenOf = (nodes: PanelNode[], id: string | undefined) =>
  nodes.filter((n) => (n.parentId ?? undefined) === id);
/** Tree order (parents before children) skipping the descendants of collapsed nodes. */
export function visibleRows(nodes: PanelNode[], collapsed: Set<string>): Row[] {
  const rows: Row[] = [];
  const known = new Set(nodes.map((n) => n.id));
  const visit = (parent: string | undefined, depth: number) => {
    for (const node of nodes.filter((n) =>
      parent === undefined ? !n.parentId || !known.has(n.parentId) : n.parentId === parent,
    )) {
      const kids = childrenOf(nodes, node.id);
      rows.push({ node, depth, hasChildren: kids.length > 0 });
      if (!collapsed.has(node.id)) visit(node.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return rows;
}
export function descendants(nodes: PanelNode[], id: string): string[] {
  return childrenOf(nodes, id).flatMap((c) => [c.id, ...descendants(nodes, c.id)]);
}
const byId = (nodes: PanelNode[], id: string | undefined) => nodes.find((n) => n.id === id);

export function reducePanel(
  state: PanelState,
  action: PanelAction,
  nodes: PanelNode[],
): { state: PanelState; effect?: PanelEffect; handled: boolean } {
  const done = (next: PanelState, effect?: PanelEffect) => ({
    state: next,
    ...(effect ? { effect } : {}),
    handled: true,
  });
  const skip = { state, handled: false };
  const first = visibleRows(nodes, state.collapsed)[0]?.node;
  const cancelOrConfirm = (id: string | undefined) => {
    if (!id) return done(state);
    const count = descendants(nodes, id).length;
    return count
      ? done({ ...state, confirm: { id, count } })
      : done({ ...state, confirm: undefined }, { type: "cancel", id });
  };
  const open = (node: PanelNode | undefined, base: PanelState) =>
    node?.sessionId
      ? done(
          { ...base, focus: "view", viewing: node.id, selected: node.id, chordUntil: undefined },
          {
            type: "open",
            sessionId: node.sessionId,
          },
        )
      : done(base);
  if (state.confirm && action.type === "key") {
    if (action.key === "yes")
      return done({ ...state, confirm: undefined }, { type: "cancel", id: state.confirm.id });
    return done({ ...state, confirm: undefined });
  }
  if (action.type === "ctrlX") {
    if (!nodes.length) return skip;
    const running = nodes.find((n) => n.status === "running") ?? first;
    return done({
      ...state,
      focus: "panel",
      selected:
        state.selected && byId(nodes, state.selected) ? state.selected : (running?.id ?? first?.id),
      chordUntil: action.now + CHORD_MS,
    });
  }
  const key = action.key;
  if (state.focus === "editor") {
    if (key === "down" && action.editorEmpty && nodes.length)
      return done({ ...state, focus: "panel", selected: state.selected ?? first?.id });
    return skip;
  }
  if (state.focus === "panel") {
    const rows = visibleRows(nodes, state.collapsed);
    const index = Math.max(
      0,
      rows.findIndex((r) => r.node.id === state.selected),
    );
    const current = rows[index];
    switch (key) {
      case "down":
        if (state.chordUntil && action.now <= state.chordUntil) return open(first, state);
        return done({
          ...state,
          selected: rows[Math.min(rows.length - 1, index + 1)]?.node.id,
          chordUntil: undefined,
        });
      case "up":
        return done({
          ...state,
          selected: rows[Math.max(0, index - 1)]?.node.id,
          chordUntil: undefined,
        });
      case "right": {
        if (!current?.hasChildren) return done(state);
        if (state.collapsed.has(current.node.id)) {
          const collapsed = new Set(state.collapsed);
          collapsed.delete(current.node.id);
          return done({ ...state, collapsed });
        }
        return done({ ...state, selected: childrenOf(nodes, current.node.id)[0]?.id });
      }
      case "left": {
        if (current?.hasChildren && !state.collapsed.has(current.node.id))
          return done({ ...state, collapsed: new Set([...state.collapsed, current.node.id]) });
        const parent = current?.node.parentId;
        return done(parent && byId(nodes, parent) ? { ...state, selected: parent } : state);
      }
      case "enter":
        return open(current?.node, state);
      case "escape":
      case "tab":
        return done({ ...state, focus: "editor", chordUntil: undefined });
      case "cancel":
        return cancelOrConfirm(current?.node.id);
      default:
        // Any other key returns focus to the editor and is typed there.
        return { state: { ...state, focus: "editor", chordUntil: undefined }, handled: false };
    }
  }
  // Read-only child view.
  const viewing = byId(nodes, state.viewing);
  const back = () =>
    done({ ...state, focus: "editor", viewing: undefined }, { type: "close-view" });
  switch (key) {
    case "escape":
      return back();
    case "up": {
      const parent = byId(nodes, viewing?.parentId);
      return parent ? open(parent, state) : back();
    }
    case "down":
      return open(childrenOf(nodes, viewing?.id)[0], state);
    case "left":
    case "right": {
      const siblings = childrenOf(nodes, viewing?.parentId);
      const i = siblings.findIndex((s) => s.id === viewing?.id);
      if (siblings.length < 2 || i < 0) return done(state);
      const next = siblings[(i + (key === "right" ? 1 : siblings.length - 1)) % siblings.length];
      return open(next, state);
    }
    case "cancel":
      return cancelOrConfirm(viewing?.id);
    default:
      return done(state);
  }
}
