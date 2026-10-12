/**
 * What the HTTP surface does with a session's scratchpad (spec §9.4, §11.1): list it, open one file
 * for download and empty it. Everything is relative to the verified scratchpad folder, symbolic links
 * are never followed (a link is neither listed, opened nor entered; emptying removes the link itself),
 * and nothing returned names an absolute host path.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ForgeError } from "./errors.ts";
import { resolveScratchPath, scratchUsage } from "./session-dir.ts";

export interface ScratchFileInfo {
  name: string;
  size: number;
  mtime: number;
}

/** Most files a listing returns. */
export const SCRATCH_LIST_LIMIT = 2_000;

/** Deepest directory level a listing enters. */
export const SCRATCH_LIST_MAX_DEPTH = 32;

/**
 * Regular files of the scratchpad in name order; links and special files are left out. The walk
 * visits entries in the order of the final sort (a directory sorts as `name/`) and stops as soon
 * as one file more than `limit` is known, so a huge tree costs no more than the cap. `scanned` is
 * how many files were examined.
 */
export async function listScratch(
  scratchpad: string,
  limit = SCRATCH_LIST_LIMIT,
): Promise<{ files: ScratchFileInfo[]; usedBytes: number; truncated: boolean; scanned: number }> {
  const files: ScratchFileInfo[] = [];
  let scanned = 0;
  const key = (entry: { name: string; isDirectory(): boolean }): string =>
    entry.isDirectory() ? `${entry.name}/` : entry.name;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    for (const entry of entries) {
      if (files.length > limit) return;
      const path = join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < SCRATCH_LIST_MAX_DEPTH) await walk(path, name, depth + 1);
      } else if (entry.isFile()) {
        scanned++;
        const info = await lstat(path).catch(() => undefined);
        if (info?.isFile()) files.push({ name, size: info.size, mtime: Math.floor(info.mtimeMs) });
      }
    }
  };
  await walk(scratchpad, "", 0);
  return {
    files: files.slice(0, limit),
    usedBytes: await scratchUsage(scratchpad),
    truncated: files.length > limit,
    scanned,
  };
}

/**
 * A read handle for one file of the scratchpad. The path is confined (lexically and on the real
 * file system), no segment may be a link and the file is opened with `O_NOFOLLOW` where the
 * platform has it. Throws `INVALID_INPUT` for anything that is not a regular file inside.
 */
export async function openScratchFile(
  scratchpad: string,
  relative: string,
): Promise<{ handle: import("node:fs/promises").FileHandle; size: number; name: string }> {
  if (!relative || relative.includes("\0") || relative.includes("\\"))
    throw new ForgeError("INVALID_INPUT", "not a scratchpad file");
  const target = await resolveScratchPath(scratchpad, relative);
  let current = scratchpad;
  const segments = relative.split("/").filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink())
      throw new ForgeError("INVALID_INPUT", "not a scratchpad file");
  }
  const info = await lstat(target);
  if (!info.isFile()) throw new ForgeError("INVALID_INPUT", "not a scratchpad file");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  return { handle, size: info.size, name: segments.at(-1) ?? relative };
}

/** Removes everything inside the scratchpad and keeps the folder. Never follows a link. */
export async function emptyScratch(
  scratchpad: string,
): Promise<{ removed: number; freedBytes: number }> {
  const freedBytes = await scratchUsage(scratchpad);
  let removed = 0;
  const count = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await count(join(dir, entry.name));
      else removed++;
    }
  };
  await count(scratchpad);
  for (const entry of await readdir(scratchpad)) {
    await rm(join(scratchpad, entry), { recursive: true, force: true });
  }
  return { removed, freedBytes };
}
