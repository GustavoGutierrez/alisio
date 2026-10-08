import { spawn } from "node:child_process";
import type { PromptAccepted, SessionDetail, SessionSummary } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import {
  fakeProvider,
  gatedProvider,
  newSession,
  reply,
  settled,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const prompt = (s: TestServer, sid: string, requestId: string, text = "hello", extra = {}) =>
  s.api.post(`/api/sessions/${sid}/prompts`, { requestId, text, ...extra });

describe("sessions", () => {
  it("creates, reads, lists and patches sessions without deleting them", async () => {
    t = await startTestServer();
    const created = await newSession(t, { title: "First" });
    expect(created).toMatchObject({
      title: "First",
      status: "idle",
      preset: "workspace-write",
      pinned: false,
      archived: false,
      children: [],
    });
    expect(created.presets.map((p) => p.id)).toEqual([
      "read-only",
      "ask",
      "workspace-write",
      "full-access",
    ]);
    const patched = await t.api.patch(`/api/sessions/${created.id}`, {
      title: "Renamed",
      pinned: true,
      effort: "high",
      preset: "ask",
    });
    expect(patched.json<SessionDetail>()).toMatchObject({
      title: "Renamed",
      pinned: true,
      effort: "high",
      preset: "ask",
    });
    await t.api.patch(`/api/sessions/${created.id}`, { archived: true });
    const active = (await t.api.get("/api/sessions")).json<{ items: SessionSummary[] }>();
    expect(active.items).toEqual([]);
    const archived = (await t.api.get("/api/sessions?archived=true")).json<{
      items: SessionSummary[];
    }>();
    expect(archived.items.map((s) => s.id)).toEqual([created.id]);
    expect((await t.api.get("/api/sessions/nope")).status).toBe(404);
  });

  it("re-binds the session to the active provider when the model changes", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const patched = await t.api.patch(`/api/sessions/${session.id}`, { model: "other-model" });
    expect(patched.status).toBe(200);
    // Same provider (the active one), new model: the session is rebound instead of only relabelled.
    expect(patched.json<SessionDetail>()).toMatchObject({
      model: "other-model",
      provider: session.provider,
    });
    // The next run uses the rebound binding (the transcript is provider-neutral).
    await prompt(t, session.id, "rebind-1");
    expect(await settled(t, session.id)).toMatchObject({ status: "completed" });
  });

  it("refuses presets above the capability ceiling (403 capability_ceiling)", async () => {
    t = await startTestServer({ app: { readOnly: true } });
    const session = await newSession(t);
    expect(session.preset).toBe("read-only");
    expect(session.presets.filter((p) => p.available).map((p) => p.id)).toEqual(["read-only"]);
    const res = await t.api.patch(`/api/sessions/${session.id}`, { preset: "ask" });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "capability_ceiling" } });
  });

  it("reports effects degraded by the launch flags", async () => {
    t = await startTestServer({ app: { allowWrite: true } });
    const session = await newSession(t);
    const full = session.presets.find((p) => p.id === "full-access");
    expect(full).toMatchObject({
      available: true,
      policy: { write: true, process: false, external: false },
    });
    expect(full?.reason).toMatch(/--allow-process/);
  });
});

