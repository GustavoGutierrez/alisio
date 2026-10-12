import type { RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { InflightTracker } from "../packages/server/src/sse/inflight.ts";

const event = (type: string, data: unknown, timestamp: string): RunEvent => ({
  schemaVersion: 1,
  runId: "r1",
  sessionId: "s1",
  seq: 1,
  type,
  timestamp,
  data,
});

describe("in-flight run snapshot", () => {
  it("reports when the run started so a reloaded client keeps its elapsed time", () => {
    const tracker = new InflightTracker();
    tracker.mark("s1", "r1", "queued");
    expect(tracker.get("s1")?.startedAt).toBeUndefined();
    tracker.apply(event("run_started", { model: "m" }, "2026-10-01T12:00:00.000Z"));
    expect(tracker.get("s1")?.startedAt).toBe(Date.parse("2026-10-01T12:00:00.000Z"));
    tracker.apply(event("reasoning_delta", { delta: "x" }, "2026-10-01T12:00:05.000Z"));
    expect(tracker.get("s1")).toMatchObject({
      reasoning: "x",
      startedAt: Date.parse("2026-10-01T12:00:00.000Z"),
    });
    tracker.apply(event("run_completed", {}, "2026-10-01T12:00:09.000Z"));
    expect(tracker.get("s1")).toBeUndefined();
  });

  it("keeps the latest ForgeProgress of a running tool apart from its text tail", () => {
    const tracker = new InflightTracker();
    const at = "2026-10-01T12:00:00.000Z";
    tracker.apply(event("run_started", {}, at));
    tracker.apply(
      event(
        "tool_started",
        { id: "c1", name: "python_run", arguments: "{}", effect: "process" },
        at,
      ),
    );
    tracker.apply(event("tool_progress", { id: "c1", data: "loading data\n" }, at));
    const running = { kind: "forge", executionId: "e1", engine: "python-wasm", phase: "running" };
    tracker.apply(event("tool_progress", { id: "c1", data: running }, at));
    const calling = { ...running, phase: "call", completed: 2, total: 5 };
    tracker.apply(event("tool_progress", { id: "c1", data: calling }, at));
    const [tool] = tracker.get("s1")?.tools ?? [];
    expect(tool?.tail).toBe("loading data\n");
    expect(tool?.forge).toEqual(calling);
  });
});
