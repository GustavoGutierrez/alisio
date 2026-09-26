/**
 * Generic child sessions (the `api.sessions` extension point). A child is a separate,
 * persisted conversation with a parent link that runs through the same runner with narrowed
 * permissions: it can never gain a capability, tool or approval its parent lacks. Nothing here
 * knows about "agents" or delegation policies; plugins build those on top.
 */
import type {
  ChildRunResult,
  ChildSessionInfo,
  ChildSessionSpec,
  PluginAPI,
  ResolvedProviderModel,
  SessionStatus,
  ToolDefinition,
} from "@alisio/sdk";
import type { ContextSource, Policy, Session, SessionStore } from "../core/contracts.ts";
import type { AgentRunner } from "../core/runner.ts";

type SessionsAPI = PluginAPI["sessions"];
interface StoredSpec {
  instructions?: string;
  tools?: { allow?: string[]; deny?: string[] };
  readOnly?: boolean;
  permission?: ChildSessionSpec["permission"];
  maxTurns?: number;
  timeoutMs?: number;
  maxTokens?: number;
}
export interface ChildSessionsOptions {
  store: SessionStore;
  runner: AgentRunner;
  providerId: () => string;
  resolveModel?: (reference: string, signal?: AbortSignal) => Promise<ResolvedProviderModel>;
  bindProvider?: (sessionId: string, target: ResolvedProviderModel) => Promise<string>;
  /** The root policy (the runner's; it may widen after "allow for session" approvals). */
  rootPolicy: () => Policy;
  rootApprovals: boolean;
  readOnly: boolean;
  contextFor: (workspace: string) => ContextSource;
}
const STATE_CHANGING = new Set(["write", "process", "external"]);

