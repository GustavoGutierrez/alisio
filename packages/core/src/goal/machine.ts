/**
 * The goal state machine: pure functions over a `GoalRecord`, no I/O, no clock of their own.
 * The store applies them inside one transaction (compare-and-set), the controller decides what
 * to do after a run, and every surface calls the same code.
 *
 *              ┌───────── resume ─────────┐
 *   created ─▶ active ──▶ paused | blocked | budget_limited | complete
 *              ▲  └─ complete (model, with evidence) ─▶ complete
 *              └──── budget raised / cleared (token_budget only) ── budget_limited
 *
 * Who may do what:
 * - user:   create, pause, resume (paused|blocked), edit, clear, change the budget.
 * - model:  `update_goal` complete / blocked, only while the goal is `active`.
 * - system: the caps and breakers (pause / budget_limited / blocked on error), user interrupt,
 *           restart. The system never resumes a goal.
 */
import type { GoalAction, GoalEvidence, GoalInfo, GoalReason, GoalStatus } from "@alisio/sdk";

export type GoalActor = "user" | "model" | "system";

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
];

/** The longest `detail` kept (an error text is truncated). */
export const GOAL_DETAIL_MAX = 300;
/** Every N-th turn the continuation carries the audit-style status reminder. */
export const GOAL_REMINDER_EVERY = 5;

/** The caps and breaker limits in force (from `config.goal`, snapshotted per goal for the caps). */
export interface GoalLimits {
  maxTurns: number;
  maxWallMs: number;
  repeatedReplyLimit: number;
  noToolTurnsLimit: number;
  blockedRepeats: number;
}

export const DEFAULT_GOAL_LIMITS: GoalLimits = {
  maxTurns: 50,
  maxWallMs: 120 * 60_000,
  repeatedReplyLimit: 3,
  noToolTurnsLimit: 3,
  blockedRepeats: 2,
};

