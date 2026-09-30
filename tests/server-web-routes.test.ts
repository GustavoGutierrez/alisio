import type {
  CommandDescriptor,
  CommandOutcome,
  ModelProvider,
  ProviderEvent,
  SessionContextUsage,
  SessionModels,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
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

const withModels = (provider: ModelProvider): ModelProvider => ({
  ...provider,
  listModels: async () => [
    { id: "fake-model", contextWindow: 32_000, effort: { supportedLevels: ["low", "high"] } },
    { id: "other-model", contextWindow: 8_000 },
  ],
});

const GREET = {
  name: "greet",
  text: "---\ndescription: Greet someone\n---\nSay hello to $ARGUMENTS",
};

describe("GET /api/commands", () => {
  it("lists the web commands of a session's workspace, without TUI-only ones", async () => {
    t = await startTestServer({ app: { builtinPrompts: [GREET] } });
    const session = await newSession(t);
    const res = await t.api.get(`/api/commands?session=${session.id}`);
    expect(res.status).toBe(200);
    const names = res.json<CommandDescriptor[]>().map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["compact", "stats", "model", "greet", "help"]));
    expect(names).not.toContain("copy");
    expect(names).not.toContain("exit");
    expect(names).not.toContain("connect");
  });

  it("lists only built-ins without a session and 404s an unknown session", async () => {
    t = await startTestServer({ app: { builtinPrompts: [GREET] } });
    const names = (await t.api.get("/api/commands")).json<CommandDescriptor[]>().map((c) => c.name);
    expect(names).toContain("stats");
    expect(names).not.toContain("greet");
    expect((await t.api.get("/api/commands?session=nope")).status).toBe(404);
  });
});

describe("POST /api/sessions/:sid/commands", () => {
  it("runs a core command and returns its markdown output", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const res = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "c1",
      name: "stats",
    });
    expect(res.status).toBe(200);
    const outcome = res.json<CommandOutcome>();
    expect(outcome.output).toContain("Session statistics");
    expect(outcome.output).toContain(session.id);
  });

  it("expands prompt templates and /ask into a prompt the client sends", async () => {
    t = await startTestServer({ app: { builtinPrompts: [GREET] } });
    const session = await newSession(t);
    const greet = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "c2",
      name: "greet",
      args: "Ana",
    });
    expect(greet.json<CommandOutcome>().prompt).toEqual({
      text: expect.stringContaining("Say hello to Ana"),
      display: "/greet Ana",
    });
    const ask = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "c3",
      name: "ask",
      args: "tabs or spaces?",
    });
    const prompt = ask.json<CommandOutcome>().prompt;
    expect(prompt?.display).toBe("/ask tabs or spaces?");
    expect(prompt?.text).toContain("ask_user_question");
  });

  it("answers /help with the web command list", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const res = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "h1",
      name: "help",
    });
    expect(res.json<CommandOutcome>().output).toContain("/compact");
  });

  it("returns the new session of /clear and resolves aliases", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const res = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "n1",
      name: "new",
    });
    const outcome = res.json<CommandOutcome>();
    expect(outcome.sessionId).toBeTruthy();
    expect(outcome.sessionId).not.toBe(session.id);
    expect((await t.api.get(`/api/sessions/${outcome.sessionId}`)).status).toBe(200);
  });

  it("stores /effort per session instead of changing the global setting", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "e1",
      name: "effort",
      args: "high",
    });
    expect(
      (await t.api.get(`/api/sessions/${session.id}`)).json<{ effort?: string }>().effort,
    ).toBe("high");
  });

  it("rejects unknown and TUI-only commands with unknown_command, and repeats idempotently", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const unknown = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "u1",
      name: "does-not-exist",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe("unknown_command");
    const tuiOnly = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "u2",
      name: "copy",
    });
    expect(tuiOnly.status).toBe(404);
    const first = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "same",
      name: "stats",
    });
    const again = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "same",
      name: "stats",
    });
    expect(first.json<CommandOutcome>().duplicate).toBeUndefined();
    expect(again.json<CommandOutcome>()).toEqual({ duplicate: true });
  });

  it("refuses /model and /compact while the session runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    t = await startTestServer({
      provider: fakeProvider(async function* (): AsyncGenerator<ProviderEvent> {
        await gate;
        yield* reply("done");
      }),
    });
    const session = await newSession(t);
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "hi" });
    const res = await t.api.post(`/api/sessions/${session.id}/commands`, {
      requestId: "m1",
      name: "model",
      args: "other",
    });
    expect(res.status).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("session_busy");
    release();
    await settled(t, session.id);
  });
});

