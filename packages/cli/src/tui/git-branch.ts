import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** Hard cap for branch names shown in the header, so a hostile/long ref never breaks layout. */
export const BRANCH_MAX_LENGTH = 24;
/** How long a resolved branch is reused before git is asked again (avoids spawning per frame). */
export const BRANCH_TTL_MS = 10_000;
/** Re-check cadence; matches the cache TTL so the header follows branch switches within ~10s. */
export const BRANCH_REFRESH_MS = BRANCH_TTL_MS;
/** Bounded spawn: a slow or hung git must never stall the TUI. */
export const BRANCH_TIMEOUT_MS = 800;

type Spawn = typeof execFile;

/**
 * Strips ANSI escapes and control characters, then truncates to `BRANCH_MAX_LENGTH` chars with an
 * ellipsis. Branch names come from the workspace repository, not from user input, but a hostile or
 * corrupted ref must never inject escape sequences or overflow the header line.
 */
export function sanitizeBranchName(name: string): string {
  const clean = name
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const chars = [...clean];
  return chars.length > BRANCH_MAX_LENGTH
    ? `${chars.slice(0, BRANCH_MAX_LENGTH - 1).join("")}…`
    : clean;
}

/** Header segment text: `⎇ main` on unicode terminals, `branch main` otherwise. */
export function branchDisplay(branch: string, unicode: boolean): string {
  return `${unicode ? "⎇" : "branch"} ${branch}`;
}

function runGit(spawn: Spawn, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    spawn("git", args, { cwd, timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export interface ReadBranchOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to node:child_process execFile. */
  spawn?: Spawn;
}

/**
 * Reads the branch of the git repository at `workspace` (read-only ref query, safe under
 * `--read-only`). Returns the branch name, the short commit SHA on a detached HEAD, or `undefined`
 * when the directory is missing, is not a git repository, git itself is unavailable, or the call
 * times out. All failures are silent: stderr is captured and never printed.
 */
export async function readGitBranch(
  workspace: string,
  options: ReadBranchOptions = {},
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? BRANCH_TIMEOUT_MS;
  if (!existsSync(workspace)) return undefined;
  const spawn = options.spawn ?? execFile;
  try {
    const ref = (
      await runGit(spawn, ["rev-parse", "--abbrev-ref", "HEAD"], workspace, timeoutMs)
    ).trim();
    if (ref && ref !== "HEAD") return sanitizeBranchName(ref);
    if (ref === "HEAD") {
      const sha = (
        await runGit(spawn, ["rev-parse", "--short", "HEAD"], workspace, timeoutMs)
      ).trim();
      return sha ? sanitizeBranchName(sha) : undefined;
    }
    return undefined;
  } catch {
    // Not a repository, git missing, or timed out: the header simply shows no branch segment.
    return undefined;
  }
}

export interface BranchCache {
  /** Cached branch for `workspace`, or a fresh read when the entry expired; dedupes in-flight reads. */
  read(workspace: string): Promise<string | undefined>;
  clear(workspace: string): void;
}

export interface BranchCacheOptions {
  ttlMs?: number;
  timeoutMs?: number;
  spawn?: Spawn;
  /** Injectable clock for expiry tests. */
  now?: () => number;
}

/**
 * TTL cache keyed by workspace so the TUI never spawns git on every frame: one read per workspace
 * per `ttlMs` (hits and misses are both cached), with a single in-flight promise per key.
 */
export function createBranchCache(options: BranchCacheOptions = {}): BranchCache {
  const ttlMs = options.ttlMs ?? BRANCH_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { branch: string | undefined; expires: number }>();
  const inflight = new Map<string, Promise<string | undefined>>();
  const read = (workspace: string): Promise<string | undefined> => {
    const hit = entries.get(workspace);
    if (hit && hit.expires > now()) return Promise.resolve(hit.branch);
    const pending = inflight.get(workspace);
    if (pending) return pending;
    const promise = readGitBranch(workspace, {
      timeoutMs: options.timeoutMs,
      spawn: options.spawn,
    })
      .then((branch) => {
        entries.set(workspace, { branch, expires: now() + ttlMs });
        inflight.delete(workspace);
        return branch;
      })
      .catch(() => {
        inflight.delete(workspace);
        return undefined;
      });
    inflight.set(workspace, promise);
    return promise;
  };
  return { read, clear: (workspace: string) => void entries.delete(workspace) };
}
