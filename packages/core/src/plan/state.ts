/**
 * Plan review state (`sessions.options.plan`) and the pure helpers around it. One entry per
 * session: the latest `exit_plan` proposal. Every transition is a compare-and-set inside one
 * `BEGIN IMMEDIATE` transaction, so it is safe across surfaces (and processes) that share the
 * database: whatever happens twice (a double click, a reload, two tabs) changes the state once.
 *
 * pending ──approve──▶ approved ──claim──▶ implementing
 *    ├────skip──────▶ skipped          └─discard─▶ cancelled (the run was cancelled)
 *    └────context───▶ feedback         (a later `exit_plan` call starts a new revision)
 */
import { createHash } from "node:crypto";
import type { QuestionOption } from "@alisio/sdk";

/** The decision screen title (web: localized; the TUI prints it as is). */
export const PLAN_REVIEW_TITLE = "Plan complete. What would you like to do?";
export const PLAN_QUESTION_ID = "plan";
export const PLAN_TEXT_KEY = `${PLAN_QUESTION_ID}:text`;
/** The agent an approved plan is handed to. */
export const IMPLEMENTATION_AGENT_ID = "build";
export const PLAN_MAX_CHARS = 60_000;
/** Longest "Add context" text accepted (the same bound everywhere). */
export const PLAN_CONTEXT_MAX_CHARS = 20_000;

/** The three decisions, with the exact visible English strings (the web localizes by `value`). */
export const PLAN_OPTIONS: QuestionOption[] = [
  { value: "approve", label: "Agree and start implementation", recommended: true },
  { value: "skip", label: "Skip for now" },
  {
    value: "context",
    label: "Add context",
    textInput: { placeholder: "Add context for the plan" },
  },
];

export type PlanStatus =
  | "pending"
  | "approved"
  | "implementing"
  | "skipped"
  | "feedback"
  | "cancelled";

export interface PlanState {
  /** One per `exit_plan` call. */
  planId: string;
  revision: number;
  hash: string;
  title: string;
  status: PlanStatus;
  callId?: string;
  artifactId?: string;
  /** The approved snapshot; kept only while `approved` (afterwards it lives in the user message). */
  plan?: string;
  updatedAt: number;
}

/** What a store must offer to keep plan state (`SQLiteStore` does). */
export interface PlanStore {
  mutateSessionOptions<T>(
    id: string,
    change: (current: Record<string, unknown>) => { patch?: Record<string, unknown>; value: T },
  ): T;
  get(id: string): { options?: Record<string, unknown> };
}

export const planHash = (plan: string): string =>
  createHash("sha256").update(plan, "utf8").digest("hex");

const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "implementing",
  "skipped",
  "feedback",
  "cancelled",
]);

/** The plan state stored in `options`, or undefined when absent or malformed. */
export function readPlanState(options: Record<string, unknown> | undefined): PlanState | undefined {
  const raw = options?.plan as Partial<PlanState> | undefined;
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.planId !== "string" ||
    typeof raw.hash !== "string" ||
    typeof raw.revision !== "number" ||
    typeof raw.status !== "string" ||
    !STATUSES.has(raw.status)
  )
    return undefined;
  return raw as PlanState;
}

export const currentPlan = (store: PlanStore, sessionId: string): PlanState | undefined =>
  readPlanState(store.get(sessionId).options);

/** The revision the next proposal of this session gets. */
export const nextPlanRevision = (store: PlanStore, sessionId: string): number =>
  (currentPlan(store, sessionId)?.revision ?? 0) + 1;

/** Records a new proposal (replacing any earlier one: only the latest plan can be decided). */
export function proposePlan(
  store: PlanStore,
  sessionId: string,
  input: Omit<PlanState, "status" | "updatedAt" | "plan"> & { status?: PlanStatus },
): PlanState {
  const state: PlanState = { ...input, status: input.status ?? "pending", updatedAt: Date.now() };
  return store.mutateSessionOptions(sessionId, () => ({ patch: { plan: state }, value: state }));
}

export type PlanDecision = "approve" | "skip" | "context";

/**
 * Applies the user's decision to the pending proposal `planId`. Returns the new state, or
 * undefined when that proposal is not pending any more (already decided, replaced, withdrawn).
 */
export function decidePlan(
  store: PlanStore,
  sessionId: string,
  planId: string,
  decision: PlanDecision,
  plan: string,
): PlanState | undefined {
  return store.mutateSessionOptions(sessionId, (options) => {
    const current = readPlanState(options);
    if (!current || current.planId !== planId || current.status !== "pending")
      return { value: undefined };
    const next: PlanState = {
      ...current,
      status: decision === "approve" ? "approved" : decision === "skip" ? "skipped" : "feedback",
      ...(decision === "approve" ? { plan } : {}),
      updatedAt: Date.now(),
    };
    return { patch: { plan: next }, value: next };
  });
}

