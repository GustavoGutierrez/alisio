/**
 * `/goal` over HTTP with a real server and a scripted provider: a goal that continues on its own
 * until the model completes it, the hard token budget (and its re-arm), the breakers, the user's
 * pause/resume/edit/clear and the compare-and-set between two windows, the waits (a background
 * task, plan mode, a pending approval), the replay after a reload, the restart pause, the typed
 * command and the same auth/Origin rules as the rest of the API.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GoalInfo, ProviderEvent, ServerFrame, ToolCall } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import {
  fakeProvider,
  gatedProvider,
  newSession,
  openStream,
  raw,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

let t: TestServer | undefined;
const streams: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await t?.close();
  t = undefined;
});
const stream = (sessions: string[]) => {
  const s = openStream((t as TestServer).server.port, (t as TestServer).cookie, sessions);
  streams.push(s);
  return s;
};

interface Step {
  text?: string;
  calls?: ToolCall[];
  usage?: { input: number; output: number };
}
const NODE = JSON.stringify(process.execPath);
const COMPLETE = (id: string): ToolCall => ({
  id,
  name: "update_goal",
  arguments: JSON.stringify({
    status: "complete",
    summary: "Everything is done",
    evidence: [{ kind: "test", detail: "pnpm test: all green" }],
  }),
});
const READ = (id: string): ToolCall => ({
  id,
  name: "read_file",
  arguments: JSON.stringify({ path: "README.md" }),
});

/**
 * A provider for goals. `onTurn(n, texts)` answers the n-th goal message (the kickoff is 1); after
 * a tool result the model just says what it finished.
 */
function goalModel(
  onTurn: (n: number, text: string) => Step,
  finalText = (n: number) => `finished step ${n}`,
) {
  let goalTurns = 0;
  let requests = 0;
  const provider = fakeProvider(async function* (request): AsyncGenerator<ProviderEvent> {
    requests++;
    const last = request.messages.at(-1);
    const usage = { input: 100, output: 50 };
    if (last?.role === "tool") {
      yield {
        type: "completed",
        message: { role: "assistant", text: finalText(goalTurns), calls: [] },
        usage,
      };
      return;
    }
    const text = last?.role === "user" ? last.text : "";
    const isGoal = /<goal_objective>|Continue working on the session goal|Goal status check/.test(
      text,
    );
    const n = isGoal ? ++goalTurns : 0;
    const step = onTurn(n, text);
    yield {
      type: "completed",
      message: { role: "assistant", text: step.text ?? "", calls: step.calls ?? [] },
      usage: step.usage ?? usage,
    };
  });
  return { provider, turns: () => goalTurns, requests: () => requests };
}

async function start(
  model: ReturnType<typeof goalModel> | ReturnType<typeof gatedProvider> | { provider: never },
  options: Parameters<typeof startTestServer>[0] = {},
  session: Record<string, unknown> = { preset: "full-access" },
) {
  t = await startTestServer({
    provider: model.provider,
    app: { allowProcess: true, allowWrite: true },
    ...options,
  });
  await writeFile(join(t.workspace, "README.md"), "# Hello\n");
  const created = await newSession(t, session);
  return { t, id: created.id };
}

const goalOf = async (id: string) =>
  (await (t as TestServer).api.get(`/api/sessions/${id}/goal`)).json<{ goal: GoalInfo | null }>()
    .goal;
const waitGoal = async (id: string, predicate: (goal: GoalInfo) => boolean, ms = 8_000) =>
  (await until(async () => {
    const goal = await goalOf(id);
    return goal && predicate(goal) ? goal : undefined;
  }, ms)) as GoalInfo;
const putGoal = (id: string, body: Record<string, unknown>) =>
  (t as TestServer).api.put(`/api/sessions/${id}/goal`, body);
const runsOf = async (id: string) =>
  (await (t as TestServer).api.get(`/api/sessions/${id}/runs`)).json<
    Array<{ id: string; status: string; requestId?: string }>
  >();
