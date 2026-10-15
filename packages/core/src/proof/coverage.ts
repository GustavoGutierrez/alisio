/**
 * Pure parser and judge of the `coverage` verifier (specs/011 3.1, Fase 7). They read the text a
 * coverage command printed and say whether the overall percentage reaches `minPercent`; they never
 * run anything and never generate tests. The evidence itself is captured by the recorder from the
 * RAW result of a call the runner executed under its gate (D3, D6).
 *
 * Formats, tried from the most explicit overall figure to the least:
 *  1. `coverage.py` / pytest-cov: the `TOTAL` row (last percentage) or `Total coverage: N%`.
 *  2. A text table (vitest, c8, istanbul): the `All files` row, `% Lines` column.
 *  3. An istanbul `text-summary`: the `Lines : N%` row.
 *  4. `lcov --summary`: the `lines......: N%` row.
 *  5. Raw `lcov` tracefile: sum of `LH` over sum of `LF`.
 * Per-file rows never stand in for the total: a missing overall figure is "not found", so an
 * unparseable output can never verify a criterion. Several matches of one format: the last wins.
 */
import type { ProofVerifierSpec } from "@alisio/sdk";

export type CoverageSpec = Extract<ProofVerifierSpec, { kind: "coverage" }>;
export type CoverageFormat = "coverage.py" | "table" | "summary" | "lcov-summary" | "lcov";

export interface ParsedCoverage {
  percent: number;
  format: CoverageFormat;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const NUMBER = String.raw`(\d{1,3}(?:\.\d+)?)`;

const valid = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 100;

const lastMatch = (text: string, pattern: RegExp): RegExpExecArray | undefined => {
  let found: RegExpExecArray | undefined;
  for (const match of text.matchAll(pattern)) found = match;
  return found;
};

function pythonTotal(text: string): number | undefined {
  // pytest-cov prints the precise figure on its own line; prefer it over the rounded TOTAL row.
  const line = lastMatch(text, new RegExp(String.raw`Total coverage:\s*${NUMBER}%`, "gi"));
  if (line?.[1]) return Number(line[1]);
  const row = lastMatch(
    text,
    new RegExp(String.raw`^\s*TOTAL\b[^\n]*?(?<![\d.])${NUMBER}%[ \t]*$`, "gim"),
  );
  return row?.[1] ? Number(row[1]) : undefined;
}

function tableTotal(text: string): number | undefined {
  const lines = text.split("\n");
  let column = -1;
  let result: number | undefined;
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const header = cells.findIndex((cell) => /^%\s*lines?$/i.test(cell));
    if (header >= 0) {
      column = header;
      continue;
    }
    if (column < 0 || !/^all files$/i.test(cells[0] ?? "")) continue;
    const raw = (cells[column] ?? "").replace(/%$/, "");
    result = /^\d{1,3}(?:\.\d+)?$/.test(raw) ? Number(raw) : undefined;
  }
  return result;
}

function summaryLines(text: string): number | undefined {
  const row = lastMatch(text, new RegExp(String.raw`^\s*Lines\s*:\s*${NUMBER}%`, "gim"));
  return row?.[1] ? Number(row[1]) : undefined;
}

function lcovSummary(text: string): number | undefined {
  const row = lastMatch(text, new RegExp(String.raw`^\s*lines\.+:\s*${NUMBER}%`, "gim"));
  return row?.[1] ? Number(row[1]) : undefined;
}

function lcovTracefile(text: string): number | undefined {
  let found = 0;
  let hit = 0;
  for (const match of text.matchAll(/^(LF|LH):(\d+)\s*$/gm)) {
    if (match[1] === "LF") found += Number(match[2]);
    else hit += Number(match[2]);
  }
  return found > 0 ? (hit / found) * 100 : undefined;
}

const PARSERS: ReadonlyArray<[CoverageFormat, (text: string) => number | undefined]> = [
  ["coverage.py", pythonTotal],
  ["table", tableTotal],
  ["summary", summaryLines],
  ["lcov-summary", lcovSummary],
  ["lcov", lcovTracefile],
];

/** The overall coverage percentage a command printed, or undefined when there is none to trust. */
export function parseCoverage(output: string): ParsedCoverage | undefined {
  const text = output.replace(ANSI, "");
  for (const [format, parse] of PARSERS) {
    const percent = parse(text);
    if (percent !== undefined && valid(percent)) return { percent, format };
  }
  return undefined;
}

/** What a coverage judgement concluded: the verdict and a short, secret-free sentence about it. */
export interface CoverageJudgement {
  ok: boolean;
  summary: string;
}

const shown = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * Judges what the coverage command did. It verifies only when the command exited 0 AND an overall
 * percentage was found AND it reaches `minPercent` (inclusive); every other case is a failure with
 * a reason, so an unparseable output or a crashed run is never silently verified.
 */
export function judgeCoverage(
  spec: CoverageSpec,
  run: { exitCode: number; output: string },
): CoverageJudgement {
  const parsed = parseCoverage(run.output);
  if (!parsed)
    return {
      ok: false,
      summary: `no coverage percentage found in the output (command exited ${run.exitCode}); expected lcov, a vitest/istanbul table or coverage.py report`,
    };
  const percent = `${shown(parsed.percent)}%`;
  if (run.exitCode !== 0)
    return {
      ok: false,
      summary: `the coverage command exited ${run.exitCode} (reported ${percent}, ${parsed.format})`,
    };
  if (parsed.percent < spec.minPercent)
    return {
      ok: false,
      summary: `coverage ${percent} is below the minimum ${shown(spec.minPercent)}% (${parsed.format})`,
    };
  return {
    ok: true,
    summary: `coverage ${percent} reaches the minimum ${shown(spec.minPercent)}% (${parsed.format})`,
  };
}
