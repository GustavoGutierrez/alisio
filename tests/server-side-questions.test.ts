/** `/btw` over HTTP: `POST/GET /api/sessions/:sid/btw` and `POST .../btw/cancel`. */
import { request as httpRequest } from "node:http";
import type { CommandOutcome, ProviderEvent, SideQuestionEntry } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortable,
  deferred,
  fakeProvider,
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

type Request = Parameters<ReturnType<typeof fakeProvider>["stream"]>[0];
const isSide = (request: Request) => {
  const last = request.messages.at(-1);
  return last?.role === "user" && last.text.includes("Side question:");
};

/**
 * Main runs wait for `releaseRun()`; side questions answer "side: <question>" (or wait for
 * `releaseSide()` when `gateSide`). `sideSignal` is the last side call's abort signal.
 */
function scripted(options: { gateSide?: boolean; failSide?: boolean } = {}) {
  let run = deferred();
  let side = deferred();
  const runStarted = deferred();
  const sideStarted = deferred();
  let sideSignal: AbortSignal | undefined;
  const provider = fakeProvider(async function* (request): AsyncGenerator<ProviderEvent> {
    if (isSide(request)) {
      sideSignal = request.signal;
      sideStarted.resolve();
      if (options.failSide) throw new Error("upstream 500");
      if (options.gateSide) await abortable(side.promise, request.signal);
      const last = request.messages.at(-1);
      const question = last?.role === "user" ? last.text.split("Side question: ").at(-1) : "";
      yield {
        type: "completed",
        message: { role: "assistant", text: `side: ${question}`, calls: [] },
        usage: { input: 42, output: 7 },
      };
      return;
    }
    runStarted.resolve();
    await abortable(run.promise, request.signal);
    yield* reply("main done");
  });
  return {
    provider,
    runStarted: runStarted.promise,
    sideStarted: sideStarted.promise,
    get sideSignal() {
      return sideSignal;
    },
    releaseRun() {
      run.resolve();
      run = deferred();
    },
    releaseSide() {
      side.resolve();
      side = deferred();
    },
  };
}

const eventCount = async (s: TestServer, sid: string) =>
  (await s.api.get(`/api/sessions/${sid}/events?after=0&limit=1000`)).json<{ items: unknown[] }>()
    .items.length;

