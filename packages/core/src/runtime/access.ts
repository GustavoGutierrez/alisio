/**
 * Mediated path access: the workspace plus explicitly declared extra directories.
 *
 * A tool path is resolved against the workspace first. Paths that fall outside every allowed root
 * are NOT rejected outright anymore: they trigger an interactive approval scoped to the containing
 * directory (mirroring OpenCode's `external_directory` model), and the approved directory is
 * remembered for the session. In non-interactive runs the same check denies with an actionable
 * error that names the resolved path and the exact remedy instead of hanging.
 *
 * This reuses `safePath`'s symlink hardening for the final resolution, so the symlink and
 * per-segment `lstat` guarantees are preserved. Like the rest of Alisio, this is mediation, not an
 * OS sandbox and not race-proof against hostile concurrent processes.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ApprovalDecision } from "../core/contracts.ts";
import { scratchUsage } from "../forge/session-dir.ts";
import { inside, outsideRootsMessage, safePath } from "./paths.ts";

export type ExternalDirectoryDecision = ApprovalDecision;

export interface ExternalDirectoryRequest {
  /** Canonical directory the call needs; approval is scoped to this directory and its subtree. */
  directory: string;
  /** Concrete path that triggered the request (named in the prompt and the error). */
  path: string;
  session?: string;
  label?: string;
  signal: AbortSignal;
}

/**
 * Interactive approval for a directory outside the workspace and every declared extra root.
 * The three decisions match the existing tool-ask flow: allow once, allow for the session, deny.
 */
export type ExternalDirectoryHandler = (
  request: ExternalDirectoryRequest,
) => Promise<ExternalDirectoryDecision>;

export interface PathAccessOptions {
  /** Canonical workspace root (the fallback boundary for every relative tool path). */
  workspace: string;
  /** Declared extra roots (config `additionalDirectories` plus per-run `--add-dir`). */
  extraRoots?: readonly string[];
  /** Interactive approval for directories outside every allowed root. */
  approve?: ExternalDirectoryHandler;
  /** Fully locked: declared roots are ignored and no external directory is ever approvable. */
  readOnly?: boolean;
  /**
   * The verified scratchpad of a session's ROOT session (Forja, spec §9.4), created on first use.
   * When given, that folder is an authorized root: a path inside it needs no directory approval.
   * Absent when Forja is off, so nothing changes; ignored under `--read-only`. A failure to
   * provide it just means "no scratchpad".
   */
  scratchpad?: (session: string) => Promise<string | undefined>;
  /** `forge.scratch.maxBytes`, read on every check: the quota of one scratchpad. */
  scratchMaxBytes?: () => number;
}

export interface ResolvePathOptions {
  /** Workspace to resolve a relative path against (child sessions may use a worktree). */
  workspace?: string;
  session?: string;
  label?: string;
  signal?: AbortSignal;
  /**
   * When false, an unapproved external directory is denied without prompting. Used by nested
   * `execute` calls, which must never trigger a new interactive approval.
   */
  interactive?: boolean;
}

