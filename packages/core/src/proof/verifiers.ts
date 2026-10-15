/**
 * Pure judgements of the `file` and `data-check` verifiers (specs/011 3.1, D3). They read the
 * RAW result of a core tool call (`read_file`, `data_query`) and say whether the criterion holds;
 * they never touch the filesystem or a dataset themselves, so the only inputs that count are the
 * structured results of calls the runner really executed under its gate (D6).
 *
 * `undefined` from a judge means "this call cannot decide": a window of a file that does not
 * start at line 1, a scalar that is not a number. No evidence is better than a guess.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProofVerifierSpec } from "@alisio/sdk";

export type FileSpec = Extract<ProofVerifierSpec, { kind: "file" }>;
export type DataCheckSpec = Extract<ProofVerifierSpec, { kind: "data-check" }>;

/** A core tool call that makes a verifier's evidence appear when it runs. */
export interface VerifierCall {
  name: string;
  input: Record<string, unknown>;
}

/** What a judge concluded: the verdict and a short, secret-free sentence about it. */
export interface Judgement {
  ok: boolean;
  summary: string;
}

const DEFAULT_TABLE = "data";
/** Lines a pattern read asks for; `read_file` caps a window at 1000 lines. */
const PATTERN_LINES = 1000;
const NUMBER_TOLERANCE = 1e-9;

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** The single SQL statement whose result decides a `data-check` (no column: no verdict). */
export function canonicalSql(spec: DataCheckSpec): string | undefined {
  const from = `FROM ${quote(spec.table ?? DEFAULT_TABLE)}`;
  if (spec.check === "row_count") return `SELECT COUNT(*) ${from}`;
  if (!spec.column) return undefined;
  // TOTAL() is 0.0 over no rows where SUM() would be NULL.
  if (spec.check === "sum") return `SELECT TOTAL(${quote(spec.column)}) ${from}`;
  if (spec.check === "equals") return `SELECT DISTINCT ${quote(spec.column)} ${from} LIMIT 2`;
  return undefined;
}

/**
 * Case, quoting, spacing and a trailing `;` do not change a canonical query. Identifiers with
 * quotes or case differences collapse, which is what SQLite does with them anyway.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*;+$/, "")
    .toLowerCase();
}

/**
 * The tool call an on-demand verification runs for this spec, or undefined when the spec cannot
 * be checked by one (`manual`, `command`, `plugin`, or a data-check missing its column).
 */
export function verifierCall(spec: ProofVerifierSpec): VerifierCall | undefined {
  if (spec.kind === "file")
    return {
      name: "read_file",
      input: { path: spec.path, limit: spec.pattern ? PATTERN_LINES : 1 },
    };
  // The configured coverage command, as the `shell` call whose raw result the recorder judges.
  if (spec.kind === "coverage") return { name: "shell", input: { command: spec.command } };
  if (spec.kind === "data-check") {
    const sql = canonicalSql(spec);
    return sql ? { name: "data_query", input: { datasetId: spec.datasetId, sql } } : undefined;
  }
  return undefined;
}

/** Workspace-relative POSIX path, or undefined when it leaves the workspace. */
export function workspacePath(workspace: string, path: string): string | undefined {
  const rel = relative(workspace, resolve(workspace, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/** Does a `read_file` call (by its input) read the file this criterion names? */
export function readsFile(spec: FileSpec, inputPath: unknown, workspace: string): boolean {
  if (typeof inputPath !== "string") return false;
  const wanted = workspacePath(workspace, spec.path);
  return wanted !== undefined && wanted === workspacePath(workspace, inputPath);
}

/** Does a `data_query` call (by its input) run the canonical query of this criterion? */
export function runsCanonicalQuery(spec: DataCheckSpec, input: Record<string, unknown>): boolean {
  const canonical = canonicalSql(spec);
  return (
    canonical !== undefined &&
    input.datasetId === spec.datasetId &&
    typeof input.sql === "string" &&
    normalizeSql(input.sql) === normalizeSql(canonical)
  );
}

const LINE_PREFIX = /^\d+: ?/;

/** The text of a `read_file` window without its `N: ` line prefixes. */
function plainContent(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(LINE_PREFIX, ""))
    .join("\n");
}

function patternMatches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "m").test(text);
  } catch {
    return false; // an unusable pattern never verifies anything
  }
}

