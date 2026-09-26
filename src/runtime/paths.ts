import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
export function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}
/** Mediated path policy; not an OS sandbox and not race-proof against hostile concurrent processes. */
export async function safePath(root: string, path: string): Promise<string> {
  const canonical = await realpath(root),
    target = resolve(canonical, path);
  if (!inside(canonical, target)) throw new Error("Path outside workspace");
  let cursor = canonical;
  for (const part of relative(canonical, target).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${cursor}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return target;
}
export async function findWorkspace(cwd: string): Promise<string> {
  let path = await realpath(cwd);
  while (true) {
    try {
      await lstat(resolve(path, ".git"));
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (dirname(path) === path) return realpath(cwd);
    path = dirname(path);
  }
}
