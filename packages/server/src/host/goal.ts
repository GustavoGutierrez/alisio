/**
 * The server side of `/goal`: the glue between the core goal service (state machine, caps,
 * breakers, the claim of ONE continuation) and what only the server knows (the run scheduler, the
 * pending approvals and questions, the open workspace applications, the SSE hub).
 *
 * Everything funnels through `pump(sessionId)`: it asks the core whether the goal continues now
 * and, when it does, starts the continuation as a normal run (`goal-<goalId>-<n>` is the run's
 * request id, so a double trigger starts one run). It is called after each user action, after each
 * run, when the last background task ends, and when anything that blocks a goal may have changed.
 * A goal never starts a run by any other path.
 */
import { randomUUID } from "node:crypto";
import {
  type GoalHostView,
  GoalStore,
  goalOutcome,
  goalWaiting,
  type SQLiteStore,
  toGoalInfo,
} from "@alisio/core";
import type { GoalInfo, ServerFrame } from "@alisio/sdk";
import type { RunJob, RunOutcome, RunScheduler } from "./run-scheduler.ts";
import type { SessionService } from "./sessions.ts";
import { type WorkspaceHost, workspaceId } from "./workspace-host.ts";

export interface GoalDriverOptions {
  catalog: SQLiteStore;
  sessions: () => SessionService;
  scheduler: () => RunScheduler;
  workspaces: () => WorkspaceHost;
  awaiting: (root: string) => "approval" | "question" | undefined;
  toSession: (sessionId: string, frame: ServerFrame) => void;
  closing: () => boolean;
  log: (event: string, data: Record<string, unknown>) => void;
}

export class GoalDriver {
  private readonly store: GoalStore;
  /** The last frame sent per session, so an unchanged goal is not sent again. */
  private sent = new Map<string, string>();

  constructor(private readonly options: GoalDriverOptions) {
    this.store = new GoalStore(options.catalog.db);
  }

  private opened(sessionId: string) {
    try {
      return this.options
        .workspaces()
        .get(workspaceId(this.options.catalog.get(sessionId).workspace));
    } catch {
      return undefined;
    }
  }

  /** What the host knows about a session, for the core's blocker list. */
  view(sessionId: string): GoalHostView {
    const { catalog } = this.options;
    const session = catalog.get(sessionId);
    const opened = this.opened(sessionId);
    const awaiting = this.options.awaiting(sessionId);
    return {
      running:
        this.options.scheduler().busy(sessionId) ||
        !!opened?.app.runner.isRunning(sessionId) ||
        !!catalog.lockedBy(sessionId),
      queuedInput: false,
      ...(awaiting ? { awaiting } : {}),
      planMode: this.options.sessions().activeAgentId(session) === "plan",
      liveTasks: opened?.app.tasks.liveCount(sessionId) ?? 0,
    };
  }

  /** The goal of a root session as UIs see it (with what it waits for), or undefined. */
  info(sessionId: string): GoalInfo | undefined {
    const goal = this.store.get(sessionId);
    if (!goal) return undefined;
    const enabled = this.opened(sessionId)?.app.goals.enabled ?? true;
    const waiting = goalWaiting({
      ...this.view(sessionId),
      status: goal.status,
      enabled,
      inflight: !!goal.inflight,
    });
    return { ...toGoalInfo(goal), ...(waiting ? { waiting } : {}) };
  }

  /** Sends `goal_changed` when what a UI shows changed (dedupe by content). */
  refresh(sessionId: string): void {
    let info: GoalInfo | undefined;
    try {
      info = this.info(sessionId);
    } catch {
      return;
    }
    const key = JSON.stringify(info ?? null);
    if (this.sent.get(sessionId) === key) return;
    this.sent.set(sessionId, key);
    this.options.toSession(sessionId, { t: "goal_changed", sessionId, goal: info ?? null });
  }

  /** Folds a finished run into the session's goal. Child sessions and tool-only jobs have none. */
  settle(job: RunJob, outcome: RunOutcome): void {
    if (job.tool) return;
    const opened = this.opened(job.sessionId);
    if (!opened || !opened.app.goals.get(job.sessionId)) return;
    opened.app.goals.settle(
      job.sessionId,
      goalOutcome({
        runId: job.runId,
        startedAt: outcome.startedAt,
        endedAt: outcome.endedAt,
        cancelled: outcome.cancelled,
        ...(outcome.result ? { result: outcome.result } : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      }),
    );
  }

  /**
   * Continues the goal if it may continue now. Safe to call from anywhere, any number of times:
   * the core claims at most one continuation, and a busy session is simply left alone.
   */
  pump(sessionId: string): "started" | "waiting" | "idle" {
    const { catalog } = this.options;
    try {
      const session = catalog.get(sessionId);
      const opened = this.opened(sessionId);
      if (this.options.closing() || session.parentId || session.archivedAt || !opened) {
        this.refresh(sessionId);
        return "idle";
      }
      const goals = opened.app.goals;
      if (!goals.get(sessionId)) return "idle";
      const decision = goals.next(sessionId, this.view(sessionId));
      this.refresh(sessionId);
      if (decision.kind === "wait") return "waiting";
      if (decision.kind !== "continue") return "idle";
      const { requestId, prompt, run } = decision;
      const sessions = this.options.sessions();
      const correlationId = randomUUID();
      const { run: record, created } = sessions.beginRun({
        id: randomUUID(),
        session: sessionId,
        status: "queued",
        requestId,
        correlationId,
        model: session.model,
      });
      if (!created) {
        // The same continuation was already started (a double trigger): nothing more to do, and
        // the claim stays with that run.
        if (
          ["completed", "failed", "cancelled", "interrupted", "turns_exceeded"].includes(
            record.status,
          )
        )
          goals.abandon(sessionId, requestId, prompt.kind);
        return "started";
      }
      const job: RunJob = {
        runId: record.id,
        sessionId,
        workspaceId: opened.id,
        app: opened.app,
        text: prompt.text,
        display: prompt.display,
        correlationId,
        // The goal's own caps (the runner resets its own per run): what is left of the budget and
        // of the time cap, applied on top of the session's usual run options.
        options: () => {
          const base = sessions.runOptions(sessionId);
          const timeout = opened.app.config.limits.timeoutMs;
          return {
            ...base,
            ...(run.maxTokens !== undefined ? { maxTokens: run.maxTokens } : {}),
            timeoutMs: Math.max(1000, Math.min(run.remainingMs, timeout ?? run.remainingMs)),
          };
        },
      };
      try {
        this.options.scheduler().submit(job);
      } catch (error) {
        goals.abandon(sessionId, requestId, prompt.kind);
        throw error;
      }
      return "started";
    } catch (error) {
      this.options.log("goal_pump_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "idle";
    }
  }
}
