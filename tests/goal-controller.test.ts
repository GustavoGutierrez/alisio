/**
 * The goal controller over a real database and a fake clock: cumulative token accounting across
 * runs, the hard budget and the run's own cap, the turn and time caps, the breakers, the blocked
 * audit, errors, an idempotent continuation claim (a double trigger starts one run), the kickoff
 * once then hints, the restart pause and compare-and-set races between two surfaces.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GoalRunOutcome } from "../packages/core/src/goal/machine.ts";
import type { GoalHostView } from "../packages/core/src/goal/service.ts";
import { GoalService, type GoalSettings } from "../packages/core/src/goal/service.ts";
import { GoalStore } from "../packages/core/src/goal/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
const stores: SQLiteStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SETTINGS: GoalSettings = {
  enabled: true,
  maxTurns: 50,
  maxMinutes: 120,
  repeatedReplyLimit: 3,
  noToolTurnsLimit: 3,
  blockedRepeats: 2,
};
const idle: GoalHostView = { running: false, queuedInput: false, planMode: false, liveTasks: 0 };

async function fixture(settings: Partial<GoalSettings> = {}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-goal-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  stores.push(store);
  const session = store.create(root, "p", "m").id;
  const clock = { now: 1_000_000 };
  const changes: Array<string | undefined> = [];
  const logs: string[] = [];
  const config = { ...SETTINGS, ...settings };
  let ids = 0;
  const goals = new GoalService({
    store: new GoalStore(store.db),
    settings: () => config,
    now: () => clock.now,
    newId: () => `g${++ids}`,
    onChange: (_session, goal) => changes.push(goal?.status),
    onLog: (_session, log) => logs.push(log.event),
  });
  let runs = 0;
  /** Starts the continuation the core allows, then settles a run that behaved as `outcome` says. */
  const turn = (outcome: Partial<GoalRunOutcome> = {}, view: Partial<GoalHostView> = {}) => {
    const decision = goals.next(session, { ...idle, ...view });
    if (decision.kind !== "continue") return decision;
    clock.now += 5_000;
    goals.settle(session, {
      runId: `run-${++runs}`,
      status: "completed",
      usage: { input: 400, output: 100 },
      text: `progress ${runs}`,
      toolCalls: 2,
      startedAt: clock.now - 4_000,
      durationMs: 4_000,
      ...outcome,
    });
    return decision;
  };
  return { goals, store, session, clock, config, changes, logs, turn };
}

