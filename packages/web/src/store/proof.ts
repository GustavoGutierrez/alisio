/**
 * The Proof card's logic (specs/011 phase 5): the pure model the tests exercise and the actions
 * behind its buttons. This module is its own chunk (it loads when a session has criteria or the
 * Proof panel opens), so none of it is in the initial bundle. The ledger is read from
 * `GET /api/sessions/:sid/proof` and read again whenever `proof_updated` arrives; the actions send
 * the user's request and show the ledger the server answers with (the one every surface shows).
 */
import type {
  GoalInfo,
  ProofCriterion,
  ProofEvidence,
  ProofLedger,
  ProofStatus,
} from "@alisio/sdk";
import { signal } from "@preact/signals";
import { pk } from "../components/proof/strings.ts";
import { api, currentId, proofCount, showToast } from "./app.ts";
import { errorText } from "./errors.ts";

/** The ledger of the open session (`undefined` until loaded). */
export const ledger = signal<ProofLedger | undefined>(undefined);
/** A request is in flight (the buttons are disabled). */
export const working = signal(false);

export interface ProofRow {
  criterionId: string;
  text: string;
  status: ProofStatus;
  stale: boolean;
  required: boolean;
  origin: ProofCriterion["origin"];
  command?: string;
  /** The latest evidence of the criterion (the ledger lists them in capture order). */
  evidence?: Pick<ProofEvidence, "callId" | "exitCode" | "capturedAt" | "ok">;
  notApplicableReason?: string;
}

export function proofRows(source: ProofLedger): ProofRow[] {
  const byId = new Map(source.evidence.map((e) => [e.evidenceId, e]));
  return source.criteria.map((c) => {
    const latest = [...c.evidenceIds]
      .map((id) => byId.get(id))
      .filter((e): e is ProofEvidence => !!e)
      .at(-1);
    return {
      criterionId: c.criterionId,
      text: c.text,
      status: c.status,
      stale: !!c.stale,
      required: c.required,
      origin: c.origin,
      ...(c.verifier?.kind === "command" || c.verifier?.kind === "coverage"
        ? { command: c.verifier.command }
        : {}),
      ...(latest
        ? {
            evidence: {
              callId: latest.callId,
              ...(latest.exitCode !== undefined ? { exitCode: latest.exitCode } : {}),
              capturedAt: latest.capturedAt,
              ok: latest.ok,
            },
          }
        : {}),
      ...(c.notApplicableReason ? { notApplicableReason: c.notApplicableReason } : {}),
    };
  });
}

export interface ProofCounts {
  total: number;
  verified: number;
  failed: number;
  notChecked: number;
  manualReview: number;
  notApplicable: number;
  /** Required criteria that are failed, not checked or in manual review. */
  requiredUnmet: number;
}

export function proofCounts(source: ProofLedger): ProofCounts {
  const n = (status: ProofStatus) => source.criteria.filter((c) => c.status === status).length;
  return {
    total: source.criteria.length,
    verified: n("verified"),
    failed: n("failed"),
    notChecked: n("not_checked"),
    manualReview: n("manual_review"),
    notApplicable: n("not_applicable"),
    requiredUnmet: source.criteria.filter(
      (c) =>
        c.required &&
        (c.status === "failed" || c.status === "not_checked" || c.status === "manual_review"),
    ).length,
  };
}

/** The user's override exists for a goal that can still be worked on, over unmet required criteria. */
export function overrideAvailable(
  goal: Pick<GoalInfo, "status"> | null | undefined,
  source: ProofLedger | undefined,
): boolean {
  if (!goal || !source) return false;
  if (goal.status !== "active" && goal.status !== "paused" && goal.status !== "blocked")
    return false;
  return proofCounts(source).requiredUnmet > 0;
}

export const exportHref = (sessionId: string, format: "md" | "json"): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/proof/export?format=${format}`;

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/proof`;

/** Reads the ledger of a session (ignored when another session is open by the time it answers). */
export async function loadProof(sessionId: string): Promise<void> {
  try {
    const next = await api.request<ProofLedger>("GET", base(sessionId));
    if (currentId.value === sessionId) {
      ledger.value = next;
      proofCount.value = next.criteria.length;
    }
  } catch {
    /* the stream keeps it current; a failed read changes nothing */
  }
}

/** One user request that answers with the new ledger; a failure is a toast. */
async function act(sessionId: string, request: () => Promise<ProofLedger>): Promise<boolean> {
  working.value = true;
  try {
    const next = await request();
    if (currentId.value === sessionId) {
      ledger.value = next;
      proofCount.value = next.criteria.length;
    }
    return true;
  } catch (error) {
    showToast(pk("failed", { error: errorText(error) }));
    return false;
  } finally {
    working.value = false;
  }
}

export interface NewCriterionForm {
  text: string;
  verify?: string;
  required?: boolean;
}

export const addCriterion = (sessionId: string, form: NewCriterionForm): Promise<boolean> =>
  act(sessionId, () =>
    api.request<ProofLedger>("POST", `${base(sessionId)}/criteria`, {
      text: form.text,
      ...(form.verify ? { verify: form.verify } : {}),
      ...(form.required !== undefined ? { required: form.required } : {}),
    }),
  );

export const saveCriterion = (
  sessionId: string,
  criterionId: string,
  change: { text?: string; required?: boolean },
): Promise<boolean> =>
  act(sessionId, () =>
    api.request<ProofLedger>("POST", `${base(sessionId)}/criteria`, { criterionId, ...change }),
  );

export const markNotApplicable = (
  sessionId: string,
  criterionId: string,
  reason: string,
): Promise<boolean> =>
  act(sessionId, () =>
    api.request<ProofLedger>(
      "POST",
      `${base(sessionId)}/criteria/${encodeURIComponent(criterionId)}/not-applicable`,
      { reason },
    ),
  );
