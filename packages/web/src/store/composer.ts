/** Pure composer helpers: slash parsing and matching (RF-07) and prompt history (RF-06). */
import type { CommandDescriptor } from "@alisio/sdk";

/** `/name args` at the very start of the text (leading spaces allowed), else undefined. */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\s*\/([^\s/][^\s]*)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match?.[1]) return undefined;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

const subsequence = (needle: string, haystack: string): boolean => {
  let i = 0;
  for (const ch of haystack) if (ch === needle[i]) i++;
  return i === needle.length;
};

/** Commands for the palette: name prefix, alias prefix, substring, then fuzzy subsequence. */
export function matchCommands(commands: CommandDescriptor[], query: string): CommandDescriptor[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const tiers: CommandDescriptor[][] = [[], [], [], []];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const tier = name.startsWith(q)
      ? 0
      : command.aliases?.some((a) => a.toLowerCase().startsWith(q))
        ? 1
        : name.includes(q)
          ? 2
          : subsequence(q, name)
            ? 3
            : -1;
    if (tier >= 0) tiers[tier]?.push(command);
  }
  return tiers.flat();
}

/** Appends a sent prompt to the history (no blanks, no consecutive duplicates, bounded). */
export function pushHistory(history: string[], text: string, limit = 100): string[] {
  if (!text.trim() || history.at(-1) === text) return history;
  return [...history, text].slice(-limit);
}

/**
 * One ↑ (`-1`) or ↓ (`+1`) step through the history. `index` undefined means "editing the
 * draft"; stepping past the newest entry returns the draft.
 */
export function historyStep(
  history: string[],
  index: number | undefined,
  direction: -1 | 1,
  draft: string,
): { index: number | undefined; text: string } {
  if (!history.length) return { index: undefined, text: draft };
  if (index === undefined) {
    if (direction === 1) return { index: undefined, text: draft };
    const last = history.length - 1;
    return { index: last, text: history[last] as string };
  }
  const next = index + direction;
  if (next < 0) return { index: 0, text: history[0] as string };
  if (next >= history.length) return { index: undefined, text: draft };
  return { index: next, text: history[next] as string };
}