describe("creating and replacing a goal", () => {
  it("creates one goal per session and asks before replacing it", async () => {
    const { goals, session } = await fixture();
    const created = goals.create(session, { objective: "Ship it", tokenBudget: 50_000 });
    expect(created.ok && created.goal).toMatchObject({
      status: "active",
      reason: "created",
      tokenBudget: 50_000,
      maxTurns: 50,
      maxWallMs: 7_200_000,
      epoch: 1,
    });
    const second = goals.create(session, { objective: "Another" });
    expect(second).toMatchObject({ ok: false, code: "exists" });
    expect(goals.get(session)?.objective).toBe("Ship it");
    const replaced = goals.create(session, { objective: "Another", replace: true });
    expect(replaced.ok && replaced.goal).toMatchObject({
      objective: "Another",
      epoch: 2,
      tokensUsed: 0,
    });
  });

  it("refuses an empty or oversized objective and a disabled feature", async () => {
    const { goals, session } = await fixture();
    expect(goals.create(session, { objective: "  " })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(goals.create(session, { objective: "x".repeat(4001) })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    const off = await fixture({ enabled: false });
    expect(off.goals.create(off.session, { objective: "x" })).toMatchObject({
      ok: false,
      code: "disabled",
    });
  });

  it("snapshots the caps when the goal is created", async () => {
    const { goals, session, config } = await fixture();
    config.maxTurns = 3;
    goals.create(session, { objective: "x" });
    config.maxTurns = 99;
    expect(goals.get(session)?.maxTurns).toBe(3);
  });
});

describe("continuing: one claim, kickoff once, then hints", () => {
  it("sends the contract once, then a short hint, with an idempotent request id", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const first = f.turn();
    const second = f.turn();
    const third = f.turn();
    expect(first).toMatchObject({ kind: "continue", requestId: "goal-g1-1" });
    expect(first.kind === "continue" && first.prompt.kind).toBe("kickoff");
    expect(second.kind === "continue" && second.prompt.kind).toBe("hint");
    expect(third.kind === "continue" && third.requestId).toBe("goal-g1-3");
    expect(f.goals.get(f.session)).toMatchObject({
      continuations: 3,
      turnsUsed: 3,
      kickoffSent: true,
    });
  });

  it("starts ONE run for a double trigger", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const a = f.goals.next(f.session, idle);
    const b = f.goals.next(f.session, idle);
    expect(a.kind).toBe("continue");
    expect(b).toMatchObject({ kind: "wait", blocker: "busy" });
    expect(f.goals.get(f.session)?.continuations).toBe(1);
  });

  it("gives a failed start back, so the next trigger may retry the same turn", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const a = f.goals.next(f.session, idle);
    if (a.kind !== "continue") throw new Error("expected a continuation");
    f.goals.abandon(f.session, a.requestId, a.prompt.kind);
    const again = f.goals.next(f.session, idle);
    expect(again).toMatchObject({ kind: "continue", requestId: a.requestId });
    expect(again.kind === "continue" && again.prompt.kind).toBe("kickoff");
  });

  it("sends the audit reminder on the sixth turn and the contract again after an edit", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const kinds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = f.turn();
      if (d.kind === "continue") kinds.push(d.prompt.kind);
    }
    expect(kinds).toEqual(["kickoff", "hint", "hint", "hint", "hint", "reminder", "hint"]);
    f.goals.edit(f.session, "Ship it, then document it");
    const afterEdit = f.goals.next(f.session, idle);
    expect(afterEdit.kind === "continue" && afterEdit.prompt.kind).toBe("kickoff");
  });
});

describe("cumulative tokens and the hard budget", () => {
  it("adds the tokens of every run and caps each run at what is left", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it", tokenBudget: 2_000 });
    const first = f.turn({ usage: { input: 600, output: 200 } });
    expect(first.kind === "continue" && first.run.maxTokens).toBe(2_000);
    const second = f.turn({ usage: { input: 500, output: 100 } });
    // 800 used by the first run: the second run was capped at the 1 200 that were left.
    expect(second.kind === "continue" && second.run.maxTokens).toBe(1_200);
    expect(f.goals.get(f.session)).toMatchObject({ tokensUsed: 1_400, status: "active" });
    const third = f.goals.next(f.session, idle);
    expect(third.kind === "continue" && third.run.maxTokens).toBe(600);
  });

  it("never continues past the budget: the goal goes to budget_limited and stays there", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it", tokenBudget: 1_000 });
    f.turn({ usage: { input: 700, output: 400 } });
    expect(f.goals.get(f.session)).toMatchObject({
      status: "budget_limited",
      reason: "token_budget",
      tokensUsed: 1_100,
    });
    expect(f.goals.next(f.session, idle)).toEqual({ kind: "idle" });
    expect(f.goals.resume(f.session)).toMatchObject({ ok: false, code: "not_allowed" });
  });

  it("stops before a continuation when the budget was lowered meanwhile", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it", tokenBudget: 10_000 });
    f.turn({ usage: { input: 3_000, output: 1_000 } });
    // Lowering to what was already spent stops the goal at once.
    const lowered = f.goals.setBudget(f.session, 4_000);
    expect(lowered.ok && lowered.goal.status).toBe("budget_limited");
    expect(f.goals.next(f.session, idle).kind).toBe("idle");
  });

  it("re-arms when the budget is raised, and continues with the new remainder", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it", tokenBudget: 1_000 });
    f.turn({ usage: { input: 900, output: 300 } });
    expect(f.goals.get(f.session)?.status).toBe("budget_limited");
    const raised = f.goals.setBudget(f.session, 5_000);
    expect(raised.ok && raised.goal).toMatchObject({ status: "active", reason: "resumed" });
    const next = f.goals.next(f.session, idle);
    expect(next.kind === "continue" && next.run.maxTokens).toBe(3_800);
    const cleared = f.goals.setBudget(f.session, null);
    expect(cleared.ok && cleared.goal.tokenBudget).toBeUndefined();
  });

  it("works without a budget: no per-run token cap", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const d = f.turn();
    expect(d.kind === "continue" && d.run.maxTokens).toBeUndefined();
  });
});