export class ChildSessions implements SessionsAPI {
  private cancelled = new Set<string>();
  constructor(private o: ChildSessionsOptions) {
    // Work left running by a previous process is never restarted automatically.
    o.store.interruptStale();
  }
  private spec(session: Session): StoredSpec {
    return (session.options ?? {}) as StoredSpec;
  }
  private info(session: Session): ChildSessionInfo {
    if (!session.parentId) throw new Error(`Not a child session: ${session.id}`);
    return {
      id: session.id,
      parentId: session.parentId,
      depth: session.depth ?? 1,
      agent: session.agent ?? "agent",
      title: session.title ?? "",
      status: session.status ?? "queued",
      model: session.model,
      provider: session.provider,
      workspace: session.workspace,
      usage: session.usage ?? { input: 0, output: 0 },
      capabilities: (({ readOnly: _r, ...caps }) => caps)(this.capabilities(session.id)),
      createdAt: session.createdAt ?? 0,
      updatedAt: session.updatedAt ?? 0,
    };
  }
  capabilities(id: string): {
    write: boolean;
    process: boolean;
    approvals: boolean;
    readOnly: boolean;
  } {
    const session = this.o.store.get(id);
    if (!session.parentId) {
      const policy = this.o.rootPolicy();
      return {
        write: policy.write,
        process: policy.process,
        approvals: this.o.rootApprovals && !this.o.readOnly,
        readOnly: this.o.readOnly,
      };
    }
    const parent = this.capabilities(session.parentId);
    const spec = this.spec(session);
    const readOnly = parent.readOnly || !!spec.readOnly;
    const level = (effect: "write" | "process") => spec.permission?.[effect] ?? "allow";
    return {
      write: parent.write && !readOnly && level("write") === "allow",
      process: parent.process && !readOnly && level("process") === "allow",
      approvals:
        parent.approvals && !readOnly && (level("write") !== "deny" || level("process") !== "deny"),
      readOnly,
    };
  }
  /** Tool filter for a session: the parent's filter AND the child's own allow/deny/effects. */
  private filter(id: string): (tool: ToolDefinition) => boolean {
    const session = this.o.store.get(id);
    if (!session.parentId) return () => true;
    const parent = this.filter(session.parentId);
    const spec = this.spec(session);
    const caps = this.capabilities(id);
    const allow = spec.tools?.allow;
    const deny = new Set(spec.tools?.deny ?? []);
    return (tool) => {
      if (!parent(tool) || deny.has(tool.name)) return false;
      if (allow && !allow.includes("*") && !allow.includes(tool.name)) return false;
      const effect = tool.effect ?? "external";
      if (caps.readOnly && STATE_CHANGING.has(effect)) return false;
      for (const e of ["write", "process"] as const)
        if (effect === e && spec.permission?.[e] === "deny") return false;
      return true;
    };
  }
  spawn(spec: ChildSessionSpec): ChildSessionInfo {
    const parent = this.o.store.get(spec.parentId);
    if (spec.id && !/^[0-9a-f-]{36}$/i.test(spec.id)) throw new Error("Child id must be a UUID");
    const stored: StoredSpec = {
      ...(spec.instructions ? { instructions: spec.instructions } : {}),
      ...(spec.tools ? { tools: spec.tools } : {}),
      ...(spec.readOnly ? { readOnly: true } : {}),
      ...(spec.permission ? { permission: spec.permission } : {}),
      ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
      ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
      ...(spec.maxTokens ? { maxTokens: spec.maxTokens } : {}),
    };
    const child = this.o.store.createChild({
      ...(spec.id ? { id: spec.id } : {}),
      parentId: parent.id,
      workspace: spec.workspace ?? parent.workspace,
      provider: parent.provider,
      model: spec.model ?? parent.model,
      agent: spec.agent,
      title: spec.title,
      depth: (parent.depth ?? 0) + 1,
      options: stored as Record<string, unknown>,
    });
    return this.info(child);
  }
  async create(spec: ChildSessionSpec): Promise<ChildSessionInfo> {
    if (!spec.model) return this.spawn(spec);
    if (!this.o.resolveModel || !this.o.bindProvider)
      throw new Error("Cross-provider model resolution is not available");
    const target = await this.o.resolveModel(spec.model);
    const child = this.spawn({ ...spec, model: target.model.id });
    try {
      const provider = await this.o.bindProvider(child.id, target);
      this.o.store.updateBinding(child.id, provider, target.model.id);
      return this.info(this.o.store.get(child.id));
    } catch (error) {
      this.o.store.updateSession(child.id, { status: "failed" });
      throw error;
    }
  }
  /** Agent path from the top-level child down, e.g. "general › explore". */
  private label(id: string): string {
    return [...this.ancestors(id).reverse(), id]
      .map((x) => this.o.store.get(x))
      .filter((s) => s.parentId)
      .map((s) => s.agent ?? "agent")
      .join(" › ");
  }
  async run(
    id: string,
    prompt: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChildRunResult> {
    const session = this.o.store.get(id);
    if (!session.parentId) throw new Error(`Not a child session: ${id}`);
    if (this.o.runner.isRunning(id)) throw new Error(`Session ${id} is already running`);
    const spec = this.spec(session);
    const caps = this.capabilities(id);
    const root = this.o.rootPolicy();
    const signals = [options.signal, this.o.runner.signal(session.parentId)].filter(
      (s): s is AbortSignal => !!s,
    );
    this.cancelled.delete(id);
    this.o.store.updateSession(id, { status: "running" });
    const usage = { ...(session.usage ?? { input: 0, output: 0 }) };
    try {
      const result = await this.o.runner.run(
        id,
        prompt,
        signals.length ? AbortSignal.any(signals) : undefined,
        {
          ...(spec.instructions ? { instructions: spec.instructions } : {}),
          toolFilter: this.filter(id),
          policy: {
            write: caps.write,
            process: caps.process,
            external: root.external && !caps.readOnly,
          },
          approvals: caps.approvals,
          label: this.label(id),
          workspace: session.workspace,
          context: this.o.contextFor(session.workspace),
          ...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
          ...(spec.maxTokens ? { maxTokens: spec.maxTokens } : {}),
          ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
        },
      );
      usage.input += result.usage.input;
      usage.output += result.usage.output;
      this.o.store.updateSession(id, { status: "completed", usage });
      return { id, status: "completed", text: result.text, usage };
    } catch (error) {
      const aborted = this.cancelled.has(id) || signals.some((s) => s.aborted);
      const status: SessionStatus = aborted ? "cancelled" : "failed";
      this.o.store.updateSession(id, { status });
      return {
        id,
        status,
        text: "",
        usage,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  get(id: string): ChildSessionInfo | undefined {
    try {
      const session = this.o.store.get(id);
      return session.parentId ? this.info(session) : undefined;
    } catch {
      return undefined;
    }
  }
  children(parentId: string): ChildSessionInfo[] {
    return this.o.store.children(parentId).map((s) => this.info(s));
  }
  ancestors(id: string): string[] {
    const out: string[] = [];
    let current = this.o.store.get(id);
    while (current.parentId) {
      out.push(current.parentId);
      current = this.o.store.get(current.parentId);
    }
    return out;
  }
  private descendants(id: string): string[] {
    return this.o.store.children(id).flatMap((c) => [c.id, ...this.descendants(c.id)]);
  }
  cancel(id: string): number {
    let running = 0;
    for (const target of [id, ...this.descendants(id)]) {
      const session = this.o.store.get(target);
      if (this.o.runner.isRunning(target)) {
        this.cancelled.add(target);
        this.o.runner.abort(target, new Error("Cancelled by the user"));
        running++;
      } else if (session.parentId && session.status === "queued")
        this.o.store.updateSession(target, { status: "cancelled" });
    }
    return running;
  }
  enqueue(id: string, text: string): void {
    this.o.runner.enqueue(id, text);
  }
  isRunning(id: string): boolean {
    return this.o.runner.isRunning(id);
  }
  model(id: string): string {
    return this.o.store.get(id).model;
  }
  workspace(id: string): string {
    return this.o.store.get(id).workspace;
  }
  setStatus(id: string, status: SessionStatus): void {
    if (this.o.store.get(id).parentId) this.o.store.updateSession(id, { status });
  }
}
