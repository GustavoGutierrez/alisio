/**
 * Pure helpers of the Scratch tab (Forja spec §11.2): which files preview and how, the download
 * URL (relative names only), the quota bar and the order of the list. No DOM or signals.
 */
import type { ScratchFile } from "@alisio/sdk";
import { extensionOf } from "./files.ts";

/** Bigger files offer only the download. */
export const PREVIEW_MAX_BYTES = 1024 * 1024;

const PREVIEWABLE: Record<string, "code" | "json" | "markdown"> = {
  js: "code",
  py: "code",
  csv: "code",
  txt: "code",
  json: "json",
  md: "markdown",
};

/** How a scratch file previews with the existing text viewer, or undefined (download only). */
export function previewOf(
  file: Pick<ScratchFile, "name" | "size">,
): { as: "code" | "json" | "markdown"; entry: string } | undefined {
  const as = PREVIEWABLE[extensionOf(file.name)];
  return as && file.size <= PREVIEW_MAX_BYTES ? { as, entry: file.name } : undefined;
}

/** The download URL of a scratch file; names that could leave the folder have none. */
export function scratchFileUrl(sessionId: string, name: string): string | undefined {
  if (!name || name.startsWith("/") || name.includes("\\")) return undefined;
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "..")) return undefined;
  return `/api/sessions/${encodeURIComponent(sessionId)}/scratch/files/${parts.map(encodeURIComponent).join("/")}`;
}

/** Most recently changed first, then by name. */
export const newestFirst = (files: readonly ScratchFile[]): ScratchFile[] =>
  [...files].sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** The quota bar: whole percent (capped at 100) and how worried to look. */
export function quotaLevel(
  used: number,
  quota: number,
): { percent: number; level: "ok" | "warn" | "full" } {
  const percent = quota > 0 ? Math.min(100, Math.floor((used / quota) * 100)) : 0;
  return { percent, level: percent >= 95 ? "full" : percent >= 80 ? "warn" : "ok" };
}