describe("caps, breakers and errors", () => {
  it("pauses at the turn cap and resumes with one more allowance", async () => {
    const f = await fixture({ maxTurns: 3 });
    f.goals.create(f.session, { objective: "Ship it" });
    for (let i = 0; i < 3; i++) f.turn();
    expect(f.goals.get(f.session)).toMatchObject({
      status: "paused",
      reason: "max_turns",
      turnsUsed: 3,
    });
    expect(f.goals.next(f.session, idle).kind).toBe("idle");
    f.goals.resume(f.session);
    expect(f.goals.get(f.session)).toMatchObject({ status: "active", maxTurns: 6 });
    expect(f.turn().kind).toBe("continue");
  });

  it("pauses at the time cap and caps the run's own time", async () => {
    const f = await fixture({ maxMinutes: 1 });
    f.goals.create(f.session, { objective: "Ship it" });
    const first = f.turn({ durationMs: 40_000 });
    expect(first.kind === "continue" && first.run.remainingMs).toBe(60_000);
    const second = f.goals.next(f.session, idle);
    expect(second.kind === "continue" && second.run.remainingMs).toBe(20_000);
  });

  it("observes, nudges, then pauses an identical reply", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const prompts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = f.turn({ text: "I am still working on it" });
      if (d.kind === "continue")
        prompts.push(d.prompt.text.includes("nearly identical") ? "nudge" : "plain");
    }
    expect(prompts).toEqual(["plain", "plain", "plain", "nudge"]);
    expect(f.goals.get(f.session)).toMatchObject({
      status: "paused",
      reason: "no_progress",
      detail: "repeated_reply",
    });
    expect(f.logs).toContain("repeat_observed");
  });

  it("pauses after turns without tool calls", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    for (let i = 0; i < 3; i++) f.turn({ toolCalls: 0, text: `thought ${i}` });
    expect(f.goals.get(f.session)).toMatchObject({
      status: "paused",
      reason: "no_progress",
      detail: "no_tool_turns",
    });
    expect(f.logs).toContain("no_tool_turn");
  });

  it("blocks with the error as the reason, but a provider timeout only counts as a turn", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    f.turn({ status: "failed", error: "timed out", timedOut: true, toolCalls: 0 });
    expect(f.goals.get(f.session)?.status).toBe("active");
    f.turn({ status: "failed", error: "400 context length exceeded" });
    expect(f.goals.get(f.session)).toMatchObject({
      status: "blocked",
      reason: "run_error",
      detail: "400 context length exceeded",
    });
    expect(f.goals.next(f.session, idle).kind).toBe("idle");
  });

  it("pauses when the user interrupts the run", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    f.turn({ status: "cancelled" });
    expect(f.goals.get(f.session)).toMatchObject({ status: "paused", reason: "user_interrupt" });
  });
});

