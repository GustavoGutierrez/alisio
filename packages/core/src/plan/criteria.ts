/**
 * Validation of the acceptance criteria a model proposes in `exit_plan` (specs/011 3.6, O3).
 * Pure: no I/O. The result is a DRAFT: nothing here creates a criterion; the plan decision of
 * the user does (`exit-plan.ts`). The model may only propose verifier kinds Alisio can run today
 * (`command`, `file`, `data-check`, `coverage`, `plugin`, `manual`) and plain workspace-relative scopes.
 */
import type { PlanCriterionDraft, ProofVerifierSpec } from "@alisio/sdk";

export const CRITERIA_MAX = 20;
export const CRITERION_TEXT_MAX = 500;
const COMMAND_MAX = 1000;
const PATH_MAX = 500;
const PATTERN_MAX = 200;
const SCOPE_ENTRIES_MAX = 20;
const SCOPE_ENTRY_MAX = 256;
const EXIT_CODES_MAX = 10;
const DATASET_ID_MAX = 64;
const IDENTIFIER_MAX = 200;
const EXPECTED_MAX = 500;
const PLUGIN_INPUT_MAX = 4096;
const PLUGIN_VERIFIER_ID = /^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/;
const DATA_CHECKS = new Set(["row_count", "sum", "equals"]);

export interface DroppedCriterion {
  /** Zero-based position in the proposed list. */
  index: number;
  reason: string;
}

export interface ValidatedCriteria {
  accepted: PlanCriterionDraft[];
  dropped: DroppedCriterion[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max ? value : undefined;

function verifierOf(raw: unknown): ProofVerifierSpec | string {
  if (!isRecord(raw)) return "verifier must be an object";
  if (raw.kind === "manual") return { kind: "manual" };
  if (raw.kind === "command") {
    const command = text(raw.command, COMMAND_MAX)?.trim();
    if (!command) return "a command verifier needs a command";
    const cwd = raw.cwd === undefined ? undefined : text(raw.cwd, PATH_MAX);
    if (raw.cwd !== undefined && !cwd) return "cwd must be a short string";
    if (cwd && (isAbsoluteLike(cwd) || hasParentSegment(cwd)))
      return "cwd must stay in the workspace";
    const codes = raw.successExitCodes;
    if (
      codes !== undefined &&
      !(
        Array.isArray(codes) &&
        codes.length > 0 &&
        codes.length <= EXIT_CODES_MAX &&
        codes.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)
      )
    )
      return "successExitCodes must be a short list of exit codes";
    const pattern =
      raw.outputPattern === undefined ? undefined : text(raw.outputPattern, PATTERN_MAX);
    if (raw.outputPattern !== undefined && !pattern) return "outputPattern must be a short string";
    return {
      kind: "command",
      command,
      ...(cwd ? { cwd } : {}),
      ...(codes ? { successExitCodes: codes as number[] } : {}),
      ...(pattern ? { outputPattern: pattern } : {}),
    };
  }
  if (raw.kind === "file") {
    const path = text(raw.path, PATH_MAX)?.trim();
    if (!path || isAbsoluteLike(path) || hasParentSegment(path))
      return "a file verifier needs a workspace-relative path";
    const sha = typeof raw.sha256 === "string" && /^[0-9a-f]{64}$/.test(raw.sha256);
    const pattern = raw.pattern === undefined ? undefined : text(raw.pattern, PATTERN_MAX);
    if (raw.pattern !== undefined && !pattern) return "pattern must be a short string";
    if (raw.sha256 !== undefined && !sha) return "sha256 must be 64 hex characters";
    return {
      kind: "file",
      path,
      ...(sha ? { sha256: raw.sha256 as string } : {}),
      ...(pattern ? { pattern } : {}),
    };
  }
  if (raw.kind === "data-check") return dataCheckOf(raw);
  if (raw.kind === "coverage") {
    const command = text(raw.command, COMMAND_MAX)?.trim();
    if (!command) return "a coverage verifier needs a command";
    const min = raw.minPercent;
    if (typeof min !== "number" || !Number.isFinite(min) || min < 0 || min > 100)
      return "a coverage verifier needs minPercent between 0 and 100";
    return { kind: "coverage", command, minPercent: min };
  }
  if (raw.kind === "plugin") {
    const verifierId = typeof raw.verifierId === "string" ? raw.verifierId : "";
    if (!PLUGIN_VERIFIER_ID.test(verifierId))
      return "a plugin verifier needs a verifierId like pluginId:verifier";
    if (raw.input === undefined) return { kind: "plugin", verifierId };
    let size = Number.POSITIVE_INFINITY;
    try {
      size = JSON.stringify(raw.input)?.length ?? Number.POSITIVE_INFINITY;
    } catch {
      /* Not serializable: refused below. */
    }
    if (size > PLUGIN_INPUT_MAX) return "a plugin verifier input must be short JSON";
    return { kind: "plugin", verifierId, input: raw.input };
  }
  return "that verifier kind cannot be proposed (use command, file, data-check, coverage, plugin or manual)";
}

function dataCheckOf(raw: Record<string, unknown>): ProofVerifierSpec | string {
  const datasetId = text(raw.datasetId, DATASET_ID_MAX)?.trim();
  if (!datasetId) return "a data-check verifier needs a datasetId";
  const check = typeof raw.check === "string" ? raw.check : "";
  if (!DATA_CHECKS.has(check)) return "check must be row_count, sum or equals";
  const expected = raw.expected;
  const expectedOk =
    (typeof expected === "number" && Number.isFinite(expected)) ||
    (typeof expected === "string" && expected.length > 0 && expected.length <= EXPECTED_MAX);
  if (!expectedOk) return "a data-check verifier needs an expected number or short string";
  const column = raw.column === undefined ? undefined : text(raw.column, IDENTIFIER_MAX);
  if (raw.column !== undefined && !column) return "column must be a short string";
  if (check !== "row_count" && !column) return `a ${check} check needs a column`;
  const table = raw.table === undefined ? undefined : text(raw.table, IDENTIFIER_MAX);
  if (raw.table !== undefined && !table) return "table must be a short string";
  return {
    kind: "data-check",
    datasetId,
    check: check as "row_count" | "sum" | "equals",
    ...(column ? { column } : {}),
    expected: expected as number | string,
    ...(table ? { table } : {}),
  };
}

const isAbsoluteLike = (path: string): boolean =>
  path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
const hasParentSegment = (path: string): boolean => path.split(/[\\/]/).includes("..");

function scopeOf(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SCOPE_ENTRIES_MAX)
    return "scope must be a short list of globs";
  const out: string[] = [];
  for (const entry of raw) {
    const glob = text(entry, SCOPE_ENTRY_MAX)?.trim();
    if (!glob) return "every scope entry must be a short string";
    if (isAbsoluteLike(glob) || hasParentSegment(glob))
      return "scope entries must stay inside the workspace";
    out.push(glob);
  }
  return out;
}

