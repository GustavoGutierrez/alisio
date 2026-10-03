/**
 * Decision Intelligence inside a run: `ToolContext.decisions` is bound to the run, the core emits
 * `decision_completed` / `decision_fallback` with a metadata-only payload, `decisions.telemetry`
 * gates persistence (not the in-memory metrics) and nothing leaks the request contents.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DecisionRequest,
  definePlugin,
  type ModelProvider,
  type RunEvent,
  summarizeDecisionEvents,
  type ToolDefinition,
} from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialViewState, reduceEvent } from "../packages/cli/src/tui/state.ts";
import { type BuiltinPlugin, createApplication } from "../packages/core/src/index.ts";
import { computeStats } from "../packages/web/src/store/stats.ts";
import { trajectory } from "../packages/web/src/store/trajectory.ts";
import { applyFrame, emptyTranscript } from "../packages/web/src/store/transcript.ts";
import { fakeProvider, sampleRequest } from "./fixtures/decision-provider.ts";

const SENTINELS = ["SENTINEL_STATE_7f3a", "SENTINEL_INSTRUCTION_91bc", "SENTINEL_OPTION_c0de"];

/** A request whose state, instruction and option labels all carry a sentinel. */
function secretRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    version: 1,
    id: "events-site-v1",
    pack: { id: "events-pack", version: 2 },
    state: { goal: SENTINELS[0] as string, columns: [{ label: SENTINELS[0] as string }] },
    decisions: {
      kind: {
        type: "select",
        instruction: `Pick ${SENTINELS[1]}`,
        options: { a: `${SENTINELS[2]} first`, b: `${SENTINELS[2]} second` },
      },
      flag: { type: "boolean", instruction: `Is it ${SENTINELS[1]}?` },
    },
    ...overrides,
  };
}

let root: string;
let workspace: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-dec-events-"));
  workspace = join(root, "ws");
  await mkdir(workspace);
  await mkdir(join(root, "config"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const silent: ModelProvider = {
  id: "silent",
  defaultModel: "m",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
} as never;

/** Starts an app whose builtin plugin registers the fake provider and a tool that decides. */
async function start(
  decisions: Record<string, unknown> | undefined,
  provider = fakeProvider(),
  request: () => DecisionRequest = secretRequest,
) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "config", "config.json"), JSON.stringify({ decisions }));
  const seen: { hasDecisions?: boolean; result?: unknown } = {};
  const tool: ToolDefinition = {
    name: "decide_something",
    description: "Calls context.decisions.tryDecide",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    async execute(_input, context) {
      seen.hasDecisions = context.decisions !== undefined;
      seen.result = (await context.decisions?.tryDecide(request())) ?? null;
      return { content: [{ type: "text", text: "done" }] };
    },
  };
  const builtin: BuiltinPlugin = {
    id: "engine",
    description: "test engine",
    create: () =>
      definePlugin({
        id: "engine",
        version: "1.0.0",
        apiVersion: 1,
        setup: (api) => {
          api.decisions?.registerProvider(provider);
          api.tools.register(tool);
        },
      }),
  };
  const events: RunEvent[] = [];
  const app = await createApplication({
    cwd: workspace,
    db: join(root, "state", "sessions.sqlite"),
    noHerdr: true,
    provider: silent,
    builtins: [builtin],
    onEvent: (event) => events.push(event),
  });
  apps.push(app);
  const session = app.store.create(app.workspace, "silent", "m").id;
  const decisionEvents = () => events.filter((e) => e.type.startsWith("decision_"));
  return { app, provider, session, events, seen, decisionEvents };
}

/** Persisted `events` rows of a session, as raw JSON text. */
function persistedBodies(app: Awaited<ReturnType<typeof start>>["app"], session: string) {
  return app.store.eventsPage(session, { limit: 1000 }).items;
}

