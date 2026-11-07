/**
 * Checks for the runtime tree shipped under `resources/runtime`.
 *
 * The tree must hold plain files and directories only. A symlink is a problem on every platform:
 * a link that escapes the tree (pnpm deploy leaves a self-link to the workspace package) makes
 * 7-Zip follow it recursively and balloons the NSIS archive past 1.7 GB, and an NSIS installer
 * cannot reliably recreate symlinks on Windows (it needs privileges).
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RuntimeViolation {
  /** Path relative to the runtime root. */
  path: string;
  /** Where the symlink points, as stored on disk. */
  target: string;
  /** True when the link resolves outside the runtime root (or does not resolve at all). */
  escapes: boolean;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Lists every symlink under `root`, never following one. */
export function findRuntimeViolations(root: string): RuntimeViolation[] {
  const base = realpathSync(root);
  const violations: RuntimeViolation[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (lstatSync(full).isSymbolicLink()) {
        const target = readlinkSync(full);
        let escapes: boolean;
        try {
          escapes = !isInside(base, realpathSync(full));
        } catch {
          escapes = true;
        }
        violations.push({ path: relative(base, full), target, escapes });
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(base);
  return violations;
}

/** Throws when the tree contains any symlink, naming each one and whether it escapes the tree. */
export function assertSelfContainedRuntime(root: string): void {
  const violations = findRuntimeViolations(root);
  if (violations.length === 0) return;
  const lines = violations.map(
    (v) => `  ${v.path} -> ${v.target}${v.escapes ? " (escapes the runtime tree)" : ""}`,
  );
  throw new Error(
    `The runtime tree must contain no symlinks, found ${violations.length}:\n${lines.join("\n")}`,
  );
}

/** Removes every `node_modules/.bin` directory: they only hold symlink shims the host never uses. */
export function removeBinDirectories(root: string): void {
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === ".bin") rmSync(full, { recursive: true, force: true });
      else walk(full);
    }
  };
  walk(resolve(root));
}