/** Turns the model's `acceptanceCriteria` input into drafts, reporting what it could not keep. */
export function validateCriteriaDrafts(raw: unknown): ValidatedCriteria {
  const accepted: PlanCriterionDraft[] = [];
  const dropped: DroppedCriterion[] = [];
  if (!Array.isArray(raw)) {
    return { accepted, dropped: [{ index: 0, reason: "acceptanceCriteria must be an array" }] };
  }
  raw.forEach((entry, index) => {
    if (accepted.length >= CRITERIA_MAX) {
      dropped.push({ index, reason: `more than ${CRITERIA_MAX} criteria were proposed` });
      return;
    }
    if (!isRecord(entry)) {
      dropped.push({ index, reason: "a criterion must be an object" });
      return;
    }
    const statement = typeof entry.text === "string" ? entry.text.replace(/\s+/g, " ").trim() : "";
    if (!statement) {
      dropped.push({ index, reason: "a criterion needs text" });
      return;
    }
    let verifier: ProofVerifierSpec | undefined;
    if (entry.verifier !== undefined) {
      const checked = verifierOf(entry.verifier);
      if (typeof checked === "string") {
        dropped.push({ index, reason: checked });
        return;
      }
      verifier = checked;
    }
    let scope: string[] | undefined;
    if (entry.scope !== undefined) {
      const checked = scopeOf(entry.scope);
      if (typeof checked === "string") {
        dropped.push({ index, reason: checked });
        return;
      }
      scope = checked;
    }
    accepted.push({
      text:
        statement.length > CRITERION_TEXT_MAX ? statement.slice(0, CRITERION_TEXT_MAX) : statement,
      required: entry.required === true,
      ...(verifier ? { verifier } : {}),
      ...(scope ? { scope } : {}),
      origin: "inferred",
    });
  });
  return { accepted, dropped };
}

/**
 * Applies the user's per-draft decisions (`plan:criteria`) to the drafts of the plan they approved.
 * `undefined` selection keeps every draft (the plain "approve"). Anything malformed, any index
 * outside the list or an empty edit returns `undefined` for "nothing is activated": a selection
 * the user did not make cleanly never activates a criterion (fail closed).
 */
export function applyCriteriaSelection(
  drafts: readonly PlanCriterionDraft[],
  raw: unknown,
): { kept: PlanCriterionDraft[]; rejected: number } | undefined {
  if (raw === undefined || raw === "") return { kept: [...drafts], rejected: 0 };
  let selection: unknown;
  try {
    selection = typeof raw === "string" ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
  if (!isRecord(selection)) return undefined;
  const index = (key: unknown): number | undefined => {
    const n = typeof key === "string" ? Number(key) : (key as number);
    return Number.isInteger(n) && n >= 0 && n < drafts.length ? n : undefined;
  };
  const rejected = new Set<number>();
  if (selection.reject !== undefined) {
    if (!Array.isArray(selection.reject)) return undefined;
    for (const entry of selection.reject) {
      const i = index(entry);
      if (i === undefined) return undefined;
      rejected.add(i);
    }
  }
  const edits = new Map<number, string>();
  if (selection.edit !== undefined) {
    if (!isRecord(selection.edit)) return undefined;
    for (const [key, value] of Object.entries(selection.edit)) {
      const i = index(key);
      const statement = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      if (i === undefined || !statement) return undefined;
      edits.set(i, statement.slice(0, CRITERION_TEXT_MAX));
    }
  }
  const required = new Map<number, boolean>();
  if (selection.required !== undefined) {
    if (!isRecord(selection.required)) return undefined;
    for (const [key, value] of Object.entries(selection.required)) {
      const i = index(key);
      if (i === undefined || typeof value !== "boolean") return undefined;
      required.set(i, value);
    }
  }
  const kept = drafts.flatMap((draft, i): PlanCriterionDraft[] =>
    rejected.has(i)
      ? []
      : [
          {
            ...draft,
            text: edits.get(i) ?? draft.text,
            required: required.get(i) ?? draft.required,
          },
        ],
  );
  return { kept, rejected: rejected.size };
}
