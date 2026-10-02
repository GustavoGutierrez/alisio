/**
 * The goal bar's logic (`/goal`): the pure helpers the tests exercise and the actions behind its
 * buttons. The module is its own chunk (the bar loads when a session has a goal, or when `/goal`
 * is typed), so none of this is in the initial bundle. The state itself (`goalInfo`) is kept by
 * the stream in `store/app.ts`; every change arrives as a `goal_changed` frame, so the actions
 * here only send the request and leave the display to the frame.
 *
 * Each request carries what this window last saw (`expect: {goalId, epoch}`): when the goal moved
 * on (another window, or the agent finishing it) the server answers 409 and the bar reloads it.
 */
import type { CommandOutcome, GoalAction, GoalInfo } from "@alisio/sdk";
import { signal } from "@preact/signals";
import { gk } from "../components/goal/strings.ts";
import { ApiRequestError, newId } from "../net/api.ts";
import { api, currentId, goalInfo, showToast, transcript } from "./app.ts";
import { errorText } from "./errors.ts";
import { addLocalNote } from "./transcript.ts";

/** The bar's form is open (the objective and the budget are edited together). */
export const editing = signal(false);
/** An action is in flight (its button is disabled). */
export const working = signal(false);

/** Share of the token budget spent, 0–100 (`undefined` without a budget). */
export function budgetPercent(
  goal: Pick<GoalInfo, "tokensUsed" | "tokenBudget">,
): number | undefined {
  if (!goal.tokenBudget) return undefined;
  return Math.min(100, Math.max(0, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)));
}

/** How the budget bar is coloured: calm, close to the limit, spent. */
export function budgetLevel(percent: number | undefined): "ok" | "warn" | "danger" {
  if (percent === undefined) return "ok";
  return percent >= 100 ? "danger" : percent >= 80 ? "warn" : "ok";
}

/** `12.3k`, `50k`, `1.5M`, `812`. */
export function compactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  const trim = (value: string) => value.replace(/\.0$/, "");
  if (tokens < 1_000_000) {
    const k = tokens / 1_000;
    return `${k < 100 ? trim(k.toFixed(1)) : Math.round(k)}k`;
  }
  return `${trim((tokens / 1_000_000).toFixed(1))}M`;
}

/** `45s`, `4m 12s`, `1h 05m`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The buttons the bar shows for a goal (the server says which actions the state allows). */
export function barActions(goal: Pick<GoalInfo, "actions">): GoalAction[] {
  return (["pause", "resume", "edit", "clear"] as const).filter((action) =>
    goal.actions.includes(action),
  );
}

/** Whether the bar carries the report of the agent (complete, blocked) worth showing at once. */
export const hasReport = (goal: Pick<GoalInfo, "summary" | "status">): boolean =>
  !!goal.summary && (goal.status === "complete" || goal.status === "blocked");

const seen = (goal: GoalInfo) => ({ goalId: goal.goalId, epoch: goal.epoch });

/** Reads the goal again (after a conflict, or when this window may have missed a frame). */
export async function reloadGoal(sessionId: string): Promise<void> {
  try {
    const { goal } = await api.request<{ goal: GoalInfo | null }>(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/goal`,
    );
    if (currentId.value === sessionId) goalInfo.value = goal;
  } catch {
    /* the stream keeps it current; a failed reload changes nothing */
  }
}

/** Runs one request; a conflict reloads the goal and says so, anything else is a toast. */
async function act<T>(sessionId: string, request: () => Promise<T>): Promise<T | undefined> {
  working.value = true;
  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "goal_conflict") {
      showToast(gk("changed"));
      await reloadGoal(sessionId);
    } else showToast(gk("failed", { error: errorText(error) }));
    return undefined;
  } finally {
    working.value = false;
  }
}

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/goal`;

export async function pauseGoal(goal: GoalInfo): Promise<void> {
  await act(goal.sessionId, () =>
    api.request("POST", `${base(goal.sessionId)}/pause`, { expect: seen(goal) }),
  );
}

export async function resumeGoal(goal: GoalInfo): Promise<void> {
  await act(goal.sessionId, () =>
    api.request("POST", `${base(goal.sessionId)}/resume`, { expect: seen(goal) }),
  );
}

export async function clearGoal(goal: GoalInfo): Promise<void> {
  if (!window.confirm(gk("clearConfirm"))) return;
  const { goalId, epoch } = seen(goal);
  await act(goal.sessionId, () =>
    api.request(
      "DELETE",
      `${base(goal.sessionId)}?goalId=${encodeURIComponent(goalId)}&epoch=${epoch}`,
    ),
  );
}

/**
 * Saves the form: a changed objective goes to the goal route; the budget text (`50k`, `1.5M`,
 * `clear`) goes through the `/goal budget=` command, so the server's one parser reads it.
 * Returns whether it worked (the form stays open otherwise).
 */
export async function saveGoal(
  goal: GoalInfo,
  form: { objective: string; budget: string },
): Promise<boolean> {
  const objective = form.objective.trim();
  const budget = form.budget.trim();
  const sessionId = goal.sessionId;
  let expect = seen(goal);
  const ok = await act(sessionId, async () => {
    if (objective && objective !== goal.objective) {
      const { goal: next } = await api.request<{ goal: GoalInfo | null }>(
        "PATCH",
        base(sessionId),
        {
          objective,
          expect,
        },
      );
      if (next) expect = seen(next);
    }
    const wanted = budget === "" ? "clear" : budget;
    const current = goal.tokenBudget === undefined ? "clear" : String(goal.tokenBudget);
    if (wanted !== current && wanted.toLowerCase() !== current) {
      await api.request<CommandOutcome>(
        "POST",
        `/api/sessions/${encodeURIComponent(sessionId)}/commands`,
        {
          requestId: newId(),
          name: "goal",
          args: `budget=${wanted}`,
        },
      );
    }
    return true;
  });
  if (ok) editing.value = false;
  return !!ok;
}

/**
 * A typed `/goal …`: the server parses it (the same grammar as the terminal). A new objective over
 * an existing goal asks first; `/goal edit` without text opens the bar's form; the answer is a note.
 */
export async function runGoalCommand(sessionId: string, args: string): Promise<void> {
  const send = (confirm: boolean) =>
    api.request<CommandOutcome>("POST", `/api/sessions/${encodeURIComponent(sessionId)}/commands`, {
      requestId: newId(),
      name: "goal",
      ...(args ? { args } : {}),
      ...(confirm ? { confirm: true } : {}),
    });
  const show = (text: string) => {
    if (currentId.value === sessionId) transcript.value = addLocalNote(transcript.value, text);
  };
  try {
    let outcome: CommandOutcome;
    try {
      outcome = await send(false);
    } catch (error) {
      const exists =
        error instanceof ApiRequestError &&
        error.code === "goal_conflict" &&
        (error.details as { reason?: string } | undefined)?.reason === "exists";
      if (!exists || !window.confirm(gk("replace"))) throw error;
      outcome = await send(true);
    }
    if (outcome.effects?.includes("goal_edit")) editing.value = true;
    else if (outcome.output) show(outcome.output);
    if (outcome.effects?.includes("goal")) await reloadGoal(sessionId);
  } catch (error) {
    show(`**/goal**: ${errorText(error)}`);
  }
}
