/** Path confinement shared by the suite loader and the verifiers (specs/010 D1, D4). */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class EvalPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalPathError";
  }
}

/** Reason a path string is not a plain relative path inside a directory, or undefined if it is. */
export function unsafeRelativeReason(path: string): string | undefined {
  if (path.length === 0) return "is empty";
  if (path.includes("\0")) return "contains a NUL byte";
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\"))
    return "must be relative, not absolute";
  if (path.split(/[\\/]+/).includes("..")) return "must not contain '..' segments";
  return undefined;
}

/** True when `child` is `parent` or lies below it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Real path of the nearest existing ancestor of `path` (symlinks resolved). */
function realAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return realpathSync(current);
}

/**
 * Resolves `rel` under `root` and proves, symlinks included, that the result stays inside `root`.
 * The target does not have to exist. Throws `EvalPathError` otherwise.
 */
export function resolveInside(root: string, rel: string, what = "path"): string {
  const reason = unsafeRelativeReason(rel);
  if (reason) throw new EvalPathError(`${what} "${rel}" ${reason}.`);
  const absolute = resolve(root, rel);
  if (!within(realpathSync(root), realAncestor(absolute)))
    throw new EvalPathError(`${what} "${rel}" resolves outside the directory (symlink escape).`);
  return absolute;
}
