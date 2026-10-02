/**
 * The goal controller: one service per application over the shared database. It holds no state of
 * its own (everything is in `session_goals`), so the TUI and the web server, which may run in
 * different processes, behave the same. Hosts call it at the same few moments:
 *
 *   user action        create / pause / resume / edit / clear / setBudget
 *   after every run    settle(sessionId, outcome)         (folds the run in, may stop the goal)
 *   whenever the cause of a wait may be gone
 *                      next(sessionId, hostState)         (claims ONE continuation, or waits)
 *   if a claimed continuation could not start
 *                      abandon(sessionId, requestId, kind)
 *   from the model     report(sessionId, runId, report)   (`update_goal`)
 *
 * A continuation is claimed with a compare-and-set (`inflight` request id `goal-<id>-<n>`), so a
 * double trigger (two surfaces, a retry, two events at once) starts ONE run: the second caller
 * finds the claim and waits.
 */
import { randomUUID } from "node:crypto";
import type { GoalEvidence, GoalInfo, GoalWaiting } from "@alisio/sdk";
import { type GoalBlocker, type GoalHostState, goalBlocker, waitingOf } from "./blockers.ts";
import { objectiveError } from "./command.ts";
import {
  checkCaps,
  DEFAULT_GOAL_LIMITS,
  type GoalLimits,
  type GoalLog,
  type GoalRecord,
  type GoalRunOutcome,
  modelBlocked,
  modelComplete,
  newGoal,
  settleRun,
  toGoalInfo,
  userBudget,
  userEdit,
  userPause,
  userResume,
} from "./machine.ts";
import { buildGoalPrompt, type GoalPrompt } from "./prompts.ts";
import { type GoalExpectation, type GoalStore } from "./store.ts";

/** `config.goal`, as the service reads it (live: a settings change applies to the next call). */
export interface GoalSettings {
  enabled: boolean;
  maxTurns: number;
  maxMinutes: number;
  repeatedReplyLimit: number;
  noToolTurnsLimit: number;
  blockedRepeats: number;
}

export const settingsToLimits = (settings: GoalSettings): GoalLimits => ({
  maxTurns: settings.maxTurns,
  maxWallMs: settings.maxMinutes * 60_000,
  repeatedReplyLimit: settings.repeatedReplyLimit,
  noToolTurnsLimit: settings.noToolTurnsLimit,
  blockedRepeats: settings.blockedRepeats,
});

export type GoalErrorCode =
  | "disabled"
  | "exists"
  | "invalid"
  | "not_found"
  | "conflict"
  | "not_allowed";

export type GoalOutcome =
  | { ok: true; goal: GoalRecord }
  | { ok: false; code: GoalErrorCode; message: string };

/** What the host sees about the session when it asks whether the goal may continue. */
export type GoalHostView = Omit<GoalHostState, "status" | "enabled" | "inflight">;

export type GoalDecision =
  | { kind: "idle" }
  /** A cap stopped the goal just now (the state changed; the host refreshes its UI). */
  | { kind: "stopped"; goal: GoalRecord }
  | { kind: "wait"; blocker: GoalBlocker; waiting?: GoalWaiting }
  | {
      kind: "continue";
      goal: GoalRecord;
      /** The idempotent request id of the run: `goal-<goalId>-<n>`. */
      requestId: string;
      prompt: GoalPrompt;
      run: {
        /** The run's own token cap: what is left of the goal's budget (absent = no budget). */
        maxTokens?: number;
        /** What is left of the goal's time cap, in ms (the host applies min with its own). */
        remainingMs: number;
      };
    };

export interface GoalServiceOptions {
  store: GoalStore;
  settings: () => GoalSettings;
  now?: () => number;
  ownerPid?: number;
  newId?: () => string;
  /** Called after every write (the goal as stored; `undefined` = removed). */
  onChange?: (sessionId: string, goal: GoalRecord | undefined) => void;
  /** Breaker observations (counts only; never the objective or the reply). */
  onLog?: (sessionId: string, log: GoalLog) => void;
}

export class GoalService {
  readonly store: GoalStore;
  private readonly clock: () => number;
  private readonly pid: number;

  constructor(private readonly options: GoalServiceOptions) {
    this.store = options.store;
    this.clock = options.now ?? Date.now;
    this.pid = options.ownerPid ?? process.pid;
  }

  get enabled(): boolean {
    return this.options.settings().enabled;
  }

  limits(): GoalLimits {
    return { ...DEFAULT_GOAL_LIMITS, ...settingsToLimits(this.options.settings()) };
  }

