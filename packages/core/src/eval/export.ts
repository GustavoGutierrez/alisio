/**
 * The shareable export of one evaluation run (specs/010 5.4, D9): a single JSON bundle
 * `{ schemaVersion: 1, report, runs[], markdown }` without absolute paths and without secrets.
 * Pure: the caller reads the files and supplies the roots to hide.
 *
 * - Known roots (home, data directory, run directory, temp directories) become placeholders; any
 *   other absolute path that remains becomes `<path>`. Scrubbing is pattern-based: it is not a
 *   guarantee against every sensitive string a task prompt, verifier detail or tool output holds.
 * - The cassette secret scanner runs over every string of the scrubbed bundle. A hit REFUSES the
 *   export (nothing is stripped) and names the field path, never the matched text.
 * - A provider id that is not a plain identifier may embed an endpoint host: it is reduced to
 *   `custom-endpoint` everywhere it appears.
 */

import type { EvalReport, EvalRunRecord } from "@alisio/sdk";
import { findSecrets } from "./secrets.ts";

export interface EvalExportBundle {
  schemaVersion: 1;
  report: EvalReport;
  runs: EvalRunRecord[];
  markdown: string;
}

export interface ExportContext {
  /** Absolute directories to hide, each with the placeholder that replaces it. */
  roots: Array<{ path: string; placeholder: string }>;
  /** Exact credential values to look for verbatim (profile and environment). */
  secrets?: string[];
}

/** The export holds something that looks like a secret; `fieldPath` says where, never what. */
export class EvalExportRefusedError extends Error {
  constructor(
    readonly fieldPath: string,
    readonly rules: string[],
  ) {
    super(
      `Refusing to export: ${fieldPath} looks like it holds a secret (${rules.join(", ")}). Nothing was written. Remove it from the run, or do not share this run.`,
    );
    this.name = "EvalExportRefusedError";
  }
}

const SAFE_PROVIDER = /^[A-Za-z0-9_-]+$/;
const HOST_FREE_PROVIDER = "custom-endpoint";
const NAME_CHAR = "[\\w.@+~-]";

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const trimSlash = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, "") : path);

const POSIX_PATH = new RegExp(`(?<![\\w.:/<>~-])/(?:${NAME_CHAR}+/)+${NAME_CHAR}*`, "g");
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s"'<>|,;]+/g;

function scrubber(ctx: ExportContext, providers: string[]): (text: string) => string {
  const roots = ctx.roots
    .map((r) => ({ path: trimSlash(r.path), placeholder: r.placeholder }))
    .filter((r) => r.path.length > 1)
    .sort((a, b) => b.path.length - a.path.length)
    .map((r) => ({
      pattern: new RegExp(`${escapeRegex(r.path)}(?!${NAME_CHAR})`, "g"),
      placeholder: r.placeholder,
    }));
  const hosts = [...providers].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const provider of hosts) out = out.split(provider).join(HOST_FREE_PROVIDER);
    for (const root of roots) out = out.replace(root.pattern, root.placeholder);
    return out.replace(WINDOWS_PATH, "<path>").replace(POSIX_PATH, "<path>");
  };
}

/** Rebuilds `value` with `fn` applied to every string (keys included untouched). */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/** Calls `visit` with the field path of every string in `value`. */
function walkStrings(value: unknown, path: string, visit: (text: string, path: string) => void) {
  if (typeof value === "string") visit(value, path);
  else if (Array.isArray(value))
    value.forEach((item, index) => walkStrings(item, `${path}[${index}]`, visit));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      walkStrings(item, path ? `${path}.${key}` : key, visit);
}

export function buildExportBundle(
  input: { report: EvalReport; runs: EvalRunRecord[]; markdown: string },
  ctx: ExportContext,
): EvalExportBundle {
  const providers = new Set<string>();
  for (const value of [input.report.conditions.provider, ...input.runs.map((r) => r.provider)])
    if (value && !SAFE_PROVIDER.test(value)) providers.add(value);
  const scrub = scrubber(ctx, [...providers]);
  const bundle: EvalExportBundle = {
    schemaVersion: 1,
    report: mapStrings(input.report, scrub) as EvalReport,
    runs: mapStrings(input.runs, scrub) as EvalRunRecord[],
    markdown: scrub(input.markdown),
  };
  walkStrings(bundle, "", (text, path) => {
    const rules = findSecrets(text, ctx.secrets ?? []);
    if (rules.length > 0) throw new EvalExportRefusedError(path, rules);
  });
  return bundle;
}