describe("side questions over HTTP", () => {
  it("answers while a run is active without touching messages, events or runs", async () => {
    const script = scripted();
    t = await startTestServer({ provider: script.provider });
    const session = await newSession(t);
    const accepted = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r1",
      text: "do the work",
    });
    expect(accepted.status).toBe(202);
    await script.runStarted;
    const eventsBefore = await eventCount(t, session.id);
    const res = await t.api.post(`/api/sessions/${session.id}/btw`, { question: "what now?" });
    expect(res.status).toBe(200);
    const entry = res.json<SideQuestionEntry>();
    expect(entry).toMatchObject({
      question: "what now?",
      answer: "side: what now?",
      model: "fake-model",
      usage: { input: 42, output: 7 },
    });
    // The side call had no tools and the run kept going.
    const sideCall = script.provider.calls.find(isSide);
    expect(sideCall?.tools).toEqual([]);
    expect(await eventCount(t, session.id)).toBe(eventsBefore);
    expect((await t.api.get(`/api/sessions/${session.id}`)).json()).toMatchObject({
      status: "running",
    });
    script.releaseRun();
    await settled(t, session.id);
    const messages = (await t.api.get(`/api/sessions/${session.id}/messages?limit=50`)).json<{
      items: Array<{ message: { role: string; text?: string } }>;
    }>();
    expect(messages.items.map((i) => i.message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(messages)).not.toContain("what now?");
    const runs = (await t.api.get(`/api/sessions/${session.id}/runs`)).json<unknown[]>();
    expect(runs).toHaveLength(1);
    const events = await t.api.get(`/api/sessions/${session.id}/events?after=0&limit=1000`);
    expect(events.text).not.toContain("what now?");
    const history = await t.api.get(`/api/sessions/${session.id}/btw`);
    expect(history.json<SideQuestionEntry[]>()).toEqual([entry]);
  });

  it("validates the question and the session", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const empty = await t.api.post(`/api/sessions/${session.id}/btw`, { question: "  " });
    expect(empty.status).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: "validation_failed" } });
    const long = await t.api.post(`/api/sessions/${session.id}/btw`, {
      question: "x".repeat(4_001),
    });
    expect(long.status).toBe(400);
    const extra = await t.api.post(`/api/sessions/${session.id}/btw`, { question: "q", x: 1 });
    expect(extra.status).toBe(400);
    const missing = await t.api.post("/api/sessions/nope/btw", { question: "q" });
    expect(missing.status).toBe(404);
    expect((await t.api.get("/api/sessions/nope/btw")).status).toBe(404);
    expect((await t.api.get(`/api/sessions/${session.id}/btw`)).json()).toEqual([]);
  });

  it("cancels an in-flight side question and records nothing", async () => {
    const script = scripted({ gateSide: true });
    t = await startTestServer({ provider: script.provider });
    const session = await newSession(t);
    const pending = t.api.post(`/api/sessions/${session.id}/btw`, { question: "slow?" });
    await script.sideStarted;
    const cancel = await t.api.post(`/api/sessions/${session.id}/btw/cancel`);
    expect(cancel.json()).toEqual({ cancelled: true });
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "cancelled" } });
    expect((await t.api.get(`/api/sessions/${session.id}/btw`)).json()).toEqual([]);
    const idle = await t.api.post(`/api/sessions/${session.id}/btw/cancel`);
    expect(idle.json()).toEqual({ cancelled: false });
  });

  it("aborts the provider call when the client goes away", async () => {
    const script = scripted({ gateSide: true });
    t = await startTestServer({ provider: script.provider });
    const session = await newSession(t);
    const port = t.server.port;
    const body = JSON.stringify({ question: "gone?" });
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: `/api/sessions/${session.id}/btw`,
      method: "POST",
      headers: {
        Cookie: t.cookie,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
    });
    req.on("error", () => {});
    req.end(body);
    await script.sideStarted;
    req.destroy();
    await until(() => script.sideSignal?.aborted);
    const current = t;
    await until(async () => {
      const list = (await current.api.get(`/api/sessions/${session.id}/btw`)).json<unknown[]>();
      return list.length === 0;
    });
  });

  it("reports provider failures as provider_unavailable", async () => {
    const script = scripted({ failSide: true });
    t = await startTestServer({ provider: script.provider });
    const session = await newSession(t);
    const res = await t.api.post(`/api/sessions/${session.id}/btw`, { question: "boom?" });
    expect(res.status).toBe(502);
    expect(res.json()).toMatchObject({
      error: { code: "provider_unavailable", message: "Side question failed: upstream 500" },
    });
  });

  it("runs /btw through the commands route: usage line, then the latest answer", async () => {
    const script = scripted();
    t = await startTestServer({ provider: script.provider });
    const session = await newSession(t);
    const list = (await t.api.get(`/api/commands?session=${session.id}`)).json<
      Array<{ name: string; argumentHint?: string }>
    >();
    expect(list.find((c) => c.name === "btw")?.argumentHint).toBe("[question]");
    const run = (args?: string) =>
      t?.api.post(`/api/sessions/${session.id}/commands`, {
        requestId: `c${Math.random().toString(36).slice(2)}`,
        name: "btw",
        ...(args ? { args } : {}),
      });
    const usage = (await run())?.json<CommandOutcome>();
    expect(usage?.output?.split("\n")[0]).toBe("Usage: /btw <question>");
    const asked = (await run("hello?"))?.json<CommandOutcome>();
    expect(asked?.output).toContain("side: hello?");
    const latest = (await run())?.json<CommandOutcome>();
    expect(latest?.output).toContain("**btw 1/1** · hello?");
  });
});
