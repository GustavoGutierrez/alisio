/**
 * The goal of a root session (`/goal`): read it, create or replace it, edit its objective or
 * token budget, pause, resume, clear. The same auth, Host and Origin rules as every other `/api`
 * route apply. Every change is a compare-and-set in the core: a client may send what it last saw
 * (`expect: {goalId, epoch}`) and gets `409 goal_conflict` when another surface (or the agent)
 * changed the goal since. A change that lets the goal run (create, resume, a re-armed budget)
 * also makes it continue now; changes arrive in every window as `goal_changed` frames.
 *
 * Only the user changes a goal through here; the model has `update_goal` (complete / blocked).
 */
import type { GoalErrorCode, GoalExpectation } from "@alisio/core";
import { GOAL_OBJECTIVE_MAX } from "@alisio/core";
import type { GoalDriver } from "../host/goal.ts";
import type { SessionService } from "../host/sessions.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";

const BUDGET = is.integer(1, 1_000_000_000);
const nullableBudget = (v: unknown) => v === null || BUDGET(v);
const EXPECT = (v: unknown) =>
  is.object()(v) &&
  Object.keys(v as object).every((key) => key === "goalId" || key === "epoch") &&
  ((v as { goalId?: unknown }).goalId === undefined ||
    is.nonEmpty(64)((v as { goalId?: unknown }).goalId)) &&
  ((v as { epoch?: unknown }).epoch === undefined ||
    is.integer(0, Number.MAX_SAFE_INTEGER)((v as { epoch?: unknown }).epoch));

/** The HTTP error of a refused goal operation. */
export function goalError(code: GoalErrorCode, message: string): HttpError {
  switch (code) {
    case "disabled":
      return new HttpError("goal_disabled", message);
    case "not_found":
      return new HttpError("goal_not_found", message);
    case "invalid":
      return new HttpError("validation_failed", message, { fields: ["objective"] });
    default:
      return new HttpError("goal_conflict", message, { reason: code });
  }
}

export function registerGoalRoutes(
  router: Router,
  ctx: { sessions: SessionService; goals: Pick<GoalDriver, "info" | "pump" | "refresh"> },
): void {
  const { sessions, goals } = ctx;
  /** The root session and its workspace's goal service (opened on demand). */
  const open = async (sid: string | undefined, writing: boolean) => {
    const session = sessions.get(sid ?? "");
    if (session.parentId)
      throw new HttpError("validation_failed", "Goals belong to a root session, not a subagent.", {
        fields: ["sid"],
      });
    if (writing && session.archivedAt)
      throw new HttpError("validation_failed", "The session is archived.", { fields: ["sid"] });
    const { app } = await sessions.app(session);
    return { session, service: app.goals };
  };
  const reply = (sessionId: string) => ({ body: { goal: goals.info(sessionId) ?? null } });
  const settled = (sessionId: string) => {
    goals.refresh(sessionId);
    setImmediate(() => goals.pump(sessionId));
    return reply(sessionId);
  };

  router.get("/api/sessions/:sid/goal", async ({ params }) => {
    const { session } = await open(params.sid, false);
    return reply(session.id);
  });

  router.put("/api/sessions/:sid/goal", async ({ req, params }) => {
    const input = validate<{
      objective: string;
      tokenBudget?: number | null;
      replace?: boolean;
      expect?: GoalExpectation;
    }>(await readJson(req), {
      objective: { check: is.nonEmpty(GOAL_OBJECTIVE_MAX + 200), required: true },
      tokenBudget: { check: nullableBudget },
      replace: { check: is.boolean() },
      expect: { check: EXPECT },
    });
    const { session, service } = await open(params.sid, true);
    const outcome = service.create(
      session.id,
      {
        objective: input.objective,
        ...(typeof input.tokenBudget === "number" ? { tokenBudget: input.tokenBudget } : {}),
        ...(input.replace ? { replace: true } : {}),
      },
      input.expect,
    );
    if (!outcome.ok) throw goalError(outcome.code, outcome.message);
    return settled(session.id);
  });

  router.patch("/api/sessions/:sid/goal", async ({ req, params }) => {
    const input = validate<{
      objective?: string;
      tokenBudget?: number | null;
      expect?: GoalExpectation;
    }>(await readJson(req), {
      objective: { check: is.nonEmpty(GOAL_OBJECTIVE_MAX + 200) },
      tokenBudget: { check: nullableBudget },
      expect: { check: EXPECT },
    });
    if (input.objective === undefined && input.tokenBudget === undefined)
      throw new HttpError("validation_failed", "Send an objective or a tokenBudget to change", {
        fields: ["objective", "tokenBudget"],
      });
    const { session, service } = await open(params.sid, true);
    // The expectation applies to the first change; the second sees the epoch the first produced.
    let expect = input.expect;
    if (input.objective !== undefined) {
      const outcome = service.edit(session.id, input.objective, expect);
      if (!outcome.ok) throw goalError(outcome.code, outcome.message);
      expect = { goalId: outcome.goal.goalId, epoch: outcome.goal.epoch };
    }
    if (input.tokenBudget !== undefined) {
      const outcome = service.setBudget(session.id, input.tokenBudget, expect);
      if (!outcome.ok) throw goalError(outcome.code, outcome.message);
    }
    return settled(session.id);
  });

  router.delete("/api/sessions/:sid/goal", async ({ params, url }) => {
    const { session, service } = await open(params.sid, true);
    const epoch = url.searchParams.get("epoch");
    const goalId = url.searchParams.get("goalId");
    const outcome = service.clear(session.id, {
      ...(goalId ? { goalId } : {}),
      ...(epoch !== null && epoch !== "" && Number.isInteger(Number(epoch))
        ? { epoch: Number(epoch) }
        : {}),
    });
    if (!outcome.ok) throw goalError(outcome.code, outcome.message);
    goals.refresh(session.id);
    return reply(session.id);
  });

  for (const action of ["pause", "resume"] as const)
    router.post(`/api/sessions/:sid/goal/${action}`, async ({ req, params }) => {
      const input = validate<{ expect?: GoalExpectation }>(await readJson(req), {
        expect: { check: EXPECT },
      });
      const { session, service } = await open(params.sid, true);
      const outcome =
        action === "pause"
          ? service.pause(session.id, input.expect)
          : service.resume(session.id, input.expect);
      if (!outcome.ok) throw goalError(outcome.code, outcome.message);
      return settled(session.id);
    });
}
