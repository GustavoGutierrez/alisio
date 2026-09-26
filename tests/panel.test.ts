import type { PanelNode } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  initialPanelState,
  type PanelState,
  reducePanel,
  visibleRows,
} from "../packages/cli/src/tui/panel.ts";

// Tree: a (b (d), c), e
const nodes: PanelNode[] = [
  { id: "a", label: "general", status: "running", sessionId: "a" },
  { id: "b", parentId: "a", label: "explore", status: "running", sessionId: "b" },
  { id: "d", parentId: "b", label: "explore", status: "queued", sessionId: "d" },
  { id: "c", parentId: "a", label: "plan", status: "completed", sessionId: "c" },
  { id: "e", label: "explore", status: "completed", sessionId: "e" },
];
const run = (state: PanelState, ...keys: Parameters<typeof reducePanel>[1][]) => {
  let s = state;
  const effects = [];
  for (const k of keys) {
    const r = reducePanel(s, k, nodes);
    s = r.state;
    if (r.effect) effects.push(r.effect);
  }
  return { state: s, effects };
};
const key = (name: string, now = 10_000) => ({
  type: "key" as const,
  key: name,
  now,
  editorEmpty: true,
});

describe("panel focus reducer", () => {
  it("focuses the panel with Ctrl+X or ↓ on an empty editor, and ignores it without agents", () => {
    expect(run(initialPanelState(), { type: "ctrlX", now: 0 }).state).toMatchObject({
      focus: "panel",
      selected: "a",
    });
    expect(run(initialPanelState(), key("down")).state.focus).toBe("panel");
    expect(
      reducePanel(initialPanelState(), { ...key("down"), editorEmpty: false }, nodes).handled,
    ).toBe(false);
    expect(reducePanel(initialPanelState(), { type: "ctrlX", now: 0 }, []).handled).toBe(false);
  });

  it("moves through visible rows in tree order, expanding and collapsing", () => {
    expect(visibleRows(nodes, new Set()).map((r) => `${r.depth}${r.node.id}`)).toEqual([
      "0a",
      "1b",
      "2d",
      "1c",
      "0e",
    ]);
    let { state } = run(initialPanelState(), { type: "ctrlX", now: 0 }, key("down"), key("down"));
    expect(state.selected).toBe("d");
    ({ state } = run(state, key("left")));
    expect(state.selected).toBe("b");
    expect(state.collapsed.has("b")).toBe(false);
    ({ state } = run(state, key("left")));
    expect(state.collapsed.has("b")).toBe(true);
    expect(visibleRows(nodes, state.collapsed).map((r) => r.node.id)).toEqual(["a", "b", "c", "e"]);
    ({ state } = run(state, key("right")));
    expect(state.collapsed.has("b")).toBe(false);
    ({ state } = run(state, key("right")));
    expect(state.selected).toBe("d");
    ({ state } = run(state, key("down"), key("down"), key("down")));
    expect(state.selected).toBe("e");
  });

  it("opens the read-only view with Enter and returns to the editor with Esc or Tab", () => {
    const opened = run(
      initialPanelState(),
      { type: "ctrlX", now: 0 },
      key("down", 5_000),
      key("enter"),
    );
    expect(opened.state).toMatchObject({ focus: "view", viewing: "b" });
    expect(opened.effects).toContainEqual({ type: "open", sessionId: "b" });
    expect(run(initialPanelState(), { type: "ctrlX", now: 0 }, key("tab")).state.focus).toBe(
      "editor",
    );
    expect(run(initialPanelState(), { type: "ctrlX", now: 0 }, key("escape")).state.focus).toBe(
      "editor",
    );
  });

  it("treats Ctrl+X then ↓ within the chord window as open-first-child", () => {
    const r = run(initialPanelState(), { type: "ctrlX", now: 1_000 }, key("down", 1_300));
    expect(r.state).toMatchObject({ focus: "view", viewing: "a" });
  });

  it("navigates the tree directly in a child view with plain arrows", () => {
    let { state } = run(initialPanelState(), { type: "ctrlX", now: 0 }, key("enter"));
    expect(state.viewing).toBe("a");
    ({ state } = run(state, key("down")));
    expect(state.viewing).toBe("b");
    ({ state } = run(state, key("right")));
    expect(state.viewing).toBe("c");
    ({ state } = run(state, key("right")));
    expect(state.viewing).toBe("b");
    ({ state } = run(state, key("left")));
    expect(state.viewing).toBe("c");
    ({ state } = run(state, key("up")));
    expect(state.viewing).toBe("a");
    const back = run(state, key("up"));
    expect(back.state).toMatchObject({ focus: "editor", viewing: undefined });
    expect(run(state, key("escape")).state).toMatchObject({ focus: "editor", viewing: undefined });
  });

  it("asks for confirmation before cancelling a subtree with children", () => {
    const withKids = run(initialPanelState(), { type: "ctrlX", now: 0 }, key("cancel"));
    expect(withKids.state.confirm).toEqual({ id: "a", count: 3 });
    expect(withKids.effects).toEqual([]);
    expect(run(withKids.state, key("no")).state.confirm).toBeUndefined();
    expect(run(withKids.state, key("yes")).effects).toContainEqual({ type: "cancel", id: "a" });
    const leaf = run(
      initialPanelState(),
      { type: "ctrlX", now: 0 },
      key("down"),
      key("down"),
      key("down"),
      key("cancel"),
    );
    expect(leaf.state.selected).toBe("c");
    expect(leaf.effects).toContainEqual({ type: "cancel", id: "c" });
  });
});
