/** Terminal text helpers for startup rendering (no pi-tui dependency). */

const SGR = /\x1b\[[0-9;]*m/g;
/** CSI, OSC, DCS/APC/PM/SOS strings and single-character escapes. */
const CONTROL_SEQUENCE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

export const stripAnsi = (text: string) => text.replace(CONTROL_SEQUENCE, "");
/** Printable width in columns (code points; wide East Asian glyphs count as one). */
export const visibleWidth = (text: string) => [...stripAnsi(text)].length;
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/**
 * Makes provider output safe: keeps only SGR (and only when color is allowed), removes other
 * escape sequences and control characters, tabs become spaces, non-ASCII becomes `?` when
 * unicode is not allowed.
 */
export function sanitizeLine(line: string, options: { color: boolean; unicode: boolean }): string {
  let out = "";
  let last = 0;
  const pieces: Array<{ text: string; sgr: boolean }> = [];
  for (const match of line.matchAll(CONTROL_SEQUENCE)) {
    pieces.push({ text: line.slice(last, match.index), sgr: false });
    pieces.push({ text: match[0], sgr: /^\x1b\[[0-9;]*m$/.test(match[0]) });
    last = (match.index ?? 0) + match[0].length;
  }
  pieces.push({ text: line.slice(last), sgr: false });
  for (const piece of pieces) {
    if (piece.sgr) {
      if (options.color) out += piece.text;
      continue;
    }
    if (piece.text.startsWith("\x1b")) continue;
    let text = piece.text.replace(/\t/g, "  ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    if (!options.unicode && !isAscii(text)) text = text.replace(/[^\x20-\x7e]/gu, "?");
    out += text;
  }
  return out;
}
/** Truncates to `width` columns, keeping SGR codes and resetting color when cut. */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const room = Math.max(0, width - [...ellipsis].length);
  let out = "",
    used = 0,
    colored = false;
  for (const token of text.split(/(\x1b\[[0-9;]*m)/)) {
    if (!token) continue;
    if (/^\x1b\[[0-9;]*m$/.test(token)) {
      out += token;
      colored = true;
      continue;
    }
    for (const ch of token) {
      if (used >= room) break;
      out += ch;
      used++;
    }
    if (used >= room) break;
  }
  return `${out}${ellipsis.slice(0, width - used)}${colored ? "\x1b[0m" : ""}`;
}
export const padEnd = (text: string, width: number) =>
  `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
export const sgr =
  (enabled: boolean, open: string, close = "0") =>
  (text: string) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;
export { SGR };
