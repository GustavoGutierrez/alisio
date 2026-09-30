import type { Policy, Session, SQLiteStore } from "@alisio/core";
import type {
  ServerFrame,
  SessionDetail,
  SessionDetailWire,
  SessionSummary,
  SessionUiStatus,
} from "@alisio/sdk";
import { HttpError } from "../http/errors.ts";
import { type Ceiling, presetInfos, sessionPreset } from "./presets.ts";
import type { RunScheduler } from "./run-scheduler.ts";
import {
  type OpenWorkspace,
  type ServerAppOptions,
  type WorkspaceHost,
  workspaceId,
} from "./workspace-host.ts";

export interface SessionServiceOptions {
  catalog: SQLiteStore;
  workspaces: WorkspaceHost;
  scheduler: RunScheduler;
  base: ServerAppOptions;
  /** Whether an approval or interaction waits for input in a root session's tree. */
  awaitingInput?: (rootSessionId: string) => boolean;
  /** Sends a frame to every connected stream (session status for sidebars). */
  broadcast?: (frame: ServerFrame) => void;
}

/**
 * Session views (derived UI status §6.2, wire/summary/detail shapes) and per-session run
 * policy. Reads go to the server's own store connection, so listing sessions never opens a
 * workspace application.
 */
export class SessionService {
  /** Per-session policy objects: "allow for session" widens only its own session. */
  private policies = new Map<string, Policy>();
  readonly ceiling: Ceiling;

  constructor(private options: SessionServiceOptions) {
    const base = options.base;
    const readOnly = !!base.readOnly;
    this.ceiling = {
      policy: {
        write: !readOnly && !!base.allowWrite,
        process: !readOnly && !!base.allowProcess,
        external: !readOnly && (!!base.allowExternal || !!base.allowMcp || !!base.allowAgents),
      },
      approvals: !readOnly,
      readOnly,
    };
  }

  /** A session by id, or 404. */
  get(id: string): Session {
    try {
      return this.options.catalog.get(id);
    } catch {
      throw new HttpError("not_found", "Session not found");
    }
  }

  /** The root of a session (itself for roots). */
  rootOf(id: string): string {
    let current = id;
    for (let depth = 0; depth < 32; depth++) {
      let session: Session;
      try {
        session = this.options.catalog.get(current);
      } catch {
        return current;
      }
      if (!session.parentId) return current;
      current = session.parentId;
    }
    return current;
  }

  /** Derived UI status (§6.2); never persisted. */
  status(session: Session): SessionUiStatus {
    const { catalog, scheduler } = this.options;
    if (catalog.lockedBy(session.id)) return "locked";
    const job = scheduler.job(session.id);
    if (job?.status === "queued") return "queued";
    if (job || scheduler.compacting(session.id))
      return this.options.awaitingInput?.(session.id) ? "awaiting_input" : "running";
    const last = catalog.runs?.(session.id, { limit: 1 })[0];
    return last && (last.status === "failed" || last.status === "interrupted") ? "error" : "idle";
  }

  wire(session: Session): SessionDetailWire {
    return {
      id: session.id,
      workspaceId: workspaceId(session.workspace),
      workspace: session.workspace,
      provider: session.provider,
      model: session.model,
      status: session.parentId ? "idle" : this.status(session),
      ...(session.title ? { title: session.title } : {}),
      ...(session.parentId ? { parentId: session.parentId } : {}),
      ...(session.parentId && session.status ? { childStatus: session.status } : {}),
      ...(session.createdAt ? { createdAt: session.createdAt } : {}),
      ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
    };
  }

  summary(session: Session): SessionSummary {
    return { ...this.wire(session), pinned: !!session.pinned, archived: !!session.archivedAt };
  }

  detail(session: Session): SessionDetail {
    const options = session.options ?? {};
    return {
      ...this.summary(session),
      preset: sessionPreset(options, this.ceiling),
      ...(typeof options.effort === "string" ? { effort: options.effort } : {}),
      ...(typeof options.agent === "string" ? { agent: options.agent } : {}),
      presets: presetInfos(this.ceiling),
      children: this.options.catalog.children(session.id).map((child) => this.wire(child)),
    };
  }

  /**
   * The policy object passed as `RunOptions.policy` for a session: the preset narrowed by the
   * ceiling. The runner widens this object on "allow for session", so each session keeps its
   * own object (the app-wide policy is never mutated by web approvals).
   */
  policy(session: Session): { policy: Policy; approvals: boolean } {
    const info = presetInfos(this.ceiling).find(
      (p) => p.id === sessionPreset(session.options, this.ceiling),
    );
    let policy = this.policies.get(session.id);
    if (!policy) {
      policy = { ...(info?.policy ?? { write: false, process: false, external: false }) };
      this.policies.set(session.id, policy);
    }
    return { policy, approvals: info?.approvals ?? false };
  }

  /** Drops session-scoped grants (after a preset change). */
  resetPolicy(sessionId: string): void {
    this.policies.delete(sessionId);
  }

  /** Run options for the session's next run: its own policy object, approvals and effort. */
  runOptions(sessionId: string): {
    policy: Policy;
    approvals: boolean;
    reasoningEffort?: string;
  } {
    const session = this.get(sessionId);
    const { policy, approvals } = this.policy(session);
    const effort = session.options?.effort;
    return {
      policy,
      approvals,
      ...(typeof effort === "string" ? { reasoningEffort: effort } : {}),
    };
  }

  runByRequest(sessionId: string, requestId: string) {
    return this.options.catalog.runByRequest(sessionId, requestId);
  }

  beginRun(input: Parameters<SQLiteStore["beginRun"]>[0]) {
    return this.options.catalog.beginRun(input);
  }

  /** Pid of another live process holding the session (for example the TUI). */
  lockedBy(sessionId: string): number | undefined {
    return this.options.catalog.lockedBy(sessionId);
  }

  /** The already open workspace application of a session, without opening one. */
  openApp(session: Session): OpenWorkspace | undefined {
    return this.options.workspaces.get(workspaceId(session.workspace));
  }

  /** The workspace application of a session, opened on demand. */
  async app(session: Session): Promise<OpenWorkspace> {
    const opened = await this.options.workspaces.openPath(session.workspace);
    opened.lastUsed = Date.now();
    return opened;
  }

  /** Broadcasts the current status of a session to every stream (sidebars). */
  notify(sessionId: string): void {
    if (!this.options.broadcast) return;
    let session: Session;
    try {
      session = this.options.catalog.get(sessionId);
    } catch {
      return;
    }
    this.options.broadcast({
      t: "session_status",
      sessionId,
      workspaceId: workspaceId(session.workspace),
      status: this.status(session),
      ...(session.title ? { title: session.title } : {}),
      ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
    });
  }

  /** Late binding for components created after this service. */
  bind(hooks: Pick<SessionServiceOptions, "awaitingInput" | "broadcast">): void {
    Object.assign(this.options, hooks);
  }
}
