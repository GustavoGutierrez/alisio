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
  /** Session-approved directory subtrees (allow for the session). */
  private readonly approved = new Set<string>();
  /** Canonicalized roots, memoized; a nonexistent declared root never matches. */
  private readonly canonical = new Map<string, Promise<string | undefined>>();

  constructor(options: PathAccessOptions) {
    this.workspace = options.workspace;
    this.roots = options.readOnly ? [] : [...(options.extraRoots ?? [])];
    this.readOnly = !!options.readOnly;
    if (options.approve && !options.readOnly) this.approve = options.approve;
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
