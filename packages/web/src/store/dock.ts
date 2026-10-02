/**
 * The right dock (RF-12): Files (lazy tree), Changes (files the session wrote) and Preview.
 * Signals plus actions; the pure path helpers live in `util/files.ts`.
 */
import type { FileEntry, SessionChange, UiBlock } from "@alisio/sdk";
import { batch, signal } from "@preact/signals";
import { type PreviewKind, parentDirs, previewKind, workspaceRelative } from "../util/files.ts";
import { api, currentId, detail } from "./app.ts";
import { readPref, writePref } from "./storage.ts";

export type DockTab = "files" | "changes" | "preview" | "tasks";

export interface DirState {
  entries: FileEntry[];
  next?: string;
  loading: boolean;
  error?: string;
}

export type PreviewState =
  | { path: string; status: "loading" }
  | { path: string; status: "error"; error: string }
  | {
      path: string;
      status: "ready";
      kind: PreviewKind;
      truncated: boolean;
      size: number;
      /** Text content (text kinds) or an object URL (images). */
      text?: string;
      url?: string;
      /** A diff block (opened from Changes); the file itself shows under it when available. */
      diff?: UiBlock;
    };

export const dockOpen = signal(readPref("alisio.dock") === "open");
export const dockTab = signal<DockTab>("files");
/** Live background tasks of the open session (set by the lazy tasks store; feeds the badges). */
export const liveTasks = signal(0);
export const dirs = signal<Record<string, DirState>>({});
export const expanded = signal<Set<string>>(new Set([""]));
export const preview = signal<PreviewState | undefined>(undefined);
export const changes = signal<{ files: SessionChange[]; loading: boolean; error?: string }>({
  files: [],
  loading: false,
});

let dockWorkspace: string | undefined;
let objectUrl: string | undefined;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `/tasks`: opens the dock on its Tasks tab. */
export function openTasks(): void {
  batch(() => {
    dockOpen.value = true;
    dockTab.value = "tasks";
  });
  writePref("alisio.dock", "open");
  ensureWorkspace();
}

export function setDockOpen(open: boolean): void {
  dockOpen.value = open;
  writePref("alisio.dock", open ? "open" : undefined);
  if (open) ensureWorkspace();
}

/** Resets the tree when the open session belongs to another workspace. */
function ensureWorkspace(): string | undefined {
  const wid = detail.value?.workspaceId;
  if (wid !== dockWorkspace) {
    dockWorkspace = wid;
    batch(() => {
      dirs.value = {};
      expanded.value = new Set([""]);
      changes.value = { files: [], loading: false };
    });
    if (wid) void loadDir("");
  }
  return wid;
}

export async function loadDir(path: string, more = false): Promise<void> {
  const wid = ensureWorkspace();
  if (!wid) return;
  const current = dirs.value[path];
  if (current?.loading || (current && !more && !current.error)) return;
  dirs.value = {
    ...dirs.value,
    [path]: {
      entries: current?.entries ?? [],
      loading: true,
      ...(current?.next ? { next: current.next } : {}),
    },
  };
  try {
    const page = await api.tree(wid, path, more ? current?.next : undefined);
    if (dockWorkspace !== wid) return;
    dirs.value = {
      ...dirs.value,
      [path]: {
        entries: [...(more ? (current?.entries ?? []) : []), ...page.entries],
        loading: false,
        ...(page.next ? { next: page.next } : {}),
      },
    };
  } catch (error) {
    dirs.value = {
      ...dirs.value,
      [path]: { entries: [], loading: false, error: errorText(error) },
    };
  }
}

export function toggleDir(path: string): void {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else {
    next.add(path);
    void loadDir(path);
  }
  expanded.value = next;
}

/** Re-reads every expanded directory (after a run changed files). */
export function refreshTree(): void {
  dirs.value = {};
  for (const path of expanded.value) void loadDir(path);
}

export async function loadChanges(): Promise<void> {
  const id = currentId.value;
  if (!id) return;
  changes.value = { ...changes.value, loading: true };
  try {
    const { files } = await api.changes(id);
    if (currentId.value === id) changes.value = { files, loading: false };
  } catch (error) {
    changes.value = { files: [], loading: false, error: errorText(error) };
  }
}

/** Opens a file (tool-row path, Markdown link, tree entry) in the Preview tab. */
export async function openInDock(rawPath: string, options: { diff?: boolean } = {}): Promise<void> {
  const path = workspaceRelative(detail.value?.workspace, rawPath);
  const wid = ensureWorkspace();
  if (path === undefined || !wid) return;
  batch(() => {
    dockOpen.value = true;
    dockTab.value = "preview";
    preview.value = { path, status: "loading" };
    // Reveal the file in the tree.
    const next = new Set(expanded.value);
    for (const dir of parentDirs(path)) next.add(dir);
    expanded.value = next;
  });
  writePref("alisio.dock", "open");
  for (const dir of parentDirs(path)) void loadDir(dir);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined;
  let diff: UiBlock | undefined;
  if (options.diff)
    try {
      diff = await api.diff(wid, path);
    } catch {
      // Not a git repository (409) or an unreadable file: the preview alone still helps.
    }
  try {
    const file = await api.file(wid, path);
    if (preview.value?.path !== path) return;
    const kind = previewKind(path, file.contentType);
    if (kind === "image") objectUrl = URL.createObjectURL(file.blob);
    preview.value = {
      path,
      status: "ready",
      kind,
      truncated: file.truncated,
      size: file.size,
      ...(kind === "image"
        ? { url: objectUrl }
        : kind === "binary"
          ? {}
          : { text: await file.blob.text() }),
      ...(diff ? { diff } : {}),
    };
  } catch (error) {
    if (preview.value?.path !== path) return;
    preview.value = diff
      ? { path, status: "ready", kind: "binary", truncated: false, size: 0, diff }
      : { path, status: "error", error: errorText(error) };
  }
}

export const downloadUrl = (path: string): string | undefined =>
  detail.value?.workspaceId ? api.fileUrl(detail.value.workspaceId, path, true) : undefined;