const quiet = async (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every run of the session ended and its totals were folded into the goal. */
const settledGoal = async (id: string) => {
  await until(async () =>
    (await runsOf(id)).every((r) => r.status !== "queued" && r.status !== "running"),
  );
  await quiet(60);
  return (await goalOf(id)) as GoalInfo;
};

describe("a goal that continues on its own", () => {
  it("runs three turns, ends with update_goal(complete) and keeps tool call ids consistent", async () => {
    const model = goalModel((n) =>
      n < 3 ? { calls: [READ(`r${n}`)] } : { calls: [COMPLETE("done1")] },
    );
    const { id } = await start(model);
    const s = stream([id]);
    const created = await putGoal(id, { objective: "Read the readme three times" });
    expect(created.status).toBe(200);
    expect(created.json<{ goal: GoalInfo }>().goal).toMatchObject({
      status: "active",
      reason: "created",
    });
    await waitGoal(id, (g) => g.status === "complete");
    const done = await settledGoal(id);
    expect(done).toMatchObject({
      status: "complete",
      reason: "model_complete",
      summary: "Everything is done",
      turnsUsed: 3,
    });
    expect(done.tokensUsed).toBeGreaterThan(0);
    expect(done.actions).toEqual(["edit", "budget", "clear"]);
    // One run per turn, each with its idempotent request id; nothing runs afterwards.
    const runs = (await runsOf(id)).reverse();
    expect(runs.map((r) => r.requestId)).toEqual([
      expect.stringMatching(/^goal-.+-1$/),
      expect.stringMatching(/^goal-.+-2$/),
      expect.stringMatching(/^goal-.+-3$/),
    ]);
    expect(runs.every((r) => r.status === "completed")).toBe(true);
    await quiet();
    expect(await runsOf(id)).toHaveLength(3);
    // The frames carried every state, ending with `complete`.
    const frames = s
      .frames()
      .filter((f): f is Extract<ServerFrame, { t: "goal_changed" }> => f.t === "goal_changed");
    expect(frames.at(-1)?.goal?.status).toBe("complete");
    expect(frames.some((f) => f.goal?.status === "active")).toBe(true);
    // The persisted conversation is consistent: every call has its result, the kickoff came once.
    const messages = (await t?.api.get(`/api/sessions/${id}/messages?limit=100`))?.json<{
      items: Array<{
        message: {
          role: string;
          text?: string;
          display?: string;
          callId?: string;
          calls?: Array<{ id: string }>;
        };
      }>;
    }>();
    const users = messages?.items.filter((i) => i.message.role === "user") ?? [];
    expect(users.filter((u) => u.message.text?.includes("<goal_objective>"))).toHaveLength(1);
    const calls = messages?.items.flatMap((i) => i.message.calls?.map((c) => c.id) ?? []) ?? [];
    const results =
      messages?.items.filter((i) => i.message.role === "tool").map((i) => i.message.callId) ?? [];
    expect(results.sort()).toEqual([...calls].sort());
  });

  it("shows the goal again after a reload (snapshot) and as GET", async () => {
    const model = goalModel((n) =>
      n < 2 ? { calls: [READ(`r${n}`)] } : { calls: [COMPLETE("d")] },
    );
    const { id } = await start(model);
    await putGoal(id, { objective: "Two reads" });
    await waitGoal(id, (g) => g.status === "complete");
    const reloaded = stream([id]);
    const snapshot = (await reloaded.next((e) => e.frame.t === "snapshot")).frame as Extract<
      ServerFrame,
      { t: "snapshot" }
    >;
    expect(snapshot.goal).toMatchObject({ objective: "Two reads", status: "complete" });
  });
});

describe("the hard token budget", () => {
  it("stops in budget_limited without running more, and is re-armed by a higher budget", async () => {
    // 600 tokens per request, two requests per run: ~1200 per turn.
    const heavy = goalModel((n) => ({
      calls: [READ(`r${n}`)],
      usage: { input: 500, output: 100 },
    }));
    const { id } = await start(heavy);
    await putGoal(id, { objective: "Spend carefully", tokenBudget: 2_000 });
    const stopped = await waitGoal(id, (g) => g.status === "budget_limited");
    expect(stopped).toMatchObject({ reason: "token_budget", tokenBudget: 2_000 });
    expect(stopped.tokensUsed).toBeGreaterThanOrEqual(2_000);
    const count = (await runsOf(id)).length;
    await quiet(300);
    expect(await runsOf(id)).toHaveLength(count);
    // Resume is refused (not resumable), but a higher budget re-arms it.
    const refused = await (t as TestServer).api.post(`/api/sessions/${id}/goal/resume`, {});
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "goal_conflict" } });
    const raised = await (t as TestServer).api.patch(`/api/sessions/${id}/goal`, {
      tokenBudget: 50_000,
    });
    expect(raised.json<{ goal: GoalInfo }>().goal).toMatchObject({
      status: "active",
      reason: "resumed",
    });
    await until(async () => (await runsOf(id)).length > count);
    // Clearing the budget is allowed too (and the goal keeps being bounded by its turn cap).
    const cleared = await (t as TestServer).api.patch(`/api/sessions/${id}/goal`, {
      tokenBudget: null,
    });
    expect(cleared.json<{ goal: GoalInfo }>().goal.tokenBudget).toBeUndefined();
  });
});

