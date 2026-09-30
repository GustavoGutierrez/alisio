import type { RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  compactNumber,
  computeStats,
  formatSeconds,
  sessionStats,
} from "../packages/web/src/store/stats.ts";
import { appendEvents, trajectory } from "../packages/web/src/store/trajectory.ts";

let seq = 0;
const ev = (
  runId: string,
  type: string,
  data: Record<string, unknown> = {},
  at = seq * 1000,
): RunEvent => {
  seq++;
  return {
    schemaVersion: 1,
    runId,
    sessionId: "s",
    seq,
    eventId: String(seq),
    type,
    timestamp: new Date(at).toISOString(),
    data,
  };
};
const turn = (runId: string, n: number, extra: Record<string, unknown>) =>
  ev(runId, "turn_completed", { turn: n, tokens: 0, calls: 0, model: "m", ...extra });
const tool = (runId: string, name: string, durationMs: number, isError = false) =>
  ev(runId, "tool_completed", { id: `${name}-${seq}`, name, isError, durationMs, preview: "" });

describe("stats line (RF-16)", () => {
  it("derives turns, steps, times, TTFT, throughput, cache and input from events", () => {
    const events = [
      ev("r1", "run_started", { model: "m" }),
      turn("r1", 1, {
        durationMs: 2000,
        ttftMs: 500,
        usage: { input: 1000, output: 100, cachedInput: 600 },
      }),
      tool("r1", "read_file", 300),
      tool("r1", "shell", 700),
      turn("r1", 2, {
        durationMs: 3000,
        ttftMs: 1500,
        usage: { input: 3000, output: 400, cachedInput: 2400 },
      }),
      ev("r1", "run_completed", { tokens: 500, text: "" }),
    ];
    expect(computeStats(events)).toEqual({
      runs: 1,
      turns: 2,
      steps: 2,
      llmMs: 5000,
      toolMs: 1000,
      ttftMs: 1000,
      tokensPerSecond: 100,
      cacheHit: 0.75,
      inputTokens: 4000,
      outputTokens: 500,
    });
  });

  it("shows cache as unknown (not 0 %) when the provider never reports cached input", () => {
    const stats = computeStats([turn("r", 1, { durationMs: 0, usage: { input: 10, output: 5 } })]);
    expect(stats.cacheHit).toBeUndefined();
    expect(stats.tokensPerSecond).toBeUndefined();
    expect(stats.ttftMs).toBeUndefined();
    expect(
      computeStats([turn("r", 1, { usage: { input: 10, output: 5, cachedInput: 0 } })]).cacheHit,
    ).toBe(0);
  });

  it("defaults to the last run and keeps session totals for the hover", () => {
    const events = [
      ev("a", "run_started"),
      turn("a", 1, { usage: { input: 5, output: 1 } }),
      ev("b", "run_started"),
      turn("b", 1, { usage: { input: 7, output: 1 } }),
      tool("b", "x", 10),
    ];
    const { last, session } = sessionStats(events);
    expect(last).toMatchObject({ runs: 1, turns: 1, steps: 1, inputTokens: 7 });
    expect(session).toMatchObject({ runs: 2, turns: 2, steps: 1, inputTokens: 12 });
    expect(sessionStats([]).last).toBeUndefined();
  });

  it("formats seconds and token counts compactly", () => {
    expect(formatSeconds(11_940)).toBe("11.9s");
    expect(formatSeconds(600)).toBe("0.6s");
    expect(formatSeconds(16)).toBe("16ms");
    expect(formatSeconds(0)).toBe("0ms");
    expect(formatSeconds(125_000)).toBe("2m 5s");
    expect(compactNumber(12_345)).toBe("12.3k");
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(2_500_000)).toBe("2.5M");
  });
});

describe("trajectory (RF-10)", () => {
  it("groups durable events by run with turn numbers, summaries and durations", () => {
    seq = 0; // timestamps default to seq·1 s: keep them inside the run
    const events = [
      ev("r1", "run_started", { model: "gpt" }, 1_000),
      turn("r1", 1, { durationMs: 1200 }),
      ev("r1", "tool_started", { id: "c1", name: "shell", arguments: "{}", effect: "process" }),
      ev("r1", "approval_requested", { id: "c1", name: "shell", effect: "process" }),
      ev("r1", "approval_resolved", {
        id: "c1",
        name: "shell",
        effect: "process",
        decision: "once",
      }),
      tool("r1", "shell", 40, true),
      turn("r1", 2, { durationMs: 800 }),
      ev("r1", "run_completed", { tokens: 9, text: "done" }, 9_000),
      ev("r2", "run_started", { model: "gpt" }),
      ev("r2", "run_failed", { error: "boom" }),
    ];
    const groups = trajectory(events);
    expect(groups.map((g) => [g.runId, g.status, g.turns])).toEqual([
      ["r1", "completed", 2],
      ["r2", "failed", 0],
    ]);
    expect(groups[0]?.durationMs).toBe(8_000);
    const rows = groups[0]?.rows ?? [];
    expect(rows.map((r) => [r.type, r.turn ?? null])).toEqual([
      ["run_started", null],
      ["turn_completed", 1],
      ["tool_started", 1],
      ["approval_requested", 1],
      ["approval_resolved", 1],
      ["tool_completed", 1],
      ["turn_completed", 2],
      ["run_completed", 2],
    ]);
    expect(rows[0]?.summary).toBe("gpt");
    expect(rows[4]?.summary).toBe("shell · once");
    expect(rows[5]).toMatchObject({ summary: "shell", durationMs: 40, error: true });
    expect(rows[6]).toMatchObject({ durationMs: 800 });
    expect(groups[1]?.rows.at(-1)).toMatchObject({ summary: "boom", error: true });
  });

  it("appends newer pages without duplicating events", () => {
    const a = ev("r", "run_started");
    const b = ev("r", "run_completed");
    expect(appendEvents([a], [a, b]).map((e) => e.eventId)).toEqual([a.eventId, b.eventId]);
  });
});
