import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EPHEMERAL_RUN_EVENT_TYPES,
  type EphemeralRunEventType,
  isEphemeralRunEventType,
  type KnownRunEvent,
  type Message,
  type ModelProvider,
  type ProviderEvent,
  type RunEvent,
  type RunEventType,
  type ToolCall,
  textResult,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import type { SessionStore } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

// Compile-time contract: every KnownRunEvent is a RunEvent, so existing consumers keep working.
const _knownIsRunEvent = (event: KnownRunEvent): RunEvent => event;
void _knownIsRunEvent;

type Check = (data: Record<string, unknown>) => boolean;
const str = (v: unknown) => typeof v === "string";
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const opt = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);
const record = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf =
  (...values: string[]) =>
  (v: unknown) =>
    typeof v === "string" && values.includes(v);
const effect = oneOf("read", "write", "process", "external", "internal");
const gated = oneOf("write", "process", "external");
const usage = (v: unknown) =>
  record(v) &&
  num((v as Record<string, unknown>).input) &&
  num((v as Record<string, unknown>).output) &&
  opt((v as Record<string, unknown>).cachedInput, num);
const hookFailure: Check = (d) =>
  str(d.source) && str(d.hook) && str(d.error) && d.continued === true;

/**
 * Runtime mirror of `KnownRunEvent`. The mapped type makes a missing event type a compile error,
 * so adding a type to the SDK union forces this contract test to learn its payload.
 */
const contract: { [K in RunEventType]: Check } = {
  run_started: (d) => str(d.model),
  text_delta: (d) => str(d.delta),
  reasoning_delta: (d) => str(d.delta),
  turn_completed: (d) =>
    num(d.turn) &&
    num(d.tokens) &&
    num(d.calls) &&
    str(d.model) &&
    opt(d.usage, usage) &&
    opt(d.durationMs, num) &&
    opt(d.ttftMs, num),
  tool_started: (d) => str(d.id) && str(d.name) && str(d.arguments) && effect(d.effect),
  tool_progress: (d) => str(d.id) && "data" in d,
  tool_completed: (d) =>
    str(d.id) &&
    str(d.name) &&
    typeof d.isError === "boolean" &&
    num(d.durationMs) &&
    str(d.preview),
  approval_requested: (d) => str(d.id) && str(d.name) && gated(d.effect) && opt(d.label, str),
  approval_resolved: (d) =>
    str(d.id) && str(d.name) && gated(d.effect) && oneOf("once", "session", "deny")(d.decision),
  run_completed: (d) =>
    num(d.tokens) && str(d.text) && opt(d.truncated, (v) => typeof v === "boolean"),
  response_truncated: (d) => num(d.turn) && num(d.maxOutputTokens),
  run_turns_exceeded: (d) => num(d.turns) && num(d.maxTurns),
  run_failed: (d) => str(d.error),
  run_cancelled: (d) => str(d.error),
  model_changed: (d) => str(d.model) && str(d.previous),
  compaction_started: (d) => oneOf("manual", "auto")(d.reason) && num(d.before) && num(d.messages),
  compaction_completed: (d) =>
    oneOf("manual", "auto")(d.reason) &&
    num(d.before) &&
    num(d.after) &&
    num(d.replaced) &&
    typeof d.structured === "boolean" &&
    num(d.summarizedTokens) &&
    num(d.checkpointTokens) &&
    record(d.plugins) &&
    opt(d.partial, (v) => v === true),
  compaction_skipped: (d) => oneOf("manual", "auto")(d.reason) && num(d.before) && str(d.detail),
  compaction_failed: (d) => oneOf("manual", "auto")(d.reason) && str(d.error),
  context_reduced: (d) => num(d.messages),
  session_context_injected: (d) =>
    num(d.tokens) && Array.isArray(d.sources) && (d.sources as unknown[]).every(str),
  plugin_hook_failed: hookFailure,
};

