/** Settings dialog size: restored (default) or maximized, remembered per viewer. */
import { readPref, writePref } from "../../store/storage.ts";

export const MAXIMIZED_PREF = "alisio.settings.maximized";

export function readMaximized(): boolean {
  return readPref(MAXIMIZED_PREF) === "1";
}

/** Flips the size and persists it (storage may be unavailable: the in-memory value still holds). */
export function toggleMaximized(current: boolean): boolean {
  const next = !current;
  writePref(MAXIMIZED_PREF, next ? "1" : undefined);
  return next;
}
