import {
  agentCatalogFromState,
  agentRunOptions,
  GoalStore,
  goalOptInTools,
  PLAN_AGENT_ID,
  type Policy,
  resolveActiveAgent,
  type Session,
  type SQLiteStore,
} from "@alisio/core";
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
  /** A session's stored options changed (agent, preset, effort): a goal may now continue. */
  onOptions?: (sessionId: string) => void;
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
  private readonly goals: GoalStore;

  constructor(private options: SessionServiceOptions) {
    this.goals = new GoalStore(options.catalog.db);
    const base = options.base;
    const readOnly = !!base.readOnly;
    this.ceiling = {
      policy: {
        write: !readOnly && !!base.allowWrite,
        process: !readOnly && !!base.allowProcess,
        external: !readOnly && (!!base.allowExternal || !!base.allowMcp || !!base.allowAgents),
        ...(!readOnly && base.allowAnalysis ? { analysis: true } : {}),
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

  /**
   * The stored title, else the first user prompt collapsed to one line and cut at 60
   * characters (RF-10). Derived on read, never persisted, so a rename always wins.
   */
  title(session: Session): string | undefined {
    if (session.title) return session.title;
    const first = this.options.catalog
      .messagesPage(session.id, { after: -1, limit: 4, compacted: true })
      .items.find((i) => i.message.role === "user" && !i.message.summary)?.message;
    if (first?.role !== "user") return undefined;
    const text = (first.display ?? first.text).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 60) : undefined;
  }

  wire(session: Session): SessionDetailWire {
    const title = this.title(session);
    return {
      id: session.id,
      workspaceId: workspaceId(session.workspace),
      workspace: session.workspace,
      provider: session.provider,
      model: session.model,
      status: session.parentId ? "idle" : this.status(session),
      ...(title ? { title } : {}),
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

  /**
   * Run options for the session's next run: its own policy object, approvals, effort and the
   * session's agent (stored id, else the app's active agent, as in the TUI). A read-only agent
   * narrows the run to reads without approvals; its instructions are appended per run.
   */
  runOptions(sessionId: string): {
    policy: Policy;
    approvals: boolean;
    reasoningEffort?: string;
    instructions?: string;
    optInTools?: string[];
  } {
    const session = this.get(sessionId);
    const { policy, approvals } = this.policy(session);
    const effort = session.options?.effort;
    const agent = this.agentOptions(session);
    // The goal tools exist for the runs of a session with an ACTIVE goal (never in plan mode).
    const goalTools = goalOptInTools(
      this.goals.get(session.id),
      this.activeAgentId(session) === PLAN_AGENT_ID,
    );
    const optInTools = [...(agent.optInTools ?? []), ...goalTools];
    return {
      policy: agent.policy ? { ...agent.policy } : policy,
      approvals: agent.approvals ?? approvals,
      // The session's own effort wins; otherwise the agent's default (`alisio.reasoning.effort`).
      ...(typeof effort === "string"
        ? { reasoningEffort: effort }
        : agent.reasoningEffort
          ? { reasoningEffort: agent.reasoningEffort }
          : {}),
      ...(agent.instructions ? { instructions: agent.instructions } : {}),
      ...(optInTools.length ? { optInTools } : {}),
    };
  }

  /** The agent id the session's next run uses (stored id, else the app's active agent). */
  activeAgentId(session: Session): string | undefined {
    const app = this.openApp(session)?.app;
    const stored = session.options?.agent;
    if (!app) return typeof stored === "string" ? stored : undefined;
    return this.resolveAgent(session, app)?.id;
  }

  private resolveAgent(session: Session, app: OpenWorkspace["app"]) {
    let state: unknown;
    try {
      state = app.plugins.pluginState("subagents", "mainAgents");
    } catch {
      /* agent contributions are best-effort */
    }
    const stored = session.options?.agent;
    return resolveActiveAgent(
      agentCatalogFromState(state),
      typeof stored === "string" ? stored : app.config.agents.active,
    );
  }

  private agentOptions(session: Session): ReturnType<typeof agentRunOptions> {
    const app = this.openApp(session)?.app;
    if (!app) return {};
    return agentRunOptions(this.resolveAgent(session, app));
  }

  /** Merges keys into the session's stored options (undefined removes a key). */
  setOptions(sessionId: string, options: Record<string, unknown>): void {
    this.options.catalog.updateSessionMeta(sessionId, { options });
    this.optionsChanged(sessionId);
  }

  /** A session option (agent, preset, effort) changed: a goal that waited on it may continue. */
  optionsChanged(sessionId: string): void {
    this.options.onOptions?.(sessionId);
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
      ...(this.title(session) ? { title: this.title(session) } : {}),
      ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
    });
  }

  /** Late binding for components created after this service. */
  bind(hooks: Pick<SessionServiceOptions, "awaitingInput" | "broadcast" | "onOptions">): void {
    Object.assign(this.options, hooks);
  }
}
