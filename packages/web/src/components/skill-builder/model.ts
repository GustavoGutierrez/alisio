/**
 * Pure logic of the Skill Builder window (no DOM): the describe form and its request, the
 * progress stages shown while the model works, review-step editing, live validation and the
 * classification of save failures. The validation rules are the shared ones of `@alisio/sdk`
 * (the server runs the same function before writing).
 */
import {
  SKILL_LIMITS,
  type SkillDraft,
  type SkillDraftRequest,
  type SkillInclude,
  type SkillIssue,
  type SkillWriteScope,
  validateSkillDraft,
} from "@alisio/sdk";
import { ApiRequestError } from "../../net/api.ts";

export const IDEA_MAX = 4_000;
export const FEEDBACK_MAX = 2_000;

export type SkillBuilderStep = "describe" | "generating" | "review" | "saved";
export type IncludeKey = "scripts" | "templates" | "references";

export interface DescribeForm {
  idea: string;
  when: string;
  scope: SkillWriteScope;
  include: Partial<Record<IncludeKey, SkillInclude>>;
}

export const emptyDescribe = (scope: SkillWriteScope = "project"): DescribeForm => ({
  idea: "",
  when: "",
  scope,
  include: {},
});

/** What stops the form from being submitted, if anything. */
export function describeProblem(form: DescribeForm): "idea_required" | "idea_too_long" | undefined {
  const idea = form.idea.trim();
  if (!idea) return "idea_required";
  if (idea.length > IDEA_MAX) return "idea_too_long";
  return undefined;
}

/** The draft request: only filled fields; `auto` choices are the default and are not sent. */
export function buildRequest(
  form: DescribeForm,
  refine?: { previous: SkillDraft; feedback?: string },
): SkillDraftRequest {
  const include: NonNullable<SkillDraftRequest["include"]> = {};
  for (const key of ["scripts", "templates", "references"] as const) {
    const choice = form.include[key];
    if (choice === "yes" || choice === "no") include[key] = choice;
  }
  const when = form.when.trim();
  const feedback = refine?.feedback?.trim();
  return {
    idea: form.idea.trim(),
    ...(when ? { when } : {}),
    scope: form.scope,
    ...(Object.keys(include).length ? { include } : {}),
    ...(refine ? { previous: refine.previous } : {}),
    ...(feedback ? { feedback } : {}),
  };
}

export type StageId = "analyze" | "write" | "files" | "validate";
export type StageState = "pending" | "active" | "done";
export type GenerationPhase = "waiting" | "validating" | "done";

/** Elapsed time (ms) after which each timed hint moves on. These are estimates, not events. */
const HINT_AT = { write: 4_000, files: 25_000 } as const;

/**
 * The stages of the generating step. The model answers in one piece, so the first three are
 * timed hints that never claim completion while waiting; "validate" is the real check run on the
 * response (`validating`), and everything is done only after it (`done`).
 */
export function progressStages(
  elapsedMs: number,
  phase: GenerationPhase,
): Array<{ id: StageId; state: StageState }> {
  const ids: StageId[] = ["analyze", "write", "files", "validate"];
  const active =
    phase === "done"
      ? 4
      : phase === "validating"
        ? 3
        : elapsedMs >= HINT_AT.files
          ? 2
          : elapsedMs >= HINT_AT.write
            ? 1
            : 0;
  return ids.map((id, index) => ({
    id,
    state: index < active ? "done" : index === active ? "active" : "pending",
  }));
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export type DraftField = "name" | "description" | "body" | "compatibility" | "license";

export function setDraftField(draft: SkillDraft, field: DraftField, value: string): SkillDraft {
  if ((field === "compatibility" || field === "license") && !value) {
    const { [field]: _removed, ...rest } = draft;
    return rest;
  }
  return { ...draft, [field]: value };
}

export const setFileContent = (draft: SkillDraft, path: string, content: string): SkillDraft => ({
  ...draft,
  files: draft.files.map((file) => (file.path === path ? { ...file, content } : file)),
});

export const removeFile = (draft: SkillDraft, path: string): SkillDraft => ({
  ...draft,
  files: draft.files.filter((file) => file.path !== path),
});

export const draftIsDirty = (original: SkillDraft, current: SkillDraft): boolean =>
  JSON.stringify(original) !== JSON.stringify(current);

export interface TreeFile {
  path: string;
  name: string;
  lines: number;
  bytes: number;
  purpose?: string;
}
export interface TreeGroup {
  folder: string;
  files: TreeFile[];
}

/** Extra files grouped by top-level folder (scripts, references, assets), empty folders left out. */
export function fileTree(draft: SkillDraft): TreeGroup[] {
  const encoder = new TextEncoder();
  const groups: TreeGroup[] = [];
  for (const folder of ["scripts", "references", "assets"]) {
    const files = draft.files
      .filter((file) => file.path.startsWith(`${folder}/`))
      .map(
        (file): TreeFile => ({
          path: file.path,
          name: file.path.slice(file.path.lastIndexOf("/") + 1),
          lines: file.content.split("\n").length,
          bytes: encoder.encode(file.content).length,
          ...(file.purpose ? { purpose: file.purpose } : {}),
        }),
      );
    if (files.length) groups.push({ folder, files });
  }
  return groups;
}

export interface Review {
  errors: SkillIssue[];
  warnings: SkillIssue[];
  /** Errors and suggestions by field (`name`, `description`, `body`, `file`, ...). */
  byField: Record<string, SkillIssue[]>;
  canSave: boolean;
}

/** Live validation of the draft being edited; only errors block saving. */
export function reviewDraft(draft: SkillDraft, existingNames: string[]): Review {
  const { errors, warnings } = validateSkillDraft(draft, { existingNames });
  const byField: Record<string, SkillIssue[]> = {};
  for (const issue of [...errors, ...warnings]) (byField[issue.field] ??= []).push(issue);
  return { errors, warnings, byField, canSave: errors.length === 0 };
}

export type SaveFailure = "exists" | "untrusted" | "readonly" | "invalid" | "other";

/** How the UI reacts to a failed save: confirm an overwrite, offer trust, or show the message. */
export function saveFailure(error: unknown): SaveFailure {
  if (!(error instanceof ApiRequestError)) return "other";
  if (error.code === "skill_exists") return "exists";
  if (error.code === "not_manageable") return "untrusted";
  if (error.code === "capability_ceiling") return "readonly";
  if (error.code === "validation_failed") return "invalid";
  return "other";
}

export const LIMITS = SKILL_LIMITS;
