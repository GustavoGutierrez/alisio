/**
 * Plan review over HTTP: the interaction frame of a plan, the free-text answer, replay after a
 * reconnect, withdrawal on cancel, auth/Origin like every route, and the follow-up that starts
 * ONE implementation run with the build agent after an approval.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message, PendingInteraction, ProviderEvent, RunEvent } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeProvider,
  newSession,
  openStream,
  raw,
  type SseEvent,
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

const PLAN_ONE = "# Write the file\n\n## Goal\nCreate out.txt.\n\n## Steps\n1. Write out.txt.\n";
const PLAN_TWO = `${PLAN_ONE}2. Verify it.\n`;

/** The plan agent proposes plans in order; the build agent writes out.txt then finishes. */
function scriptedModel(plans: string[] = [PLAN_ONE, PLAN_TWO]) {
  let proposed = 0;
  const provider = fakeProvider(async function* (request): AsyncGenerator<ProviderEvent> {
    const last = request.messages.at(-1);
    const planRun = request.tools.some((tool) => tool.name === "exit_plan");
    if (planRun) {
      const feedback =
        last?.role === "tool" &&
        last.result.content.some((p) => p.type === "text" && p.text.includes('"feedback"'));
      if (last?.role === "user" || feedback) {
        const plan = plans[Math.min(proposed++, plans.length - 1)] ?? PLAN_ONE;
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: "",
            calls: [
              {
                id: `exit-${proposed}`,
                name: "exit_plan",
                arguments: JSON.stringify({ title: `Plan ${proposed}`, plan }),
              },
            ],
          },
        };
        return;
      }
      yield { type: "completed", message: { role: "assistant", text: "Plan noted.", calls: [] } };
      return;
    }
    if (last?.role === "user") {
      yield {
        type: "completed",
        message: {
          role: "assistant",
          text: "",
          calls: [
            {
              id: "write-1",
              name: "write_file",
              arguments: JSON.stringify({
                path: "out.txt",
                content: "built\n",
                expectedHash: null,
              }),
            },
          ],
        },
      };
      return;
    }
    yield { type: "completed", message: { role: "assistant", text: "Implemented.", calls: [] } };
  });
  return provider;
}

async function start(provider = scriptedModel()) {
  t = await startTestServer({
    provider,
    app: { allowWrite: true },
  });
  const session = await newSession(t, { agent: "plan", preset: "workspace-write" });
  return { t, session, provider };
}

const prompt = (sid: string, text = "plan the change") =>
  t?.api.post(`/api/sessions/${sid}/prompts`, {
    requestId: `r${Math.random().toString(36).slice(2, 10)}`,
    text,
  });

const isPlan = (e: SseEvent): boolean =>
  e.frame.t === "interaction" &&
  e.frame.interaction.request.kind === "questions" &&
  !!e.frame.interaction.request.plan;

const runs = async (sid: string) =>
  (await (t as TestServer).api.get(`/api/sessions/${sid}/runs`)).json<
    Array<{ id: string; status: string; request_id?: string }>
  >();

