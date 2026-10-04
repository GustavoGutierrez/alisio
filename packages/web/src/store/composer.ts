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

const GOAL_PALETTE: Record<string, string> = {
  pause: "Pause the goal's automatic continuation",
  resume: "Resume the paused or blocked goal",
  edit: "Edit the goal's objective",
  clear: "Remove the goal from this session",
};

/**
 * `/goal` subcommands for the palette: one row per action the session's goal allows (typing
 * `/goal` lists them under the command itself), so the palette offers what the goal bar does.
 */
export function goalPaletteRows(
  goal: { actions: readonly string[] } | null,
  query: string,
): CommandDescriptor[] {
  const q = query.trim().toLowerCase();
  if (!goal || q.length < 3 || !"goal".startsWith(q)) return [];
  return goal.actions
    .filter((action) => action in GOAL_PALETTE)
    .map((action) => ({
      name: `goal ${action}`,
      description: GOAL_PALETTE[action] as string,
      source: "builtin" as const,
      surfaces: ["web" as const],
      execution: "surface" as const,
    }));
}

/** The palette rows for `query`: the matching commands, with the goal's actions under `/goal`. */
export function paletteRows(
  commands: CommandDescriptor[],
  query: string,
  goal: { actions: readonly string[] } | null,
): CommandDescriptor[] {
  const rows = matchCommands(commands, query);
  const extra = goalPaletteRows(goal, query);
  if (!extra.length) return rows;
  const at = rows.findIndex((row) => row.name === "goal");
  return at < 0 ? [...rows, ...extra] : [...rows.slice(0, at + 1), ...extra, ...rows.slice(at + 1)];
}

/**
 * At most `limit` palette rows. With an empty query the built-ins would fill every slot, so up to
 * four slots go to the other sources (plugin commands first), shown after the built-ins.
 */
export function paletteWindow(
  rows: CommandDescriptor[],
  query: string,
  limit = 12,
): CommandDescriptor[] {
  if (query.trim() || rows.length <= limit) return rows.slice(0, limit);
  const others = rows.filter((row) => row.source !== "builtin").slice(0, 4);
  const builtins = rows.filter((row) => row.source === "builtin");
  return [...builtins.slice(0, limit - others.length), ...others];
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