  get(sessionId: string): GoalRecord | undefined {
    return this.store.get(sessionId);
  }

  info(sessionId: string, waiting?: GoalWaiting): GoalInfo | undefined {
    const goal = this.store.get(sessionId);
    return goal ? { ...toGoalInfo(goal), ...(waiting ? { waiting } : {}) } : undefined;
  }

  private emit(sessionId: string, goal: GoalRecord | undefined): void {
    try {
      this.options.onChange?.(sessionId, goal);
    } catch {
      /* a UI hook never breaks the goal */
    }
  }

  private done(
    sessionId: string,
    result: GoalOutcome | { ok: true; goal: GoalRecord },
  ): GoalOutcome {
    if (result.ok) this.emit(sessionId, result.goal);
    return result;
  }

  /** Creates the session's goal, replacing an existing one only with `replace` (the UI asks first). */
  create(
    sessionId: string,
    input: { objective: string; tokenBudget?: number; replace?: boolean },
    expect?: GoalExpectation,
  ): GoalOutcome {
    if (!this.enabled)
      return { ok: false, code: "disabled", message: "Goals are turned off (goal.enabled)." };
    const invalid = objectiveError(input.objective);
    if (invalid) return { ok: false, code: "invalid", message: invalid };
    const limits = this.limits();
    const now = this.clock();
    const goalId = (this.options.newId ?? (() => randomUUID().replace(/-/g, "").slice(0, 10)))();
    const outcome = this.store.replace(
      sessionId,
      (previous) =>
        previous && !input.replace
          ? "exists"
          : newGoal({
              sessionId,
              goalId,
              objective: input.objective.trim(),
              ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
              limits,
              epoch: (previous?.epoch ?? 0) + 1,
              now,
              ownerPid: this.pid,
            }),
      expect,
    );
    if (!outcome.ok) return outcome;
    return this.done(sessionId, outcome);
  }

  private act(
    sessionId: string,
    expect: GoalExpectation | undefined,
    apply: (goal: GoalRecord) => ReturnType<typeof userPause>,
  ): GoalOutcome {
    const outcome = this.store.update<ReturnType<typeof userPause>>(
      sessionId,
      (goal) => {
        const result = apply(goal);
        return result.ok ? { goal: result.goal, value: result } : { value: result };
      },
      expect,
    );
    if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
    const result = outcome.value;
    if (!result.ok) return { ok: false, code: "not_allowed", message: result.message };
    return this.done(sessionId, { ok: true, goal: result.goal });
  }

  pause(sessionId: string, expect?: GoalExpectation): GoalOutcome {
    return this.act(sessionId, expect, (goal) => userPause(goal, this.clock()));
  }

  resume(sessionId: string, expect?: GoalExpectation): GoalOutcome {
    if (!this.enabled)
      return { ok: false, code: "disabled", message: "Goals are turned off (goal.enabled)." };
    const limits = this.limits();
    return this.act(sessionId, expect, (goal) => userResume(goal, this.clock(), limits, this.pid));
  }

  edit(sessionId: string, objective: string, expect?: GoalExpectation): GoalOutcome {
    const invalid = objectiveError(objective);
    if (invalid) return { ok: false, code: "invalid", message: invalid };
    return this.act(sessionId, expect, (goal) => userEdit(goal, this.clock(), objective.trim()));
  }

  setBudget(sessionId: string, tokens: number | null, expect?: GoalExpectation): GoalOutcome {
    return this.act(sessionId, expect, (goal) => userBudget(goal, this.clock(), tokens, this.pid));
  }

  clear(sessionId: string, expect?: GoalExpectation): GoalOutcome {
    const outcome = this.store.delete(sessionId, expect);
    if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
    this.emit(sessionId, undefined);
    return { ok: true, goal: outcome.goal };
  }

  /** Folds a finished run into the goal (idempotent per run) and applies the stops. */
  settle(sessionId: string, outcome: GoalRunOutcome): GoalRecord | undefined {
    const limits = this.limits();
    const logs: GoalLog[] = [];
    const result = this.store.update(sessionId, (goal) => {
      const settled = settleRun(goal, outcome, limits, this.clock());
      logs.push(...settled.logs);
      return settled.goal === goal
        ? { value: undefined }
        : { goal: settled.goal, value: undefined };
    });
    if (!result.ok) return undefined;
    for (const log of logs)
      try {
        this.options.onLog?.(sessionId, log);
      } catch {
        /* logging never breaks the goal */
      }
    this.emit(sessionId, result.goal);
    return result.goal;
  }

