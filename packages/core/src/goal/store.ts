/**
 * Persistence of session goals (table `session_goals`, schema v7 + v8): ONE row per session.
 * Every change goes through `update`, a read-modify-write inside one `BEGIN IMMEDIATE`
 * transaction (the adapter's `transaction`), so two surfaces (and two processes sharing the
 * database) can never interleave. A caller may pass what it saw (`expect`): when the goal moved
 * on (another epoch, another goal), nothing is written and the caller gets `conflict`.
 *
 * The `epoch` counter moves with every VISIBLE change (status, objective, budget); the running
 * totals only move `updated_at`, so a UI that read the goal a moment ago can still act on it.
 */
import type { GoalEvidence, GoalReason, GoalStatus, SqlDatabase, SqlRow } from "@alisio/sdk";
import { isProcessAlive } from "../runtime/process.ts";
import { GOAL_STATUSES, type GoalRecord, systemRestart } from "./machine.ts";

/** What a client saw when it decided to act; both are optional. */
export interface GoalExpectation {
  goalId?: string;
  epoch?: number;
}

export type GoalUpdate<T> =
  | { ok: true; goal: GoalRecord; value: T }
  | { ok: false; code: "not_found" | "conflict" | "exists"; message: string };

const num = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);
const str = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);

function parseEvidence(raw: unknown): GoalEvidence[] | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as GoalEvidence[]) : undefined;
  } catch {
    return undefined;
  }
}

