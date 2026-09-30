import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  type AppOptions,
  createApplication,
  findWorkspace,
  resolveTrust,
  type SQLiteStore,
} from "@alisio/core";
import type { WorkspaceInfo } from "@alisio/sdk";
import { HttpError } from "../http/errors.ts";

export type Application = Awaited<ReturnType<typeof createApplication>>;
/** `AppOptions` minus what the server owns per workspace (cwd, events, approvals). */
export type ServerAppOptions = Omit<
  AppOptions,
  "cwd" | "onEvent" | "approve" | "approveExternalDirectory"
>;

/** An open workspace: one `Application` bound to one canonical path. */
export interface OpenWorkspace {
  id: string;
  path: string;
  app: Application;
  trusted: boolean;
  untrustedResources: boolean;
  lastUsed: number;
}

export interface WorkspaceHostOptions {
  base: ServerAppOptions;
  /** Server-level store over the same database (workspace list, metadata). */
  catalog: SQLiteStore;
  maxOpen?: number;
  /** Close an app after this long without runs, subscribers or approvals (default 10 min). */
  idleEvictMs?: number;
  /** Listed even before it has sessions (e.g. the directory `alisio serve` ran in). */
  defaultWorkspace?: string;
  /** Per-workspace wiring the server owns: events and approval handlers. */
  wire?: (
    id: string,
    path: string,
  ) => Pick<AppOptions, "onEvent" | "approve" | "approveExternalDirectory">;
  /** Called once an app is created (e.g. to bind interactive UI) and before it is closed. */
  onOpen?: (workspace: OpenWorkspace) => void;
  onClose?: (workspace: OpenWorkspace) => void;
  /** A workspace with runs, subscribers or pending approvals is never evicted. */
  busy?: (id: string) => boolean;
  /** Injectable for tests. */
  create?: typeof createApplication;
  now?: () => number;
}

const MISSING_ERRNO = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"]);
const missing = (path: string) =>
  new HttpError("workspace_missing", `Workspace folder not found: ${path}`, { path });

/** Whether a workspace folder is still an accessible directory (a known one may be deleted). */
export async function workspaceExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Opaque, stable workspace id: a short sha256 of the canonical path (never a path in URLs). */
export const workspaceId = (path: string): string =>
  createHash("sha256").update(path).digest("hex").slice(0, 16);

/**
 * One lazily created `Application` per workspace (ADR-06), with LRU eviction of idle apps,
 * a cap on open apps and trust resolved from the terminal's trust store (the web never grants
 * trust). All apps share the same session database (WAL).
 */
export class WorkspaceHost {
  private open = new Map<string, OpenWorkspace>();
  private opening = new Map<string, Promise<OpenWorkspace>>();
  private readonly maxOpen: number;
  private readonly idleEvictMs: number;
  private readonly now: () => number;
  private closed = false;

  constructor(private options: WorkspaceHostOptions) {
    this.maxOpen = options.maxOpen ?? 4;
    this.idleEvictMs = options.idleEvictMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Canonical workspace root of a directory (realpath, then the enclosing git root). */
  async canonical(path: string): Promise<string> {
    try {
      if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
      return await findWorkspace(path);
    } catch {
      throw new HttpError("not_found", "Directory not found");
    }
  }

  get openCount(): number {
    return this.open.size;
  }

  /** Open workspaces (no side effects). */
  entries(): OpenWorkspace[] {
    return [...this.open.values()];
  }

  get(id: string): OpenWorkspace | undefined {
    return this.open.get(id);
  }

  /** Opens (or reuses) the app of a canonical workspace path, evicting an idle one if needed. */
  async openPath(path: string): Promise<OpenWorkspace> {
    if (this.closed) throw new HttpError("shutting_down", "Server is shutting down");
    // A known workspace (from old sessions) may have been deleted or moved: 404, never a 500.
    if (!(await workspaceExists(path))) throw missing(path);
    const id = workspaceId(path);
    const existing = this.open.get(id);
    if (existing) {
      existing.lastUsed = this.now();
      return existing;
    }
    const pending = this.opening.get(id);
    if (pending) return pending;
    if (this.open.size + this.opening.size >= this.maxOpen) await this.evictOne();
    const promise = this.create(id, path).finally(() => this.opening.delete(id));
    this.opening.set(id, promise);
    return promise;
  }

  private async create(id: string, path: string): Promise<OpenWorkspace> {
    const base = this.options.base;
    // Launch flags are explicit, one-run trust like in the terminal; otherwise the trust store
    // decides and a workspace that would need a prompt opens untrusted.
    const explicit = !!base.trustProject || !!base.config;
    const trust = explicit ? undefined : await resolveTrust(path);
    const trusted = explicit || !!trust?.trusted;
    let app: Application;
    try {
      app = await (this.options.create ?? createApplication)({
        ...base,
        trustProject: explicit ? base.trustProject : trusted,
        cwd: path,
        ...(this.options.wire?.(id, path) ?? {}),
      });
    } catch (error) {
      // The folder vanished between the check and the open (the core canonicalizes it).
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code && MISSING_ERRNO.has(code) && !(await workspaceExists(path))) throw missing(path);
      throw error;
    }
    const entry: OpenWorkspace = {
      id,
      path,
      app,
      trusted,
      untrustedResources: !trusted && !!trust?.hasProjectResources,
      lastUsed: this.now(),
    };
    if (this.closed) {
      await app.close();
      throw new HttpError("shutting_down", "Server is shutting down");
    }
    this.open.set(id, entry);
    this.options.catalog.recordWorkspace(path, { lastOpenedAt: entry.lastUsed });
    this.options.onOpen?.(entry);
    return entry;
  }

