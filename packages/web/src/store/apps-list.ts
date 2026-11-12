import { signal } from "@preact/signals";
import { readPref, writePref } from "./storage.ts";

/** Apps the sidebar lists before "Show all", so Projects and the footer always stay on screen. */
export const APPS_VISIBLE = 5;
const KEY = "alisio.sidebar.appsAll";

/** Whether this viewer chose "Show all" in the sidebar Apps list (per browser). */
export const appsExpanded = signal(readPref(KEY) === "1");

export function setAppsExpanded(value: boolean): void {
  appsExpanded.value = value;
  writePref(KEY, value ? "1" : undefined);
}

/**
 * The rows the Apps list shows. A long list is capped to `cap` rows (a single extra app never
 * hides behind a toggle), the open app always stays visible, and `toggle` says whether the
 * "Show all / Show less" control applies.
 */
export function capApps<T extends { active: boolean }>(
  items: T[],
  expanded: boolean,
  cap = APPS_VISIBLE,
): { shown: T[]; hidden: number; toggle: boolean } {
  const toggle = items.length > cap + 1;
  if (!toggle || expanded) return { shown: items, hidden: 0, toggle };
  const shown = items.slice(0, cap);
  const active = items.findIndex((item) => item.active);
  if (active >= cap) shown.push(items[active] as T);
  return { shown, hidden: items.length - shown.length, toggle };
}