const conforms = (event: RunEvent): boolean => {
  const check = (contract as Record<string, Check | undefined>)[event.type];
  return !!check && record(event.data) && check(event.data as Record<string, unknown>);
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-events-"));
  const path = join(root, "store.sqlite");
  const store = new SQLiteStore(path);
  const registry = new ToolRegistry();
  return {
    root,
    path,
    store,
    registry,
    /** The persisted `events` rows of a session, in insertion order. */
    rows(session: string): Array<{ seq: number; run_id: string; type: string }> {
      const db = openDatabase(path);
      try {
        return db
          .prepare("SELECT seq, run_id, type FROM events WHERE session=? ORDER BY seq")
          .all(session) as Array<{ seq: number; run_id: string; type: string }>;
      } finally {
        db.close();
      }
    },
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const assistant = (
  text: string,
  calls: ToolCall[] = [],
): Extract<Message, { role: "assistant" }> => ({ role: "assistant", text, calls });

/** Scripted provider: one list of events per turn; `delayMs` lets timing fields be non-trivial. */
function scripted(turns: ProviderEvent[][], delayMs = 0): ModelProvider {
  let turn = 0;
  return {
    id: "test",
    model: "test-model",
    async *stream() {
      const events = turns[turn++] ?? [];
      for (const event of events) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        yield event;
      }
    },
  };
}

const recorder = () => {
  const events: RunEvent[] = [];
  return { events, onEvent: (event: RunEvent) => events.push(event) };
};

describe("RunEvent contract (T-02)", () => {
  it("every emitted event conforms to KnownRunEvent, with eventId = events.seq for durable ones", async () => {
    const fx = await fixture();
    try {
      fx.registry.register({
        name: "write_note",
        description: "writes a note",
        inputSchema: { type: "object", properties: {} },
        effect: "write",
        async execute(_input, ctx) {
          ctx.emit({ step: "halfway" });
          return textResult("note written");
        },
      });
      const session = fx.store.create(fx.root, "test", "test-model");
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: scripted(
          [
            [
              { type: "reasoning_delta", delta: "thinking" },
              { type: "text_delta", delta: "Writing" },
              {
                type: "completed",
                message: assistant("Writing", [
                  { id: "call-1", name: "write_note", arguments: "{}" },
                ]),
                usage: { input: 10, output: 5 },
              },
            ],
            [
              { type: "text_delta", delta: "Done" },
              {
                type: "completed",
                message: assistant("Done"),
                usage: { input: 20, output: 3, cachedInput: 8 },
              },
            ],
          ],
          2,
        ),
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        approve: async () => "once",
        onEvent,
      });

      const result = await runner.run(session.id, "write a note", undefined, {
        runId: "run-fixed-1",
        correlationId: "req-abc",
      });
      expect(result.status).toBe("completed");

      const types = events.map((e) => e.type);
      for (const expected of [
        "run_started",
        "reasoning_delta",
        "text_delta",
        "turn_completed",
        "tool_started",
        "approval_requested",
        "approval_resolved",
        "tool_progress",
        "tool_completed",
        "run_completed",
      ])
        expect(types).toContain(expected);

      for (const event of events) {
        expect(conforms(event), `${event.type} ${JSON.stringify(event.data)}`).toBe(true);
        expect(event.schemaVersion).toBe(1);
        expect(event.runId).toBe("run-fixed-1");
        expect(event.correlationId).toBe("req-abc");
        expect(event.sessionId).toBe(session.id);
      }
      // `seq` stays a per-run counter starting at 1.
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

      const durable = events.filter((e) => !isEphemeralRunEventType(e.type));
      const ephemeral = events.filter((e) => isEphemeralRunEventType(e.type));
      expect(ephemeral.length).toBeGreaterThan(0);
      for (const event of ephemeral) expect(event.eventId).toBeUndefined();

      const rows = fx.rows(session.id);
      expect(rows.map((r) => r.type)).toEqual(durable.map((e) => e.type));
      expect(durable.map((e) => e.eventId)).toEqual(rows.map((r) => String(r.seq)));
      expect(rows.every((r) => r.run_id === "run-fixed-1")).toBe(true);

      const turnsCompleted = events.filter(
        (e): e is Extract<KnownRunEvent, { type: "turn_completed" }> => e.type === "turn_completed",
      );
      expect(turnsCompleted).toHaveLength(2);
      for (const turn of turnsCompleted) {
        expect(turn.data.durationMs).toBeGreaterThanOrEqual(0);
        expect(turn.data.ttftMs).toBeGreaterThanOrEqual(0);
        expect(turn.data.ttftMs ?? 0).toBeLessThanOrEqual(turn.data.durationMs ?? 0);
      }
      expect(turnsCompleted[1]?.data.usage?.cachedInput).toBe(8);
    } finally {
      await fx.close();
    }
  });

  it("generates a fresh runId and omits correlationId when the caller gives none", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test-model");
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        // A provider that only completes (no deltas) has no time-to-first-token.
        provider: scripted([
          [{ type: "completed", message: assistant("hi") }],
          [{ type: "completed", message: assistant("hi again") }],
        ]),
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent,
      });
      await runner.run(session.id, "hello");
      await runner.run(session.id, "again");
      const runIds = new Set(events.map((e) => e.runId));
      expect(runIds.size).toBe(2);
      for (const event of events) {
        expect(conforms(event)).toBe(true);
        expect("correlationId" in event).toBe(false);
        expect(event.eventId).toMatch(/^\d+$/);
      }
      const turn = events.find((e) => e.type === "turn_completed")?.data as Record<string, unknown>;
      expect(typeof turn.durationMs).toBe("number");
      expect("ttftMs" in turn).toBe(false);
      // eventIds are global and strictly increasing across runs of the same session.
      const ids = events.map((e) => Number(e.eventId));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      await fx.close();
    }
  });

  it("types failure, cancellation, model change and compaction payloads", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test-model");
      const { events, onEvent } = recorder();
      const failing: ModelProvider = {
        id: "test",
        model: "test-model",
        async *stream() {
          throw new Error("provider down");
        },
      };
      const runner = new AgentRunner({
        provider: failing,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent,
      });
      await expect(runner.run(session.id, "fail", undefined, { runId: "r-fail" })).rejects.toThrow(
        "provider down",
      );
      const aborted = new AbortController();
      aborted.abort(new Error("stopped by user"));
      await expect(runner.run(session.id, "cancel", aborted.signal)).rejects.toThrow();
      runner.setModel(session.id, "other-model");
      await runner.compact(session.id);

      const types = events.map((e) => e.type);
      for (const expected of ["run_failed", "run_cancelled", "model_changed", "compaction_skipped"])
        expect(types).toContain(expected);
      for (const event of events) {
        expect(conforms(event), `${event.type} ${JSON.stringify(event.data)}`).toBe(true);
        expect(event.eventId).toMatch(/^\d+$/);
      }
      expect(events.find((e) => e.type === "run_failed")?.runId).toBe("r-fail");
    } finally {
      await fx.close();
    }
  });

  it("classifies exactly text_delta, reasoning_delta and tool_progress as ephemeral", () => {
    const expected: EphemeralRunEventType[] = ["text_delta", "reasoning_delta", "tool_progress"];
    expect([...EPHEMERAL_RUN_EVENT_TYPES].sort()).toEqual([...expected].sort());
    for (const type of Object.keys(contract))
      expect(isEphemeralRunEventType(type)).toBe((expected as string[]).includes(type));
    expect(isEphemeralRunEventType("some_future_event")).toBe(false);
  });
});