  /**
   * Decides whether the goal continues now. Caps are checked first (the budget may have been
   * lowered, or another surface used the turns), then the one ordered list of blockers; only
   * then is ONE continuation claimed.
   */
  next(sessionId: string, view: GoalHostView): GoalDecision {
    const settings = this.options.settings();
    const limits = this.limits();
    const now = this.clock();
    let stoppedBy: GoalRecord | undefined;
    const claimed = this.store.update<GoalDecision>(sessionId, (goal) => {
      const capped = checkCaps(goal, now);
      if (capped) {
        stoppedBy = capped;
        return { goal: capped, value: { kind: "stopped", goal: capped } };
      }
      const blocker = goalBlocker({
        ...view,
        status: goal.status,
        enabled: settings.enabled,
        inflight: !!goal.inflight,
      });
      if (blocker) {
        const waiting = waitingOf(blocker);
        return {
          value:
            blocker === "not_active"
              ? { kind: "idle" }
              : { kind: "wait", blocker, ...(waiting ? { waiting } : {}) },
        };
      }
      const prompt = buildGoalPrompt(goal, limits);
      const n = goal.continuations + 1;
      const requestId = `goal-${goal.goalId}-${n}`;
      const next: GoalRecord = {
        ...goal,
        continuations: n,
        inflight: requestId,
        kickoffSent: true,
        ownerPid: this.pid,
        updatedAt: now,
      };
      return {
        goal: next,
        value: {
          kind: "continue",
          goal: next,
          requestId,
          prompt,
          run: {
            ...(next.tokenBudget !== undefined
              ? { maxTokens: Math.max(1, next.tokenBudget - next.tokensUsed) }
              : {}),
            remainingMs: Math.max(1, next.maxWallMs - next.activeMs),
          },
        },
      };
    });
    if (!claimed.ok) return { kind: "idle" };
    if (stoppedBy) {
      this.emit(sessionId, stoppedBy);
      return { kind: "stopped", goal: stoppedBy };
    }
    return claimed.value as GoalDecision;
  }

  /** The claimed continuation could not start: give the claim back (the next call may retry). */
  abandon(sessionId: string, requestId: string, kind: GoalPrompt["kind"]): void {
    const result = this.store.update(sessionId, (goal) =>
      goal.inflight !== requestId
        ? { value: undefined }
        : {
            goal: {
              ...goal,
              inflight: undefined,
              continuations: Math.max(0, goal.continuations - 1),
              ...(kind === "kickoff" ? { kickoffSent: false } : {}),
              updatedAt: this.clock(),
            },
            value: undefined,
          },
    );
    if (result.ok) this.emit(sessionId, result.goal);
  }

  /** `update_goal` (the model): the only transitions the model can cause. */
  report(
    sessionId: string,
    runId: string | undefined,
    report: { status: "complete" | "blocked"; summary: string; evidence: GoalEvidence[] },
  ):
    | { ok: true; goal: GoalRecord; stopped: boolean; needed?: number }
    | { ok: false; code: GoalErrorCode; message: string } {
    const limits = this.limits();
    type Reported =
      | { ok: true; stopped: boolean; needed: number | undefined }
      | { ok: false; message: string };
    const outcome = this.store.update<Reported>(sessionId, (goal) => {
      if (report.status === "complete") {
        const result = modelComplete(goal, this.clock(), report);
        return result.ok
          ? { goal: result.goal, value: { ok: true, stopped: true, needed: undefined } }
          : { value: { ok: false, message: result.message } };
      }
      const result = modelBlocked(
        goal,
        this.clock(),
        { summary: report.summary, evidence: report.evidence, runId },
        limits,
      );
      return result.ok
        ? {
            goal: result.goal.goal,
            value: { ok: true, stopped: result.goal.stopped, needed: result.goal.needed },
          }
        : { value: { ok: false, message: result.message } };
    });
    if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
    const value = outcome.value;
    if (!value.ok) return { ok: false, code: "not_allowed", message: value.message };
    this.emit(sessionId, outcome.goal);
    return {
      ok: true,
      goal: outcome.goal,
      stopped: value.stopped,
      ...(value.needed ? { needed: value.needed } : {}),
    };
  }

  /** Startup: goals whose driver process is gone pause with reason `restart`. */
  recover(): GoalRecord[] {
    const paused = this.store.pauseOrphans(this.clock());
    for (const goal of paused) this.emit(goal.sessionId, goal);
    return paused;
  }
}