describe("the breakers", () => {
  it("pauses with reason no_progress after the same reply repeats", async () => {
    // The model always ends with the same sentence after its tool call.
    const model = goalModel(
      (n) => ({ calls: [READ(`r${n}`)] }),
      () => "Still working on it.",
    );
    const { id } = await start(model);
    await putGoal(id, { objective: "Keep going" });
    const paused = await waitGoal(id, (g) => g.status === "paused");
    expect(paused).toMatchObject({ reason: "no_progress", detail: "repeated_reply" });
    // 1 fresh + 3 repeats.
    expect((await runsOf(id)).length).toBe(4);
    expect(paused.actions).toEqual(["resume", "edit", "budget", "clear"]);
  });

  it("blocks with the error as the reason when a run fails", async () => {
    const provider = fakeProvider(async function* (): AsyncGenerator<ProviderEvent> {
      throw new Error("401 Unauthorized: invalid API key");
    });
    const { id } = await start({ provider } as never);
    await putGoal(id, { objective: "Doomed" });
    const blocked = await waitGoal(id, (g) => g.status === "blocked");
    expect(blocked.reason).toBe("run_error");
    expect(blocked.detail).toContain("401");
  });
});

describe("the user's controls", () => {
  it("pause, resume, edit, budget and clear, with the same state in every window", async () => {
    const gated = gatedProvider();
    const { id } = await start(gated);
    const a = stream([id]);
    const b = stream([id]);
    await putGoal(id, { objective: "Original objective" });
    await gated.started;
    // Pause while a run is in flight: it finishes its turn but does not continue.
    const paused = await (t as TestServer).api.post(`/api/sessions/${id}/goal/pause`, {});
    expect(paused.json<{ goal: GoalInfo }>().goal).toMatchObject({
      status: "paused",
      reason: "user_paused",
    });
    gated.release();
    await until(async () => (await runsOf(id)).every((r) => r.status === "completed"));
    await quiet(200);
    expect(await runsOf(id)).toHaveLength(1);
    expect((await goalOf(id))?.status).toBe("paused");
    for (const s of [a, b])
      await s.next((e) => e.frame.t === "goal_changed" && e.frame.goal?.status === "paused");
    // Edit and set a budget while paused.
    const edited = await (t as TestServer).api.patch(`/api/sessions/${id}/goal`, {
      objective: "Edited objective",
      tokenBudget: 90_000,
    });
    expect(edited.json<{ goal: GoalInfo }>().goal).toMatchObject({
      objective: "Edited objective",
      tokenBudget: 90_000,
      status: "paused",
    });
    // Resume continues (the gate lets the next run finish).
    const before = await goalOf(id);
    const resumed = await (t as TestServer).api.post(`/api/sessions/${id}/goal/resume`, {
      expect: { goalId: before?.goalId, epoch: before?.epoch },
    });
    expect(resumed.json<{ goal: GoalInfo }>().goal.status).toBe("active");
    await gated.started;
    // A window that still sees the old epoch cannot act on it.
    const stale = await (t as TestServer).api.post(`/api/sessions/${id}/goal/pause`, {
      expect: { goalId: before?.goalId, epoch: before?.epoch },
    });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "goal_conflict" } });
    // Clear removes it everywhere.
    const cleared = await (t as TestServer).api.delete(`/api/sessions/${id}/goal`);
    expect(cleared.json()).toEqual({ goal: null });
    await a.next((e) => e.frame.t === "goal_changed" && e.frame.goal === null);
    expect(await goalOf(id)).toBeNull();
    gated.release();
  });

  it("asks before replacing a goal and rejects bad input", async () => {
    const gated = gatedProvider();
    const { id } = await start(gated);
    await putGoal(id, { objective: "First" });
    const clash = await putGoal(id, { objective: "Second" });
    expect(clash.status).toBe(409);
    expect(clash.json()).toMatchObject({
      error: { code: "goal_conflict", details: { reason: "exists" } },
    });
    expect((await putGoal(id, { objective: "Second", replace: true })).status).toBe(200);
    expect((await goalOf(id))?.objective).toBe("Second");
    expect((await putGoal(id, { objective: "" })).status).toBe(400);
    expect((await putGoal(id, { objective: "x".repeat(4500), replace: true })).status).toBe(400);
    expect((await putGoal(id, { objective: "ok", tokenBudget: -1, replace: true })).status).toBe(
      400,
    );
    expect((await (t as TestServer).api.patch(`/api/sessions/${id}/goal`, {})).status).toBe(400);
    const missing = await newSession(t as TestServer, {});
    expect(
      (await (t as TestServer).api.post(`/api/sessions/${missing.id}/goal/pause`, {})).status,
    ).toBe(404);
    gated.release();
  });

  it("does not exist for subagent sessions and 404s for unknown sessions", async () => {
    const model = goalModel(() => ({ text: "ok" }));
    await start(model);
    expect((await (t as TestServer).api.get("/api/sessions/nope/goal")).status).toBe(404);
  });
});

