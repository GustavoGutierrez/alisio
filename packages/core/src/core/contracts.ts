import type { CompactionCheckpoint, Message, ToolCall, ToolResult } from "@alisio/sdk";
export interface Session {
  id: string;
  workspace: string;
  provider: string;
  model: string;
  /** Child sessions only. */
  parentId?: string;
  depth?: number;
  agent?: string;
  status?: import("@alisio/sdk").SessionStatus;
  title?: string;
  usage?: { input: number; output: number };
  /** Persisted child spec (narrowing, limits) so resumed runs keep the same restrictions. */
  options?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}
export interface ChildSessionRecord {
  id?: string;
  parentId: string;
  workspace: string;
  provider: string;
  model: string;
  agent: string;
  title: string;
  depth: number;
  options: Record<string, unknown>;
}
export interface SessionStore {
  create(workspace: string, provider: string, model: string): Session;
  get(id: string): Session;
  list(): Session[];
  messages(id: string): Message[];
  append(id: string, message: Message): void;
  createChild(record: ChildSessionRecord): Session;
  children(parentId: string): Session[];
  updateSession(
    id: string,
    patch: {
      status?: import("@alisio/sdk").SessionStatus;
      usage?: { input: number; output: number };
    },
  ): void;
  /** Updates a queued session after its provider/model selector has resolved. */
  updateBinding(id: string, provider: string, model: string): void;
  /** Marks queued/running child sessions not locked by a live process as interrupted. */
  interruptStale(): number;
  /** Record the model used for subsequent turns of the session. */
  setModel(id: string, model: string): void;
  /**
   * Atomically replace the first `replaced` active messages with `summary`, keeping the
   * rest verbatim and in order. Callers must never split a tool call from its results.
   */
  compact(id: string, replaced: number, summary: Message): void;
  /**
   * Atomically replace the whole active history with `messages` (like `compact` without a
   * summary): used after a context-budget reduction so the persisted transcript matches what
   * was actually sent. Callers must never split a tool call from its results.
   */
  overwrite(id: string, messages: Message[]): void;
  acquire(id: string): void;
  release(id: string): void;
  beginCall(session: string, call: ToolCall): void;
  endCall(session: string, call: ToolCall, result: ToolResult): void;
  /** The persisted result of a completed tool call, for replay of rich (ui/image) parts. */
  callResult(session: string, callId: string): ToolResult | undefined;
  reconcile(id: string, acknowledge?: boolean): void;
  /**
   * Persist a durable run event. Stores that assign a global, monotonic sequence return it; the
   * runner exposes it as `RunEvent.eventId`. Returning nothing is allowed (no `eventId`).
   */
  event(id: string, runId: string, type: string, data: unknown): number | void;
}
export interface ContextSource {
  /** System instructions; `sessionId` scopes lazily attached nested instructions. */
  instructions(sessionId?: string): Promise<string>;
  /** Instructions newly relevant to paths a tool is about to touch (once per session). */
  beforePaths(paths: string[], sessionId?: string): Promise<string | undefined>;
}
export interface Policy {
  write: boolean;
  process: boolean;
  external: boolean;
}
export type ApprovalDecision = "once" | "session" | "deny";
export interface ApprovalRequest {
  call: ToolCall;
  /** Session asking (a child session when delegated). */
  session?: string;
  /** Who is asking, e.g. an agent path such as "general › explore". */
  label?: string;
  effect: "write" | "process" | "external";
  input: Record<string, unknown>;
  signal: AbortSignal;
}
/** Optional interactive approval for write/process/external tools not pre-allowed by the Policy. */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;
export interface HookFailure {
  source: string;
  hook: string;
  error: string;
}
/**
 * Generic extension points the runner calls. The plugin host implements them with per-hook
 * timeouts and failure isolation; the core never knows what an extension does.
 */
export interface RunnerExtensions {
  beforeCompact(input: {
    sessionId: string;
    reason: "manual" | "auto";
    messages: readonly Message[];
    focus?: string;
  }): Promise<{
    instructions: string[];
    /** Field name → description, with the contributing source. */
    fields: Record<string, { source: string; description: string }>;
    failures: HookFailure[];
  }>;
  afterCompact(input: {
    sessionId: string;
    reason: "manual" | "auto";
    messages: readonly Message[];
    focus?: string;
    model: string;
    replaced: number;
    structured: boolean;
    checkpoint?: CompactionCheckpoint;
    checkpointText: string;
    extracted: Record<string, unknown>;
  }): Promise<{
    inject: string[];
    reports: Record<string, Record<string, unknown>>;
    failures: HookFailure[];
  }>;
  sessionStart(input: {
    sessionId: string;
    model: string;
    workspace: string;
  }): Promise<{ inject: Array<{ source: string; text: string }>; failures: HookFailure[] }>;
}