/**
 * Judges a successful `read_file` result against a `file` criterion: existence, sha256 and a
 * regex over the content (line anchors work: the pattern runs with the `m` flag). A refutation
 * needs the whole file in view; a window that starts after line 1 or stops early can only
 * confirm a match.
 */
export function judgeFile(spec: FileSpec, body: Record<string, unknown>): Judgement | undefined {
  const parts: string[] = ["exists"];
  let undecided = false;
  if (spec.sha256 !== undefined) {
    if (typeof body.sha256 !== "string")
      undecided = true; // too large to hash
    else if (body.sha256.toLowerCase() !== spec.sha256.toLowerCase())
      return { ok: false, summary: `sha256 differs (found ${body.sha256})` };
    else parts.push("sha256 matches");
  }
  if (spec.pattern !== undefined) {
    const content = typeof body.content === "string" ? plainContent(body.content) : "";
    if (patternMatches(spec.pattern, content)) parts.push("pattern matched");
    else if (body.truncated === false && body.startLine === 1)
      return { ok: false, summary: "pattern not found" };
    else undecided = true;
  }
  return undecided ? undefined : { ok: true, summary: parts.join("; ") };
}

/** `read_file` failed because the file is not there: the criterion is refuted. */
export function judgeMissingFile(errorText: string): Judgement | undefined {
  return /^File not found\b/.test(errorText) ? { ok: false, summary: "file not found" } : undefined;
}

/** A `data_query` text result: header, rows (tab separated) and the `[N rows…]` summary. */
function parseQuery(text: string): { rows: string[]; cut: boolean } | undefined {
  const lines = text.split("\n");
  const summary = lines.at(-1) ?? "";
  if (lines.length < 2 || !/^\[[\d,]+ rows?/.test(summary)) return undefined;
  return { rows: lines.slice(1, -1), cut: /truncated|shortened/.test(summary) };
}

const numeric = (cell: string | undefined): number | undefined => {
  if (cell === undefined || cell.trim() === "") return undefined;
  const value = Number(cell);
  return Number.isFinite(value) ? value : undefined;
};

const sameNumber = (a: number, b: number): boolean =>
  Math.abs(a - b) <= NUMBER_TOLERANCE * Math.max(1, Math.abs(b));

/** Judges the result text of the canonical query of a `data-check` criterion. */
export function judgeDataCheck(spec: DataCheckSpec, text: string): Judgement | undefined {
  const parsed = parseQuery(text);
  if (!parsed || parsed.cut) return undefined;
  const { rows } = parsed;
  if (spec.check === "equals") {
    if (rows.length === 0) return { ok: false, summary: "equals: the column has no values" };
    if (rows.length > 1) return { ok: false, summary: "equals: the column has several values" };
    const actual = rows[0] ?? "";
    const expected = String(spec.expected);
    const ok =
      actual === expected ||
      (numeric(actual) !== undefined &&
        numeric(expected) !== undefined &&
        sameNumber(numeric(actual) as number, numeric(expected) as number));
    return { ok, summary: `equals ${spec.column}: actual ${actual}, expected ${expected}` };
  }
  if (rows.length !== 1) return undefined;
  const actual = numeric(rows[0]);
  if (actual === undefined) return undefined;
  const expected = numeric(String(spec.expected));
  const label = spec.check === "sum" ? `sum of ${spec.column}` : "row_count";
  return {
    ok: expected !== undefined && sameNumber(actual, expected),
    summary: `${label}: actual ${actual}, expected ${spec.expected}`,
  };
}
