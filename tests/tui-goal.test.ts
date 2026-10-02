/**
 * `/goal` in the terminal: what each typed command means for the session's goal (create, replace
 * after confirming, the subcommands, the picker, errors), the picker rows per state, the bar the
 * user sees (status, tokens, turns, time, why it waits or stopped, the action hints), and the
 * one-line notice when a goal stops by itself.
 */
import type { GoalInfo } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  GoalBar,
  goalBarText,
  goalPickerItems,
  goalPickerPrefill,
  goalStopNotice,
  NO_GOAL_TEXT,
  planGoalCommand,
} from "../packages/cli/src/tui/goal.ts";
import { GOAL_HELP, parseGoalCommand, userActions } from "../packages/core/src/index.ts";

const goal = (over: Partial<GoalInfo> = {}): GoalInfo => ({
  sessionId: "s",
  goalId: "g1",
  objective: "Fix the flaky checkout test",
  status: "active",
  reason: "created",
  epoch: 1,
  tokensUsed: 12_300,
  turnsUsed: 3,
  maxTurns: 50,
  activeMs: 252_000,
  maxWallMs: 7_200_000,
  actions: userActions(over.status ?? "active"),
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const plan = (args: string, current: GoalInfo | undefined = undefined, enabled = true) =>
  planGoalCommand(parseGoalCommand(args), { goal: current, enabled });
const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");

describe("what a typed /goal means", () => {
  it("creates from an objective, with a budget", () => {
    expect(plan("fix the test")).toEqual({ kind: "create", objective: "fix the test" });
    expect(plan("fix the test budget=50k")).toEqual({
      kind: "create",
      objective: "fix the test",
      tokenBudget: 50_000,
    });
  });
  it("asks for confirmation before replacing an existing goal", () => {
    expect(plan("new objective budget=1M", goal())).toEqual({
      kind: "confirm-replace",
      objective: "new objective",
      tokenBudget: 1_000_000,
    });
  });
  it("opens the picker for a bare /goal with a goal, and explains without one", () => {
    expect(plan("", goal())).toEqual({ kind: "picker" });
    const none = plan("");
    expect(none).toMatchObject({ kind: "say", tone: "notice" });
    expect(none.kind === "say" && none.text).toContain(NO_GOAL_TEXT);
  });
  it("maps the subcommands, and refuses them without a goal", () => {
    expect(plan("pause", goal())).toEqual({ kind: "act", action: "pause" });
    expect(plan("resume", goal({ status: "paused" }))).toEqual({ kind: "act", action: "resume" });
    expect(plan("clear", goal())).toEqual({ kind: "act", action: "clear" });
    expect(plan("budget=50k", goal())).toEqual({ kind: "budget", tokens: 50_000 });
    expect(plan("budget=clear", goal())).toEqual({ kind: "budget", tokens: null });
    expect(plan("edit a better objective", goal())).toEqual({
      kind: "edit",
      objective: "a better objective",
    });
    for (const args of ["pause", "resume", "clear", "budget=5k", "edit", "edit x"])
      expect(plan(args)).toMatchObject({ kind: "say", text: NO_GOAL_TEXT });
  });
  it("puts the current objective in the editor for a bare /goal edit", () => {
    expect(plan("edit", goal())).toEqual({
      kind: "edit-prefill",
      text: "/goal edit Fix the flaky checkout test",
    });
  });
  it("shows the help text and parse errors with the usage line", () => {
    expect(plan("help")).toEqual({ kind: "say", text: GOAL_HELP, tone: "info" });
    const bad = plan("x budget=1k budget=2k");
    expect(bad).toMatchObject({ kind: "say", tone: "notice" });
    expect(bad.kind === "say" && bad.text).toContain("only one budget");
    expect(bad.kind === "say" && bad.text).toContain("Usage: /goal");
  });
  it("refuses a new goal when goals are turned off", () => {
    expect(plan("do it", undefined, false)).toMatchObject({ kind: "say" });
  });
});

describe("the /goal picker", () => {
  const values = (g: GoalInfo) => goalPickerItems(g).map((item) => item.value);
  it("offers the actions that make sense in each state", () => {
    expect(values(goal())).toEqual(["status", "pause", "edit", "budget", "clear", "help"]);
    expect(values(goal({ status: "paused" }))).toEqual([
      "status",
      "resume",
      "edit",
      "budget",
      "clear",
      "help",
    ]);
    expect(values(goal({ status: "blocked" }))).toContain("resume");
    expect(values(goal({ status: "budget_limited" }))).toEqual([
      "status",
      "edit",
      "budget",
      "clear",
      "help",
    ]);
    expect(values(goal({ status: "complete" }))).not.toContain("resume");
    expect(
      goalPickerItems(goal({ status: "budget_limited" })).find((i) => i.value === "budget")?.label,
    ).toBe("Raise budget…");
  });
  it("leaves the text to finish in the editor for edit and budget", () => {
    expect(goalPickerPrefill("edit", goal())).toBe("/goal edit Fix the flaky checkout test");
    expect(goalPickerPrefill("budget", goal({ tokenBudget: 50_000 }))).toBe("/goal budget=50000");
    expect(goalPickerPrefill("budget", goal())).toBe("/goal budget=");
    expect(goalPickerPrefill("pause", goal())).toBeUndefined();
  });
  it("says what resuming a capped goal does", () => {
    const item = goalPickerItems(goal({ status: "paused", reason: "max_turns" })).find(
      (i) => i.value === "resume",
    );
    expect(item?.description).toContain("one more allowance");
  });
});

describe("the goal bar", () => {
  it("shows status, tokens against the budget, turns, time and the action hints", () => {
    const { head, detail } = goalBarText(goal({ tokenBudget: 50_000 }));
    expect(head).toBe("◎ Goal · Active · Fix the flaky checkout test");
    expect(detail).toContain("12.3k / 50k tokens");
    expect(detail).toContain("turn 3/50");
    expect(detail).toContain("4m 12s");
    expect(detail).toContain("/goal pause · /goal edit · /goal clear");
  });
  it("without a budget says so, and with a pause shows the reason and resume", () => {
    const { detail } = goalBarText(
      goal({ status: "paused", reason: "max_turns", actions: userActions("paused") }),
    );
    expect(detail).toContain("12.3k tokens (no budget)");
    expect(detail).toContain("The turn limit was reached");
    expect(detail).toContain("/goal resume");
    expect(detail).not.toContain("/goal pause");
  });
  it("shows what an active goal is waiting for", () => {
    const labels: Array<[GoalInfo["waiting"], string]> = [
      ["question", "Waiting for your answer"],
      ["approval", "Waiting for permission"],
      ["background_tasks", "Waiting for background tasks"],
      ["plan_mode", "plan mode is on"],
    ];
    for (const [waiting, text] of labels)
      expect(goalBarText(goal({ waiting })).detail).toContain(text);
  });
  it("explains the breakers and errors with their detail", () => {
    expect(
      goalBarText(goal({ status: "paused", reason: "no_progress", detail: "repeated_reply" }))
        .detail,
    ).toContain("No progress: the same reply repeated");
    expect(
      goalBarText(goal({ status: "blocked", reason: "run_error", detail: "401 Unauthorized" }))
        .detail,
    ).toContain("A turn failed: 401 Unauthorized");
    expect(goalBarText(goal({ status: "paused", reason: "restart" })).detail).toContain(
      "restarted",
    );
  });
  it("renders nothing without a goal and two bounded lines with one", () => {
    expect(new GoalBar(() => undefined).render(80)).toEqual([]);
    const lines = new GoalBar(() => goal({ objective: "x".repeat(300) })).render(60);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(strip(line).length).toBeLessThanOrEqual(60);
  });
});

describe("the notice when a goal stops by itself", () => {
  it("names the state, the reason and the way back", () => {
    expect(goalStopNotice(goal())).toBeUndefined();
    expect(goalStopNotice(goal({ status: "paused", reason: "user_interrupt" }))).toBe(
      "Goal paused: You interrupted the turn · /goal resume to continue",
    );
    expect(goalStopNotice(goal({ status: "budget_limited", reason: "token_budget" }))).toBe(
      "Goal budget reached: The token budget was reached · /goal budget=<n> to raise it",
    );
    expect(goalStopNotice(goal({ status: "complete", reason: "model_complete" }))).toBe(
      "Goal complete: The agent reports the goal complete",
    );
  });
});
