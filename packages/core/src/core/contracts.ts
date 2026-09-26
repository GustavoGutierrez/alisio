import type { CompactionCheckpoint, Message, ToolCall, ToolResult } from "@alisio/sdk";
export interface Session {
  id: string;
  workspace: string;
  provider: string;
  model: string;
}
export interface SessionStore {
  create(workspace: string, provider: string, model: string): Session;
  get(id: string): Session;
  list(): Session[];
  messages(id: string): Message[];
  append(id: string, message: Message): void;
  /** Record the model used for subsequent turns of the session. */
  setModel(id: string, model: string): void;
  /**
   * Atomically replace the first `replaced` active messages with `summary`, keeping the
   * rest verbatim and in order. Callers must never split a tool call from its results.
   */
  compact(id: string, replaced: number, summary: Message): void;
  acquire(id: string): void;
  release(id: string): void;
  beginCall(session: string, call: ToolCall): void;
  endCall(session: string, call: ToolCall, result: ToolResult): void;
  reconcile(id: string, acknowledge?: boolean): void;
  event(id: string, runId: string, type: string, data: unknown): void;
}
export interface ContextSource {
  instructions(): Promise<string>;
  beforePaths(paths: string[]): Promise<string | undefined>;
}
export interface Policy {
  write: boolean;
  process: boolean;
  external: boolean;
}
export type ApprovalDecision = "once" | "session" | "deny";
export interface ApprovalRequest {
  call: ToolCall;
  effect: "write" | "process";
  input: Record<string, unknown>;
  signal: AbortSignal;
}
/** Optional interactive approval for write/process tools not pre-allowed by the Policy. */
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
