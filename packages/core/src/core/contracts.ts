import type {
  AnalysisCapability,
  ArtifactPublisher,
  ArtifactRef,
  CompactionCheckpoint,
  InstallPreview,
  Message,
  ToolCall,
  ToolResult,
} from "@alisio/sdk";
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
  /** Root sessions pinned in web clients (v4). */
  pinned?: boolean;
  /** When a root session was archived in web clients (v4); absent when not archived. */
  archivedAt?: number;
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
/** `queued` and `running` are the only non-terminal run states. */
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "turns_exceeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type TerminalRunStatus = Exclude<RunStatus, "queued" | "running">;
/** One `AgentRunner.run` execution (v4 `runs` table). `id` equals `RunEvent.runId`. */
export interface RunRecord {
  id: string;
  session: string;
  status: RunStatus;
  /** Client idempotency key; absent for TUI/headless runs. */
  requestId?: string;
  correlationId?: string;
  /** Process that executes (or executed) the run, for startup reconciliation. */
  ownerPid?: number;
  model?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  usage?: { input: number; output: number; cachedInput?: number };
}
export interface BeginRunInput {
  id: string;
  session: string;
  /** `queued` for scheduled runs, `running` (default) when execution starts now. */
  status?: "queued" | "running";
  requestId?: string;
  correlationId?: string;
  model?: string;
}
export interface EndRunInput {
  status: TerminalRunStatus;
  error?: string;
  usage?: { input: number; output: number; cachedInput?: number };
}
export interface PageOptions {
  /** Only rows with a sequence greater than this (ascending from there). */
  after?: number;
  /** Only rows with a sequence lower than this (the newest `limit` of them). */
  before?: number;
  limit?: number;
}
export interface MessagePage {
  items: Array<{ seq: number; message: Message; compacted: boolean }>;
  /** More rows exist beyond the page in the paging direction. */
  hasMore: boolean;
}
export interface StoredEvent {
  /** Global `events.seq` as a string (same value as `RunEvent.eventId`). */
  eventId: string;
  runId: string;
  type: string;
  data: unknown;
  createdAt?: number;
  correlationId?: string;
}
export interface EventPage {
  items: StoredEvent[];
  hasMore: boolean;
}
/** Optional tool-call metadata (v4 columns); stores may ignore it. */
export interface ToolCallMeta {
  runId?: string;
  effect?: string;
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
  beginCall(session: string, call: ToolCall, meta?: ToolCallMeta): void;
  endCall(session: string, call: ToolCall, result: ToolResult): void;
  /** The persisted result of a completed tool call, for replay of rich (ui/image) parts. */
  callResult(session: string, callId: string): ToolResult | undefined;
  reconcile(id: string, acknowledge?: boolean): void;
  /**
   * Persist a durable run event. Stores that assign a global, monotonic sequence return it; the
   * runner exposes it as `RunEvent.eventId`. Returning nothing is allowed (no `eventId`).
   */
  event(
    id: string,
    runId: string,
    type: string,
    data: unknown,
    meta?: { correlationId?: string },
  ): number | void;
  /*
   * Optional v4 run journal and paging. The runner calls them only when present, so other
   * implementers (tests, embedders) keep compiling without them.
   */
  /**
   * Records a run, or moves an existing `queued` run with the same id to `running`. A run whose
   * `(session, requestId)` already exists is returned as is (`created: false`): idempotency.
   */
  beginRun?(input: BeginRunInput): { run: RunRecord; created: boolean };
  /** Moves a non-terminal run to a terminal state; terminal runs are never overwritten. */
  endRun?(id: string, input: EndRunInput): void;
  runByRequest?(session: string, requestId: string): RunRecord | undefined;
  /** Runs of a session, newest first. */
  runs?(session: string, options?: { limit?: number }): RunRecord[];
  messagesPage?(session: string, options?: PageOptions & { compacted?: boolean }): MessagePage;
  eventsPage?(session: string, options?: PageOptions): EventPage;
  /** Marks queued/running runs whose owner process is not alive as interrupted. */
  interruptRuns?(): number;
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
  /**
   * Pre-allows the `analysis.run` capability only (`--allow-analysis`); never widens `process`.
   * Absent means false.
   */
  analysis?: boolean;
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
  /** The approval is for this capability of the tool, not for the whole effect. */
  capability?: AnalysisCapability;
  /** Capability approvals: the first 40 lines of the script. */
  preview?: string;
  /** Capability approvals: how the code runs (`managed` is not sandboxed). */
  runtime?: "managed" | "oci";
  /** `analysis.install`: the packages, the size estimate and the network need (once or deny). */
  install?: InstallPreview;
}
/**
 * Persisted capability grants as the runner sees them (implemented by `CapabilityGrants`). A
 * `session` decision is stored for the ROOT session and survives restarts; `once` and `deny`
 * decisions are audit rows only.
 */
export interface CapabilityGate {
  granted(capability: AnalysisCapability, sessionId: string): boolean;
  record(input: {
    capability: AnalysisCapability;
    sessionId: string;
    scope: "once" | "session";
    decision: "allow" | "deny";
    source: "tui" | "web" | "flag" | "headless-grant";
    callId?: string;
    runId?: string;
    correlationId?: string;
  }): void;
  /** Recorded as the source of interactive decisions (`tui` or `web`). */
  source?: "tui" | "web";
  /** Runtime mode shown with `analysis.run` approvals (read live: the configuration can change). */
  runtime?: "managed" | "oci";
  /**
   * The script to show in an approval whose input does not carry it (a rerun runs a saved script).
   * Absent or undefined: the preview is taken from `input.code`.
   */
  preview?(input: Record<string, unknown>, sessionId: string): Promise<string | undefined>;
}
/** One artifact published during a tool call, with its local path (for `artifact_published`). */
export interface PublishedArtifactInfo {
  artifact: ArtifactRef;
  path: string;
  warnings: string[];
  executionId?: string;
}
/** The publisher core tools receive; `publishOutputs` publishes a whole staging folder at once. */
export interface CoreArtifactPublisher extends ArtifactPublisher {
  publishOutputs(
    staging: string,
    options: {
      executionId: string;
      title?: string;
      partial?: boolean;
      provenance?: Record<string, unknown>;
    },
  ): Promise<PublishedArtifactInfo[]>;
  /** Detailed variant of `publishText` (path and warnings). */
  publishTextDetailed(input: {
    fileName: string;
    title?: string;
    text: string;
  }): Promise<PublishedArtifactInfo>;
}
/** Creates the publisher of one tool call; `announce` emits `artifact_published`. */
export type ArtifactPublisherFactory = (
  call: { sessionId: string; runId: string; callId: string },
  announce: (published: PublishedArtifactInfo) => void,
) => CoreArtifactPublisher | undefined;
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
