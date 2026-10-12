/**
 * The volatile session directory (spec §9.4, D19): a private folder per root session under the
 * system temporary directory with `scratchpad/` (scripts and intermediates the model writes) and
 * `tasks/` (live output of Forja executions), plus the helpers that keep what goes into it
 * confined and bounded.
 *
 * Creation never trusts a folder it did not make private itself: every level is created `0700`
 * and then checked with `lstat` (a directory, not a symlink, owned by this user, no group or other
 * bits). If the shared root fails the check it is neither used, changed (`chmod`) nor followed:
 * the session falls back to `<stateHome>/scratch/<workspaceKey>/<rootSessionId>/` and reports a
 * diagnostic. The POSIX checks are skipped on Windows, where `%TEMP%` is already per user. This is
 * a mediated policy, not protection against a hostile process racing the creation.
 */
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { ForgeError } from "./errors.ts";
import {
  isSafeSegment,
  privateDirProblem,
  resolveWithin,
  scratchBaseName,
  tmpRootChoice,
  workspaceSlug,
} from "./session-path.ts";

export const SESSION_MARKER = ".alisio-session";

export interface SessionDirOptions {
  rootSessionId: string;
  /** Absolute path of the workspace. */
  workspace: string;
  /** `workspaceKey(workspace)` from runtime/paths.ts. */
  workspaceKey: string;
  /** `stateHome()`; home of the fallback. */
  stateHome: string;
  /** `forge.scratch.root`. */
  configRoot?: string | null;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.getuid()`. */
  uid?: number;
  /** Defaults to `os.tmpdir()`. */
  osTmpdir?: string;
  now?: () => number;
}

export interface SessionDir {
  /** `<...>/<rootSessionId>` */
  root: string;
  scratchpad: string;
  tasks: string;
  /** The shared temporary root could not be trusted and the state folder is used instead. */
  fallback: boolean;
  diagnostic?: string;
}

export interface SessionMarker {
  sessionId: string;
  workspaceKey: string;
  createdAt: number;
}

const isErrno = (error: unknown, code: string): boolean =>
  !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;

/** Creates one level `0700` if missing and checks it is private to this user (POSIX). */
async function privateDir(path: string, uid: number | undefined): Promise<string | undefined> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  if (uid === undefined) return undefined;
  const info = await lstat(path);
  const problem = privateDirProblem(
    {
      isDirectory: info.isDirectory(),
      isSymbolicLink: info.isSymbolicLink(),
      uid: info.uid,
      mode: info.mode,
    },
    uid,
  );
  return problem ? `${path}: ${problem}` : undefined;
}

/** Creates `parent/…/leaf` level by level, each private. The first problem found, if any. */
async function privateChain(
  parent: string,
  names: readonly string[],
  uid: number | undefined,
): Promise<string | undefined> {
  let current = parent;
  for (const name of names) {
    current = join(current, name);
    const problem = await privateDir(current, uid);
    if (problem) return problem;
  }
  return undefined;
}

async function writeMarker(root: string, marker: SessionMarker): Promise<void> {
  try {
    await writeFile(join(root, SESSION_MARKER), `${JSON.stringify(marker)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
}

export async function ensureSessionDir(options: SessionDirOptions): Promise<SessionDir> {
  if (!isSafeSegment(options.rootSessionId))
    throw new ForgeError("INVALID_INPUT", "root session id is not a safe folder name");
  const platform = options.platform ?? process.platform;
  const posix = platform !== "win32";
  const uid = posix ? (options.uid ?? process.getuid?.()) : undefined;
  const env = options.env ?? process.env;
  const marker: SessionMarker = {
    sessionId: options.rootSessionId,
    workspaceKey: options.workspaceKey,
    createdAt: (options.now ?? Date.now)(),
  };
  const finish = async (root: string, extra: Partial<SessionDir>): Promise<SessionDir> => {
    await writeMarker(root, marker);
    return {
      root,
      scratchpad: join(root, "scratchpad"),
      tasks: join(root, "tasks"),
      fallback: false,
      ...extra,
    };
  };
  const build = async (parent: string, names: string[]): Promise<string | undefined> =>
    (await privateChain(parent, [...names, "scratchpad"], uid)) ??
    (await privateChain(join(parent, ...names), ["tasks"], uid));

  let problem: string | undefined;
  try {
    let base = tmpRootChoice({
      env: env.ALISIO_TMPDIR,
      config: options.configRoot,
      os: options.osTmpdir ?? tmpdir(),
    });
    await mkdir(base, { recursive: true, mode: 0o700 });
    // macOS: /tmp and /var are symlinks into /private; compare and create on the real path.
    if (platform === "darwin") base = await realpath(base);
    const names = [
      scratchBaseName(platform, uid),
      workspaceSlug(options.workspace, options.workspaceKey),
      options.rootSessionId,
    ];
    problem = await build(base, names);
    if (!problem) return await finish(join(base, ...names), {});
  } catch (error) {
    problem = `${(error as Error).message}`;
  }
  // Untrusted or unusable shared root: never chmod it, never follow it.
  const fallbackNames = ["scratch", options.workspaceKey, options.rootSessionId];
  await mkdir(options.stateHome, { recursive: true, mode: 0o700 });
  const failure = await build(options.stateHome, fallbackNames);
  if (failure) throw new ForgeError("INVALID_INPUT", `no usable scratch directory: ${failure}`);
  const root = join(options.stateHome, ...fallbackNames);
  return finish(root, {
    fallback: true,
    diagnostic: `Shared scratch root not used (${problem}); using ${root}`,
  });
}

/**
 * The scratchpad folder of a session if it already exists and is a private directory, else
 * undefined. Unlike `ensureSessionDir` it never creates anything, so a read-only look (the HTTP
 * listing) leaves no trace. Tries the shared temporary root first, then the state fallback.
 */
export async function findSessionScratchpad(
  options: SessionDirOptions,
): Promise<string | undefined> {
  if (!isSafeSegment(options.rootSessionId)) return undefined;
  const platform = options.platform ?? process.platform;
  const uid = platform === "win32" ? undefined : (options.uid ?? process.getuid?.());
  const env = options.env ?? process.env;
  const usable = async (path: string): Promise<boolean> => {
    const info = await lstat(path).catch(() => undefined);
    if (!info) return false;
    if (uid === undefined) return info.isDirectory() && !info.isSymbolicLink();
    return (
      privateDirProblem(
        {
          isDirectory: info.isDirectory(),
          isSymbolicLink: info.isSymbolicLink(),
          uid: info.uid,
          mode: info.mode,
        },
        uid,
      ) === undefined
    );
  };
  try {
    let base = tmpRootChoice({
      env: env.ALISIO_TMPDIR,
      config: options.configRoot,
      os: options.osTmpdir ?? tmpdir(),
    });
    if (platform === "darwin") base = await realpath(base).catch(() => base);
    const primary = join(
      base,
      scratchBaseName(platform, uid),
      workspaceSlug(options.workspace, options.workspaceKey),
      options.rootSessionId,
      "scratchpad",
    );
    if (await usable(primary)) return primary;
  } catch {
    // fall through to the state folder
  }
  const fallback = join(
    options.stateHome,
    "scratch",
    options.workspaceKey,
    options.rootSessionId,
    "scratchpad",
  );
  return (await usable(fallback)) ? fallback : undefined;
}

/** The marker of a session folder, or undefined when it is missing or not valid. */
export async function readSessionMarker(root: string): Promise<SessionMarker | undefined> {
  try {
    const info = await lstat(join(root, SESSION_MARKER));
    if (!info.isFile()) return undefined;
    const value = JSON.parse(await readFile(join(root, SESSION_MARKER), "utf8")) as SessionMarker;
    if (typeof value.sessionId !== "string" || typeof value.workspaceKey !== "string")
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

const inside = (root: string, path: string): boolean =>
  path === root || path.startsWith(root + sep);

/**
 * A scratchpad path the model gave (relative, or absolute inside), checked lexically and then
 * against the real file system: the deepest existing ancestor must resolve inside the real
 * scratchpad, so a symlink that points out is refused. Throws `INVALID_INPUT`.
 */
export async function resolveScratchPath(scratchpad: string, input: string): Promise<string> {
  const target = resolveWithin(scratchpad, input);
  const realBase = await realpath(scratchpad);
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!inside(realBase, real))
        throw new ForgeError("INVALID_INPUT", `path escapes the scratchpad: ${input}`);
      return target;
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      // A dangling symlink is not "missing": it could point out and be created through.
      if (!isErrno(error, "ENOENT")) throw error;
      const link = await lstat(probe).catch(() => undefined);
      if (link?.isSymbolicLink())
        throw new ForgeError("INVALID_INPUT", `path is a dangling symlink: ${input}`);
      const parent = dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

/** Bytes held by the files of a folder (symlinks are counted as links, never followed). */
export async function scratchUsage(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await scratchUsage(path);
    else total += (await lstat(path).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

/**
 * Writes a file into the scratchpad with mode `0600`, refusing paths that escape it and writes
 * that would take the scratchpad past `maxBytes`. Nothing is ever deleted to make room.
 */
export async function writeScratchFile(
  scratchpad: string,
  path: string,
  data: string | Uint8Array,
  options: { maxBytes: number },
): Promise<string> {
  const target = await resolveScratchPath(scratchpad, path);
  const incoming = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  const replaced = (await lstat(target).catch(() => undefined))?.size ?? 0;
  const used = await scratchUsage(scratchpad);
  if (used - replaced + incoming > options.maxBytes)
    throw new ForgeError(
      "BUDGET_EXCEEDED",
      `scratchpad is full: ${used} of ${options.maxBytes} bytes used; this write needs ${incoming}. Nothing was deleted.`,
    );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, data, { mode: 0o600 });
  return target;
}
