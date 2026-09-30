import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderEvent, ServerFrame } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SseHub, type SseSink } from "../packages/server/src/sse/hub.ts";
import {
  fakeProvider,
  gatedProvider,
  newSession,
  openStream,
  reply,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

let t: TestServer | undefined;
const streams: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await t?.close();
  t = undefined;
});
const stream = (sessions: string[], headers?: Record<string, string>) => {
  if (!t) throw new Error("no server");
  const s = openStream(t.server.port, t.cookie, sessions, headers);
  streams.push(s);
  return s;
};
type Frame<T extends ServerFrame["t"]> = Extract<ServerFrame, { t: T }>;
const is =
  <T extends ServerFrame["t"]>(type: T, sessionId?: string) =>
  (e: { frame: ServerFrame }) =>
    e.frame.t === type &&
    (!sessionId || (e.frame as { sessionId?: string }).sessionId === sessionId);

describe("SSE stream (T-08)", () => {
  it("sends hello and a snapshot, then durable events, messages and coalesced deltas without gaps", async () => {
    t = await startTestServer({ provider: fakeProvider(() => reply("Hello world")) });
    const session = await newSession(t);
    const s = stream([session.id]);
    const hello = (await s.next(is("hello"))).frame as Frame<"hello">;
    expect(hello.protocolVersion).toBe(1);
    const snapshot = (await s.next(is("snapshot"))).frame as Frame<"snapshot">;
    expect(snapshot).toMatchObject({
      sessionId: session.id,
      cursor: 0,
      session: { id: session.id, status: "idle" },
      messages: { items: [], hasMore: false },
      pending: { approvals: [], interactions: [] },
    });
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "hi" });
    await s.next((e) => e.frame.t === "event" && e.frame.event.type === "run_completed");
    const durable = s.events.filter((e) => e.frame.t === "event");
    const ids = durable.map((e) => Number(e.id));
    expect(ids.every((id, i) => id > snapshot.cursor && (i === 0 || id > (ids[i - 1] ?? 0)))).toBe(
      true,
    );
    for (const e of durable) expect(e.id).toBe((e.frame as Frame<"event">).event.eventId);
    const text = s
      .frames()
      .filter((f): f is Frame<"delta"> => f.t === "delta")
      .map((f) => f.text ?? "")
      .join("");
    expect(text).toBe("Hello world");
    expect(s.events.filter((e) => e.frame.t === "delta").every((e) => e.id === undefined)).toBe(
      true,
    );
    await s.next(is("message"), 0);
    const messages = s
      .frames()
      .filter((f): f is Frame<"message"> => f.t === "message")
      .map((f) => [f.message.role, "text" in f.message ? f.message.text : ""]);
    expect(messages).toEqual([
      ["user", "hi"],
      ["assistant", "Hello world"],
    ]);
    const order = s.frames().map((f) => (f.t === "event" ? f.event.type : f.t));
    expect(order.indexOf("delta")).toBeLessThan(order.indexOf("turn_completed"));
  });

  it("reconnects mid-run with the in-flight buffer and continues without duplicating text", async () => {
    const gated = gatedProvider();
    t = await startTestServer({ provider: gated.provider });
    const session = await newSession(t);
    const first = stream([session.id]);
    await first.next(is("snapshot"));
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" })
    ).json<{ runId: string }>();
    await first.next((e) => e.frame.t === "delta" && e.frame.text === "wor");
    const lastId = first.events.filter((e) => e.id).at(-1)?.id ?? "";
    first.close();
    const second = stream([session.id], { "Last-Event-ID": lastId });
    const snapshot = (await second.next(is("snapshot"))).frame as Frame<"snapshot">;
    expect(snapshot.session.status).toBe("running");
    expect(snapshot.inflight).toMatchObject({ runId: run.runId, status: "running", text: "wor" });
    expect(snapshot.cursor).toBeGreaterThanOrEqual(Number(lastId));
    gated.release();
    await second.next((e) => e.frame.t === "event" && e.frame.event.type === "run_completed");
    const after = second
      .frames()
      .filter((f): f is Frame<"delta"> => f.t === "delta")
      .map((f) => f.text ?? "")
      .join("");
    expect(`${snapshot.inflight?.text}${after}`).toBe("working done");
    const assistant = second
      .frames()
      .find((f): f is Frame<"message"> => f.t === "message" && f.message.role === "assistant");
    expect(assistant?.message).toMatchObject({ text: "working done" });
    await settled(t, session.id, run.runId);
  });

  it("sends the full tool result after tool_completed", async () => {
    const provider = fakeProvider(async function* (_request, call): AsyncGenerator<ProviderEvent> {
      if (call === 0) {
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: "",
            calls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }],
          },
        };
        return;
      }
      yield* reply("read it");
    });
    t = await startTestServer({ provider });
    await writeFile(join(t.workspace, "a.txt"), "file body");
    const session = await newSession(t);
    const s = stream([session.id]);
    await s.next(is("snapshot"));
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "read" });
    const result = (await s.next(is("tool_result"))).frame as Frame<"tool_result">;
    expect(result.callId).toBe("c1");
    expect(JSON.stringify(result.result)).toContain("file body");
    await s.next((e) => e.frame.t === "event" && e.frame.event.type === "run_completed");
    const roles = s
      .frames()
      .filter((f): f is Frame<"message"> => f.t === "message")
      .map((f) => f.message.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("broadcasts session_status to streams without subscriptions (sidebars)", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const sidebar = stream([]);
    await sidebar.next(is("hello"));
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "x" });
    await sidebar.next((e) => e.frame.t === "session_status" && e.frame.status === "running");
    await sidebar.next((e) => e.frame.t === "session_status" && e.frame.status === "idle");
    expect(sidebar.frames().some((f) => f.t === "event")).toBe(false);
  });

  it("sends heartbeat comments", async () => {
    t = await startTestServer({ heartbeatMs: 30 });
    const s = stream([]);
    await s.next(is("hello"));
    await new Promise((r) => setTimeout(r, 120));
    expect(s.comments.filter((c) => c.startsWith(": ping")).length).toBeGreaterThan(0);
  });

  it("validates subscriptions and limits streams", async () => {
    t = await startTestServer({ maxStreams: 1 });
    const unknown = stream(["missing"]);
    await expect(unknown.next(is("hello"), 0, 1_000)).rejects.toThrow();
    expect(unknown.status).toBe(404);
    const nine = Array.from({ length: 9 }, (_, i) => `s${i}`);
    const tooMany = stream(nine);
    await expect(tooMany.next(is("hello"), 0, 1_000)).rejects.toThrow();
    expect(tooMany.status).toBe(400);
    const ok = stream([]);
    await ok.next(is("hello"));
    const second = stream([]);
    await expect(second.next(is("hello"), 0, 1_000)).rejects.toThrow();
    expect(second.status).toBe(503);
  });
});

