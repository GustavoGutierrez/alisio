/**
 * The pure rules of the session directory (spec §9.4, D19). No I/O: `session-dir.ts` applies them
 * to the file system.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ForgeError } from "./errors.ts";

export const MAX_SLUG_CHARS = 80;
const HASH_CHARS = 8;

/** `ALISIO_TMPDIR`, else `forge.scratch.root`, else the system temporary directory. */
export function tmpRootChoice(input: {
  env: string | undefined;
  config: string | null | undefined;
  os: string;
}): string {
  if (input.env) return input.env;
  if (input.config) return input.config;
  return input.os;
}

/** The per-user folder under the temporary root; Windows `%TEMP%` is already per user. */
export function scratchBaseName(platform: NodeJS.Platform, uid: number | undefined): string {
  return platform === "win32" ? "alisio" : `alisio-${uid}`;
}

/**
 * The workspace path with every non `[A-Za-z0-9]` character as `-`. Past 80 characters it is cut
 * and followed by `-` and the first 8 hex characters of the workspace key, so long paths neither
 * collide nor hit path-length limits.
 */
export function workspaceSlug(workspace: string, workspaceKey: string): string {
  const slug = workspace.replace(/[^A-Za-z0-9]/g, "-");
  if (slug.length <= MAX_SLUG_CHARS) return slug;
  return `${slug.slice(0, MAX_SLUG_CHARS)}-${workspaceKey.slice(0, HASH_CHARS)}`;
}

/** Whether `id` can be one folder name without escaping its parent. */
export function isSafeSegment(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

export interface DirFacts {
  isDirectory: boolean;
  isSymbolicLink: boolean;
  uid: number;
  mode: number;
}

/** Why an existing folder is not private to this user, or undefined when it is. */
export function privateDirProblem(facts: DirFacts, uid: number): string | undefined {
  if (facts.isSymbolicLink) return "it is a symlink";
  if (!facts.isDirectory) return "it is not a directory";
  if (facts.uid !== uid) return "it belongs to another owner";
  if ((facts.mode & 0o077) !== 0) return "it grants permissions to group or other";
  return undefined;
}

/**
 * Resolves `input` (relative to `base`, or absolute) and refuses anything that is not strictly
 * inside `base`: `..`, absolute escapes, `base` itself and null bytes. Lexical only; the caller
 * adds the symlink check on the real file system.
 */
export function resolveWithin(base: string, input: string): string {
  if (input.length === 0 || input.includes("\0"))
    throw new ForgeError("INVALID_INPUT", "path must be a non-empty string without null bytes");
  const target = resolve(base, input);
  const rel = relative(base, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new ForgeError("INVALID_INPUT", `path is outside the scratchpad: ${input}`);
  return target;
}
