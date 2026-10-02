/**
 * What happens after a plan run (spec: Plan Review). `exit_plan` only RECORDS the user's decision
 * while its run is still going; changing agents in the middle of a run would break the persisted
 * session. Once the run has ended this follow-up looks at the session's plan state:
 *
 * - cancelled run: an approved plan is dropped and a still-pending one is withdrawn;
 * - approved plan: claimed exactly once (compare-and-set), the session switches to `build` in the
 *   same transaction and ONE implementation run starts through the normal scheduler, carrying the
 *   approved plan as a persisted user message. The run's request id is the plan id, so even a
 *   second claim path could not create a second run.
 */
import { randomUUID } from "node:crypto";
import { IMPLEMENTATION_AGENT_ID, type SQLiteStore, settlePlanRun } from "@alisio/core";
import type { RunJob, RunScheduler } from "./run-scheduler.ts";
import type { SessionService } from "./sessions.ts";

export function followUpPlanRun(input: {
  job: RunJob;
  cancelled: boolean;
  catalog: SQLiteStore;
  sessions: SessionService;
  scheduler: RunScheduler;
}): "started" | "dropped" | "none" {
  const { job, catalog, sessions, scheduler } = input;
  const sessionId = job.sessionId;
  const next = settlePlanRun(catalog, sessionId, {
    aborted: input.cancelled,
    alsoSet: { agent: IMPLEMENTATION_AGENT_ID },
  });
  if (next.kind !== "implement") return next.kind;
  const correlationId = randomUUID();
  const { run, created } = sessions.beginRun({
    id: randomUUID(),
    session: sessionId,
    status: "queued",
    requestId: `plan-${next.plan.planId}`,
    correlationId,
    model: sessions.get(sessionId).model,
  });
  if (!created) return "none";
  scheduler.submit({
    runId: run.id,
    sessionId,
    workspaceId: job.workspaceId,
    app: job.app,
    text: next.text,
    display: next.display,
    correlationId,
    options: () => sessions.runOptions(sessionId),
  });
  return "started";
}