describe("plan review over HTTP", () => {
  it("publishes the plan interaction with the plan, its artifact and the free-text option", async () => {
    const { t, session } = await start();
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id);
    const frame = await stream.next(isPlan);
    const interaction = (frame.frame as { interaction: PendingInteraction }).interaction;
    if (interaction.request.kind !== "questions") throw new Error("expected questions");
    expect(interaction.request.questions[0]?.question).toBe(
      "Plan complete. What would you like to do?",
    );
    expect(
      interaction.request.questions[0]?.options.map((o) => [o.value, o.label, !!o.textInput]),
    ).toEqual([
      ["approve", "Agree and start implementation", false],
      ["skip", "Skip for now", false],
      ["context", "Add context", true],
    ]);
    expect(interaction.request.plan).toMatchObject({
      revision: 1,
      title: "Plan 1",
      markdown: PLAN_ONE.trim(),
      artifact: { fileName: "plan.md", kind: "document", sessionId: session.id },
    });
    // The plan artifact is real: the web opens it through the artifact routes.
    const artifactId = interaction.request.plan?.artifact?.id;
    const list = (await t.api.get(`/api/sessions/${session.id}/artifacts`)).json<{
      items: Array<{ id: string }>;
    }>();
    expect(list.items.map((a) => a.id)).toContain(artifactId);
    // The session shows it is waiting for the user.
    expect((await t.api.get(`/api/sessions/${session.id}`)).json<{ status: string }>().status).toBe(
      "awaiting_input",
    );
    stream.close();
  });

  it("replays a pending review to a client that connects (or reconnects) later", async () => {
    const { t, session } = await start();
    const first = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id);
    await first.next(isPlan);
    first.close();
    const second = openStream(t.server.port, t.cookie, [session.id]);
    const snapshot = await second.next((e) => e.frame.t === "snapshot");
    const pending = (snapshot.frame as { pending: { interactions: PendingInteraction[] } }).pending
      .interactions;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request).toMatchObject({ kind: "questions", plan: { revision: 1 } });
    second.close();
  });

  it("approve: switches to build and starts exactly one implementation run (double click included)", async () => {
    const { t, session, provider } = await start();
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id);
    const frame = await stream.next(isPlan);
    const id = (frame.frame as { interaction: PendingInteraction }).interaction.interactionId;
    const [a, b] = await Promise.all([
      t.api.post(`/api/interactions/${id}`, { answer: { plan: "approve" } }),
      t.api.post(`/api/interactions/${id}`, { answer: { plan: "approve" } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const again = await t.api.post(`/api/interactions/${id}`, { answer: { plan: "approve" } });
    expect(again.status).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "approval_resolved" } });

    // The plan run ends, then ONE implementation run writes the file as the build agent.
    await until(
      async () =>
        (await runs(session.id)).length === 2 &&
        (await runs(session.id)).every((r) => r.status === "completed"),
    );
    expect(await readFile(join(t.workspace, "out.txt"), "utf8")).toBe("built\n");
    const detail = (await t.api.get(`/api/sessions/${session.id}`)).json<{
      agent?: string;
      preset: string;
    }>();
    expect(detail).toMatchObject({ agent: "build", preset: "workspace-write" });
    expect(await runs(session.id)).toHaveLength(2);
    expect(
      provider.calls.filter((c) => c.tools.some((tool) => tool.name === "exit_plan")),
    ).toHaveLength(2);
    // The build run never saw exit_plan.
    const buildCalls = provider.calls.filter(
      (c) => !c.tools.some((tool) => tool.name === "exit_plan"),
    );
    expect(buildCalls.length).toBeGreaterThan(0);

    const messages = (await t.api.get(`/api/sessions/${session.id}/messages?limit=100`))
      .json<{
        items: Array<{ message: Message }>;
      }>()
      .items.map((i) => i.message);
    const users = messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users[1]).toMatchObject({ display: "Implement the approved plan: Plan 1" });
    expect((users[1] as { text: string }).text).toContain("<approved_plan");
    expect((users[1] as { text: string }).text).toContain("1. Write out.txt.");
    // Every tool call has its result, in order: nothing dangles.
    const calls = messages.flatMap((m) => (m.role === "assistant" ? m.calls.map((c) => c.id) : []));
    expect(
      messages.filter((m) => m.role === "tool").map((m) => (m as { callId: string }).callId),
    ).toEqual(calls);
    expect(calls).toEqual(["exit-1", "write-1"]);
    // Events of the decision are durable.
    const events = (await t.api.get(`/api/sessions/${session.id}/events?after=0&limit=500`)).json<{
      items: RunEvent[];
    }>();
    expect(
      events.items
        .filter((e) => e.type === "plan_proposed" || e.type === "plan_decided")
        .map((e) => e.type),
    ).toEqual(["plan_proposed", "plan_decided"]);
    stream.close();
  });

  it.each([
    ["skip", { plan: "skip" }],
    ["a dismissed screen (null answer)", null],
  ])("%s: stays in plan and starts nothing", async (_name, answer) => {
    const { t, session } = await start();
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id);
    const frame = await stream.next(isPlan);
    const id = (frame.frame as { interaction: PendingInteraction }).interaction.interactionId;
    expect((await t.api.post(`/api/interactions/${id}`, { answer })).status).toBe(200);
    await settled(t, session.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await runs(session.id)).toHaveLength(1);
    expect((await t.api.get(`/api/sessions/${session.id}`)).json<{ agent?: string }>().agent).toBe(
      "plan",
    );
    const [result] = (await t.api.get(`/api/sessions/${session.id}/messages?limit=100`))
      .json<{ items: Array<{ message: Message }> }>()
      .items.map((i) => i.message)
      .filter((m) => m.role === "tool");
    expect(JSON.stringify(result)).toContain("skipped");
    stream.close();
  });

  it("add context: the text reaches the model and a second review (revision 2) follows", async () => {
    const { t, session, provider } = await start();
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id);
    const first = await stream.next(isPlan);
    const firstId = (first.frame as { interaction: PendingInteraction }).interaction.interactionId;
    const sent = await t.api.post(`/api/interactions/${firstId}`, {
      answer: { plan: "context", "plan:text": "Also verify the file" },
    });
    expect(sent.status).toBe(200);
    const second = await stream.next(
      (e) =>
        isPlan(e) &&
        (e.frame as { interaction: PendingInteraction }).interaction.interactionId !== firstId,
    );
    const review = (second.frame as { interaction: PendingInteraction }).interaction.request;
    expect(review).toMatchObject({ kind: "questions", plan: { revision: 2, title: "Plan 2" } });
    const sawFeedback = provider.calls.some((c) =>
      c.messages.some(
        (m) =>
          m.role === "tool" &&
          m.result.content.some(
            (p) => p.type === "text" && p.text.includes("Also verify the file"),
          ),
      ),
    );
    expect(sawFeedback).toBe(true);
    // Both plans exist as artifacts, linked to the session.
    const list = (await t.api.get(`/api/sessions/${session.id}/artifacts`)).json<{
      items: Array<{ title: string }>;
    }>();
    expect(list.items.map((a) => a.title).sort()).toEqual(["Plan 1", "Plan 2 (revision 2)"]);
    // No implementation started: the user has not agreed yet.
    expect(await runs(session.id)).toHaveLength(1);
    stream.close();
  });

  it("validates answers: free text only where an option asks for it, bounded, strings only", async () => {
    const { t, session } = await start();
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id);
    const frame = await stream.next(isPlan);
    const id = (frame.frame as { interaction: PendingInteraction }).interaction.interactionId;
    for (const answer of [
      { plan: "approve", other: "x" },
      { "plan:text": 5 },
      { "plan:text": "x".repeat(20_001) },
      { plan: ["approve"], extra: true },
    ]) {
      const bad = await t.api.post(`/api/interactions/${id}`, { answer });
      expect(bad.status, JSON.stringify(answer).slice(0, 60)).toBe(400);
    }
    expect((await t.api.post(`/api/interactions/${id}`, { answer: { plan: "skip" } })).status).toBe(
      200,
    );
    stream.close();
  });

  it("cancelling the run withdraws the review and never starts an implementation", async () => {
    const { t, session } = await start();
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id);
    const frame = await stream.next(isPlan);
    const id = (frame.frame as { interaction: PendingInteraction }).interaction.interactionId;
    expect((await t.api.post(`/api/sessions/${session.id}/cancel`, {})).status).toBe(200);
    await stream.next(
      (e) =>
        e.frame.t === "interaction_withdrawn" &&
        (e.frame as { interactionId: string }).interactionId === id,
    );
    await settled(t, session.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await runs(session.id)).toHaveLength(1);
    // Answering a withdrawn review is a harmless conflict.
    expect(
      (await t.api.post(`/api/interactions/${id}`, { answer: { plan: "approve" } })).status,
    ).toBe(409);
    stream.close();
  });

  it("answers need the login cookie and a same-origin request, like every route", async () => {
    const { t, session } = await start();
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id);
    const frame = await stream.next(isPlan);
    const id = (frame.frame as { interaction: PendingInteraction }).interaction.interactionId;
    const path = `/api/interactions/${id}`;
    const body = { answer: { plan: "approve" } };
    const origin = `http://127.0.0.1:${t.server.port}`;
    expect(
      (
        await raw(t.server.port, path, {
          method: "POST",
          body,
          headers: { Origin: origin, "Content-Type": "application/json" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await raw(t.server.port, path, {
          method: "POST",
          body,
          headers: {
            Cookie: t.cookie,
            Origin: "http://evil.example",
            "Content-Type": "application/json",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await raw(t.server.port, path, {
          method: "POST",
          body,
          headers: { Cookie: t.cookie, "Content-Type": "application/json" },
        })
      ).status,
    ).toBe(403);
    // Nothing above changed the review: it can still be answered.
    expect((await t.api.post(path, { answer: { plan: "skip" } })).status).toBe(200);
    stream.close();
  });
});