export function goalFromRow(row: SqlRow): GoalRecord {
  const status = String(row.status) as GoalStatus;
  return {
    sessionId: String(row.session),
    goalId: str(row.goal_id) ?? String(row.session).slice(0, 8),
    objective: String(row.objective),
    status: GOAL_STATUSES.includes(status) ? status : "paused",
    ...(str(row.reason) ? { reason: str(row.reason) as GoalReason } : {}),
    ...(str(row.detail) ? { detail: str(row.detail) as string } : {}),
    ...(str(row.summary) ? { summary: str(row.summary) as string } : {}),
    ...(parseEvidence(row.evidence)
      ? { evidence: parseEvidence(row.evidence) as GoalEvidence[] }
      : {}),
    epoch: Number(row.epoch ?? 1),
    ...(num(row.token_budget) !== undefined
      ? { tokenBudget: num(row.token_budget) as number }
      : {}),
    tokensUsed: Number(row.tokens_used ?? 0),
    turnsUsed: Number(row.turns_used ?? 0),
    maxTurns: Number(row.max_turns),
    maxWallMs: Number(row.max_wall_ms),
    activeMs: Number(row.active_ms ?? 0),
    noToolStreak: Number(row.no_tool_streak ?? 0),
    repeatStreak: Number(row.repeat_streak ?? 0),
    ...(str(row.last_reply_hash) ? { lastReplyHash: str(row.last_reply_hash) as string } : {}),
    blockedStreak: Number(row.blocked_streak ?? 0),
    ...(str(row.blocked_run) ? { blockedRun: str(row.blocked_run) as string } : {}),
    continuations: Number(row.continuations ?? 0),
    ...(str(row.inflight) ? { inflight: str(row.inflight) as string } : {}),
    ...(str(row.last_run_id) ? { lastRunId: str(row.last_run_id) as string } : {}),
    kickoffSent: Number(row.kickoff_sent ?? 0) === 1,
    ...(num(row.owner_pid) !== undefined ? { ownerPid: num(row.owner_pid) as number } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(num(row.completed_at) !== undefined
      ? { completedAt: num(row.completed_at) as number }
      : {}),
  };
}

const COLUMNS = `session, goal_id, objective, status, reason, detail, summary, evidence, epoch,
  token_budget, tokens_used, turns_used, max_turns, max_wall_ms, active_ms, no_tool_streak,
  repeat_streak, last_reply_hash, blocked_streak, blocked_run, continuations, inflight,
  last_run_id, kickoff_sent, owner_pid, created_at, updated_at, completed_at`;

export class GoalStore {
  constructor(private readonly db: SqlDatabase) {}

  get(sessionId: string): GoalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM session_goals WHERE session=?").get(sessionId);
    return row ? goalFromRow(row) : undefined;
  }

  /** Every goal that is `active` (restart recovery). */
  active(): GoalRecord[] {
    return this.db
      .prepare("SELECT * FROM session_goals WHERE status='active'")
      .all()
      .map(goalFromRow);
  }

  private write(goal: GoalRecord): void {
    this.db
      .prepare(
        `INSERT INTO session_goals(${COLUMNS}) VALUES(${COLUMNS.split(",")
          .map(() => "?")
          .join(",")})
         ON CONFLICT(session) DO UPDATE SET
           goal_id=excluded.goal_id, objective=excluded.objective, status=excluded.status,
           reason=excluded.reason, detail=excluded.detail, summary=excluded.summary,
           evidence=excluded.evidence, epoch=excluded.epoch, token_budget=excluded.token_budget,
           tokens_used=excluded.tokens_used, turns_used=excluded.turns_used,
           max_turns=excluded.max_turns, max_wall_ms=excluded.max_wall_ms,
           active_ms=excluded.active_ms, no_tool_streak=excluded.no_tool_streak,
           repeat_streak=excluded.repeat_streak, last_reply_hash=excluded.last_reply_hash,
           blocked_streak=excluded.blocked_streak, blocked_run=excluded.blocked_run,
           continuations=excluded.continuations, inflight=excluded.inflight,
           last_run_id=excluded.last_run_id, kickoff_sent=excluded.kickoff_sent,
           owner_pid=excluded.owner_pid, updated_at=excluded.updated_at,
           completed_at=excluded.completed_at`,
      )
      .run(
        goal.sessionId,
        goal.goalId,
        goal.objective,
        goal.status,
        goal.reason ?? null,
        goal.detail ?? null,
        goal.summary ?? null,
        goal.evidence?.length ? JSON.stringify(goal.evidence) : null,
        goal.epoch,
        goal.tokenBudget ?? null,
        goal.tokensUsed,
        goal.turnsUsed,
        goal.maxTurns,
        goal.maxWallMs,
        goal.activeMs,
        goal.noToolStreak,
        goal.repeatStreak,
        goal.lastReplyHash ?? null,
        goal.blockedStreak,
        goal.blockedRun ?? null,
        goal.continuations,
        goal.inflight ?? null,
        goal.lastRunId ?? null,
        goal.kickoffSent ? 1 : 0,
        goal.ownerPid ?? null,
        goal.createdAt,
        goal.updatedAt,
        goal.completedAt ?? null,
      );
  }

  /**
   * Replaces (or creates) the goal of a session. `build` gets the previous goal, if any, so the
   * new one can continue its epoch (a stale client then conflicts instead of acting on the new
   * goal), or answer `"exists"` to refuse. With `expect`, a goal that moved on is not replaced.
   */
  replace(
    sessionId: string,
    build: (previous: GoalRecord | undefined) => GoalRecord | "exists",
    expect?: GoalExpectation,
  ): GoalUpdate<GoalRecord | undefined> {
    return this.db.transaction(() => {
      const previous = this.get(sessionId);
      const stale = staleness(previous, expect);
      if (stale) return stale;
      const next = build(previous);
      if (next === "exists")
        return {
          ok: false as const,
          code: "exists" as const,
          message: "This session already has a goal. Confirm to replace it.",
        };
      this.write(next);
      return { ok: true as const, goal: next, value: previous };
    });
  }

  /**
   * Read-modify-write. `change` returns the new record (or undefined to leave it untouched) and
   * a value for the caller; it must be pure (it may run inside a retried transaction).
   */
  update<T>(
    sessionId: string,
    change: (goal: GoalRecord) => { goal?: GoalRecord; value: T },
    expect?: GoalExpectation,
  ): GoalUpdate<T> {
    return this.db.transaction(() => {
      const current = this.get(sessionId);
      if (!current) return { ok: false as const, code: "not_found" as const, message: "No goal." };
      const stale = staleness(current, expect);
      if (stale) return stale;
      const { goal, value } = change(current);
      if (goal && goal !== current) this.write(goal);
      return { ok: true as const, goal: goal ?? current, value };
    });
  }

  /** Removes the goal. With `expect`, only the goal the caller saw. */
  delete(sessionId: string, expect?: GoalExpectation): GoalUpdate<undefined> {
    return this.db.transaction(() => {
      const current = this.get(sessionId);
      if (!current) return { ok: false as const, code: "not_found" as const, message: "No goal." };
      const stale = staleness(current, expect);
      if (stale) return stale;
      this.db.prepare("DELETE FROM session_goals WHERE session=?").run(sessionId);
      return { ok: true as const, goal: current, value: undefined };
    });
  }

  /**
   * Startup recovery: an `active` goal whose driving process is gone (or unknown) pauses with
   * reason `restart`. A goal driven by this very process (another application in it) or by a
   * live one is left alone. Returns the goals that paused.
   */
  pauseOrphans(now: number, alive: (pid: number) => boolean = isProcessAlive): GoalRecord[] {
    return this.db.transaction(() => {
      const paused: GoalRecord[] = [];
      for (const goal of this.active()) {
        const owner = goal.ownerPid;
        if (owner && (owner === process.pid || alive(owner))) continue;
        const next = systemRestart(goal, now);
        this.write(next);
        paused.push(next);
      }
      return paused;
    });
  }

  /** Sessions that have a goal in the given statuses (for lists). */
  sessionsWith(status: GoalStatus): string[] {
    return (
      this.db.prepare("SELECT session FROM session_goals WHERE status=?").all(status) as {
        session: string;
      }[]
    ).map((row) => row.session);
  }
}

function staleness(
  current: GoalRecord | undefined,
  expect: GoalExpectation | undefined,
): { ok: false; code: "conflict"; message: string } | undefined {
  if (!expect || !current) return undefined;
  if (expect.goalId !== undefined && expect.goalId !== current.goalId)
    return { ok: false, code: "conflict", message: "The goal was replaced by another one." };
  if (expect.epoch !== undefined && expect.epoch !== current.epoch)
    return {
      ok: false,
      code: "conflict",
      message: "The goal changed since you last saw it (another window or the agent updated it).",
    };
  return undefined;
}