describe("what the model can do (update_goal) and cannot", () => {
  const evidence = [{ kind: "test" as const, detail: "pnpm test: 12 passed" }];

  it("completes with evidence, only while active", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    expect(
      f.goals.report(f.session, "r1", { status: "complete", summary: "done", evidence: [] }),
    ).toMatchObject({
      ok: false,
    });
    const done = f.goals.report(f.session, "r1", { status: "complete", summary: "done", evidence });
    expect(done).toMatchObject({ ok: true, stopped: true });
    expect(f.goals.get(f.session)).toMatchObject({ status: "complete", reason: "model_complete" });
    expect(
      f.goals.report(f.session, "r2", { status: "complete", summary: "again", evidence }),
    ).toMatchObject({
      ok: false,
    });
  });

  it("cannot complete a goal the user paused", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    f.goals.pause(f.session);
    expect(
      f.goals.report(f.session, "r1", { status: "complete", summary: "done", evidence }),
    ).toMatchObject({
      ok: false,
    });
    expect(f.goals.get(f.session)?.status).toBe("paused");
  });

  it("the blocked audit: the same blocker in consecutive turns, evidence each time", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const log = [{ kind: "log" as const, detail: "ECONNREFUSED 5432" }];
    // Turn 1: the model reports, the goal stays active and the next prompt asks for confirmation.
    f.goals.next(f.session, idle);
    expect(
      f.goals.report(f.session, "run-1", { status: "blocked", summary: "no db", evidence: log }),
    ).toMatchObject({
      ok: true,
      stopped: false,
    });
    f.goals.settle(f.session, {
      runId: "run-1",
      status: "completed",
      usage: { input: 1, output: 1 },
      text: "blocked?",
      toolCalls: 1,
      startedAt: f.clock.now,
      durationMs: 1,
    });
    const second = f.goals.next(f.session, idle);
    expect(second.kind === "continue" && second.prompt.text).toContain("report it again");
    // Turn 2: reported again, so it stops.
    expect(
      f.goals.report(f.session, "run-2", { status: "blocked", summary: "no db", evidence: log }),
    ).toMatchObject({
      ok: true,
      stopped: true,
    });
    expect(f.goals.get(f.session)).toMatchObject({ status: "blocked", reason: "model_blocked" });
  });

  it("a turn that does not repeat the blocker clears it", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const log = [{ kind: "log" as const, detail: "flaky" }];
    f.goals.next(f.session, idle);
    f.goals.report(f.session, "run-1", { status: "blocked", summary: "flaky", evidence: log });
    f.goals.settle(f.session, {
      runId: "run-1",
      status: "completed",
      usage: { input: 1, output: 1 },
      text: "a",
      toolCalls: 1,
      startedAt: f.clock.now,
      durationMs: 1,
    });
    f.goals.next(f.session, idle);
    f.goals.settle(f.session, {
      runId: "run-2",
      status: "completed",
      usage: { input: 1, output: 1 },
      text: "b",
      toolCalls: 1,
      startedAt: f.clock.now,
      durationMs: 1,
    });
    expect(f.goals.get(f.session)?.blockedStreak).toBe(0);
  });

  it("a permission denial blocks at once", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const denied = [{ kind: "denied" as const, detail: "write to /etc denied by policy" }];
    f.goals.report(f.session, "run-1", { status: "blocked", summary: "denied", evidence: denied });
    expect(f.goals.get(f.session)).toMatchObject({ status: "blocked", reason: "policy_denied" });
  });
});

describe("waiting: the one ordered list of blockers, and resuming when the cause is gone", () => {
  it.each([
    ["a pending approval", { awaiting: "approval" as const }, "approval"],
    ["a pending question", { awaiting: "question" as const }, "question"],
    ["plan mode", { planMode: true }, "plan_mode"],
    ["background tasks", { liveTasks: 2 }, "background_tasks"],
    ["queued input", { queuedInput: true }, "user_input"],
  ])("waits for %s and starts nothing", async (_name, view, waiting) => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const decision = f.goals.next(f.session, { ...idle, ...view });
    expect(decision).toMatchObject({ kind: "wait", waiting });
    expect(f.goals.get(f.session)).toMatchObject({ continuations: 0, status: "active" });
  });

  it("continues as soon as the last background task is gone", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    expect(f.goals.next(f.session, { ...idle, liveTasks: 1 }).kind).toBe("wait");
    expect(f.goals.next(f.session, { ...idle, liveTasks: 0 }).kind).toBe("continue");
  });

  it("does nothing for a paused goal or a session without one", async () => {
    const f = await fixture();
    expect(f.goals.next(f.session, idle)).toEqual({ kind: "idle" });
    f.goals.create(f.session, { objective: "Ship it" });
    f.goals.pause(f.session);
    expect(f.goals.next(f.session, idle)).toEqual({ kind: "idle" });
  });

  it("stops continuing when goals are turned off", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    f.config.enabled = false;
    expect(f.goals.next(f.session, idle)).toMatchObject({ kind: "wait", blocker: "disabled" });
  });
});

