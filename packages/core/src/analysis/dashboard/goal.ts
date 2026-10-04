/**
 * Goal-aware planning (spec 6.2, E7c): which columns of the dataset the user's goal names. Local and
 * deterministic: the goal is only matched against column names and headers, whole word by whole
 * word (case and accent insensitive, singular or plural, simple English/Spanish synonyms) and never
 * reaches a query. Pure.
 */
import type { Candidates } from "./candidates.ts";
import { columnTokens, normalizeName, SYNONYM_GROUPS } from "./hints.ts";
import { displayName } from "./labels.ts";
import type { ProfiledColumn } from "./profile.ts";

export interface GoalMatch {
  column: ProfiledColumn;
  /** Index of the first goal word that named it: the order of the goal. */
  position: number;
  /** Indexes of the goal words that named it. */
  words: number[];
}

/** Longest goal text read for matching (the decision state gets a shorter prefix). */
export const GOAL_LIMITS = { match: 2000 } as const;

const UNIT_TOKENS: ReadonlySet<string> = new Set(["cop", "usd", "eur", "mxn", "pct"]);
/** Words too generic to name a column on their own. */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "total",
  "net",
  "gross",
  "average",
  "avg",
  "amount",
  "num",
  "nro",
  "code",
  "de",
  "del",
  "la",
  "el",
  "por",
  "by",
  "of",
  "and",
  "the",
]);

/** The singular and plural readings of a word. */
function bases(token: string): string[] {
  const out = new Set([token]);
  if (token.endsWith("ies") && token.length > 4) out.add(`${token.slice(0, -3)}y`);
  if (token.endsWith("es") && token.length > 4) out.add(token.slice(0, -2));
  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) out.add(token.slice(0, -1));
  return [...out];
}

const GROUP_OF = new Map<string, number>();
SYNONYM_GROUPS.forEach((group, index) => {
  for (const word of group) for (const base of bases(word)) GROUP_OF.set(base, index);
});

/** The comparable keys of a word: its readings, or the synonym group they belong to. */
function keysOf(token: string): Set<string> {
  const keys = new Set<string>();
  for (const base of bases(token)) {
    const group = GROUP_OF.get(base);
    keys.add(group === undefined ? `w:${base}` : `g:${group}`);
  }
  return keys;
}

const sameWord = (a: Set<string>, b: Set<string>): boolean => [...a].some((key) => b.has(key));
const wordsOf = (text: string): string[] =>
  normalizeName(text)
    .split("_")
    .filter((token) => token.length > 0);

/** Position of the goal word, once each, that names every word of the phrase; -1 when one is missing. */
function phrasePosition(phrase: string[], goal: Set<string>[], used: Set<number>): number {
  let first = Number.POSITIVE_INFINITY;
  for (const token of phrase) {
    const keys = keysOf(token);
    const at = goal.findIndex((candidate, i) => !used.has(i) && sameWord(candidate, keys));
    if (at < 0) return -1;
    used.add(at);
    first = Math.min(first, at);
  }
  return first;
}

/**
 * The columns the goal names, in the order it names them. A column is named when every word of its
 * display name, header or normalized name (units like `cop` or `pct` aside) is a goal word, or
 * when one of its words is a goal word that no other column has (generic words never count alone).
 */
export function goalColumns(goal: string, catalog: ProfiledColumn[]): GoalMatch[] {
  const goalWords = wordsOf(goal.slice(0, GOAL_LIMITS.match)).map(keysOf);
  if (goalWords.length === 0) return [];
  const matches: GoalMatch[] = [];
  const unmatched: ProfiledColumn[] = [];
  for (const column of catalog) {
    if (column.role === "unknown") continue;
    let best: { position: number; words: number[] } | undefined;
    for (const text of new Set([
      column.name,
      column.label,
      displayName(column.name, column.label),
    ])) {
      const all = wordsOf(text);
      const phrase = all.filter((token) => !UNIT_TOKENS.has(token));
      const used = new Set<number>();
      const at = phrasePosition(phrase.length > 0 ? phrase : all, goalWords, used);
      // a one- or two-letter name is not worth matching: it would fire on any stray word
      if (at >= 0 && all.join("").length >= 3 && (!best || at < best.position))
        best = { position: at, words: [...used] };
    }
    if (best) matches.push({ column, ...best });
    else unmatched.push(column);
  }
  // a goal word that only one column has names that column
  const owners = (keys: Set<string>) =>
    catalog.filter((c) =>
      [...columnTokens(c.name, c.label)].some((t) => sameWord(keysOf(t), keys)),
    );
  for (const column of unmatched) {
    let best: { position: number; words: number[] } | undefined;
    for (const token of columnTokens(column.name, column.label)) {
      if (token.length < 3 || UNIT_TOKENS.has(token) || GENERIC_TOKENS.has(token)) continue;
      const keys = keysOf(token);
      const at = goalWords.findIndex((candidate) => sameWord(candidate, keys));
      if (at >= 0 && owners(keys).length === 1 && (!best || at < best.position))
        best = { position: at, words: [at] };
    }
    if (best) matches.push({ column, ...best });
  }
  return matches.sort((a, b) => a.position - b.position || a.column.ordinal - b.column.ordinal);
}

/** The goal without the words that name a column (a `status` column is not an operational goal). */
export function unnamedGoalText(goal: string, matches: GoalMatch[]): string {
  const named = new Set(matches.flatMap((m) => m.words));
  return wordsOf(goal.slice(0, GOAL_LIMITS.match))
    .filter((_, index) => !named.has(index))
    .join("_");
}

/**
 * The shortlists with the goal's columns brought in: named measures first (so they lead the KPIs
 * and the primary pick), named time columns first, and named dimensions the shortlist left out
 * added at the end, so the default order of the dimensions stays as it was.
 */
export function withGoalColumns(candidates: Candidates, matches: GoalMatch[]): Candidates {
  const roleOf = (role: ProfiledColumn["role"][]) =>
    matches.map((m) => m.column).filter((c) => role.includes(c.role));
  const named = (list: ProfiledColumn[], extra: ProfiledColumn[]) => [
    ...extra,
    ...list.filter((c) => !extra.includes(c)),
  ];
  const dimensions = [...candidates.dimensions];
  for (const column of roleOf(["dimension", "boolean"]))
    if (!dimensions.includes(column)) dimensions.push(column);
  return {
    ...candidates,
    measures: named(candidates.measures, roleOf(["measure"])),
    time: named(candidates.time, roleOf(["time"])),
    dimensions,
  };
}