describe("decision events inside a run", () => {
  it("emits decision_completed with exactly the metadata fields and the run's identity", async () => {
    const { app, session, seen, decisionEvents } = await start({ provider: "fake" });
    const { runId } = await app.runner.runToolCall(session, "decide_something", {});
    expect(seen.hasDecisions).toBe(true);
    const [event, ...rest] = decisionEvents();
    expect(rest).toHaveLength(0);
    expect(event?.type).toBe("decision_completed");
    expect(event?.schemaVersion).toBe(1);
    expect(event?.sessionId).toBe(session);
    expect(event?.runId).toBe(runId);
    expect(Object.keys(event?.data as object).sort()).toEqual(
      [
        "confidenceMin",
        "decisionCount",
        "decisionId",
        "latencyMs",
        "pack",
        "provider",
        "rejectedCount",
      ].sort(),
    );
    expect(event?.data).toMatchObject({
      decisionId: "events-site-v1",
      pack: { id: "events-pack", version: 2 },
      provider: "fake",
      decisionCount: 2,
      rejectedCount: 0,
      confidenceMin: 0.9,
    });
    expect(typeof (event?.data as { latencyMs: number }).latencyMs).toBe("number");
  });

  it("emits decision_fallback with only the reason and identity fields", async () => {
    const provider = fakeProvider({ mode: "typedError", errorCode: "unavailable" });
    const { app, session, decisionEvents } = await start({ provider: "fake" }, provider, () =>
      secretRequest({ pack: undefined }),
    );
    await app.runner.runToolCall(session, "decide_something", {});
    const [event] = decisionEvents();
    expect(event?.type).toBe("decision_fallback");
    expect(Object.keys(event?.data as object).sort()).toEqual(
      ["decisionId", "latencyMs", "provider", "reason"].sort(),
    );
    expect(event?.data).toMatchObject({
      decisionId: "events-site-v1",
      provider: "fake",
      reason: "unavailable",
    });
  });

  it("persists the events with the run and fans them out to onEvent", async () => {
    const { app, session, decisionEvents } = await start({ provider: "fake" });
    await app.runner.runToolCall(session, "decide_something", {});
    const [live] = decisionEvents();
    expect(live?.eventId).toBeDefined();
    const stored = persistedBodies(app, session).filter((e) => e.type === "decision_completed");
    expect(stored).toHaveLength(1);
  });

  it("emits nothing when there is no active provider and records no metrics", async () => {
    const { app, session, seen, decisionEvents } = await start({ provider: null });
    await app.runner.runToolCall(session, "decide_something", {});
    expect(seen.result).toBeNull();
    expect(decisionEvents()).toHaveLength(0);
    expect(app.decisions.metrics.snapshot().requests).toBe(0);
  });

  it("a malformed request throws DecisionRequestError to the tool and emits nothing", async () => {
    const { app, session, decisionEvents } = await start({ provider: "fake" }, fakeProvider(), () =>
      secretRequest({ decisions: {} }),
    );
    const { result } = await app.runner.runToolCall(session, "decide_something", {});
    expect(result.isError).toBe(true);
    expect(decisionEvents()).toHaveLength(0);
  });
});

describe("decisions.telemetry", () => {
  it("false: nothing is persisted or fanned out, but the in-memory metrics still count", async () => {
    const { app, session, decisionEvents } = await start({ provider: "fake", telemetry: false });
    await app.runner.runToolCall(session, "decide_something", {});
    expect(decisionEvents()).toHaveLength(0);
    expect(persistedBodies(app, session).some((e) => e.type.startsWith("decision_"))).toBe(false);
    expect(app.decisions.metrics.snapshot(session)).toMatchObject({ requests: 1, completed: 1 });
    expect(app.decisions.metrics.snapshot()).toMatchObject({ requests: 1, completed: 1 });
  });

  it("follows a live change of the setting", async () => {
    const { app, session, decisionEvents } = await start({ provider: "fake", telemetry: false });
    await app.runner.runToolCall(session, "decide_something", {});
    expect(decisionEvents()).toHaveLength(0);
    await app.updateSetting("decisions.telemetry", true);
    await app.runner.runToolCall(session, "decide_something", {});
    expect(decisionEvents()).toHaveLength(1);
    expect(app.decisions.metrics.snapshot(session).requests).toBe(2);
  });
});

describe("calls outside a run", () => {
  it("api.decisions updates the process metrics only and emits nothing", async () => {
    const { app, events, decisionEvents } = await start({ provider: "fake" });
    const response = await app.decisions.service.tryDecide(sampleRequest());
    expect(response).not.toBeNull();
    expect(decisionEvents()).toHaveLength(0);
    expect(events.filter((e) => e.type.startsWith("decision_"))).toHaveLength(0);
    expect(app.decisions.metrics.snapshot()).toMatchObject({ requests: 1, completed: 1 });
    const anySession = app.store.create(app.workspace, "silent", "m").id;
    expect(app.decisions.metrics.snapshot(anySession).requests).toBe(0);
  });
});

