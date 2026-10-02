/**
 * Token budget syntax of `/goal` (`budget=50k`, `budget=1.5M`, `budget=clear`). Pure.
 *
 * A budget is a number of tokens as the runner counts them: the input AND output tokens of every
 * request of every run of the goal (so a long context is paid again on each turn).
 */

/** The values that remove the budget. */
export const BUDGET_CLEAR_WORDS: ReadonlySet<string> = new Set(["clear", "none", "off", "0"]);
/** The largest budget accepted (a typo guard: one billion tokens). */
export const MAX_TOKEN_BUDGET = 1_000_000_000;

export type BudgetParse = { ok: true; tokens: number | null } | { ok: false; error: string };

const SUFFIX: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/**
 * `50k`, `1.5M`, `2m`, `50000` or a clear word. `tokens: null` clears the budget. Decimals are
 * allowed with a suffix only (`1.5M`); the result is a positive integer.
 */
export function parseTokenBudget(raw: string): BudgetParse {
  const text = raw.trim().toLowerCase().replace(/_/g, "");
  if (!text) return { ok: false, error: "A budget is empty: use e.g. budget=50k or budget=clear." };
  if (BUDGET_CLEAR_WORDS.has(text)) return { ok: true, tokens: null };
  const match = /^(\d+(?:\.\d+)?)([kmb])?$/.exec(text);
  if (!match)
    return { ok: false, error: `"${raw}" is not a token budget: use e.g. 50k, 1.5M or clear.` };
  const [, digits = "", suffix] = match;
  if (!suffix && digits.includes("."))
    return {
      ok: false,
      error: `"${raw}" is not a token budget: decimals need a K or M suffix (1.5M).`,
    };
  const tokens = Math.round(Number(digits) * (suffix ? (SUFFIX[suffix] ?? 1) : 1));
  if (!Number.isFinite(tokens) || tokens < 1)
    return {
      ok: false,
      error: `"${raw}" is not a token budget: it must be at least 1 token (or clear).`,
    };
  if (tokens > MAX_TOKEN_BUDGET)
    return { ok: false, error: `"${raw}" is above the maximum budget of 1B tokens.` };
  return { ok: true, tokens };
}

/** `1.5M`, `50k`, `812` (the inverse of the parser, for UIs). */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens < 1_000) return String(Math.round(tokens));
  const trim = (value: string) => value.replace(/\.0$/, "");
  if (tokens < 1_000_000) {
    const k = tokens / 1_000;
    return `${k < 100 ? trim(k.toFixed(1)) : Math.round(k)}k`;
  }
  return `${trim((tokens / 1_000_000).toFixed(1))}M`;
}