  /** Closes the least recently used idle app, or fails with 503 `workspace_limit`. */
  private async evictOne(): Promise<void> {
    const idle = this.entries()
      .filter((w) => !this.options.busy?.(w.id))
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!idle)
      throw new HttpError(
        "workspace_limit",
        `All ${this.maxOpen} open workspaces are busy; retry when a run finishes`,
      );
    await this.close(idle.id);
  }

  /** Marks a workspace as used now (keeps it out of idle eviction). */
  touch(id: string): void {
    const entry = this.open.get(id);
    if (entry) entry.lastUsed = this.now();
  }

  /** Closes apps idle for longer than `idleEvictMs`; returns how many were closed. */
  async sweep(): Promise<number> {
    const cutoff = this.now() - this.idleEvictMs;
    const idle = this.entries().filter((w) => w.lastUsed <= cutoff && !this.options.busy?.(w.id));
    await Promise.all(idle.map((w) => this.close(w.id)));
    return idle.length;
  }

  async close(id: string): Promise<void> {
    const entry = this.open.get(id);
    if (!entry) return;
    this.open.delete(id);
    try {
      this.options.onClose?.(entry);
    } finally {
      await entry.app.close();
    }
  }

  /**
   * Closes and reopens a workspace's app so configuration read at startup (plugins, skills) takes
   * effect. Callers make sure it has no runs; SSE subscribers are unaffected (they read the
   * shared store) and the next request uses the new app.
   */
  async recycle(id: string): Promise<OpenWorkspace | undefined> {
    const entry = this.open.get(id);
    if (!entry) return undefined;
    await this.close(id);
    return this.openPath(entry.path);
  }

  /** Closes every app in parallel (each close is capped by the core's teardown timeouts). */
  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled(this.entries().map((w) => this.close(w.id)));
  }

  /**
   * Every known workspace: recorded or with root sessions, the default one and the open ones.
   * `archived` filters like `GET /api/sessions` (`all` by default).
   */
  async list(archived: "true" | "false" | "all" = "all"): Promise<WorkspaceInfo[]> {
    const known = new Map(this.options.catalog.workspaces().map((w) => [w.path, w]));
    const paths = new Set(known.keys());
    for (const w of this.open.values()) paths.add(w.path);
    const fallback = this.options.defaultWorkspace
      ? await this.canonical(this.options.defaultWorkspace).catch(() => undefined)
      : undefined;
    if (fallback) paths.add(fallback);
    const infos = await Promise.all(
      [...paths].sort().map((path) => this.info(path, known.get(path))),
    );
    return archived === "all" ? infos : infos.filter((w) => w.archived === (archived === "true"));
  }

  /** Whether a canonical workspace path is archived. */
  archived(path: string): boolean {
    return this.options.catalog.workspaces().some((w) => w.path === path && !!w.archivedAt);
  }

  /** The `WorkspaceInfo` of one canonical path. */
  async info(
    path: string,
    meta = this.options.catalog.workspaces().find((w) => w.path === path),
  ): Promise<WorkspaceInfo> {
    const id = workspaceId(path);
    const entry = this.open.get(id);
    let trusted = entry?.trusted ?? false;
    let untrusted = entry?.untrustedResources ?? false;
    const exists = await workspaceExists(path);
    if (!entry && exists) {
      const base = this.options.base;
      if (base.trustProject || base.config) trusted = true;
      else {
        const trust = await resolveTrust(path).catch(() => undefined);
        trusted = !!trust?.trusted;
        untrusted = !trusted && !!trust?.hasProjectResources;
      }
    }
    return {
      id,
      path,
      ...(meta?.label ? { label: meta.label } : {}),
      pinned: meta?.pinned ?? false,
      open: !!entry,
      exists,
      trusted,
      untrustedResources: untrusted,
      archived: !!meta?.archivedAt,
      ...(meta?.lastOpenedAt !== undefined ? { lastOpenedAt: meta.lastOpenedAt } : {}),
    };
  }

  /** Canonical path of a workspace id among the known ones. */
  async pathOf(id: string): Promise<string | undefined> {
    const open = this.open.get(id);
    if (open) return open.path;
    return (await this.list()).find((w) => w.id === id)?.path;
  }
}
