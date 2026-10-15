/**
 * The user's per-draft decisions on the acceptance criteria of a plan review (Proof, specs/011
 * phase 5). Pure: the answer key `plan:criteria` carries `{reject, edit, required}` by position of
 * the drafts as the review lists them; the core applies it only together with "approve".
 */
import type { PlanCriterionDraft } from "@alisio/sdk";

export interface DraftDecision {
  keep: boolean;
  text: string;
  required: boolean;
}

/** What the panel starts with: every draft kept as proposed. */
export const initialDecisions = (drafts: readonly PlanCriterionDraft[]): DraftDecision[] =>
  drafts.map((d) => ({ keep: true, text: d.text, required: d.required }));

/** The JSON of the selection, or `undefined` when nothing differs from the proposal. */
export function criteriaSelection(
  drafts: readonly PlanCriterionDraft[],
  decisions: readonly DraftDecision[],
): string | undefined {
  const reject: number[] = [];
  const edit: Record<string, string> = {};
  const required: Record<string, boolean> = {};
  drafts.forEach((draft, i) => {
    const d = decisions[i];
    if (!d) return;
    if (!d.keep) {
      reject.push(i);
      return;
    }
    const text = d.text.replace(/\s+/g, " ").trim();
    if (text && text !== draft.text) edit[String(i)] = text;
    if (d.required !== draft.required) required[String(i)] = d.required;
  });
  if (!reject.length && !Object.keys(edit).length && !Object.keys(required).length)
    return undefined;
  return JSON.stringify({
    ...(reject.length ? { reject } : {}),
    ...(Object.keys(edit).length ? { edit } : {}),
    ...(Object.keys(required).length ? { required } : {}),
  });
}