/**
 * Hands an approved plan to the implementation turn, exactly once: `approved` becomes
 * `implementing` and `alsoSet` is merged into the session options in the same transaction (the
 * web switches the session to `build` there). A second call finds nothing and returns undefined.
 */
export function claimApprovedPlan(
  store: PlanStore,
  sessionId: string,
  alsoSet: Record<string, unknown> = {},
): (PlanState & { plan: string }) | undefined {
  return store.mutateSessionOptions(sessionId, (options) => {
    const current = readPlanState(options);
    if (!current || current.status !== "approved" || typeof current.plan !== "string")
      return { value: undefined };
    const { plan, ...rest } = current;
    const claimed: PlanState = { ...rest, status: "implementing", updatedAt: Date.now() };
    return { patch: { ...alsoSet, plan: claimed }, value: { ...claimed, plan } };
  });
}

/** An approved plan whose run was cancelled never starts anything: it is marked `cancelled`. */
export function discardApprovedPlan(store: PlanStore, sessionId: string): boolean {
  return store.mutateSessionOptions(sessionId, (options) => {
    const current = readPlanState(options);
    if (!current || current.status !== "approved") return { value: false };
    const { plan: _snapshot, ...rest } = current;
    return {
      patch: { plan: { ...rest, status: "cancelled", updatedAt: Date.now() } satisfies PlanState },
      value: true,
    };
  });
}

/** A proposal still `pending` when its run ends was never answered: it counts as skipped. */
export function withdrawPendingPlan(store: PlanStore, sessionId: string): boolean {
  return store.mutateSessionOptions(sessionId, (options) => {
    const current = readPlanState(options);
    if (!current || current.status !== "pending") return { value: false };
    return {
      patch: { plan: { ...current, status: "skipped", updatedAt: Date.now() } satisfies PlanState },
      value: true,
    };
  });
}

export type PlanFollowUp =
  | { kind: "none" }
  /** An approval the run's cancellation dropped before anything started. */
  | { kind: "dropped" }
  /** Start ONE implementation turn with this prompt (the claim already happened). */
  | { kind: "implement"; plan: PlanState & { plan: string }; text: string; display: string };

/**
 * What a host does when a run has ended (the same rules for the TUI and the server): a cancelled
 * run drops an approved plan, an unanswered review counts as skipped, and an approved plan is
 * claimed exactly once and turned into the implementation prompt.
 */
export function settlePlanRun(
  store: PlanStore,
  sessionId: string,
  options: { aborted: boolean; alsoSet?: Record<string, unknown> },
): PlanFollowUp {
  withdrawPendingPlan(store, sessionId);
  if (options.aborted)
    return discardApprovedPlan(store, sessionId) ? { kind: "dropped" } : { kind: "none" };
  const claimed = claimApprovedPlan(store, sessionId, options.alsoSet);
  if (!claimed) return { kind: "none" };
  return { kind: "implement", plan: claimed, ...implementationPrompt(claimed) };
}

/** The first Markdown heading, as a fallback title. */
export function planTitle(plan: string, given?: unknown): string {
  const explicit = typeof given === "string" ? given.trim() : "";
  if (explicit) return explicit.slice(0, 120);
  const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(plan)?.[1]?.trim();
  return (heading || "Implementation plan").slice(0, 120);
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The persisted user message of the implementation turn: the approved plan as an immutable
 * snapshot, plus the short `display` the UIs show instead of the whole plan (they already showed
 * it at review time).
 */
export function implementationPrompt(state: PlanState & { plan: string }): {
  text: string;
  display: string;
} {
  const artifact = state.artifactId ? `, artifact ${state.artifactId}` : "";
  return {
    text: [
      `Implement the approved plan (revision ${state.revision}, sha256 ${state.hash.slice(0, 12)}${artifact}).`,
      "The plan below is the approved snapshot. Follow it: do not plan again and do not ask for",
      "approval again. If a step turns out to be wrong or impossible, say so and make the smallest",
      "adjustment that keeps the plan's goal.",
      "",
      `<approved_plan title="${state.title.replace(/"/g, "'")}">`,
      state.plan,
      "</approved_plan>",
    ].join("\n"),
    display: `Implement the approved plan: ${oneLine(state.title, 100)}`,
  };
}