/** The persisted goal (one per session). */
export interface GoalRecord {
  sessionId: string;
  goalId: string;
  objective: string;
  status: GoalStatus;
  reason?: GoalReason;
  detail?: string;
  summary?: string;
  evidence?: GoalEvidence[];
  epoch: number;
  tokenBudget?: number;
  tokensUsed: number;
  turnsUsed: number;
  maxTurns: number;
  maxWallMs: number;
  activeMs: number;
  /** Consecutive runs without a tool call. */
  noToolStreak: number;
  /** Consecutive replies identical to their predecessor (a fresh reply is 0). */
  repeatStreak: number;
  lastReplyHash?: string;
  /** Consecutive runs in which the model reported the goal blocked. */
  blockedStreak: number;
  /** The run of the last blocked report (a later run without one resets the streak). */
  blockedRun?: string;
  /** Continuations claimed so far (the `n` of `goal-<goalId>-<n>`). */
  continuations: number;
  /** The request id of a claimed continuation whose run has not settled yet. */
  inflight?: string;
  /** The last run folded into the totals (so settling twice counts once). */
  lastRunId?: string;
  /** The full contract has been sent (later continuations carry a short hint only). */
  kickoffSent: boolean;
  /** The process that last drove the goal (a restart pauses goals whose owner is dead). */
  ownerPid?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

/** What a run did, as the host reports it after the run ended. */
export interface GoalRunOutcome {
  runId: string;
  status: "completed" | "turns-exceeded" | "cancelled" | "failed";
  /** The error text of a failed run. */
  error?: string;
  /** A provider timeout (the runner already retried it): not a reason to block the goal. */
  timedOut?: boolean;
  usage: { input: number; output: number };
  /** The final assistant text (used for the repeated-reply fingerprint and the token estimate). */
  text: string;
  toolCalls: number;
  startedAt: number;
  durationMs: number;
}

export type GoalLog =
  | { event: "repeat_observed"; count: number }
  | { event: "no_tool_turn"; count: number };

export interface GoalSettlement {
  goal: GoalRecord;
  logs: GoalLog[];
}

/** The user actions per state (what the UIs offer). `clear`, `edit` and `budget` work anywhere. */
export function userActions(status: GoalStatus): GoalAction[] {
  switch (status) {
    case "active":
      return ["pause", "edit", "budget", "clear"];
    case "paused":
    case "blocked":
      return ["resume", "edit", "budget", "clear"];
    default:
      return ["edit", "budget", "clear"];
  }
}

export const isFinalGoalStatus = (status: GoalStatus): boolean =>
  status === "complete" || status === "budget_limited";

export const clip = (text: string, max = GOAL_DETAIL_MAX): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A goal with the given fields changed and `updatedAt` stamped. `epoch` moves with `visible`. */
function touch(
  goal: GoalRecord,
  now: number,
  patch: Partial<GoalRecord>,
  visible: boolean,
): GoalRecord {
  return { ...goal, ...patch, updatedAt: now, epoch: visible ? goal.epoch + 1 : goal.epoch };
}

/** Moves to `status`; fields that only make sense in another state are reset. */
function moveTo(
  goal: GoalRecord,
  now: number,
  status: GoalStatus,
  reason: GoalReason,
  extra: Partial<GoalRecord> = {},
): GoalRecord {
  return touch(
    goal,
    now,
    {
      status,
      reason,
      detail: undefined,
      ...(status === "complete" ? { completedAt: now } : {}),
      ...extra,
    },
    true,
  );
}

export type GoalRefusal = "not_allowed" | "not_active";

export type GoalResult<T = GoalRecord> =
  | { ok: true; goal: T }
  | { ok: false; code: GoalRefusal; message: string };

const refuse = (
  code: GoalRefusal,
  message: string,
): { ok: false; code: GoalRefusal; message: string } => ({
  ok: false,
  code,
  message,
});

/** A new goal (the user's `/goal <objective>`). The caller supplies the id and the limits. */
export function newGoal(input: {
  sessionId: string;
  goalId: string;
  objective: string;
  tokenBudget?: number;
  limits: Pick<GoalLimits, "maxTurns" | "maxWallMs">;
  epoch: number;
  now: number;
  ownerPid?: number;
}): GoalRecord {
  return {
    sessionId: input.sessionId,
    goalId: input.goalId,
    objective: input.objective,
    status: "active",
    reason: "created",
    epoch: input.epoch,
    ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
    tokensUsed: 0,
    turnsUsed: 0,
    maxTurns: input.limits.maxTurns,
    maxWallMs: input.limits.maxWallMs,
    activeMs: 0,
    noToolStreak: 0,
    repeatStreak: 0,
    blockedStreak: 0,
    continuations: 0,
    kickoffSent: false,
    ...(input.ownerPid ? { ownerPid: input.ownerPid } : {}),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** The user pauses the automatic continuation (only an `active` goal can be paused). */
export function userPause(goal: GoalRecord, now: number): GoalResult {
  if (goal.status !== "active")
    return refuse("not_allowed", `The goal is ${goal.status}: only an active goal can be paused.`);
  return { ok: true, goal: moveTo(goal, now, "paused", "user_paused", { inflight: undefined }) };
}

/**
 * The user resumes a paused or blocked goal. The streaks start again, and a goal that stopped
 * at its turn or time cap gets one more allowance of that cap (otherwise it would stop at once).
 */
export function userResume(
  goal: GoalRecord,
  now: number,
  limits: Pick<GoalLimits, "maxTurns" | "maxWallMs">,
  ownerPid?: number,
): GoalResult {
  if (goal.status !== "paused" && goal.status !== "blocked")
    return refuse(
      "not_allowed",
      goal.status === "active"
        ? "The goal is already active."
        : goal.status === "complete"
          ? "The goal is complete: start a new one with /goal <objective>."
          : "The goal ran out of its token budget: raise it with /goal budget=<n> to continue.",
    );
  return {
    ok: true,
    goal: moveTo(goal, now, "active", "resumed", {
      noToolStreak: 0,
      repeatStreak: 0,
      blockedStreak: 0,
      blockedRun: undefined,
      lastReplyHash: undefined,
      inflight: undefined,
      ...(goal.reason === "max_turns" ? { maxTurns: goal.turnsUsed + limits.maxTurns } : {}),
      ...(goal.reason === "max_wall" ? { maxWallMs: goal.activeMs + limits.maxWallMs } : {}),
      ...(ownerPid ? { ownerPid } : {}),
    }),
  };
}

/** The user changes the objective in any state; the next continuation sends the contract again. */
export function userEdit(goal: GoalRecord, now: number, objective: string): GoalResult {
  return {
    ok: true,
    goal: touch(
      goal,
      now,
      { objective, kickoffSent: false, blockedStreak: 0, blockedRun: undefined },
      true,
    ),
  };
}

/**
 * The user changes the token budget (`null` removes it) in any state. Raising or clearing the
 * budget of a goal that stopped for it re-arms it; lowering it to what was already spent stops
 * an active goal at once (the budget is hard).
 */
export function userBudget(
  goal: GoalRecord,
  now: number,
  tokens: number | null,
  ownerPid?: number,
): GoalResult {
  const base: Partial<GoalRecord> = { tokenBudget: tokens === null ? undefined : tokens };
  const exhausted = tokens !== null && goal.tokensUsed >= tokens;
  if (goal.status === "budget_limited" && goal.reason === "token_budget" && !exhausted)
    return {
      ok: true,
      goal: moveTo(goal, now, "active", "resumed", {
        ...base,
        noToolStreak: 0,
        repeatStreak: 0,
        blockedStreak: 0,
        blockedRun: undefined,
        inflight: undefined,
        completedAt: undefined,
        ...(ownerPid ? { ownerPid } : {}),
      }),
    };
  if (goal.status === "active" && exhausted)
    return {
      ok: true,
      goal: moveTo(goal, now, "budget_limited", "token_budget", { ...base, inflight: undefined }),
    };
  return { ok: true, goal: touch(goal, now, base, true) };
}

/**
 * The model reports the goal complete. Evidence is mandatory, and only an `active` goal can be
 * completed (a goal the user paused stays paused).
 */
export function modelComplete(
  goal: GoalRecord,
  now: number,
  report: { summary: string; evidence: GoalEvidence[] },
): GoalResult {
  if (goal.status !== "active")
    return refuse(
      "not_active",
      `The goal is ${goal.status}; only an active goal can be completed.`,
    );
  if (!report.evidence.length)
    return refuse("not_allowed", "Completion needs evidence (files, tests, logs or commands).");
  return {
    ok: true,
    goal: moveTo(goal, now, "complete", "model_complete", {
      summary: report.summary,
      evidence: report.evidence,
      inflight: goal.inflight,
    }),
  };
}

export interface BlockedReport {
  summary: string;
  evidence: GoalEvidence[];
  runId: string | undefined;
}

/**
 * The model reports the goal blocked. A permission denial (`denied` evidence) blocks at once;
 * anything else must be reported again, with evidence, in the next turn (`blockedRepeats`
 * consecutive runs) before the goal stops. Returns whether it stopped.
 */
export function modelBlocked(
  goal: GoalRecord,
  now: number,
  report: BlockedReport,
  limits: Pick<GoalLimits, "blockedRepeats">,
): GoalResult<{ goal: GoalRecord; stopped: boolean; needed: number }> {
  if (goal.status !== "active")
    return refuse(
      "not_active",
      `The goal is ${goal.status}; only an active goal can be reported blocked.`,
    );
  if (!report.evidence.length)
    return refuse(
      "not_allowed",
      "A blocked report needs evidence (what you tried and what failed).",
    );
  const denied = report.evidence.some((item) => item.kind === "denied");
  // The same run reporting twice counts once: the streak is about consecutive runs.
  const streak =
    report.runId && goal.blockedRun === report.runId ? goal.blockedStreak : goal.blockedStreak + 1;
  const needed = Math.max(1, limits.blockedRepeats);
  const base = { summary: report.summary, evidence: report.evidence, blockedRun: report.runId };
  if (denied || streak >= needed)
    return {
      ok: true,
      goal: {
        goal: moveTo(goal, now, "blocked", denied ? "policy_denied" : "model_blocked", {
          ...base,
          blockedStreak: streak,
          inflight: goal.inflight,
        }),
        stopped: true,
        needed,
      },
    };
  return {
    ok: true,
    goal: {
      goal: touch(goal, now, { ...base, blockedStreak: streak }, false),
      stopped: false,
      needed,
    },
  };
}

/** A process restart: an `active` goal pauses (never auto-resumes). */
export function systemRestart(goal: GoalRecord, now: number): GoalRecord {
  if (goal.status !== "active") return goal;
  return moveTo(goal, now, "paused", "restart", { inflight: undefined });
}

/** A stable fingerprint of the final reply: case, spacing and trailing punctuation do not matter. */
export function replyFingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?…\s]+$/u, "");
  if (!normalized) return "";
  // FNV-1a over the normalized text: collisions only cost a false repeat, and this stays portable.
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${normalized.length.toString(36)}:${hash.toString(36)}`;
}

/** Roughly four characters a token, for providers that report no usage (documented estimate). */
export const estimateReplyTokens = (text: string): number => Math.ceil(text.length / 4);

/** The breaker stage of a symptom seen `count` times in a row: logged, then nudged, then paused. */
export function breakerStage(count: number, limit: number): "none" | "log" | "nudge" | "pause" {
  const cap = Math.max(2, limit);
  if (count >= cap) return "pause";
  if (count >= 2) return "nudge";
  return count === 1 ? "log" : "none";
}

/** Whether the continuation after this state must carry a nudge (and which breaker asks). */
export function pendingNudge(
  goal: GoalRecord,
  limits: Pick<GoalLimits, "repeatedReplyLimit" | "noToolTurnsLimit">,
): "repeat" | "no_tool" | undefined {
  if (breakerStage(goal.repeatStreak, limits.repeatedReplyLimit) === "nudge") return "repeat";
  if (breakerStage(goal.noToolStreak, limits.noToolTurnsLimit) === "nudge") return "no_tool";
  return undefined;
}

/**
 * Folds one finished run into the goal and decides whether the goal stops. Idempotent per run id.
 * The order of the checks is the order of the stops:
 * user interrupt, token budget, failed run, turn cap, time cap, no-progress breakers.
 */
export function settleRun(
  goal: GoalRecord,
  outcome: GoalRunOutcome,
  limits: GoalLimits,
  now: number,
): GoalSettlement {
  if (goal.lastRunId === outcome.runId) return { goal, logs: [] };
  // A run that began while the goal was active still counts after the goal changed state
  // (`updatedAt` moved during the run); runs of a goal that was already over do not.
  const counts =
    outcome.startedAt >= goal.createdAt &&
    (goal.status === "active" || goal.updatedAt >= outcome.startedAt);
  if (!counts) return { goal, logs: [] };
  const reported = outcome.usage.input + outcome.usage.output;
  const tokens = reported > 0 ? reported : estimateReplyTokens(outcome.text);
  let next: GoalRecord = {
    ...goal,
    tokensUsed: goal.tokensUsed + tokens,
    turnsUsed: goal.turnsUsed + 1,
    activeMs: goal.activeMs + Math.max(0, outcome.durationMs),
    lastRunId: outcome.runId,
    inflight: undefined,
    updatedAt: now,
    // A blocked report only counts while it is in consecutive runs.
    ...(goal.blockedRun !== outcome.runId ? { blockedStreak: 0, blockedRun: undefined } : {}),
  };
  if (goal.status !== "active") return { goal: next, logs: [] };
  const logs: GoalLog[] = [];
  // Breakers (counted for every settled run so the numbers are right when a cap stops it first).
  const hash = replyFingerprint(outcome.text);
  const repeated = !!hash && hash === goal.lastReplyHash;
  next = {
    ...next,
    ...(hash ? { lastReplyHash: hash } : {}),
    repeatStreak: repeated ? goal.repeatStreak + 1 : 0,
    noToolStreak: outcome.toolCalls === 0 ? goal.noToolStreak + 1 : 0,
  };
  if (repeated && breakerStage(next.repeatStreak, limits.repeatedReplyLimit) !== "pause")
    logs.push({ event: "repeat_observed", count: next.repeatStreak });
  if (outcome.toolCalls === 0 && breakerStage(next.noToolStreak, limits.noToolTurnsLimit) === "log")
    logs.push({ event: "no_tool_turn", count: next.noToolStreak });
  if (outcome.status === "cancelled")
    return { goal: moveTo(next, now, "paused", "user_interrupt"), logs };
  if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget)
    return { goal: moveTo(next, now, "budget_limited", "token_budget"), logs };
  if (outcome.status === "failed" && !outcome.timedOut)
    return {
      goal: moveTo(next, now, "blocked", "run_error", {
        detail: clip(outcome.error?.trim() || "The run failed."),
      }),
      logs,
    };
  if (next.turnsUsed >= next.maxTurns)
    return { goal: moveTo(next, now, "paused", "max_turns"), logs };
  if (next.activeMs >= next.maxWallMs)
    return { goal: moveTo(next, now, "paused", "max_wall"), logs };
  if (breakerStage(next.repeatStreak, limits.repeatedReplyLimit) === "pause")
    return { goal: moveTo(next, now, "paused", "no_progress", { detail: "repeated_reply" }), logs };
  if (breakerStage(next.noToolStreak, limits.noToolTurnsLimit) === "pause")
    return { goal: moveTo(next, now, "paused", "no_progress", { detail: "no_tool_turns" }), logs };
  return { goal: next, logs };
}

/**
 * The caps checked again right before a continuation starts (a run only settles after it ends, but
 * the budget may have been lowered, the cap reached by another surface, or the goal re-armed).
 */
export function checkCaps(goal: GoalRecord, now: number): GoalRecord | undefined {
  if (goal.status !== "active") return undefined;
  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget)
    return moveTo(goal, now, "budget_limited", "token_budget", { inflight: undefined });
  if (goal.turnsUsed >= goal.maxTurns)
    return moveTo(goal, now, "paused", "max_turns", { inflight: undefined });
  if (goal.activeMs >= goal.maxWallMs)
    return moveTo(goal, now, "paused", "max_wall", { inflight: undefined });
  return undefined;
}

/** The wire view (no internal counters). `waiting` is added by the host. */
export function toGoalInfo(goal: GoalRecord): GoalInfo {
  return {
    sessionId: goal.sessionId,
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    ...(goal.reason ? { reason: goal.reason } : {}),
    ...(goal.detail ? { detail: goal.detail } : {}),
    epoch: goal.epoch,
    ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
    tokensUsed: goal.tokensUsed,
    turnsUsed: goal.turnsUsed,
    maxTurns: goal.maxTurns,
    activeMs: goal.activeMs,
    maxWallMs: goal.maxWallMs,
    ...(goal.summary ? { summary: goal.summary } : {}),
    ...(goal.evidence?.length ? { evidence: goal.evidence } : {}),
    actions: userActions(goal.status),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.completedAt ? { completedAt: goal.completedAt } : {}),
  };
}
