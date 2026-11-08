/**
 * Technical QA (spec 026 §5.8): glyph coverage and text normalization before the render, PDF and
 * DOM findings after it. Findings carry stable codes; `repair.ts` maps them to presentation hints.
 */
import { readFile } from "node:fs/promises";
import { DOCUMENT_LIMITS } from "./limits.ts";
import { isBundledFontName, type PdfScan } from "./pdf-scan.ts";
import type { DomMeasurements } from "./ports.ts";
import { assetsRoot } from "./themes.ts";

export interface Finding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  blockIndex?: number;
}

type Range = [number, number];
let coverageCache: Range[] | undefined;

/** Unicode ranges covered by the bundled fonts (generated `coverage.json`). */
export async function loadCoverage(): Promise<Range[]> {
  if (coverageCache) return coverageCache;
  const raw = JSON.parse(await readFile(`${assetsRoot()}fonts/coverage.json`, "utf8")) as Record<
    string,
    string[]
  >;
  const ranges: Range[] = [];
  for (const list of Object.values(raw))
    for (const part of list) {
      const m = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(part);
      if (m?.[1]) ranges.push([Number.parseInt(m[1], 16), Number.parseInt(m[2] ?? m[1], 16)]);
    }
  coverageCache = ranges;
  return ranges;
}

const covered = (cp: number, ranges: Range[]) => ranges.some(([a, b]) => cp >= a && cp <= b);

/** Symbols the bundled subsets lack (D-21) and a plain replacement for each. */
const SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[‐‑⁃]/g, "-"],
  [/→/g, "->"],
  [/←/g, "<-"],
  [/≤/g, "<="],
  [/≥/g, ">="],
  [/≠/g, "!="],
  [/[✓✔]/g, "OK"],
  [/[✗✘]/g, "x"],
  [/‰/g, "o/oo"],
];
const EMOJI = /[\p{Extended_Pictographic}‍️⃣]/gu;

const SCRIPTS: Array<[string, RegExp]> = [
  [
    "CJK (Chinese, Japanese, Korean)",
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  ],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
];

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  return value;
}

function forEachString(value: unknown, fn: (s: string) => void): void {
  if (typeof value === "string") fn(value);
  else if (Array.isArray(value)) for (const v of value) forEachString(v, fn);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) forEachString(v, fn);
}

export interface TextCheck<T> {
  value: T;
  findings: Finding[];
}

/** Substitutes missing symbols, removes emoji (Q2) and reports uncovered codepoints. */
export async function checkText<T>(input: T): Promise<TextCheck<T>> {
  const findings: Finding[] = [];
  let substituted = false;
  let emoji = false;
  const value = mapStrings(input, (s) => {
    let out = s;
    for (const [re, to] of SUBSTITUTIONS) {
      const next = out.replace(re, to);
      if (next !== out) substituted = true;
      out = next;
    }
    const noEmoji = out.replace(EMOJI, "");
    if (noEmoji !== out) emoji = true;
    return noEmoji;
  });
  if (substituted)
    findings.push({
      code: "symbols_substituted",
      severity: "info",
      message:
        "Symbols missing from the bundled fonts (arrows, comparison signs, check marks) were replaced by plain text.",
    });
  if (emoji)
    findings.push({
      code: "emoji_removed",
      severity: "warning",
      message: "Emoji are not supported and were removed from the document.",
    });
  const ranges = await loadCoverage();
  const missing = new Set<string>();
  forEachString(value, (s) => {
    for (const ch of s) {
      const cp = ch.codePointAt(0) as number;
      if (cp < 32 || cp === 0x7f || /\s/u.test(ch)) continue;
      if (!covered(cp, ranges)) missing.add(ch);
    }
  });
  if (missing.size) {
    const sample = [...missing].slice(0, 10).join(" ");
    const scripts = SCRIPTS.filter(([, re]) => [...missing].some((c) => re.test(c))).map(
      ([n]) => n,
    );
    findings.push({
      code: "glyphs_missing",
      severity: "error",
      message: `${missing.size} character(s) have no glyph in the bundled fonts (${sample})${scripts.length ? `; unsupported script: ${scripts.join(", ")}` : ""}. Remove them or use Latin, Greek or Cyrillic text.`,
    });
  }
  return { value, findings };
}

/** A trailing page with (almost) no text operators holds only header and footer. */
export const BLANK_PAGE_TEXT_OPS = 12;

export function analyzeOutput(
  scan: PdfScan,
  measurements: DomMeasurements | undefined,
  opts: { overflowChecked: boolean },
): Finding[] {
  const out: Finding[] = [];
  if (scan.pages > DOCUMENT_LIMITS.pages)
    out.push({
      code: "page_limit",
      severity: "error",
      message: `The document has ${scan.pages} pages; the limit is ${DOCUMENT_LIMITS.pages}.`,
    });
  const foreign = scan.fonts.filter((f) => !isBundledFontName(f.name));
  if (foreign.length)
    out.push({
      code: "font_not_bundled",
      severity: "error",
      message: `The PDF embeds fonts that are not bundled: ${foreign
        .map((f) => f.name)
        .slice(0, 5)
        .join(", ")}.`,
    });
  if (scan.pages > 1 && (scan.textOpsPerPage[scan.pages - 1] ?? 99) <= BLANK_PAGE_TEXT_OPS)
    out.push({
      code: "blank_trailing_page",
      severity: "warning",
      message: "The last page is empty.",
    });
  for (const o of measurements?.overflow ?? [])
    out.push({
      code: "overflow",
      severity: "error",
      message: `Block ${o.block} (${o.tag}) is ${o.overflowPx} px wider than the text area.`,
      blockIndex: o.block,
    });
  for (const img of measurements?.lowDpi ?? [])
    out.push({
      code: "low_resolution_image",
      severity: "warning",
      message: `An image prints at about ${img.dpi} dpi (below 150).`,
    });
  if (!opts.overflowChecked)
    out.push({
      code: "overflow_not_checked",
      severity: "info",
      message: "This engine does not measure overflow.",
    });
  return out;
}