describe("SseHub backpressure", () => {
  /** A sink whose socket never drains after the first write. */
  function stuckSink() {
    const writes: string[] = [];
    let ended = false;
    const sink: SseSink = {
      write(chunk) {
        writes.push(chunk);
        return writes.length < 2;
      },
      end() {
        ended = true;
      },
      once() {
        return sink;
      },
    };
    return {
      sink,
      writes,
      get ended() {
        return ended;
      },
    };
  }
  const hub = () =>
    new SseHub({
      snapshot: (sessionId) => ({
        t: "snapshot",
        sessionId,
        cursor: 0,
        session: {
          id: sessionId,
          workspaceId: "w",
          workspace: "/w",
          provider: "p",
          model: "m",
          status: "idle",
        },
        messages: { items: [], hasMore: false },
        pending: { approvals: [], interactions: [] },
      }),
      messagesAfter: () => ({ items: [], hasMore: false }),
      toolResult: () => undefined,
      workspaceOf: () => "w",
      maxQueueFrames: 5,
      heartbeatMs: 60_000,
    });
  const event = (seq: number) => ({
    schemaVersion: 1 as const,
    runId: "r",
    sessionId: "s",
    seq,
    type: "compaction_skipped",
    timestamp: new Date().toISOString(),
    data: {},
    eventId: String(seq),
  });

  it("drops queued deltas first, then ends a slow stream with resync (overflow)", () => {
    const h = hub();
    const client = stuckSink();
    h.attach(client.sink, ["s"]);
    for (let i = 0; i < 4; i++)
      h.broadcast({ t: "catalog_changed", workspaceId: "w", scope: "mcp" });
    expect(client.ended).toBe(false);
    for (let i = 0; i < 10; i++) h.publish(event(i + 1));
    expect(client.ended).toBe(true);
    expect(client.writes.at(-1)).toContain('"t":"resync"');
    expect(client.writes.at(-1)).toContain('"reason":"overflow"');
    expect(h.dropped).toBe(1);
    expect(h.size).toBe(0);
    h.closeAll();
  });
});
