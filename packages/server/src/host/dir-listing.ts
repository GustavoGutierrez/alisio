/**
 * In-app folder browser (the guaranteed fallback of the native dialog on every OS): lists the
 * subdirectory *names* of one directory as the server user. Never lists files or reads contents.
 * Path helpers take the platform explicitly (`path.win32` / `path.posix`) so Windows drive roots
 * and the drive list ("" = "This PC") are tested on any host.
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { DirectoryListing } from "@alisio/sdk";
import { HttpError } from "../http/errors.ts";

const api = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** Absolute paths only; on Windows `""` is the drive list above every drive root. */
export function isBrowsablePath(path: string, platform: NodeJS.Platform = process.platform) {
  if (path === "") return platform === "win32";
  return api(platform).isAbsolute(path);
}

/** Breadcrumbs from the filesystem root to `path` (server-built: the web assumes no separator). */
export function directorySegments(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Array<{ name: string; path: string }> {
  if (path === "") return [];
  const p = api(platform);
  const normalized = p.normalize(path);
  const root = p.parse(normalized).root;
  const segments = [{ name: root, path: root }];
  let current = root;
  for (const part of normalized.slice(root.length).split(p.sep).filter(Boolean)) {
    current = p.join(current, part);
    segments.push({ name: part, path: current });
  }
  return segments;
}

/** Parent directory; a Windows drive root's parent is the drive list (`""`); none at the top. */
export function directoryParent(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (path === "") return undefined;
  const p = api(platform);
  const normalized = p.normalize(path);
  const root = p.parse(normalized).root;
  if (normalized === root || `${normalized}${p.sep}` === root)
    return platform === "win32" && /^[A-Za-z]:\\$/.test(root) ? "" : undefined;
  return p.dirname(normalized);
}

/** The absolute path of `name` inside `dir` (inside the drive list, `name` is a drive root). */
export function childPath(dir: string, name: string, platform: NodeJS.Platform = process.platform) {
  if (dir === "" && platform === "win32") return name;
  return api(platform).join(dir, name);
}

const MAX_ENTRIES = 2_000;

/** Drive roots that exist (`A:\` … `Z:\`), for the top of the Windows browser. */
async function drives(): Promise<string[]> {
  const letters = Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`);
  const found = await Promise.all(
    letters.map(async (root) => ((await isDirectory(root)) ? root : undefined)),
  );
  return found.filter((root): root is string => !!root);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Filesystem errors become 403 `permission_denied` or 404 `not_found`, never a 500. */
function fsError(error: unknown, path: string): HttpError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM")
    return new HttpError("permission_denied", `Cannot read ${path}`, { path });
  return new HttpError("not_found", `Directory not found: ${path}`, { path });
}

/**
 * One listing page: subdirectories of `path` (symlinks included when they point at a directory),
 * sorted by name, dot-folders only when `hidden`. `path` defaults to the home directory.
 */
export async function listDirectories(
  input: { path?: string | null; hidden?: boolean },
  platform: NodeJS.Platform = process.platform,
): Promise<DirectoryListing> {
  const p = api(platform);
  const home = homedir();
  const raw = input.path ?? home;
  if (!isBrowsablePath(raw, platform))
    throw new HttpError("validation_failed", "path must be absolute", { fields: ["path"] });
  const path = raw === "" ? "" : p.normalize(raw);
  const base = {
    home,
    separator: p.sep as "/" | "\\",
    segments: directorySegments(path, platform),
    ...(directoryParent(path, platform) !== undefined
      ? { parent: directoryParent(path, platform) as string }
      : {}),
  };
  if (path === "") {
    const roots = await drives();
    return {
      ...base,
      path,
      entries: roots.map((root) => ({ name: root, path: root, hidden: false })),
    };
  }
  let dirents: Dirent[];
  try {
    if (!(await stat(path)).isDirectory()) throw Object.assign(new Error(), { code: "ENOTDIR" });
    dirents = await readdir(path, { withFileTypes: true });
  } catch (error) {
    throw fsError(error, path);
  }
  const entries: DirectoryListing["entries"] = [];
  for (const dirent of dirents) {
    const hidden = dirent.name.startsWith(".");
    if (hidden && !input.hidden) continue;
    const full = childPath(path, dirent.name, platform);
    const directory =
      dirent.isDirectory() || (dirent.isSymbolicLink() && (await isDirectory(full)));
    if (directory) entries.push({ name: dirent.name, path: full, hidden });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    ...base,
    path,
    entries: entries.slice(0, MAX_ENTRIES),
    ...(entries.length > MAX_ENTRIES ? { truncated: true } : {}),
  };
}
