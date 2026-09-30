/**
 * A tiny ANSI SGR parser for the read-only `terminal` renderer (spec §10.4). It covers what
 * build and test tools print: bold/dim/italic/underline/inverse, the 16 base colors, 256-color
 * and truecolor foregrounds/backgrounds. Every other escape (cursor moves, OSC titles, private
 * modes) is dropped, so raw ESC bytes never reach the DOM. No dependency (instead of `anser`):
 * the output is text-only spans rendered by Preact, never HTML.
 */

export interface AnsiSpan {
  text: string;
  /** 0–15: a base color (themed through CSS variables); a string: an explicit `rgb(…)`. */
  fg?: number | string;
  bg?: number | string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
}

type Style = Omit<AnsiSpan, "text">;

// CSI (ESC [ … final byte), OSC (ESC ] … BEL or ESC \), and any other two-byte escape.
const ESCAPE = /\x1b\[([0-9;:?<=>]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;

const LEVELS = [0, 95, 135, 175, 215, 255];

/** One of the 256 xterm colors: 0–15 stay themeable, the cube and grays become `rgb()`. */
function color256(n: number): number | string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return n;
  if (n >= 232) {
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }
  const c = n - 16;
  return `rgb(${LEVELS[Math.floor(c / 36)]},${LEVELS[Math.floor(c / 6) % 6]},${LEVELS[c % 6]})`;
}

function applySgr(style: Style, params: string): Style {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  let next: Style = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] as number;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      let value: number | string | undefined;
      if (codes[i + 1] === 5) {
        value = color256(codes[i + 2] as number);
        i += 2;
      } else if (codes[i + 1] === 2) {
        const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]].map((c) =>
          Math.max(0, Math.min(255, Number(c ?? 0))),
        );
        value = `rgb(${r},${g},${b})`;
        i += 4;
      }
      if (value !== undefined) next[key] = value;
    }
  }
  return next;
}

/** Splits terminal text into styled spans (adjacent text with the same style is merged). */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let style: Style = {};
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = spans.at(-1);
    if (prev && sameStyle(prev, style)) prev.text += text;
    else spans.push({ text, ...style });
  };
  for (const match of input.matchAll(ESCAPE)) {
    push(input.slice(last, match.index));
    last = (match.index ?? 0) + match[0].length;
    if (match[3] === "m" && !match[2] && !match[1]?.startsWith("?"))
      style = applySgr(style, match[1] ?? "");
  }
  push(input.slice(last));
  return spans;
}

const KEYS: Array<keyof Style> = ["fg", "bg", "bold", "dim", "italic", "underline", "inverse"];
const sameStyle = (a: Style, b: Style) => KEYS.every((k) => a[k] === b[k]);

/** Resolves `\r` rewrites (progress bars) the way a terminal shows them: the last write wins. */
export function settleCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts.findLast((p) => p !== "") ?? "";
    })
    .join("\n");
}

/** The last `max` lines and how many were hidden before them. */
export function tailLines(text: string, max: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(-max).join("\n"), hidden: lines.length - max };
}
