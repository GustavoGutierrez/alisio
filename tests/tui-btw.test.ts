/** The TUI `/btw` panel: pure browsing state and the rendered panel (never the transcript). */
import type { SideQuestionEntry } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  BTW_USAGE,
  btwBrowser,
  btwCurrent,
  btwHints,
  btwPending,
  btwPosition,
  btwWindow,
  reduceBtw,
} from "../packages/cli/src/tui/btw.ts";
import { BtwPanel } from "../packages/cli/src/tui/components.ts";
import { COMMANDS, resolveCommand } from "../packages/cli/src/tui/state.ts";

const entry = (n: number, answer = `answer ${n}`): SideQuestionEntry => ({
  id: `q${n}`,
  question: `question ${n}`,
  answer,
  model: "m",
  usage: { input: 10 * n, output: n },
  createdAt: n,
});
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("TUI /btw state", () => {
  it("is a TUI command with the usage line of the core", () => {
    expect(COMMANDS.find((c) => c.name === "btw")?.argumentHint).toBe("[question]");
    expect(resolveCommand("btw")).toBe("btw");
    expect(BTW_USAGE).toBe("Usage: /btw <question>");
  });

  it("has no browser without history and opens on the newest entry otherwise", () => {
    expect(btwBrowser([])).toBeUndefined();
    const state = btwBrowser([entry(1), entry(2), entry(3)]);
    expect(state && btwCurrent(state)?.id).toBe("q3");
    expect(state && btwPosition(state)).toBe("3/3");
  });

  it("browses earlier and later answers with clamping", () => {
    let state = btwBrowser([entry(1), entry(2), entry(3)]);
    if (!state) throw new Error("no state");
    state = reduceBtw(state, { type: "prev" });
    state = reduceBtw(state, { type: "prev" });
    expect(btwPosition(state)).toBe("1/3");
    expect(reduceBtw(state, { type: "prev" })).toBe(state);
    state = reduceBtw(state, { type: "next" });
    expect(btwPosition(state)).toBe("2/3");
    expect(btwHints(state, false)).toBe("←/→ earlier/later · Esc close");
  });

  it("moves from pending to the new answer, or to an error that still allows browsing", () => {
    const pending = btwPending([entry(1)], "new?", 0);
    expect(btwPosition(pending)).toBe("");
    expect(btwHints(pending, false)).toBe("Esc cancel");
    // Navigation is ignored while the answer is pending.
    expect(reduceBtw(pending, { type: "prev" })).toBe(pending);
    const answered = reduceBtw(pending, { type: "answered", entries: [entry(1), entry(2)] });
    expect(btwCurrent(answered)?.id).toBe("q2");
    expect(btwPosition(answered)).toBe("2/2");
    const failed = reduceBtw(pending, { type: "failed", message: "boom" });
    expect(failed.error).toEqual({ question: "new?", message: "boom" });
    expect(btwCurrent(failed)).toBeUndefined();
    expect(btwCurrent(reduceBtw(failed, { type: "prev" }))?.id).toBe("q1");
  });

  it("windows a long answer and reports what is above and below", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);
    expect(btwWindow(lines, 0, 4)).toMatchObject({ scroll: 0, above: false, below: true });
    expect(btwWindow(lines, 99, 4)).toMatchObject({
      lines: ["l6", "l7", "l8", "l9"],
      scroll: 6,
      above: true,
      below: false,
    });
  });
});

describe("BtwPanel", () => {
  it("renders the question, the Markdown answer, the position and the token usage", () => {
    const state = btwBrowser([entry(1), entry(2, "**bold** answer")]);
    if (!state) throw new Error("no state");
    const panel = new BtwPanel(
      state,
      () => {},
      () => 10,
    );
    const lines = panel.render(60).map(strip);
    expect(lines.some((l) => l.includes("btw 2/2"))).toBe(true);
    expect(lines.some((l) => l.includes("question 2"))).toBe(true);
    expect(lines.some((l) => l.includes("bold answer") && !l.includes("**"))).toBe(true);
    expect(lines.some((l) => l.includes("m · 20 in · 2 out tokens"))).toBe(true);
    for (const line of panel.render(30)) expect([...strip(line)].length).toBeLessThanOrEqual(30);
  });

  it("navigates with ←/→ and closes on Esc", () => {
    const state = btwBrowser([entry(1), entry(2)]);
    if (!state) throw new Error("no state");
    let closed = 0;
    const panel = new BtwPanel(
      state,
      () => closed++,
      () => 10,
    );
    panel.handleInput("\x1b[D");
    expect(panel.render(60).map(strip).join("\n")).toContain("btw 1/2");
    panel.handleInput("\x1b");
    expect(closed).toBe(1);
  });

  it("shows a thinking line while pending", () => {
    const panel = new BtwPanel(
      btwPending([], "why?", Date.now()),
      () => {},
      () => 10,
    );
    expect(panel.pending).toBe(true);
    const text = panel.render(60).map(strip).join("\n");
    expect(text).toContain("why?");
    expect(text).toContain("Thinking…");
    expect(text).toContain("Esc cancel");
  });
});