describe("privacy", () => {
  it("never puts the state, instructions or option labels in a persisted row or a fan-out payload", async () => {
    const failing = fakeProvider({ id: "bad", mode: "throw" });
    for (const [provider, id] of [
      [fakeProvider(), "fake"],
      [failing, "bad"],
    ] as const) {
      const { app, session, events } = await start({ provider: id }, provider);
      await app.runner.runToolCall(session, "decide_something", {});
      const rows = JSON.stringify(
        persistedBodies(app, session).filter((e) => e.type.startsWith("decision_")),
      );
      const live = JSON.stringify(events.filter((e) => e.type.startsWith("decision_")));
      expect(rows).toContain("decision_");
      expect(live).toContain("decision_");
      for (const sentinel of SENTINELS) {
        expect(rows).not.toContain(sentinel);
        expect(live).not.toContain(sentinel);
      }
      // The raw store body must be clean too (the whole transcript of events, not only ours).
      for (const sentinel of SENTINELS) {
        expect(JSON.stringify(persistedBodies(app, session))).not.toContain(sentinel);
      }
      await app.close();
      apps.splice(apps.indexOf(app), 1);
    }
  });
});

describe("consistency with the in-memory metrics", () => {
  it("summarizeDecisionEvents over the emitted events matches the session metrics", async () => {
    const provider = fakeProvider();
    const { app, session, decisionEvents } = await start({ provider: "fake" }, provider);
    await app.runner.runToolCall(session, "decide_something", {});
    await app.runner.runToolCall(session, "decide_something", {});
    provider.mode = "typedError";
    provider.errorCode = "unavailable";
    await app.runner.runToolCall(session, "decide_something", {});
    const stats = summarizeDecisionEvents(decisionEvents());
    const metrics = app.decisions.metrics.snapshot(session);
    expect(stats.requests).toBe(metrics.requests);
    expect(stats.completed).toBe(metrics.completed);
    expect(stats.fallbacks).toBe(metrics.fallbacks);
    expect(stats.packs).toEqual(metrics.packs);
    expect(stats.provider).toBe(metrics.provider);
    expect(stats.lastFallback?.reason).toBe(metrics.lastFallback?.reason);
    expect(stats.lastFallback?.decisionId).toBe(metrics.lastFallback?.decisionId);
    expect(stats.avgLatencyMs).toBe(metrics.avgLatencyMs);
    expect(stats.p95LatencyMs).toBe(metrics.p95LatencyMs);
  });
});

describe("existing event consumers ignore the new types", () => {
  const event = (type: string, data: Record<string, unknown>, seq: number): RunEvent => ({
    schemaVersion: 1,
    runId: "r1",
    sessionId: "s1",
    seq,
    eventId: String(seq),
    type,
    timestamp: "2026-01-01T00:00:00.000Z",
    data,
  });
  const completed = event(
    "decision_completed",
    {
      decisionId: "x-v1",
      provider: "fake",
      latencyMs: 12,
      decisionCount: 2,
      rejectedCount: 0,
      confidenceMin: 0.8,
    },
    2,
  );
  const fallback = event(
    "decision_fallback",
    { decisionId: "x-v1", provider: "fake", latencyMs: 0, reason: "timeout" },
    3,
  );
  const started = event("run_started", { model: "m" }, 1);

  it("the TUI reducer only records them for /stats and leaves the rest untouched", () => {
    const base = reduceEvent(initialViewState("m"), started);
    const after = reduceEvent(reduceEvent(base, completed), fallback);
    const { decisions, ...stats } = after.stats;
    expect(decisions).toEqual([completed, fallback]);
    expect(after).toEqual({
      ...base,
      stats: { ...base.stats, ...stats, decisions },
      lastEventAt: after.lastEventAt,
    });
    expect(stats).toEqual(base.stats);
    expect(after.items).toEqual(base.items);
  });

  it("the web transcript store ignores them; computeStats only adds `decisions`", () => {
    const transcript = emptyTranscript("s1");
    const after = [completed, fallback].reduce(
      (state, e) => applyFrame(state, { t: "event", sessionId: "s1", event: e } as never),
      transcript,
    );
    expect(after.sessionId).toBe("s1");
    const { decisions, ...rest } = computeStats([started, completed, fallback]);
    expect(rest).toEqual(computeStats([started]));
    expect(decisions).toEqual(summarizeDecisionEvents([started, completed, fallback]));
    expect(() => trajectory([started, completed, fallback])).not.toThrow();
  });
});