describe("session models, context and export", () => {
  it("lists the models of the session's provider with effort levels", async () => {
    t = await startTestServer({ provider: withModels(fakeProvider(() => reply("ok"))) });
    const session = await newSession(t);
    const res = await t.api.get(`/api/sessions/${session.id}/models`);
    expect(res.status).toBe(200);
    const body = res.json<SessionModels>();
    expect(body).toMatchObject({ model: "fake-model", unavailable: false });
    expect(body.models.map((m) => m.id)).toEqual(["fake-model", "other-model"]);
    expect(body.models[0]?.effort?.supportedLevels).toEqual(["low", "high"]);
  });

  it("reports an unavailable catalog instead of failing when the provider cannot list", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const body = (await t.api.get(`/api/sessions/${session.id}/models`)).json<SessionModels>();
    expect(body.model).toBe("fake-model");
    expect(body.models).toEqual([]);
  });

  it("estimates context usage against the model window", async () => {
    t = await startTestServer({ provider: withModels(fakeProvider(() => reply("ok"))) });
    const session = await newSession(t);
    const res = await t.api.get(`/api/sessions/${session.id}/context`);
    expect(res.status).toBe(200);
    const usage = res.json<SessionContextUsage>();
    expect(usage.estimated).toBeGreaterThan(0);
    expect(["window", "unknown"]).toContain(usage.basis);
    const known = await until(async () => {
      const again = (
        await t?.api.get(`/api/sessions/${session.id}/context`)
      )?.json<SessionContextUsage>();
      return again?.basis === "window" ? again : undefined;
    });
    expect(known?.total).toBe(32_000);
  });

  it("exports the session log as JSONL: events in order, then messages", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    for (const requestId of ["a", "b"]) {
      const accepted = await t.api.post(`/api/sessions/${session.id}/prompts`, {
        requestId,
        text: `hello ${requestId}`,
      });
      await settled(t, session.id, accepted.json<{ runId: string }>().runId);
    }
    const res = await t.api.get(`/api/sessions/${session.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="alisio-${session.id}.jsonl"`,
    );
    const lines = res.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const events = lines.filter((l) => l.type !== "message");
    const messages = lines.filter((l) => l.type === "message");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.schemaVersion === 1 && e.sessionId === session.id)).toBe(true);
    const ids = events.map((e) => Number(e.eventId));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(events.filter((e) => e.type === "run_completed")).toHaveLength(2);
    expect(messages.map((m) => (m.message as { role: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(lines.findIndex((l) => l.type === "message")).toBe(events.length);
  });

  it("applies the session's agent to its runs (plan: instructions and read-only)", async () => {
    const provider = fakeProvider(() => reply("planned"));
    t = await startTestServer({ provider, app: { allowWrite: true } });
    const session = await newSession(t, { agent: "plan" });
    const accepted = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "p1",
      text: "plan it",
    });
    await settled(t, session.id, accepted.json<{ runId: string }>().runId);
    const request = provider.calls[0];
    expect(request?.instructions).toContain('the "plan" agent');
    const tools = (request?.tools ?? []).map((tool) => tool.name);
    expect(tools).not.toContain("write_file");
  });
});