describe("two surfaces cannot fight (compare-and-set)", () => {
  it("rejects an action based on a stale epoch or on a replaced goal", async () => {
    const f = await fixture();
    const created = f.goals.create(f.session, { objective: "Ship it" });
    if (!created.ok) throw new Error("create failed");
    const seen = { goalId: created.goal.goalId, epoch: created.goal.epoch };
    // Window A pauses.
    expect(f.goals.pause(f.session, seen).ok).toBe(true);
    // Window B, still looking at the old epoch, tries to edit and to resume.
    expect(f.goals.edit(f.session, "B's text", seen)).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(f.goals.resume(f.session, seen)).toMatchObject({ ok: false, code: "conflict" });
    expect(f.goals.get(f.session)?.objective).toBe("Ship it");
    // With what it re-read, B succeeds.
    const fresh = f.goals.get(f.session);
    expect(f.goals.resume(f.session, { goalId: fresh?.goalId, epoch: fresh?.epoch }).ok).toBe(true);
    // A goal that was replaced is a conflict for the old id even when the epoch matches.
    const replaced = f.goals.create(f.session, { objective: "New", replace: true });
    if (!replaced.ok) throw new Error("replace failed");
    expect(
      f.goals.clear(f.session, { goalId: created.goal.goalId, epoch: replaced.goal.epoch }),
    ).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(f.goals.get(f.session)?.objective).toBe("New");
  });

  it("running totals do not invalidate what a window saw", async () => {
    const f = await fixture();
    const created = f.goals.create(f.session, { objective: "Ship it" });
    if (!created.ok) throw new Error("create failed");
    f.turn();
    expect(f.goals.get(f.session)?.epoch).toBe(created.goal.epoch);
    expect(f.goals.pause(f.session, { epoch: created.goal.epoch }).ok).toBe(true);
  });

  it("two services over one database see each other's changes", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const other = new GoalService({ store: new GoalStore(f.store.db), settings: () => SETTINGS });
    expect(other.pause(f.session).ok).toBe(true);
    expect(f.goals.get(f.session)?.status).toBe("paused");
    expect(f.goals.pause(f.session)).toMatchObject({ ok: false, code: "not_allowed" });
  });
});

describe("restart and clearing", () => {
  it("pauses an active goal whose driver process is gone, and leaves live drivers alone", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    const store = new GoalStore(f.store.db);
    // This process drives it: not touched (another application in the same process).
    expect(store.pauseOrphans(1, () => false)).toEqual([]);
    // Another, dead process drove it: paused with reason restart.
    f.store.db
      .prepare("UPDATE session_goals SET owner_pid=? WHERE session=?")
      .run(2_147_483_000, f.session);
    expect(store.pauseOrphans(2, () => true)).toEqual([]);
    const paused = store.pauseOrphans(3, () => false);
    expect(paused.map((goal) => [goal.status, goal.reason])).toEqual([["paused", "restart"]]);
    // Never auto-resumed.
    expect(f.goals.next(f.session, idle)).toEqual({ kind: "idle" });
    expect(f.goals.resume(f.session).ok).toBe(true);
  });

  it("a goal with an unknown driver is paused too", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    f.store.db.prepare("UPDATE session_goals SET owner_pid=NULL WHERE session=?").run(f.session);
    expect(new GoalStore(f.store.db).pauseOrphans(2, () => true)).toHaveLength(1);
  });

  it("clear removes the goal and notifies", async () => {
    const f = await fixture();
    f.goals.create(f.session, { objective: "Ship it" });
    expect(f.goals.clear(f.session).ok).toBe(true);
    expect(f.goals.get(f.session)).toBeUndefined();
    expect(f.changes.at(-1)).toBeUndefined();
    expect(f.goals.clear(f.session)).toMatchObject({ ok: false, code: "not_found" });
  });
});
