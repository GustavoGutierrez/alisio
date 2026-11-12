/**
 * Bounded, symlink-refusing walks and reads inside one creator project folder. Dot entries and
 * `node_modules` are skipped (the workspace marker, editor folders and installed packages are not
 * part of the plugin). This is path mediation for Alisio's own reads, not a sandbox.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { inside } from "../../runtime/paths.ts";
import { PLUGIN_CREATOR_LIMITS, PluginCreatorError } from "./types.ts";

export interface ProjectFile {
  path: string;
  bytes: number;
}

export interface ProjectWalk {
  files: ProjectFile[];
  bytes: number;
  /** Project-relative symbolic links found (never followed). */
  symlinks: string[];
  /** The walk stopped at `maxFiles`. */
  truncated: boolean;
}

const skipped = (name: string) => name.startsWith(".") || name === "node_modules";

export async function walkProject(
  dir: string,
  maxFiles: number = PLUGIN_CREATOR_LIMITS.maxFiles,
): Promise<ProjectWalk> {
  const out: ProjectWalk = { files: [], bytes: 0, symlinks: [], truncated: false };
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (depth > 12 || out.truncated) return;
    let entries: string[];
    try {
      entries = (await readdir(join(dir, rel))).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (skipped(name)) continue;
      const child = rel ? `${rel}/${name}` : name;
      const stats = await lstat(join(dir, child)).catch(() => undefined);
      if (!stats) continue;
      if (stats.isSymbolicLink()) out.symlinks.push(child);
      else if (stats.isDirectory()) await visit(child, depth + 1);
      else if (stats.isFile()) {
        if (out.files.length >= maxFiles) {
          out.truncated = true;
          return;
        }
        out.files.push({ path: child, bytes: stats.size });
        out.bytes += stats.size;
      }
    }
  };
  await visit("", 0);
  return out;
}

/** A content hash of the walked files (paths and bytes); changes whenever a source changes. */
export async function hashProject(dir: string, walk?: ProjectWalk): Promise<string> {
  const listed = walk ?? (await walkProject(dir));
  const hash = createHash("sha256");
  for (const file of listed.files) {
    hash.update(file.path).update("\0");
    hash.update(await readFile(join(dir, file.path)).catch(() => Buffer.alloc(0)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Resolves a project-relative path to an existing regular file inside `dir`. Throws
 * `path_outside_workspace` for anything that escapes, is hidden or is a symlink, and `not_found`
 * when there is no such file.
 */
export async function projectFilePath(dir: string, rel: string): Promise<string> {
  const outside = () =>
    new PluginCreatorError("path_outside_workspace", "That file is outside the plugin project");
  const clean = rel.replace(/\\/g, "/");
  if (
    !clean ||
    clean.startsWith("/") ||
    /^[A-Za-z]:/.test(clean) ||
    clean.includes("\0") ||
    clean.split("/").some((part) => part === ".." || skipped(part))
  )
    throw outside();
  const root = await realpath(dir);
  const target = resolve(root, clean);
  if (!inside(root, target) || target === root) throw outside();
  let cursor = root;
  for (const part of relative(root, target).split(sep)) {
    cursor = join(cursor, part);
    const stats = await lstat(cursor).catch(() => undefined);
    if (!stats) throw new PluginCreatorError("not_found", "File not found");
    if (stats.isSymbolicLink()) throw outside();
    if (cursor === target && !stats.isFile())
      throw new PluginCreatorError("not_found", "File not found");
  }
  return target;
}
