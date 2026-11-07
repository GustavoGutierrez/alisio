import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** A lock older than this (by `mtime`) is considered abandoned. There is no heartbeat (D24c). */
export const LOCK_STALE_MS = 30_000;
/** Retry delay between attempts, plus up to `RETRY_JITTER_MS` of jitter. */
export const LOCK_RETRY_MS = 50;
export const RETRY_JITTER_MS = 25;

export type LockErrorCode = "CREDENTIAL_LOCK_TIMEOUT" | "OAUTH_REFRESH_BUSY";

export class FileLockTimeoutError extends Error {
  constructor(
    readonly code: LockErrorCode,
    message: string,
    /** The caller may try again later. */
    readonly retryable = true,
  ) {
    super(message);
    this.name = "FileLockTimeoutError";
  }
}

export interface FileLockOptions {
  /** Abandonment threshold in ms (default `LOCK_STALE_MS`). */
  staleMs?: number;
  /** Longest wait for the lock in ms. */
  waitMs: number;
  /** Error code when the wait runs out (default `CREDENTIAL_LOCK_TIMEOUT`). */
  timeoutCode?: LockErrorCode;
  /** Timing seam for tests; defaults to the wall clock and real timers. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Test seam: runs inside a takeover, to simulate another process acting at that exact moment. */
  takeoverHooks?: {
    /** Before the takeover re-checks that the lock is still the abandoned one. */
    beforeRecheck?: () => Promise<void>;
    /** After that re-check and just before the `rename`. */
    beforeRename?: () => Promise<void>;
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Pure decision: is a lock last modified at `mtimeMs` abandoned at `now`? Strictly older than `staleMs`. */
export function isStaleLock(mtimeMs: number, now: number, staleMs = LOCK_STALE_MS): boolean {
  return now - mtimeMs > staleMs;
}

async function readOwner(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Tries to take over a stale lock (D24b): renames it to a unique name (one winner when several
 * try at once), checks that what moved is the stale lock that was read, and only then removes it.
 * When it turns out a live lock was moved by mistake, it is put back when the name is still free.
 */
async function stealStale(
  path: string,
  seen: { owner?: string; mtimeMs: number },
  token: string,
  hooks: FileLockOptions["takeoverHooks"] = {},
) {
  const parked = `${path}.stale.${token}`;
  try {
    await hooks.beforeRecheck?.();
    // Re-check right before the rename to keep the window for mistakes as small as possible.
    const again = await stat(path);
    if (again.mtimeMs !== seen.mtimeMs || (await readOwner(path)) !== seen.owner) return;
    await hooks.beforeRename?.();
    await rename(path, parked);
  } catch {
    return; // Somebody else stole or released it first: just retry.
  }
  const moved = await stat(parked).catch(() => undefined);
  const owner = await readOwner(parked);
  if (moved && moved.mtimeMs === seen.mtimeMs && owner === seen.owner) {
    await unlink(parked).catch(() => {});
    return;
  }
  // We moved a lock that was not the stale one we read: give it back if possible.
  await link(parked, path).catch(() => {});
  await unlink(parked).catch(() => {});
}

/**
 * Runs `fn` while holding an exclusive file lock (`open "wx"` + an owner token). The lock is
 * released only by its owner (the file content must still be its own token), a lock abandoned for
 * more than `staleMs` is taken over, and the wait is bounded by `waitMs` (D15, D24). Cross-process
 * convenience for the credentials store, not a security boundary.
 */
export async function withFileLock<T>(
  path: string,
  options: FileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const token = randomBytes(16).toString("hex");
  const deadline = now() + options.waitMs;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await stat(path).catch(() => undefined);
    const stale = info !== undefined && isStaleLock(info.mtimeMs, now(), staleMs);
    if (stale)
      await stealStale(
        path,
        { owner: await readOwner(path), mtimeMs: info.mtimeMs },
        token,
        options.takeoverHooks,
      );
    if (now() >= deadline)
      throw new FileLockTimeoutError(
        options.timeoutCode ?? "CREDENTIAL_LOCK_TIMEOUT",
        "Timed out waiting for the credentials lock; try again in a moment.",
      );
    if (!stale) await sleep(LOCK_RETRY_MS + Math.floor(random() * RETRY_JITTER_MS));
  }
  try {
    return await fn();
  } finally {
    // Delete only our own lock: a taken-over lock now belongs to somebody else.
    if ((await readOwner(path)) === token) await unlink(path).catch(() => {});
  }
}