/** Nearest existing ancestor directory of `target`, canonicalized; used as the approval boundary. */
async function nearestExistingDirectory(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      if ((await lstat(current)).isDirectory()) return await realpath(current);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

export class PathAccess {
  readonly workspace: string;
  private readonly roots: readonly string[];
  private readonly approve?: ExternalDirectoryHandler;
  private readonly readOnly: boolean;
  private readonly scratchpad?: (session: string) => Promise<string | undefined>;
  private readonly scratchMaxBytes?: () => number;
  /** Session-approved directory subtrees (allow for the session). */
  private readonly approved = new Set<string>();
  /** Canonicalized roots, memoized; a nonexistent declared root never matches. */
  private readonly canonical = new Map<string, Promise<string | undefined>>();

  constructor(options: PathAccessOptions) {
    this.workspace = options.workspace;
    this.roots = options.readOnly ? [] : [...(options.extraRoots ?? [])];
    this.readOnly = !!options.readOnly;
    if (options.approve && !options.readOnly) this.approve = options.approve;
    if (options.scratchpad && !options.readOnly) this.scratchpad = options.scratchpad;
    if (options.scratchMaxBytes) this.scratchMaxBytes = options.scratchMaxBytes;
  }

  /**
   * `target` made safe inside the session's scratchpad, or undefined when it is not there: outside
   * it, no session, no scratchpad, or a symlink on the way (an escaping link is "outside").
   */
  private async scratchTarget(
    target: string,
    session: string | undefined,
  ): Promise<string | undefined> {
    if (!this.scratchpad || !session) return undefined;
    try {
      const base = await this.scratchpad(session);
      if (!base || !inside(base, target)) return undefined;
      return await safePath(base, target);
    } catch {
      return undefined;
    }
  }

  /** Whether an already resolved path lies in the session's verified scratchpad (never read-only). */
  async isScratchPath(target: string, session?: string): Promise<boolean> {
    return (await this.scratchTarget(target, session)) !== undefined;
  }

  /** Scratchpad writers in flight, one queue per scratchpad directory (see `lockScratch`). */
  private scratchLocks = new Map<string, Promise<void>>();

  /**
   * Serializes the quota check and the write that follows it (L1): two parallel writes that each
   * fit would otherwise both pass the check and together overflow. Resolves to the release. Keyed
   * by the scratchpad directory, so a child session shares the lock of its root session.
   */
  async lockScratch(session: string | undefined): Promise<() => void> {
    const base =
      this.scratchpad && session
        ? await this.scratchpad(session).catch(() => undefined)
        : undefined;
    const key = base ?? "";
    const previous = this.scratchLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.scratchLocks.set(key, tail);
    await previous;
    return () => {
      release();
      if (this.scratchLocks.get(key) === tail) this.scratchLocks.delete(key);
    };
  }

  /**
   * Why a write of about `incomingBytes` into the session's scratchpad must be refused (spec §9.4,
   * FJ-AC-34), or undefined when it fits. Nothing is ever deleted to make room: the model is told,
   * plainly, that the scratchpad is full.
   */
  async scratchQuotaProblem(
    session: string | undefined,
    incomingBytes: number,
    /** Files the write replaces: their current size is not counted twice. */
    replacing: readonly string[] = [],
  ): Promise<string | undefined> {
    if (!this.scratchpad || !this.scratchMaxBytes || !session) return undefined;
    const base = await this.scratchpad(session).catch(() => undefined);
    if (!base) return undefined;
    const max = this.scratchMaxBytes();
    let used = await scratchUsage(base);
    for (const path of replacing) used -= (await lstat(path).catch(() => undefined))?.size ?? 0;
    used = Math.max(0, used);
    if (used + incomingBytes <= max) return undefined;
    return (
      `The session scratchpad is full: ${used} of ${max} bytes used and this write needs about ` +
      `${incomingBytes}. Nothing was deleted; remove files you no longer need, or ask the user to clear it.`
    );
  }

  /** Extra roots actually in force (always empty under `--read-only`). */
  get extraRoots(): readonly string[] {
    return this.roots;
  }

  /** Directory subtrees approved for the session (diagnostics and tests). */
  approvedDirectories(): string[] {
    return [...this.approved];
  }

  private canonicalize(path: string): Promise<string | undefined> {
    let cached = this.canonical.get(path);
    if (!cached) {
      cached = realpath(path).catch(() => undefined);
      this.canonical.set(path, cached);
    }
    return cached;
  }

  /** The allowed root that contains `target`, if any. */
  private async rootFor(target: string, workspace: string): Promise<string | undefined> {
    const canonicalWorkspace = (await this.canonicalize(workspace)) ?? workspace;
    if (inside(canonicalWorkspace, target)) return canonicalWorkspace;
    for (const root of this.roots) {
      const canonical = await this.canonicalize(root);
      if (canonical && inside(canonical, target)) return canonical;
    }
    return undefined;
  }

  /**
   * Resolves one tool path under the mediated policy. Inside the workspace or a declared extra
   * root it behaves exactly like `safePath`; outside every root it asks for directory approval (or
   * denies with the actionable message when no approval is possible).
   */
  async resolve(path: string, options: ResolvePathOptions = {}): Promise<string> {
    const workspace = options.workspace ?? this.workspace;
    const target = resolve(workspace, path);
    const root = await this.rootFor(target, workspace);
    if (root) return safePath(root, target);
    const scratch = await this.scratchTarget(target, options.session);
    if (scratch) return scratch;
    if (this.readOnly)
      throw new Error(
        outsideRootsMessage(
          target,
          "--read-only disables access outside the workspace; run without it to allow it",
        ),
      );
    const boundary = await nearestExistingDirectory(target);
    for (const approved of this.approved)
      if (inside(approved, target)) return safePath(approved, target);
    const approve = this.approve;
    if (options.interactive === false || !approve)
      throw new Error(
        outsideRootsMessage(
          target,
          approve
            ? "this call cannot request a new interactive approval"
            : "no interactive approval is available in this run",
        ),
      );
    const decision = await approve({
      directory: boundary,
      path: target,
      ...(options.session ? { session: options.session } : {}),
      ...(options.label ? { label: options.label } : {}),
      signal: options.signal ?? new AbortController().signal,
    });
    if (decision === "session") this.approved.add(boundary);
    if (decision === "session" || decision === "once") return safePath(boundary, target);
    throw new Error(
      outsideRootsMessage(target, `access to directory "${boundary}" was denied by the user`),
    );
  }
}
