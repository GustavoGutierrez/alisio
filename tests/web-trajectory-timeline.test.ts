/**
 * The Trajectory tab's execution timeline (trace waterfall): model, tool and user lanes rebuilt
 * from durable events, the per-turn tokens and the accumulated tool time. Pure.
 */
import type { RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { executionTimeline } from "../packages/web/src/store/trajectory.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
let seq = 0;
const ev = (type: string, seconds: number, data: unknown = {}): RunEvent => ({
  schemaVersion: 1,
  runId: "r1",
  sessionId: "s1",
  seq: ++seq,
  type,
  timestamp: new Date(T0 + seconds * 1000).toISOString(),
  data,
  eventId: String(++seq),
});

describe("execution timeline (trace waterfall)", () => {
  it("is undefined without events", () => {
    expect(executionTimeline([])).toBeUndefined();
  });

  it("reconstructs model, tool and user intervals with their lanes", () => {
    const timeline = executionTimeline([
      ev("run_started", 0, { model: "m" }),
      ev("turn_completed", 10, {
        turn: 1,
        model: "m",
        durationMs: 4000,
        usage: { input: 100, output: 20 },
      }),
      ev("tool_started", 11, { id: "c1", name: "read_file", arguments: "{}", effect: "read" }),
      ev("tool_completed", 13, {
        id: "c1",
        name: "read_file",
        isError: false,
        durationMs: 2000,
        preview: "",
      }),
      ev("approval_requested", 14, { id: "c2", name: "shell", effect: "process" }),
      ev("approval_resolved", 20, {
        id: "c2",
        name: "shell",
        effect: "process",
        decision: "once",
      }),
      ev("tool_completed", 40, {
        id: "c3",
        name: "ask_user_question",
        isError: false,
        durationMs: 5000,
        preview: "",
      }),
      ev("run_completed", 41, { tokens: 120, text: "done" }),
    ]);
    expect(timeline).toBeDefined();
    if (!timeline) return;
    expect(timeline.startAt).toBe(T0);
    expect(timeline.endAt).toBe(T0 + 41_000);
    // The model interval ends at the turn and starts `durationMs` before it.
    expect(timeline.lanes.find((lane) => lane.id === "model")?.intervals).toEqual([
      { kind: "model", label: "m", start: T0 + 6_000, end: T0 + 10_000 },
    ]);
    // The question tool stays out of the tools lane.
    expect(timeline.lanes.find((lane) => lane.id === "tool")?.intervals).toEqual([
      { kind: "tool", label: "read_file", start: T0 + 11_000, end: T0 + 13_000 },
    ]);
    // The user lane spans the approval (requested → resolved) and the question.
    expect(timeline.lanes.find((lane) => lane.id === "user")?.intervals).toEqual([
      { kind: "approval", label: "shell", start: T0 + 14_000, end: T0 + 20_000 },
      { kind: "question", label: "ask_user_question", start: T0 + 35_000, end: T0 + 40_000 },
    ]);
    expect(timeline.turns).toEqual([{ turn: 1, input: 100, output: 20 }]);
    expect(timeline.tools).toEqual([
      { name: "ask_user_question", durationMs: 5000, count: 1, error: false },
      { name: "read_file", durationMs: 2000, count: 1, error: false },
    ]);
  });

  it("marks denied approvals as errors and keeps an unresolved wait open to the last event", () => {
    const timeline = executionTimeline([
      ev("approval_requested", 5, { id: "a1", name: "shell", effect: "process" }),
      ev("approval_resolved", 9, { id: "a1", name: "shell", effect: "process", decision: "deny" }),
      ev("approval_requested", 12, { id: "a2", name: "write_file", effect: "write" }),
      ev("run_cancelled", 20, { error: "stop" }),
    ]);
    expect(timeline?.lanes.find((lane) => lane.id === "user")?.intervals).toEqual([
      { kind: "approval", label: "shell", start: T0 + 5_000, end: T0 + 9_000, error: true },
      { kind: "approval", label: "write_file", start: T0 + 12_000, end: T0 + 20_000 },
    ]);
  });

  it("aggregates repeated tools and sorts them by accumulated time", () => {
    const timeline = executionTimeline([
      ev("tool_completed", 1, {
        id: "a",
        name: "grep",
        isError: false,
        durationMs: 1000,
        preview: "",
      }),
      ev("tool_completed", 2, {
        id: "b",
        name: "grep",
        isError: true,
        durationMs: 3000,
        preview: "",
      }),
      ev("tool_completed", 3, {
        id: "c",
        name: "read_file",
        isError: false,
        durationMs: 500,
        preview: "",
      }),
    ]);
    expect(timeline?.tools).toEqual([
      { name: "grep", durationMs: 4000, count: 2, error: true },
      { name: "read_file", durationMs: 500, count: 1, error: false },
    ]);
  });
});
