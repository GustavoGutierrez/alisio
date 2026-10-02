/**
 * The ONE ordered list of reasons a goal does not continue right now. Hosts (TUI, server) build
 * a `GoalHostState` from what they can see and call `goalBlocker`; nothing else decides. A
 * blocker is a WAIT, not a state change: the goal stays `active` and continues when the cause is
 * gone (the host re-checks on the events that clear it).
 *
 * The order matters (the first match wins, and it is what the UI shows):
 *  1. not active          - nothing to continue (paused, blocked, budget_limited, complete, none)
 *  2. disabled            - `goal.enabled` is false
 *  3. busy                - a run of the session is in flight, or a continuation is already claimed
 *  4. queued_input        - the user has input queued: the user always goes first
 *  5. approval            - a permission request is waiting for the user
 *  6. question            - a question (or a plan review) is waiting for the user
 *  7. plan_mode           - the active agent is the plan agent
 *  8. background_tasks    - background tasks of the session are still running
 */
import type { GoalStatus, GoalWaiting } from "@alisio/sdk";

export interface GoalHostState {
  /** The goal's status, or undefined when the session has none. */
  status: GoalStatus | undefined;
  enabled: boolean;
  /** A run is executing (or queued) for the session, or another process holds the session. */
  running: boolean;
  /** A continuation was claimed and its run has not settled yet. */
  inflight: boolean;
  /** The user has typed or queued something that has not been sent yet. */
  queuedInput: boolean;
  /** What is waiting for the user, if anything. */
  awaiting?: "approval" | "question";
  /** The agent that would run is the plan agent. */
  planMode: boolean;
  /** Live background tasks of the session. */
  liveTasks: number;
}

export type GoalBlocker =
  | "not_active"
  | "disabled"
  | "busy"
  | "queued_input"
  | "approval"
  | "question"
  | "plan_mode"
  | "background_tasks";

/** The first reason the goal must not continue now, or undefined when it may. */
export function goalBlocker(state: GoalHostState): GoalBlocker | undefined {
  if (state.status !== "active") return "not_active";
  if (!state.enabled) return "disabled";
  if (state.running || state.inflight) return "busy";
  if (state.queuedInput) return "queued_input";
  if (state.awaiting === "approval") return "approval";
  if (state.awaiting === "question") return "question";
  if (state.planMode) return "plan_mode";
  if (state.liveTasks > 0) return "background_tasks";
  return undefined;
}

/** What the UI shows as "waiting for…" (a busy session is working, not waiting). */
export function waitingOf(blocker: GoalBlocker | undefined): GoalWaiting | undefined {
  switch (blocker) {
    case "approval":
      return "approval";
    case "question":
      return "question";
    case "queued_input":
      return "user_input";
    case "plan_mode":
      return "plan_mode";
    case "background_tasks":
      return "background_tasks";
    default:
      return undefined;
  }
}

/**
 * The label a UI shows for an active goal. A question or approval is shown even while the run
 * that asked it is still going (the run is what waits); the other waits only count once the
 * session is idle (a task running while the agent works is not "waiting").
 */
export function goalWaiting(state: GoalHostState): GoalWaiting | undefined {
  if (state.status !== "active" || !state.enabled) return undefined;
  if (state.awaiting) return state.awaiting;
  if (state.running || state.inflight) return undefined;
  return waitingOf(goalBlocker(state));
}
