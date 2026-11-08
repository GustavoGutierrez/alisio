/** Which project folders the user collapsed in the sidebar (per viewer, kept in local storage). */
import { signal } from "@preact/signals";
import { readJson, writePref } from "./storage.ts";

const KEY = "alisio.folders";

function load(): Set<string> {
  const stored = readJson<unknown>(KEY, []);
  return new Set(Array.isArray(stored) ? stored.filter((v) => typeof v === "string") : []);
}

/** Workspace ids collapsed by the user; anything else (new projects included) is open. */
export const closedFolders = signal<Set<string>>(load());

/** A folder shows its sessions unless collapsed; an active search forces it open (not saved). */
export const folderOpen = (id: string, closed: ReadonlySet<string>, query: string): boolean =>
  !closed.has(id) || !!query.trim();

/** The expand/collapse-all button expands only when every listed folder is collapsed. */
export const allCollapsed = (ids: string[], closed: ReadonlySet<string>): boolean =>
  ids.length > 0 && ids.every((id) => closed.has(id));

/** Re-reads storage (tests simulate a reload with it). */
export function reloadFolders(): void {
  closedFolders.value = load();
}

/** Opens or collapses the given folders and remembers it. */
export function setFoldersOpen(ids: string[], open: boolean): void {
  const next = new Set(closedFolders.value);
  for (const id of ids) {
    if (open) next.delete(id);
    else next.add(id);
  }
  closedFolders.value = next;
  writePref(KEY, next.size ? JSON.stringify([...next]) : undefined);
}