describe("SessionStore.event (store port)", () => {
  it("SQLiteStore returns the persisted global events.seq", async () => {
    const fx = await fixture();
    try {
      const a = fx.store.create(fx.root, "test", "m");
      const b = fx.store.create(fx.root, "test", "m");
      const first = fx.store.event(a.id, "r1", "run_started", { model: "m" });
      const second = fx.store.event(b.id, "r2", "run_started", { model: "m" });
      expect(typeof first).toBe("number");
      expect(second).toBe((first as number) + 1);
      expect(fx.rows(b.id).map((r) => r.seq)).toEqual([second]);
    } finally {
      await fx.close();
    }
  });

  it("a store that returns nothing still works; events just carry no eventId", async () => {
    const fx = await fixture();
    try {
      const legacy: SessionStore = new Proxy(fx.store as SessionStore, {
        get(target, prop, receiver) {
          if (prop === "event")
            return (id: string, runId: string, type: string, data: unknown): void => {
              target.event(id, runId, type, data);
            };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const session = fx.store.create(fx.root, "test", "test-model");
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: scripted([[{ type: "completed", message: assistant("ok") }]]),
        registry: fx.registry,
        store: legacy,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent,
      });
      await runner.run(session.id, "hi");
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect("eventId" in event).toBe(false);
    } finally {
      await fx.close();
    }
  });
});
