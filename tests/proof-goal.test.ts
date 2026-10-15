/**
 * Proof phase 4, goal side (specs/011 3.6, O2, O6, D1, D2, D7): `update_goal complete` is judged
 * against the Proof ledger; only the USER can override the gate; a declaration without a
 * resolvable `evidenceId` is free text and never backs a status. Real SQLite, no provider.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalEvidence, ProofVerifierSpec } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { GoalService, type GoalSettings } from "../packages/core/src/goal/service.ts";
import { GoalStore } from "../packages/core/src/goal/store.ts";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { registerGoalTools } from "../packages/core/src/tools/goal.ts";

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
const COMMAND: ProofVerifierSpec = { kind: "command", command: "pnpm test" };

async function fixture(options: { withProof?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-proof-goal-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  stores.push(store);
  const session = store.create(root, "p", "m").id;
  const other = store.create(root, "p", "m").id;
  const proof = new ProofStore(store.db);
  const clock = { now: 1_000_000 };
  let ids = 0;
  const goals = new GoalService({
    store: new GoalStore(store.db),
    settings: () => SETTINGS,
    now: () => clock.now,
    newId: () => `g${++ids}`,
    ...(options.withProof === false ? {} : { proof }),
  });
  const created = goals.create(session, { objective: "ship the feature" });
  if (!created.ok) throw new Error(created.message);
  const criterion = (
    over: Partial<Parameters<ProofStore["addCriterion"]>[0]> = {},
  ): ReturnType<ProofStore["addCriterion"]> =>
    proof.addCriterion({
      sessionId: session,
      text: "Tests pass",
      origin: "user",
      required: true,
      verifier: COMMAND,
      ...over,
    });
  const evidence = (criterionId: string, ok: boolean, at = "2026-10-14T10:00:00.000Z") =>
    proof.appendEvidence({
      criterionId,
      verifierKind: "command",
      runId: "run_1",
      callId: `call_${ok ? "ok" : "bad"}`,
      ok,
      exitCode: ok ? 0 : 1,
      durationMs: 5,
      outputHash: "h",
      treeFingerprint: "t",
      filesTouched: [],
      capturedAt: at,
    });
  const log: GoalEvidence[] = [{ kind: "log", detail: "ran the suite" }];
  const complete = (evidenceItems: GoalEvidence[] = log, runId = "r1") =>
    goals.report(session, runId, { status: "complete", summary: "done", evidence: evidenceItems });
  return { store, proof, goals, session, other, clock, criterion, evidence, complete, log };
}

describe("update_goal complete against the ledger (O6)", () => {
  it("a required criterion that failed keeps the goal active and says why", async () => {
    const f = await fixture();
    const crit = f.criterion();
    f.evidence(crit.criterionId, false);
    const before = f.goals.get(f.session);

    const result = f.complete();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_allowed");
    expect(result.message).toContain("Tests pass");
    expect(result.unmet).toEqual([
      { criterionId: crit.criterionId, text: "Tests pass", status: "failed" },
    ]);
    // Nothing moved: same status, same epoch, no evidence stored from the refused report.
    expect(f.goals.get(f.session)).toEqual(before);
    expect(f.goals.get(f.session)?.status).toBe("active");
  });

  it("a required criterion that was never checked blocks completion too", async () => {
    const f = await fixture();
    const crit = f.criterion();
    const bare = f.criterion({ text: "Docs updated", verifier: undefined });

    const result = f.complete();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmet?.map((u) => [u.criterionId, u.status])).toEqual([
      [crit.criterionId, "not_checked"],
      [bare.criterionId, "not_checked"],
    ]);
  });

  it("completes when every required criterion is verified and attaches the ledger", async () => {
    const f = await fixture();
    const crit = f.criterion();
    const evidence = f.evidence(crit.criterionId, true);

    const result = f.complete([
      { kind: "test", detail: "pnpm test", evidenceId: evidence.evidenceId },
    ]);

    expect(result.ok).toBe(true);
    const goal = f.goals.get(f.session);
    expect(goal?.status).toBe("complete");
    expect(goal?.reason).toBe("model_complete");
    expect(goal?.proof).toMatchObject({
      criteria: [{ criterionId: crit.criterionId, required: true, status: "verified" }],
      unmet: [],
      linkedEvidence: [evidence.evidenceId],
    });
    expect(goal?.proof?.override).toBeUndefined();
    expect(f.goals.info(f.session)?.proof?.unmet).toEqual([]);
  });

  it("optional, not_applicable and manual_review criteria never block", async () => {
    const f = await fixture();
    const optional = f.criterion({ text: "Nice to have", required: false });
    f.evidence(optional.criterionId, false);
    const na = f.criterion({ text: "Mobile layout" });
    f.proof.markNotApplicable(na.criterionId, "no UI in this task");
    f.criterion({ text: "Looks right", verifier: { kind: "manual" } });

    expect(f.complete().ok).toBe(true);
    expect(f.goals.get(f.session)?.proof?.unmet).toEqual([]);
  });

  it("only criteria of this goal or of the whole session count", async () => {
    const f = await fixture();
    f.criterion({ text: "Belongs to an older goal", goalId: "g-old" });
    f.criterion({ text: "Other session", sessionId: f.other });
    const mine = f.criterion({ text: "Mine", goalId: "g1" });

    const result = f.complete();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmet?.map((u) => u.criterionId)).toEqual([mine.criterionId]);
  });

  it("a refused completion leaves the model free to report blocked and the caps untouched", async () => {
    const f = await fixture();
    f.criterion();
    expect(f.complete().ok).toBe(false);

    const blocked = f.goals.report(f.session, "r2", {
      status: "blocked",
      summary: "cannot run the suite",
      evidence: [{ kind: "denied", detail: "shell denied" }],
    });
    expect(blocked.ok).toBe(true);
    expect(f.goals.get(f.session)?.status).toBe("blocked");
  });

  it("a status change after the report is judged again on the next attempt", async () => {
    const f = await fixture();
    const crit = f.criterion();
    f.evidence(crit.criterionId, false);
    expect(f.complete().ok).toBe(false);

    f.evidence(crit.criterionId, true, "2026-10-14T10:05:00.000Z");
    expect(f.complete().ok).toBe(true);
  });
});

describe("the user override (O2, O6)", () => {
  it("completes a goal with an unmet required criterion and records who, why and what was unmet", async () => {
    const f = await fixture();
    const crit = f.criterion();
    f.evidence(crit.criterionId, false);
    f.clock.now += 1_000;

    const result = f.goals.overrideComplete(f.session, { reason: "  flaky CI, verified by hand " });

    expect(result.ok).toBe(true);
    const goal = f.goals.get(f.session);
    expect(goal).toMatchObject({ status: "complete", reason: "user_override" });
    expect(goal?.completedAt).toBe(f.clock.now);
    expect(goal?.proof?.override).toEqual({
      reason: "flaky CI, verified by hand",
      at: f.clock.now,
    });
    expect(goal?.proof?.unmet).toEqual([crit.criterionId]);
    expect(f.goals.info(f.session)?.proof?.override?.reason).toBe("flaky CI, verified by hand");
  });

  it("needs a real reason and something to override", async () => {
    const f = await fixture();
    expect(f.goals.overrideComplete(f.session, { reason: "x" }).ok).toBe(false);
    const crit = f.criterion();
    f.evidence(crit.criterionId, false);
    expect(f.goals.overrideComplete(f.session, { reason: "   " })).toMatchObject({
      ok: false,
      code: "invalid",
    });
    expect(f.goals.get(f.session)?.status).toBe("active");
  });

  it("works from paused and blocked, never from budget_limited or complete", async () => {
    for (const setup of ["paused", "blocked"] as const) {
      const f = await fixture();
      f.criterion();
      if (setup === "paused") f.goals.pause(f.session);
      else
        f.goals.report(f.session, "r1", {
          status: "blocked",
          summary: "stuck",
          evidence: [{ kind: "denied", detail: "no" }],
        });
      expect(f.goals.get(f.session)?.status).toBe(setup);
      expect(f.goals.overrideComplete(f.session, { reason: "reviewed" }).ok).toBe(true);
    }
    const limited = await fixture();
    limited.criterion();
    limited.goals.setBudget(limited.session, 1);
    limited.goals.settle(limited.session, {
      runId: "r",
      status: "completed",
      usage: { input: 5, output: 5 },
      text: "t",
      toolCalls: 1,
      startedAt: limited.clock.now,
      durationMs: 10,
    });
    expect(limited.goals.get(limited.session)?.status).toBe("budget_limited");
    expect(limited.goals.overrideComplete(limited.session, { reason: "reviewed" }).ok).toBe(false);

    const done = await fixture();
    const c = done.criterion();
    done.evidence(c.criterionId, true);
    expect(done.complete().ok).toBe(true);
    expect(done.goals.overrideComplete(done.session, { reason: "again" }).ok).toBe(false);
  });

  it("is a compare-and-set: a stale epoch conflicts", async () => {
    const f = await fixture();
    f.criterion();
    const seen = f.goals.get(f.session);
    f.goals.edit(f.session, "a different objective");
    const result = f.goals.overrideComplete(
      f.session,
      { reason: "reviewed" },
      { goalId: seen?.goalId, epoch: seen?.epoch },
    );
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(f.goals.get(f.session)?.status).toBe("active");
  });

  it("the model cannot smuggle an override through update_goal or the service report", async () => {
    const f = await fixture();
    f.criterion();
    const registry = new ToolRegistry();
    registerGoalTools(registry, { goals: f.goals });

    const viaTool = await registry.get("update_goal").execute(
      {
        status: "complete",
        summary: "done",
        evidence: [{ kind: "log", detail: "trust me" }],
        override: { reason: "the model says so" },
      },
      { session: f.session, runId: "r1" } as never,
    );
    const text = viaTool.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(JSON.parse(text)).toMatchObject({ ok: false });
    expect(JSON.parse(text).unmet).toHaveLength(1);

    const viaService = f.goals.report(f.session, "r2", {
      status: "complete",
      summary: "done",
      evidence: f.log,
      override: { reason: "the model says so" },
    } as never);
    expect(viaService.ok).toBe(false);
    expect(f.goals.get(f.session)?.status).toBe("active");
    expect(f.goals.get(f.session)?.proof).toBeUndefined();
  });
});

describe("GoalEvidence.evidenceId (3.6)", () => {
  it("keeps a link only when it resolves to evidence of this session", async () => {
    const f = await fixture();
    const crit = f.criterion();
    const mine = f.evidence(crit.criterionId, true);
    const foreignCrit = f.proof.addCriterion({
      sessionId: f.other,
      text: "elsewhere",
      origin: "user",
      verifier: COMMAND,
    });
    const foreign = f.evidence(foreignCrit.criterionId, true);

    const result = f.complete([
      { kind: "test", detail: "linked", evidenceId: mine.evidenceId },
      { kind: "test", detail: "foreign", evidenceId: foreign.evidenceId },
      { kind: "test", detail: "invented", evidenceId: "ev_made_up" },
      { kind: "log", detail: "free text" },
    ]);

    expect(result.ok).toBe(true);
    const goal = f.goals.get(f.session);
    expect(goal?.evidence?.map((e) => e.evidenceId)).toEqual([
      mine.evidenceId,
      undefined,
      undefined,
      undefined,
    ]);
    expect(goal?.proof?.linkedEvidence).toEqual([mine.evidenceId]);
  });

  it("a link or a claim cannot change a status: failed evidence stays failed, free text counts for nothing", async () => {
    const f = await fixture();
    const crit = f.criterion();
    const bad = f.evidence(crit.criterionId, false);

    const linked = f.complete([
      { kind: "test", detail: "all tests pass", evidenceId: bad.evidenceId },
    ]);
    expect(linked.ok).toBe(false);

    const unchecked = await fixture();
    unchecked.criterion();
    const claim = unchecked.complete([{ kind: "test", detail: "pnpm test: 120 passed" }]);
    expect(claim.ok).toBe(false);
    expect(unchecked.proof.ledger(unchecked.session).criteria[0]?.status).toBe("not_checked");
  });

  it("update_goal accepts evidenceId in its schema and parser", async () => {
    const f = await fixture();
    const crit = f.criterion();
    const ev = f.evidence(crit.criterionId, true);
    const registry = new ToolRegistry();
    registerGoalTools(registry, { goals: f.goals });
    const tool = registry.get("update_goal");
    expect(JSON.stringify(tool.inputSchema)).toContain("evidenceId");

    const out = await tool.execute(
      {
        status: "complete",
        summary: "done",
        evidence: [{ kind: "test", detail: "suite", evidenceId: ev.evidenceId }],
      },
      { session: f.session, runId: "r1" } as never,
    );
    expect(
      JSON.parse(out.content.map((p) => (p.type === "text" ? p.text : "")).join("")),
    ).toMatchObject({ ok: true, status: "complete" });
    expect(f.goals.get(f.session)?.proof?.linkedEvidence).toEqual([ev.evidenceId]);
  });
});

describe("without criteria the goal behaves as in 0.7.x (D7, characterization)", () => {
  const strip = (goal: unknown) => {
    const { goalId: _goalId, sessionId: _session, ...rest } = goal as Record<string, unknown>;
    return rest;
  };

  it("complete and blocked give the same record with or without the Proof port", async () => {
    const withProof = await fixture();
    const without = await fixture({ withProof: false });
    const evidence = [
      { kind: "file" as const, detail: "src/a.ts" },
      { kind: "log" as const, detail: "ok", evidenceId: "ev_unresolved" },
    ];

    const a = withProof.complete(evidence);
    const b = without.complete(evidence);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(strip(withProof.goals.get(withProof.session))).toEqual(
      strip(without.goals.get(without.session)),
    );
    const goal = withProof.goals.get(withProof.session);
    expect(goal?.proof).toBeUndefined();
    expect("proof" in (withProof.goals.info(withProof.session) ?? {})).toBe(false);
    // An evidenceId that resolves to nothing is dropped; everything else is stored as declared.
    expect(goal?.evidence).toEqual([
      { kind: "file", detail: "src/a.ts" },
      { kind: "log", detail: "ok" },
    ]);
  });

  it("the user has no override when there is nothing to override", async () => {
    const f = await fixture();
    expect(f.goals.overrideComplete(f.session, { reason: "just because" })).toMatchObject({
      ok: false,
      code: "not_allowed",
    });
  });

  it("a service without a ledger source completes exactly as before", async () => {
    const f = await fixture({ withProof: false });
    f.criterion({ text: "ignored: nobody reads the ledger" });
    expect(f.complete().ok).toBe(true);
  });
});

describe("persistence of the Proof snapshot (migration v13)", () => {
  it("survives a reopen, and a goal row without it still loads", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-proof-goal-db-"));
    roots.push(root);
    const path = join(root, "sessions.sqlite");
    const first = new SQLiteStore(path);
    const session = first.create(root, "p", "m").id;
    const proof = new ProofStore(first.db);
    const goals = new GoalService({
      store: new GoalStore(first.db),
      settings: () => SETTINGS,
      proof,
    });
    goals.create(session, { objective: "ship the feature" });
    const crit = proof.addCriterion({
      sessionId: session,
      text: "T",
      origin: "user",
      required: true,
    });
    expect(goals.overrideComplete(session, { reason: "checked by hand" }).ok).toBe(true);
    first.close();

    const second = new SQLiteStore(path);
    stores.push(second);
    const versions = second.db.prepare("SELECT version FROM schema_migrations").all() as {
      version: number;
    }[];
    expect(versions.map((v) => v.version)).toContain(13);
    const goal = new GoalStore(second.db).get(session);
    expect(goal?.proof).toMatchObject({
      unmet: [crit.criterionId],
      override: { reason: "checked by hand" },
    });
    // A goal row written before the column existed (NULL) has no proof at all.
    second.db.prepare("UPDATE session_goals SET proof_json=NULL WHERE session=?").run(session);
    expect(new GoalStore(second.db).get(session)?.proof).toBeUndefined();
  });
});

describe("a model that retries a refused completion (phase 4 concern, closed in phase 5)", () => {
  it("pauses the goal as no_progress after refusals in three different runs", async () => {
    const f = await fixture();
    const crit = f.criterion();
    f.evidence(crit.criterionId, false);
    expect(f.complete(f.log, "r1").ok).toBe(false);
    expect(f.complete(f.log, "r2").ok).toBe(false);
    expect(f.goals.get(f.session)?.status).toBe("active");
    const third = f.complete(f.log, "r3");
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.message).toContain("paused");
    expect(f.goals.get(f.session)).toMatchObject({
      status: "paused",
      reason: "no_progress",
      detail: "completion_refused",
    });
  });

  it("counts a run once, however many times it retries inside it", async () => {
    const f = await fixture();
    f.evidence(f.criterion().criterionId, false);
    for (let i = 0; i < 6; i++) expect(f.complete(f.log, "r1").ok).toBe(false);
    expect(f.goals.get(f.session)?.status).toBe("active");
  });

  it("starts counting again after the user resumes the goal", async () => {
    const f = await fixture();
    f.evidence(f.criterion().criterionId, false);
    f.complete(f.log, "r1");
    f.complete(f.log, "r2");
    f.complete(f.log, "r3");
    expect(f.goals.get(f.session)?.status).toBe("paused");
    expect(f.goals.resume(f.session).ok).toBe(true);
    f.complete(f.log, "r4");
    f.complete(f.log, "r5");
    expect(f.goals.get(f.session)?.status).toBe("active");
  });

  it("does not count a refusal that is not about the ledger, and never without criteria", async () => {
    const f = await fixture();
    // No criterion: completing works as in 0.7.x.
    expect(f.complete(f.log, "r1").ok).toBe(true);
  });
});

describe("/goal override <reason> (the user's way past unmet criteria)", () => {
  it("parses the reason, and refuses an empty one or one mixed with budget=", async () => {
    const { parseGoalCommand } = await import("../packages/core/src/goal/command.ts");
    expect(parseGoalCommand("override Checked by hand on staging")).toEqual({
      type: "override",
      reason: "Checked by hand on staging",
    });
    expect(parseGoalCommand("override")).toMatchObject({ type: "error" });
    expect(parseGoalCommand("override ok budget=5k")).toMatchObject({ type: "error" });
  });
});