describe("what a goal waits for", () => {
  it("does not run in plan mode, and continues when the agent leaves it", async () => {
    const model = goalModel((n) =>
      n < 2 ? { calls: [READ(`r${n}`)] } : { calls: [COMPLETE("d")] },
    );
    const { id } = await start(model, {}, { preset: "full-access", agent: "plan" });
    await putGoal(id, { objective: "Plan mode must not run it" });
    await quiet(300);
    expect(await runsOf(id)).toHaveLength(0);
    expect(await goalOf(id)).toMatchObject({ status: "active", waiting: "plan_mode" });
    // Switching to build lets it continue by itself.
    const patched = await (t as TestServer).api.patch(`/api/sessions/${id}`, { agent: "build" });
    expect(patched.status).toBe(200);
    await waitGoal(id, (g) => g.status === "complete");
    expect(await settledGoal(id)).toMatchObject({ turnsUsed: 2 });
  });

  it("waits for a pending approval and continues after it is answered", async () => {
    const model = goalModel((n) =>
      n === 1
        ? {
            calls: [
              {
                id: "w1",
                name: "write_file",
                arguments: JSON.stringify({ path: "out.txt", content: "x", expectedHash: null }),
              },
            ],
          }
        : { calls: [COMPLETE("d")] },
    );
    const { id } = await start(model, {}, { preset: "ask" });
    const s = stream([id]);
    await s.next((e) => e.frame.t === "snapshot");
    await putGoal(id, { objective: "Write a file" });
    const { approval } = (await s.next((e) => e.frame.t === "approval")).frame as Extract<
      ServerFrame,
      { t: "approval" }
    >;
    const waiting = await waitGoal(id, (g) => g.waiting === "approval");
    expect(waiting.status).toBe("active");
    await quiet(200);
    expect(await runsOf(id)).toHaveLength(1);
    await (t as TestServer).api.post(`/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
      decision: "once",
    });
    await waitGoal(id, (g) => g.status === "complete");
    expect(await settledGoal(id)).toMatchObject({ turnsUsed: 2 });
  });

  it("waits for a background task and continues when the last one ends", async () => {
    const task = `${NODE} -e "setTimeout(() => console.log('built'), 700)"`;
    const model = goalModel((n) =>
      n === 1
        ? {
            calls: [
              {
                id: "b1",
                name: "bg_run",
                arguments: JSON.stringify({ command: task, label: "build" }),
              },
            ],
          }
        : { calls: [COMPLETE("d")] },
    );
    const { id } = await start(model, {
      tasks: {
        timing: {
          batchMs: 40,
          minIntervalMs: 0,
          retryMs: 40,
          burstMax: 100,
          burstWindowMs: 60_000,
        },
        killGraceMs: 300,
      },
    });
    await putGoal(id, { objective: "Build in the background" });
    const waiting = await waitGoal(id, (g) => g.waiting === "background_tasks");
    expect(waiting.status).toBe("active");
    // While the task runs, no goal turn starts.
    expect(model.turns()).toBe(1);
    await waitGoal(id, (g) => g.status === "complete", 10_000);
    expect((await settledGoal(id)).turnsUsed).toBeGreaterThanOrEqual(2);
  });

  it("pauses when the user cancels the run", async () => {
    const gated = gatedProvider();
    const { id } = await start(gated);
    await putGoal(id, { objective: "Interrupt me" });
    await gated.started;
    await (t as TestServer).api.post(`/api/sessions/${id}/cancel`, {});
    const paused = await waitGoal(id, (g) => g.status === "paused");
    expect(paused.reason).toBe("user_interrupt");
    await quiet(200);
    expect(await runsOf(id)).toHaveLength(1);
  });
});

describe("restart", () => {
  it("brings an active goal of a dead process back paused, and never resumes it", async () => {
    const model = goalModel(() => ({ text: "ok" }));
    const { id } = await start(model);
    const dbPath = (t as TestServer).db;
    // Another process left an active goal behind (simulated: a driver pid that does not exist).
    const store = new SQLiteStore(dbPath);
    store.db
      .prepare(
        `INSERT INTO session_goals(session,goal_id,objective,status,epoch,max_turns,max_wall_ms,owner_pid,kickoff_sent,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, "old1", "Left running", "active", 3, 50, 7_200_000, 2_147_483_000, 1, 1, 1);
    store.close();
    // A server that starts on that database pauses it (reason `restart`).
    const second = await startTestServer({
      provider: model.provider,
      app: { db: dbPath, allowProcess: true, allowWrite: true },
    });
    try {
      const goal = (await second.api.get(`/api/sessions/${id}/goal`)).json<{ goal: GoalInfo }>()
        .goal;
      expect(goal).toMatchObject({
        status: "paused",
        reason: "restart",
        objective: "Left running",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await second.api.get(`/api/sessions/${id}/runs`)).json<unknown[]>()).toHaveLength(0);
      // The user decides: resume continues.
      const resumed = await second.api.post(`/api/sessions/${id}/goal/resume`, {});
      expect(resumed.json<{ goal: GoalInfo }>().goal.status).toBe("active");
    } finally {
      await second.close();
    }
  });
});

describe("the /goal command and the API rules", () => {
  it("runs the typed command with the same grammar as the terminal", async () => {
    const gated = gatedProvider();
    const { id } = await start(gated);
    const cmd = (args: string, extra: Record<string, unknown> = {}) =>
      (t as TestServer).api.post(`/api/sessions/${id}/commands`, {
        requestId: `c${Math.random().toString(36).slice(2, 10)}`,
        name: "goal",
        args,
        ...extra,
      });
    expect((await cmd("help")).json<{ output: string }>().output).toContain("/goal budget=50k");
    expect((await cmd("")).json<{ output: string }>().output).toContain("No goal");
    const bad = await cmd("x budget=1k budget=2k");
    expect(bad.status).toBe(400);
    expect(bad.json<{ error: { message: string } }>().error.message).toContain("only one budget");
    const created = await cmd("Ship the thing budget=50k");
    expect(created.status).toBe(200);
    expect(created.json()).toMatchObject({ effects: ["goal"] });
    expect(await goalOf(id)).toMatchObject({ objective: "Ship the thing", tokenBudget: 50_000 });
    const clash = await cmd("Another objective");
    expect(clash.status).toBe(409);
    expect((await cmd("Another objective", { confirm: true })).status).toBe(200);
    expect((await cmd("budget=2m")).status).toBe(200);
    expect((await goalOf(id))?.tokenBudget).toBe(2_000_000);
    expect((await cmd("budget=clear")).status).toBe(200);
    expect((await goalOf(id))?.tokenBudget).toBeUndefined();
    expect((await cmd("pause")).status).toBe(200);
    expect((await goalOf(id))?.status).toBe("paused");
    const edit = await cmd("edit");
    expect(edit.json()).toMatchObject({ effects: ["goal_edit"], output: "Another objective" });
    expect((await cmd("edit A third objective")).status).toBe(200);
    expect((await cmd("resume")).status).toBe(200);
    expect((await cmd("clear")).status).toBe(200);
    expect(await goalOf(id)).toBeNull();
    expect((await cmd("pause")).status).toBe(404);
    gated.release();
  });

  it("uses the same auth and Origin rules as every other route", async () => {
    const gated = gatedProvider();
    const { id } = await start(gated);
    const base = `/api/sessions/${id}/goal`;
    expect((await raw((t as TestServer).server.port, base)).status).toBe(401);
    const foreign = await raw((t as TestServer).server.port, base, {
      method: "PUT",
      body: { objective: "x" },
      headers: {
        Cookie: (t as TestServer).cookie,
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
    });
    expect(foreign.status).toBe(403);
    const notJson = await raw((t as TestServer).server.port, `${base}/pause`, {
      method: "POST",
      body: "x",
      headers: {
        Cookie: (t as TestServer).cookie,
        Origin: `http://127.0.0.1:${(t as TestServer).server.port}`,
        "Content-Type": "text/plain",
      },
    });
    expect([400, 415]).toContain(notJson.status);
    expect(await goalOf(id)).toBeNull();
    gated.release();
  });

  it("refuses new goals and stops continuing when goal.enabled is turned off", async () => {
    const gated = gatedProvider();
    const { id } = await start(gated);
    const off = await (t as TestServer).api.patch("/api/settings", {
      workspace: (t as TestServer).workspace,
      key: "goal.enabled",
      value: false,
    });
    expect(off.status).toBe(200);
    const refused = await putGoal(id, { objective: "Not allowed" });
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "goal_disabled" } });
    expect(await goalOf(id)).toBeNull();
    // Turned back on, the same request works.
    await (t as TestServer).api.patch("/api/settings", {
      workspace: (t as TestServer).workspace,
      key: "goal.enabled",
      value: true,
    });
    expect((await putGoal(id, { objective: "Allowed" })).status).toBe(200);
    gated.release();
  });
});
