/**
 * ADR-6: the three `/stats` render paths (core handler, TUI report/reducer, web `computeStats`)
 * derive the Decision Intelligence numbers from `summarizeDecisionEvents`; the section only
 * appears when at least one decision happened.
 */
import { type RunEvent, summarizeDecisionEvents } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { initialViewState, reduceEvent } from "../packages/cli/src/tui/state.ts";
import { CommandCatalog, type CommandHost } from "../packages/core/src/commands/catalog.ts";
import { formatDecisionStatsSection } from "../packages/core/src/decisions/index.ts";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { format } from "../packages/web/src/i18n/format.ts";
import { computeStats, decisionsSummary } from "../packages/web/src/store/stats.ts";

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
let n = 0;
const event = (type: string, data: Record<string, unknown>, at = T0 + n * 1000): RunEvent => {
  n++;
  return {
    schemaVersion: 1,
    runId: "r1",
    sessionId: "s1",
    seq: n,
    eventId: String(n),
    type,
    timestamp: new Date(at).toISOString(),
    data,
  };
};
const done = (latencyMs: number) =>
  event("decision_completed", {
    decisionId: "smart-dashboard-v1",
    provider: "fake",
    latencyMs,
    pack: { id: "smart-dashboard-v1", version: 1 },
  });
const fallback = (at: number) =>
  event(
    "decision_fallback",
    {
      decisionId: "smart-dashboard-v1",
      provider: "fake",
      reason: "timeout",
      latencyMs: 1500,
      pack: { id: "smart-dashboard-v1", version: 1 },
    },
    at,
  );
const FEED = [
  event("run_started", { model: "m" }),
  done(40),
  done(60),
  done(80),
  fallback(T0 + 5000),
  event("run_completed", { tokens: 1, text: "" }),
];
const NONE = [
  event("run_started", { model: "m" }),
  event("run_completed", { tokens: 1, text: "" }),
];

/** A host whose store serves `events` (as persisted rows) in pages of `pageSize`. */
function coreStats(events: RunEvent[], pageSize = 2) {
  const rows = events.map((e) => ({
    eventId: e.eventId as string,
    runId: e.runId,
    type: e.type,
    data: e.data,
    createdAt: Date.parse(e.timestamp),
  }));
  const calls: unknown[] = [];
  const host = {
    workspace: "/w",
    provider: { id: "p" },
    store: {
      get: () => ({ id: "s1", model: "m" }),
      messages: () => [],
      runs: () => [],
      eventsPage: (_s: string, o: { after?: number; limit?: number } = {}) => {
        calls.push(o);
        const items = rows.filter((r) => Number(r.eventId) > (o.after ?? 0)).slice(0, pageSize);
        const last = items.at(-1);
        return {
          items,
          hasMore: !!last && rows.some((r) => Number(r.eventId) > Number(last.eventId)),
        };
      },
    },
  } as unknown as CommandHost;
  return new CommandCatalog(host)
    .execute("stats", "", { sessionId: "s1" })
    .then((r) => ({ text: r.text ?? "", calls }));
}

const tuiDecisions = (events: RunEvent[]) => {
  const view = events.reduce(reduceEvent, initialViewState("m"));
  return view.stats.decisions ?? [];
};
const tr = (key: keyof typeof en, params?: Record<string, string | number>) =>
  format(en[key], params);

describe("/stats Decision Intelligence section", () => {
  it("is absent with zero decisions on all three paths", async () => {
    expect((await coreStats(NONE)).text).not.toContain("Decision Intelligence");
    expect(formatDecisionStatsSection(summarizeDecisionEvents(NONE))).toBeUndefined();
    expect(tuiDecisions(NONE)).toEqual([]);
    expect(computeStats(NONE).decisions).toBeUndefined();
    expect(decisionsSummary(computeStats(NONE).decisions, tr)).toBeUndefined();
  });

  it("shows identical numbers on core, TUI and web for the same events", async () => {
    const expected = summarizeDecisionEvents(FEED);
    expect(expected).toMatchObject({ requests: 4, completed: 3, fallbacks: 1, avgLatencyMs: 60 });

    const core = await coreStats(FEED);
    expect(core.text).toContain("**Decision Intelligence**");
    expect(core.text).toContain("Requests: 4 · completed 3 · fallbacks 1");
    expect(core.text).toContain("Latency: avg 60 ms · p95 80 ms");
    expect(core.text).toContain("Last fallback: timeout (smart-dashboard-v1) at 12:00:05 UTC");
    expect(core.calls.length).toBeGreaterThan(1); // paged through every event

    const section = formatDecisionStatsSection(summarizeDecisionEvents(tuiDecisions(FEED)));
    expect(section).toBeDefined();
    expect(core.text).toContain(section as string);

    expect(computeStats(FEED).decisions).toEqual(expected);
    const web = decisionsSummary(computeStats(FEED).decisions, tr) as string;
    expect(web).toContain("4");
    expect(web).toContain("3");
    expect(web).toContain("60 ms");
    expect(web).toContain("80 ms");
  });

  it("ignores non-decision events and keeps the web strings in EN/ES parity", () => {
    expect(summarizeDecisionEvents(tuiDecisions(FEED))).toEqual(summarizeDecisionEvents(FEED));
    const keys = (d: Record<string, string>) =>
      Object.keys(d).filter((k) => k.startsWith("stats.decisions"));
    expect(keys(es).sort()).toEqual(keys(en).sort());
    expect(keys(en).length).toBeGreaterThan(0);
  });
});
