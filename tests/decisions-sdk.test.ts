import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DecisionProviderError,
  DecisionRequestError,
  type RunEvent,
  summarizeDecisionEvents,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";

let seq = 0;
const event = (type: string, data: unknown, timestamp = "2026-10-03T12:00:00.000Z"): RunEvent => ({
  schemaVersion: 1,
  runId: "r1",
  sessionId: "s1",
  seq: ++seq,
  type,
  timestamp,
  data,
});
const completed = (latencyMs: number, pack?: { id: string; version: number }, provider = "p") =>
  event("decision_completed", {
    decisionId: "site",
    ...(pack ? { pack } : {}),
    provider,
    latencyMs,
    decisionCount: 1,
    rejectedCount: 0,
    confidenceMin: 0.9,
  });
const fallback = (reason: string, at: string, decisionId = "site") =>
  event("decision_fallback", { decisionId, provider: "p", latencyMs: 5, reason }, at);

describe("summarizeDecisionEvents", () => {
  it("returns zeros and no optional fields without decision events", () => {
    const stats = summarizeDecisionEvents([event("run_started", { model: "m" })]);
    expect(stats).toEqual({ requests: 0, completed: 0, fallbacks: 0, packs: {} });
  });

  it("counts completed and fallback events and ignores everything else", () => {
    const stats = summarizeDecisionEvents([
      event("turn_completed", {}),
      completed(10),
      completed(30),
      fallback("timeout", "2026-10-03T12:04:31.000Z", "a"),
      fallback("circuit_open", "2026-10-03T12:05:00.000Z", "b"),
    ]);
    expect(stats.requests).toBe(4);
    expect(stats.completed).toBe(2);
    expect(stats.fallbacks).toBe(2);
    expect(stats.avgLatencyMs).toBe(20);
    expect(stats.lastFallback).toEqual({
      reason: "circuit_open",
      decisionId: "b",
      at: "2026-10-03T12:05:00.000Z",
    });
    expect(stats.provider).toBe("p");
  });

  it("computes p95 with the nearest-rank method over completed latencies", () => {
    const events = Array.from({ length: 20 }, (_, i) => completed((i + 1) * 10));
    expect(summarizeDecisionEvents(events).p95LatencyMs).toBe(190);
    expect(summarizeDecisionEvents([completed(42)]).p95LatencyMs).toBe(42);
  });

  it("counts calls per pack id, both completed and fallback", () => {
    const pack = { id: "smart-dashboard-v1", version: 1 };
    const stats = summarizeDecisionEvents([
      completed(1, pack),
      completed(1, pack),
      event("decision_fallback", {
        decisionId: "x",
        pack,
        provider: "p",
        latencyMs: 1,
        reason: "timeout",
      }),
      completed(1),
    ]);
    expect(stats.packs).toEqual({ "smart-dashboard-v1": 3 });
  });

  it("survives malformed payloads without throwing", () => {
    expect(() =>
      summarizeDecisionEvents([
        event("decision_completed", null),
        event("decision_completed", { latencyMs: "fast" }),
      ]),
    ).not.toThrow();
  });
});

describe("typed decision errors", () => {
  it("DecisionProviderError carries a code and defaults the message to it", () => {
    const error = new DecisionProviderError("not_ready");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not_ready");
    expect(error.message).toBe("not_ready");
    expect(error.name).toBe("DecisionProviderError");
    expect(new DecisionProviderError("internal", "boom").message).toBe("boom");
  });

  it("DecisionRequestError is a TypeError with a stable code", () => {
    const error = new DecisionRequestError("bad");
    expect(error).toBeInstanceOf(TypeError);
    expect(error.code).toBe("decision_invalid_request");
    expect(error.name).toBe("DecisionRequestError");
  });
});

describe("SDK stays free of decision engine names", () => {
  it("has no source mentioning a concrete provider", async () => {
    const dir = join(import.meta.dirname, "../packages/sdk/src");
    for (const name of await readdir(dir, { recursive: true })) {
      if (!String(name).endsWith(".ts")) continue;
      const text = await readFile(join(dir, String(name)), "utf8");
      expect(text, String(name)).not.toMatch(/(?<![a-z])(laya|jev)(?![a-z])/i);
    }
  });
});
