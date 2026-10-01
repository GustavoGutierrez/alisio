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
});