describe("prompts (T-09)", () => {
  it("runs a prompt, journals it with the request correlation id and pages messages and events", async () => {
    const provider = fakeProvider(() => reply("Hi there"));
    t = await startTestServer({ provider });
    const session = await newSession(t);
    const res = await t.api.post(
      `/api/sessions/${session.id}/prompts`,
      { requestId: "r-1", text: "hello" },
      { "X-Request-Id": "corr-1" },
    );
    expect(res.status).toBe(202);
    const accepted = res.json<{ runId: string; status: string }>();
    expect(["queued", "running"]).toContain(accepted.status);
    const run = await settled(t, session.id, accepted.runId);
    expect(run).toMatchObject({ status: "completed", requestId: "r-1", correlationId: "corr-1" });
    const messages = (await t.api.get(`/api/sessions/${session.id}/messages`)).json<{
      items: Array<{ seq: number; message: { role: string; text: string } }>;
      hasMore: boolean;
    }>();
    expect(messages.items.map((m) => [m.message.role, m.message.text])).toEqual([
      ["user", "hello"],
      ["assistant", "Hi there"],
    ]);
    const older = (
      await t.api.get(`/api/sessions/${session.id}/messages?before=${messages.items[1]?.seq}`)
    ).json<{ items: unknown[] }>();
    expect(older.items).toHaveLength(1);
    const events = (await t.api.get(`/api/sessions/${session.id}/events?limit=2`)).json<{
      items: Array<{ type: string; eventId: string; correlationId?: string; runId: string }>;
      next?: string;
    }>();
    expect(events.items[0]).toMatchObject({ type: "run_started", correlationId: "corr-1" });
    expect(events.next).toBe(events.items[1]?.eventId);
    const rest = (
      await t.api.get(`/api/sessions/${session.id}/events?after=${events.next}&types=run_completed`)
    ).json<{ items: Array<{ type: string }> }>();
    expect(rest.items.map((e) => e.type)).toEqual(["run_completed"]);
  });

  it("is idempotent by requestId, sequentially and concurrently", async () => {
    const provider = fakeProvider(() => reply("once"));
    t = await startTestServer({ provider });
    const a = await newSession(t);
    const first = await prompt(t, a.id, "same");
    const { runId } = first.json<{ runId: string }>();
    await settled(t, a.id, runId);
    const retry = await prompt(t, a.id, "same");
    expect(retry.status).toBe(200);
    expect(retry.json()).toEqual({ runId, status: "completed", duplicate: true });
    const b = await newSession(t);
    const [x, y] = await Promise.all([prompt(t, b.id, "both"), prompt(t, b.id, "both")]);
    expect([x.status, y.status].sort()).toEqual([200, 202]);
    expect(x.json<{ runId: string }>().runId).toBe(y.json<{ runId: string }>().runId);
    await settled(t, b.id);
    expect(provider.calls).toHaveLength(2);
  });

  it("enqueues text while running, refuses attachments with 409 session_busy", async () => {
    const gated = gatedProvider();
    t = await startTestServer({ provider: gated.provider });
    const session = await newSession(t);
    const first = await prompt(t, session.id, "r1", "first");
    await gated.started;
    const queued = await prompt(t, session.id, "r2", "follow up");
    expect(queued.status).toBe(202);
    expect(queued.json<PromptAccepted>()).toEqual({ status: "enqueued" });
    expect((await prompt(t, session.id, "r2", "follow up")).json()).toEqual({
      status: "enqueued",
      duplicate: true,
    });
    const withImage = await prompt(t, session.id, "r3", "look", {
      attachments: [{ hash: "a".repeat(64), mimeType: "image/png", bytes: 1 }],
    });
    expect(withImage.status).toBe(409);
    expect(withImage.json()).toMatchObject({ error: { code: "session_busy" } });
    expect((await t.api.get(`/api/sessions/${session.id}`)).json()).toMatchObject({
      status: "running",
    });
    gated.release();
    await settled(t, session.id, first.json<{ runId: string }>().runId);
  });

  it("answers 409 session_locked when another live process holds the session", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    const store = new SQLiteStore(t.db);
    try {
      store.db
        .prepare("UPDATE sessions SET locked_pid=? WHERE id=?")
        .run(other.pid as number, session.id);
      const res = await prompt(t, session.id, "r1");
      expect(res.status).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: "session_locked" } });
      expect((await t.api.get(`/api/sessions/${session.id}`)).json()).toMatchObject({
        status: "locked",
      });
      expect((await t.api.get(`/api/sessions/${session.id}/messages`)).status).toBe(200);
    } finally {
      other.kill();
      store.close();
    }
  });

  it("queues runs beyond --max-runs in FIFO order", async () => {
    const gated = gatedProvider();
    t = await startTestServer({ provider: gated.provider, maxConcurrentRuns: 1 });
    const a = await newSession(t);
    const b = await newSession(t);
    const ra = await prompt(t, a.id, "a1");
    expect(ra.json()).toMatchObject({ status: "running" });
    await gated.started;
    const rb = await prompt(t, b.id, "b1");
    expect(rb.json()).toMatchObject({ status: "queued" });
    expect((await t.api.get(`/api/sessions/${b.id}`)).json()).toMatchObject({ status: "queued" });
    expect((await t.api.get("/api/metrics")).json()).toMatchObject({
      activeRuns: 1,
      queuedRuns: 1,
    });
    expect((await prompt(t, b.id, "b2")).json()).toMatchObject({
      error: { code: "session_busy" },
    });
    gated.release();
    await settled(t, a.id);
    await gated.started;
    expect((await t.api.get(`/api/sessions/${b.id}`)).json<SessionDetail>().status).toBe("running");
    gated.release();
    expect(await settled(t, b.id)).toMatchObject({ status: "completed" });
  });

  it("cancels running and queued runs", async () => {
    const gated = gatedProvider();
    t = await startTestServer({ provider: gated.provider, maxConcurrentRuns: 1 });
    const a = await newSession(t);
    const b = await newSession(t);
    const ra = (await prompt(t, a.id, "a1")).json<{ runId: string }>();
    await gated.started;
    const rb = (await prompt(t, b.id, "b1")).json<{ runId: string }>();
    expect((await t.api.post(`/api/sessions/${b.id}/cancel`, {})).json()).toEqual({
      cancelled: true,
    });
    expect(await settled(t, b.id, rb.runId)).toMatchObject({ status: "cancelled" });
    expect((await t.api.post(`/api/sessions/${a.id}/cancel`, { runId: "other" })).json()).toEqual({
      cancelled: false,
    });
    expect((await t.api.post(`/api/sessions/${a.id}/cancel`, { runId: ra.runId })).json()).toEqual({
      cancelled: true,
    });
    expect(await settled(t, a.id, ra.runId)).toMatchObject({ status: "cancelled" });
    expect((await t.api.get(`/api/sessions/${a.id}`)).json()).toMatchObject({ status: "idle" });
  });

  it("refuses compaction while running and starts it when idle", async () => {
    const gated = gatedProvider();
    t = await startTestServer({ provider: gated.provider });
    const session = await newSession(t);
    const run = (await prompt(t, session.id, "r1")).json<{ runId: string }>();
    await gated.started;
    const busy = await t.api.post(`/api/sessions/${session.id}/compact`, {});
    expect(busy.status).toBe(409);
    gated.release();
    await settled(t, session.id, run.runId);
    const res = await t.api.post(`/api/sessions/${session.id}/compact`, {});
    expect(res.status).toBe(202);
    await until(async () => {
      const events = (await t?.api.get(`/api/sessions/${session.id}/events`))?.json<{
        items: Array<{ type: string }>;
      }>();
      return events?.items.some((e) => e.type.startsWith("compaction_"));
    });
  });

  it("validates prompt bodies", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const res = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "bad id",
      text: 1,
    });
    expect(res.status).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: "validation_failed", details: { fields: ["requestId", "text"] } },
    });
  });
});
