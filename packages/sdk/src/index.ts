/** Public, runtime-independent contracts. This package has no Bun or provider imports. */
export type JsonSchema = Record<string, unknown>;
/**
 * `internal` writes only Alisio-owned state (never the workspace or network). It is always
 * allowed and is honored only for built-in plugins; external plugins are downgraded to `external`.
 */
export type Effect = "read" | "write" | "process" | "external" | "internal";
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
/** A node of a `{ kind: "tree" }` UI block. */
export interface TreeNode {
  label: string;
  children?: TreeNode[];
  /** Optional annotation rendered after the label, e.g. a count or a status word. */
  meta?: string;
}
/**
 * Alisio-owned structured rendering of a tool result, produced by core adapters (for example
 * the MCP connector) when a tool returns structured data. It never carries MCP protocol types:
 * plugins wanting a structured block build one of these shapes directly. The runner always
 * keeps a plain-text projection alongside a `ui` part, so providers, compaction and headless
 * output only ever see text; the block is a display hint for TUI rendering.
 */
export type UiBlock =
  | { kind: "table"; columns: string[]; rows: Array<Array<string>>; caption?: string }
  | { kind: "key-value"; entries: Array<[string, string]>; caption?: string }
  | { kind: "tree"; nodes: Array<TreeNode> }
  | { kind: "code"; lang?: string; code: string; caption?: string }
  | { kind: "markdown"; text: string }
  /**
   * A file change: a unified `patch`, or `before`/`after` contents when no patch is available.
   * Producers bound the payload (about 200 KB).
   */
  | {
      kind: "diff";
      path?: string;
      patch?: string;
      before?: string;
      after?: string;
      lang?: string;
      caption?: string;
    }
  /** Output of a command. `output` may contain ANSI escapes; producers bound it (about 256 KB). */
  | {
      kind: "terminal";
      command?: string;
      cwd?: string;
      output: string;
      exitCode?: number;
      durationMs?: number;
      truncated?: boolean;
    }
  /** Mermaid diagram source; text surfaces show the source verbatim. */
  | { kind: "mermaid"; source: string; title?: string }
  /** A LaTeX formula; `display` requests block (not inline) layout. */
  | { kind: "math"; latex: string; display?: boolean }
  /** Any JSON value, shown as a collapsible tree by rich surfaces (bounded to about 256 KB). */
  | { kind: "json"; value: unknown; collapsedDepth?: number; caption?: string }
  /** Test run results grouped by suite. */
  | {
      kind: "test-results";
      framework?: string;
      durationMs?: number;
      suites: Array<{ name: string; file?: string; cases: TestCaseResult[] }>;
    }
  /** A checklist of steps with their current status. */
  | { kind: "progress"; title?: string; steps: ProgressStep[] }
  /** A published, downloadable artifact (`ToolContext.artifacts`). Text surfaces show one line. */
  | { kind: "artifact"; artifact: ArtifactRef };
/** Kind of a published artifact; decides the icon, the label and the renderer. */
export type ArtifactKind =
  | "dashboard"
  | "document"
  | "spreadsheet"
  | "image"
  | "data"
  | "code"
  | "archive"
  | "file";
/** Public reference to a published artifact. Never carries absolute paths. */
export interface ArtifactRef {
  /** `art_<ULID>`. */
  id: string;
  /** Root session that owns the artifact. */
  sessionId: string;
  title: string;
  /** Download name, e.g. `report.md`, or `site.zip` for a multi-file artifact. */
  fileName: string;
  kind: ArtifactKind;
  mimeType: string;
  bytes: number;
  /** More than 1 for multi-file dashboards. */
  fileCount: number;
  /** Decided by the host from the artifact kind and size. */
  previewable: boolean;
  createdAt: number;
  /** Published from a failed execution (`publishOnError`). */
  partial?: boolean;
  status: "ready" | "deleted" | "expired";
}
/** Input of `ArtifactPublisher.publish`: files already written by the caller. */
export interface ArtifactPublishInput {
  /** Absolute path of a file or a directory owned by the caller. */
  source: string;
  title?: string;
  /** Entry file for a directory; defaults to `index.html` when present. */
  entry?: string;
}
/** Publishes caller-owned files as downloadable artifacts of the current session. */
export interface ArtifactPublisher {
  /** Validates, copies and registers; throws with a user-readable message on rejection. */
  publish(input: ArtifactPublishInput): Promise<ArtifactRef>;
  /** Creates a single-file artifact from text the tool already holds. */
  publishText(input: { fileName: string; title?: string; text: string }): Promise<ArtifactRef>;
}
/** Finer-grained permissions inside an effect (closed union; extended additively). */
export type AnalysisCapability = "analysis.run" | "analysis.install";

/**
 * What an `analysis.install` approval shows (phase 4): the optional Python packages that would be
 * installed, an estimate of the download and that it needs the network. Always asks, only `once`.
 */
export interface InstallPreview {
  extras: "analysis" | "science";
  /** Top-level packages, e.g. `pandas`, `numpy`. */
  packages: string[];
  /** Pinned distributions in the lockfile (the packages plus their dependencies). */
  packageCount: number;
  /** Rough download size (wheels only); an estimate, not a measurement. */
  estimatedBytes: number;
  network: true;
}
/** What a tool asks the host to approve before installing packages (capability `analysis.install`). */
export type InstallApprover = (request: InstallPreview) => Promise<"once" | "deny">;
/** A persisted capability decision as exposed by the web API. */
export interface CapabilityGrantWire {
  id: string;
  capability: AnalysisCapability;
  sessionId: string;
  scope: "once" | "session";
  decision: "allow" | "deny";
  source: "tui" | "web" | "flag" | "headless-grant";
  createdAt: number;
  revokedAt?: number;
}
/** Tabular formats the data tools ingest into one SQLite file per dataset. */
export type DatasetFormat = "csv" | "tsv" | "json" | "jsonl" | "xlsx";
/** A dataset (a CSV/TSV/JSON/JSONL/XLSX file ingested into SQLite). Never carries paths. */
export interface DatasetRef {
  /** `ds_<ULID>`. */
  id: string;
  /** Original file name. */
  name: string;
  format: DatasetFormat;
  bytes: number;
  sha256: string;
  sheets: Array<{ name: string; table: string; rows: number; columns: number }>;
}
/** Column of a dataset table with the statistics computed at ingestion. */
export interface DatasetColumnWire {
  name: string;
  /** Original header text. */
  label: string;
  /** A hint (`integer`, `real`, `date`, `boolean`, `text`); values are stored without conversion. */
  type: string;
  nulls: number;
  distinct: number;
  distinctExact: boolean;
  min?: string;
  max?: string;
  mean?: number;
  textFallbacks: number;
  top: Array<{ value: string; count: number }>;
}
/** `GET /api/datasets/:did`: the dataset with the schema and statistics of every sheet. */
export interface DatasetDetailWire extends DatasetRef {
  ingestVersion: number;
  encoding?: string;
  delimiter?: string;
  sheetDetails: Array<{
    name: string;
    table: string;
    rows: number;
    columns: DatasetColumnWire[];
  }>;
  /** Sorting and filtering are disabled above this many rows (`analysis.data.maxInteractiveRows`). */
  maxInteractiveRows: number;
}
/** `GET /api/datasets/:did/rows`: one page of a sheet (keyset-paginated). */
export interface DatasetRowsPage {
  columns: Array<{ name: string; label: string; type: string }>;
  /** Cell values as stored: numbers stay numbers, everything else is text, empty cells are null. */
  rows: Array<Array<string | number | null>>;
  /** 1-based position of the first row in the (unfiltered, unsorted) sheet, per row. */
  rowids: number[];
  /** Opaque cursor for the next page; absent on the last page. */
  next?: string;
  /** Rows in the sheet. */
  total: number;
  /** Rows matching the filter (first page only). */
  matched?: number;
  /** Sorting and filtering were ignored because the sheet exceeds `maxInteractiveRows`. */
  interactive: boolean;
}
/** One case of a `{ kind: "test-results" }` UI block. */
export interface TestCaseResult {
  name: string;
  status: "passed" | "failed" | "skipped" | "todo";
  durationMs?: number;
  error?: string;
  line?: number;
}
/** One step of a `{ kind: "progress" }` UI block. */
export interface ProgressStep {
  label: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  detail?: string;
}
/**
 * Every `UiBlock` kind, for surfaces that dispatch on the kind at runtime (renderer registries,
 * validators). Surfaces must still render an unknown kind as text: blocks persisted by a newer
 * Alisio can be replayed by an older one.
 */
export const UI_BLOCK_KINDS = [
  "table",
  "key-value",
  "tree",
  "code",
  "markdown",
  "diff",
  "terminal",
  "mermaid",
  "math",
  "json",
  "test-results",
  "progress",
  "artifact",
] as const satisfies readonly UiBlock["kind"][];
export interface ToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; mimeType: string; data: string }
    | { type: "ui"; block: UiBlock }
  >;
  isError?: boolean;
}
/**
 * An image attached to a user message. Persisted verbatim in the session store; sent to the
 * provider as a vision content part alongside the text. Never carried into a compaction summary
 * (only its mime type and dimensions are, as plain text) so raw bytes never reach the model twice.
 */
export interface Attachment {
  kind: "image";
  mimeType: string;
  /**
   * Base64-encoded bytes, no `data:` prefix. Required: providers and plugins read it directly,
   * and no runtime check yet guarantees an alternative source. Content-addressed uploads travel
   * as `BlobRef` and are resolved to `data` by the host before they reach an `Attachment`.
   */
  data: string;
  bytes: number;
  width?: number;
  height?: number;
}
export type Message =
  /**
   * `summary` marks injected context (e.g. a compaction checkpoint); `display` is what UIs show
   * instead of `text` (e.g. `/init` for an expanded prompt template). Providers ignore both.
   */
  | {
      role: "user";
      text: string;
      summary?: boolean;
      display?: string;
      attachments?: Attachment[];
      /** Datasets attached to this prompt (UI chips); the model sees their text summary in `text`. */
      datasets?: DatasetRef[];
    }
  | {
      role: "assistant";
      text: string;
      calls: ToolCall[];
      providerData?: unknown[];
      /**
       * The provider reported `finish_reason: "length"` (or an equivalent incomplete-stop signal):
       * the response was cut by the output token budget. Per-answer text and tool calls are
       * complete as far as they went; consumers decide whether to warn or accept a partial result.
       */
      truncated?: boolean;
    }
  | { role: "tool"; callId: string; result: ToolResult };
export interface Usage {
  input: number;
  output: number;
  /** Input tokens served from a provider prompt cache, when reported. */
  cachedInput?: number;
}
export type ProviderEvent =
  | { type: "text_delta"; delta: string }
  /** Provider-visible reasoning text. Display only; never persisted or replayed. */
  | { type: "reasoning_delta"; delta: string }
  | {
      type: "completed";
      message: Extract<Message, { role: "assistant" }>;
      usage?: Usage;
    };
export interface ModelInfo {
  id: string;
  name?: string;
  /** Organization that owns the model, when required by the provider catalog. */
  ownedBy?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Modalities accepted by the model, as reported by its catalog. */
  inputModalities?: string[];
  /** Modalities produced by the model, as reported by its catalog. */
  outputModalities?: string[];
  /** Provider-declared, per-protocol API metadata. Preserved without flattening. */
  apiCapabilities?: Record<string, JsonValue>;
  /** Provider-declared reasoning effort levels. */
  effort?: { supportedLevels: string[]; defaultLevel?: string };
  /** Legacy combined modality metadata from OpenAI-compatible catalogs. */
  modalities?: string[];
  /** Provider-declared API/capability metadata; informational and never contains credentials. */
  capabilities?: Record<string, boolean | string | number>;
}
/** Credential-free model target exposed by the host resolver. */
export interface AvailableProviderModel {
  /** Canonical selector, always `<provider>/<model>` (the model may itself contain `/`). */
  reference: string;
  provider: string;
  profile: string;
  providerName: string;
  model: ModelInfo;
}
/** A validated model target. Credentials remain inside the host. */
export interface ResolvedProviderModel extends AvailableProviderModel {}
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export interface ModelProvider {
  id: string;
  /** Default model; a request may override it for one call. */
  model: string;
  stream(request: {
    instructions: string;
    messages: Message[];
    tools: ToolDefinition[];
    maxOutputTokens: number;
    signal: AbortSignal;
    model?: string;
    /** Opaque persisted conversation id. Providers may use it for cache affinity only. */
    sessionId?: string;
    /**
     * Raw provider-native tool definitions (for example a hosted `web_search` tool), appended to
     * the request's `tools` array verbatim, alongside the function tools built from `tools`. Only
     * meaningful for providers that document an equivalent server-side tool; an implementation
     * that does not support one may ignore this or let the provider reject it.
     */
    nativeTools?: Array<Record<string, unknown>>;
    /**
     * Provider-declared reasoning effort level (a value from `ModelInfo.effort.supportedLevels`).
     * Providers that advertise effort levels map it to their request field (for example DeepSeek
     * `reasoning_effort`); providers without a concept ignore it.
     */
    reasoningEffort?: string;
  }): AsyncIterable<ProviderEvent>;
  /** Optional model catalog. Implementations must not expose credentials. */
  listModels?(signal: AbortSignal): Promise<ModelInfo[]>;
  /** Releases provider-owned clients or transports. */
  dispose?(): void | Promise<void>;
}
export type ProviderConfigurationValue = string | boolean | number;
export interface ProviderConfigurationField {
  key: string;
  label: string;
  kind: "text" | "secret" | "url" | "select" | "boolean";
  required?: boolean;
  description?: string;
  defaultValue?: ProviderConfigurationValue;
  options?: Array<{ value: string; label: string }>;
}
export interface ProviderCapabilities {
  nativeWebSearch?: boolean | { field: string; values: ProviderConfigurationValue[] };
}
export interface ProviderCreateRequest {
  /** Non-secret, globally persisted profile values. */
  profile: Record<string, ProviderConfigurationValue>;
  /** Secret values loaded from the dedicated credentials store. */
  credentials: Record<string, string>;
  /** Legacy root provider configuration, supplied without rewriting it. */
  legacy?: Record<string, unknown>;
}
/** Additive model-provider contribution. Multiple registrations coexist in the host registry. */
export interface ProviderRegistration {
  id: string;
  name: string;
  description?: string;
  fields: ProviderConfigurationField[];
  capabilities?: ProviderCapabilities;
  create(request: ProviderCreateRequest): ModelProvider | Promise<ModelProvider>;
}
export interface ToolContext {
  signal: AbortSignal;
  workspace: string;
  emit: (data: unknown) => void;
  /** Session that issued the call, when run by the agent loop. */
  session?: string;
  /** Who is asking, e.g. an agent path such as "general › explore" (child sessions only). */
  label?: string;
  /**
   * Resolves a tool path under the session's mediated path policy (workspace plus declared extra
   * directories). Out-of-root paths ask for directory approval when the host allows it; hosts that
   * do not inject this fall back to the workspace-only `safePath` policy.
   */
  resolvePath?: (path: string) => Promise<string>;
  /** Run and tool call that issued this execution, when run by the agent loop. */
  runId?: string;
  callId?: string;
  /**
   * Emits a durable run event of the call's run. Only `exit_plan` receives it (`plan_proposed`,
   * `plan_decided`); other tools, plugin tools included, never do.
   */
  emitEvent?: <K extends "plan_proposed" | "plan_decided">(
    type: K,
    data: RunEventDataMap[K],
  ) => void;
  /** Present when the host has an artifact store for this session (built-in tools only in v1). */
  artifacts?: ArtifactPublisher;
  /**
   * Asks the user to approve installing the optional Python packages (capability
   * `analysis.install`; built-in tools only). Resolves `deny` where nobody can be asked
   * (headless, `--read-only`), because no flag grants an installation.
   */
  approveInstall?: InstallApprover;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Unknown/plugin operations default to external; only declare read for side-effect-free tools. */
  effect?: Effect;
  /** May run concurrently with other read/concurrent calls of the same turn (e.g. delegation). */
  concurrent?: boolean;
  paths?: (input: Record<string, unknown>) => string[];
  /**
   * Finer-grained permission inside `effect`: a broad grant of `effect` covers it, a grant of the
   * capability never widens `effect`. Honored for built-in tools only (ignored for plugins in v1).
   */
  capability?: AnalysisCapability;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
/**
 * One event of an agent run, as delivered to `onEvent`, plugins and `alisio run --json` (JSONL).
 * `schemaVersion` stays `1` while changes are additive (new optional fields, new event types);
 * consumers must ignore unknown fields and unknown `type` values. See `KnownRunEvent` for the
 * typed payloads of the events the core emits today.
 */
export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  /** Per-run counter starting at 1 (restarts on every run; not unique within a session). */
  seq: number;
  type: string;
  timestamp: string;
  data: unknown;
  /**
   * Stable id of a durable event: the persisted global `events.seq`, as a decimal string. Absent
   * for ephemeral events (`EphemeralRunEventType`) and when the host store does not report it.
   */
  eventId?: string;
  /** Embedder-supplied correlation id (for example an HTTP `X-Request-Id`), when given. */
  correlationId?: string;
}
/** What a `run_failed` event with `code: "timeout"` says about the limit that stopped the run. */
export interface RunTimeoutInfo {
  /** `run`: the whole-run limit (`limits.timeoutMs`); `first_token`: a silent request (`limits.firstTokenTimeoutMs`). */
  kind: "run" | "first_token";
  /** The limit that was reached, in milliseconds. */
  ms: number;
  /** Model the run was using, when known. */
  model?: string;
  /** Short provider label (the host of an OpenAI-compatible endpoint), when known. */
  provider?: string;
  /** What the run was doing: waiting for the first token of a request, streaming, or running a tool. */
  stage: "waiting_model" | "streaming" | "tool" | "other";
  /** The tool that was running when `stage` is `tool`. */
  tool?: string;
  /** Nothing had been produced yet: the very first model request of the run got no answer. */
  firstRequest?: boolean;
  /**
   * `first_token` only: how many times the same request was sent (the first try plus the silent
   * retries of `limits.firstTokenRetries`); `1` when retrying is disabled.
   */
  attempts?: number;
}
/** What a `run_failed` event with `code: "output_truncated"` says about the limit that cut it. */
export interface RunTruncationInfo {
  /** How many responses were cut off (the first plus every recovery). */
  attempts: number;
  /** The output-token budget of the cut requests (the effective one, see `source`). */
  maxOutputTokens: number;
  /** Where that budget came from: the user, the model's catalog, or the default. */
  source?: "user" | "model" | "default";
  /** The model whose responses were cut. */
  model?: string;
}
/**
 * Payload of each event type the core emits today, keyed by `RunEvent.type`. Additive: new
 * types and new optional fields may appear; existing fields keep their meaning.
 */
export interface RunEventDataMap {
  run_started: { model: string };
  text_delta: { delta: string };
  /** Provider-visible reasoning text; display only, never persisted. */
  reasoning_delta: { delta: string };
  turn_completed: {
    /** 1-based turn number within the run. */
    turn: number;
    /** Cumulative input + output tokens of the run so far. */
    tokens: number;
    calls: number;
    model: string;
    usage?: Usage;
    /** Milliseconds from sending the provider request to its completed response. */
    durationMs?: number;
    /** Milliseconds to the first streamed text/reasoning delta; absent when nothing streamed. */
    ttftMs?: number;
  };
  tool_started: { id: string; name: string; arguments: string; effect: Effect };
  /** `data` is whatever the tool passed to `ToolContext.emit`. */
  tool_progress: { id: string; data: unknown };
  tool_completed: {
    id: string;
    name: string;
    isError: boolean;
    durationMs: number;
    /** Text projection of the result, capped at 2,000 characters. */
    preview: string;
  };
  approval_requested: {
    id: string;
    name: string;
    effect: "write" | "process" | "external";
    label?: string;
    /** The approval is for this capability (not the whole effect). */
    capability?: AnalysisCapability;
    /** `analysis.install` approvals: the packages, the size estimate and the network need. */
    install?: InstallPreview;
  };
  approval_resolved: {
    id: string;
    name: string;
    effect: "write" | "process" | "external";
    decision: "once" | "session" | "deny";
    capability?: AnalysisCapability;
    /** A `session` capability decision was stored and survives restarts. */
    persisted?: boolean;
  };
  /**
   * A tool published an artifact. `path` is the absolute local path of the file (or the entry of a
   * multi-file artifact) for local consumers (TUI, JSONL); web clients ignore it.
   */
  artifact_published: {
    artifact: ArtifactRef;
    path: string;
    callId?: string;
    executionId?: string;
  };
  /** The plan agent proposed a plan with `exit_plan` and is waiting for the user's decision. */
  plan_proposed: {
    callId: string;
    planId: string;
    revision: number;
    hash: string;
    title: string;
    /** The `plan.md` artifact (absent when publishing failed). */
    artifactId?: string;
  };
  /** The user decided: approve (implementation follows), skip (stay in plan) or add context. */
  plan_decided: {
    callId: string;
    planId: string;
    hash: string;
    decision: "approve" | "skip" | "context";
  };
  run_completed: { tokens: number; text: string; truncated?: boolean };
  /**
   * `maxOutputTokens` is the effective budget of the cut request; `source` says whether it was
   * set by the user, taken from the model's catalog, or the default.
   */
  response_truncated: {
    turn: number;
    maxOutputTokens: number;
    source?: "user" | "model" | "default";
  };
  /**
   * A model request stayed completely silent for `limits.firstTokenTimeoutMs` and the same
   * request is sent again (no new turn, nothing appended to the session). `attempt` is the
   * retry about to start (1-based), `of` the retries allowed (`limits.firstTokenRetries`) and
   * `afterMs` how long the aborted request had been silent.
   */
  request_retry: { attempt: number; of: number; reason: "first_token_timeout"; afterMs: number };
  /**
   * A model response was cut off by the output-token limit before it was usable (no text and no
   * tool call, or a tool call whose arguments are incomplete) and the same turn is requested
   * again with a short continuation notice. The truncated tool calls were discarded, never
   * executed or persisted, and the retry is not a turn. `attempt` is the recovery about to start
   * (1-based), `of` the recoveries allowed (`limits.truncationRecoveries`), `reason` what was
   * lost, and `effort` the lowered reasoning effort of that request, when one was applied.
   */
  truncation_recovery: {
    attempt: number;
    of: number;
    reason: "tool_call_cut" | "empty_response";
    maxOutputTokens: number;
    effort?: string;
  };
  run_turns_exceeded: { turns: number; maxTurns: number };
  /**
   * The run failed. `error` is always a human-readable message. `code: "timeout"` (with `timeout`)
   * marks a run stopped by a time limit instead of a provider or tool error;
   * `code: "output_truncated"` (with `truncation`) a run whose responses kept being cut off by
   * the output-token limit after the allowed recoveries. These fields are additive and absent
   * for every other failure.
   */
  run_failed: {
    error: string;
    code?: "timeout" | "output_truncated";
    timeout?: RunTimeoutInfo;
    truncation?: RunTruncationInfo;
  };
  run_cancelled: { error: string };
  model_changed: { model: string; previous: string };
  compaction_started: { reason: "manual" | "auto"; before: number; messages: number };
  compaction_completed: {
    reason: "manual" | "auto";
    before: number;
    after: number;
    replaced: number;
    structured: boolean;
    summarizedTokens: number;
    checkpointTokens: number;
    /** Per-plugin `CompactionOutcome.report`, keyed by plugin id. */
    plugins: Record<string, Record<string, unknown>>;
    /** The summary hit its output budget and was accepted as partial. */
    partial?: true;
  };
  compaction_skipped: { reason: "manual" | "auto"; before: number; detail: string };
  compaction_failed: { reason: "manual" | "auto"; error: string };
  /** Tool results clipped in place to fit the context budget. */
  context_reduced: { messages: number };
  session_context_injected: { tokens: number; sources: string[] };
  plugin_hook_failed: { source: string; hook: string; error: string; continued: true };
}
/** Every `RunEvent.type` the core emits today. `RunEvent.type` itself stays `string`. */
export type RunEventType = keyof RunEventDataMap;
/** Event types never persisted to the session store (and therefore without `eventId`). */
export type EphemeralRunEventType = "text_delta" | "reasoning_delta" | "tool_progress";
export const EPHEMERAL_RUN_EVENT_TYPES: readonly EphemeralRunEventType[] = [
  "text_delta",
  "reasoning_delta",
  "tool_progress",
];
/** True for streaming-only event types that are never persisted. */
export function isEphemeralRunEventType(type: string): type is EphemeralRunEventType {
  return (EPHEMERAL_RUN_EVENT_TYPES as readonly string[]).includes(type);
}
/**
 * Discriminated view of `RunEvent` with typed `data`, for consumers that narrow on `type`.
 * Every member is assignable to `RunEvent`; events of unknown types remain plain `RunEvent`s.
 */
export type KnownRunEvent = {
  [K in RunEventType]: RunEvent & { type: K; data: RunEventDataMap[K] };
}[RunEventType];
/** Generic structured checkpoint produced by core context compaction. */
export interface CompactionCheckpoint {
  goal: string;
  instructions: string[];
  discoveries: string[];
  accomplished: string[];
  currentState: string;
  nextSteps: string[];
  relevantFiles: string[];
}
export interface CompactionStart {
  sessionId: string;
  reason: "manual" | "auto";
  /** Messages about to be replaced by the checkpoint. */
  messages: readonly Message[];
  focus?: string;
  signal: AbortSignal;
}
export interface CompactionContribution {
  /** Extra guidance appended to the summarizer instructions. */
  instructions?: string;
  /**
   * Extra top-level JSON fields requested in the same summarizer call, as name → description.
   * Values are returned unvalidated in `CompactionResult.extracted`; validate them yourself.
   */
  outputFields?: Record<string, string>;
}
export interface CompactionResult extends CompactionStart {
  model: string;
  replaced: number;
  /** False when the summarizer did not return valid JSON (text-only checkpoint). */
  structured: boolean;
  checkpoint?: CompactionCheckpoint;
  checkpointText: string;
  /** This plugin's requested output fields, when present. */
  extracted: Record<string, unknown>;
}
export interface CompactionOutcome {
  /** Text appended after the checkpoint in the compacted history (keep it budgeted). */
  injectContext?: string;
  /** Shown to the user; `summary` is displayed verbatim when present. */
  report?: { summary?: string } & Record<string, unknown>;
}
export interface CompactionHooks {
  beforeCompact?(input: CompactionStart): Promise<CompactionContribution | undefined | void>;
  afterCompact?(input: CompactionResult): Promise<CompactionOutcome | undefined | void>;
}
export interface SessionInfo {
  sessionId: string;
  model: string;
  workspace: string;
  reason: "start" | "clear" | "exit";
  messages: readonly Message[];
  /** Aborted when the host timeout for this hook expires. */
  signal: AbortSignal;
}
export interface CompletionRequest {
  system: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  maxTokens?: number;
  model?: string;
  /** Session whose provider binding should be used when model is omitted. */
  sessionId?: string;
  /** Reasoning effort level when the target model advertises `ModelInfo.effort`. */
  reasoningEffort?: string;
  signal?: AbortSignal;
}
export type SqlValue = string | number | bigint | null | Uint8Array;
/** Row objects are plain; column types depend on the query, so they are typed loosely. */
export type SqlRow = Record<string, any>;
export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  /** First row as a plain object, or undefined. */
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}
/**
 * Storage port: a synchronous SQLite database (FTS5 available) provided by the host, so plugins
 * never depend on a specific runtime driver.
 */
export interface SqlDatabase {
  exec(sql: string): void;
  /** Prepared statements are cached per SQL text. */
  prepare(sql: string): SqlStatement;
  /** Runs `fn` in an immediate transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T;
  close(): void;
}
/** What the host knows about the terminal; providers must honor it (no globals, env or fs). */
export interface TerminalCapabilities {
  /** ANSI SGR colors allowed. When false, output must be plain text. */
  color: boolean;
  /** Non-ASCII glyphs allowed. When false, output must be ASCII. */
  unicode: boolean;
  columns: number;
  interactive: boolean;
}
export interface MascotContext {
  terminal: TerminalCapabilities;
  version: string;
}
/** A small piece of character art; one string (may contain newlines) or lines. */
export interface MascotProvider {
  id: string;
  render(ctx: MascotContext): string | string[];
}
/**
 * Catalog grouping a plugin declares in its manifest; the host derives `"model-provider"` from
 * provider registrations. The TUI groups `/plugins` by the first declared category. Accepted
 * values:
 * - `"model-provider"` — registers model providers.
 * - `"methodology-harness"` — bundles a development-methodology workflow.
 * - `"memory"` — persistent memory, recollection and session summaries.
 * - `"subagents"` — delegation, child sessions and agent management.
 * - `"search"` — web or vector search providers.
 * - `"tools"` — general-purpose tool collections.
 * - `"security"` — audit, sandbox or permission tooling.
 * - `"analytics"` — usage/metrics instrumentation (session stats, cost tracking).
 * - `"mcp"` — MCP-server management or bundling helpers.
 * - `"storage"` — durable storage backends beyond the default SQLite state.
 * - `"ui"` — TUI presentation providers (startup screens, mascots, panels).
 */
export type PluginCategory =
  | "model-provider"
  | "methodology-harness"
  | "memory"
  | "subagents"
  | "search"
  | "tools"
  | "security"
  | "analytics"
  | "mcp"
  | "storage"
  | "ui";
export interface PluginMetadata {
  id: string;
  version: string;
  builtin: boolean;
  name?: string;
  description?: string;
  /**
   * Categories declared by the plugin or derived by the host from its registrations; any value of
   * the `PluginCategory` union.
   */
  categories?: PluginCategory[];
}
export interface StartupFact {
  label: string;
  value: string;
}
export interface StartupContext {
  version: string;
  cwd: string;
  model?: string;
  /** Provider host only (never credentials). */
  provider?: string;
  userName?: string;
  terminal: TerminalCapabilities;
  plugins: readonly PluginMetadata[];
  /** The resolved (and validated) mascot, so custom screens can reuse it. */
  mascot: MascotProvider;
  tips: readonly string[];
  /** Host-provided contextual facts such as permissions or plugin state. */
  facts?: readonly StartupFact[];
}
/** Renders the startup screen as plain lines (ANSI SGR only when `terminal.color`). */
export interface StartupScreenProvider {
  id: string;
  render(ctx: StartupContext): string[];
}
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
/** A pluggable web-search backend for the `websearch` tool. */
export interface SearchProvider {
  id: string;
  search(query: string, options?: { signal?: AbortSignal }): Promise<SearchResult[]>;
}
/** Typed map of extension points; new points are added here without breaking existing ones. */
export interface ExtensionPoints {
  mascot: MascotProvider;
  "startup-screen": StartupScreenProvider;
  /** Replaces the built-in websearch resolution (SearXNG/DuckDuckGo/configured/native) entirely. */
  websearch: SearchProvider;
}
export interface ExtensionOptions {
  /** Higher wins (default 0). Ties break by plugin id, then registration order. */
  priority?: number;
}
/** Lifecycle of a child session (delegated work). */
export type SessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
/** Capability narrowing for a child session: it can never exceed its parent. */
export type PermissionLevel = "allow" | "ask" | "deny";
export interface ChildSessionSpec {
  parentId: string;
  /** Optional preassigned id (UUID), e.g. to name a git branch before spawning. */
  id?: string;
  title: string;
  /** Free-form label shown in UIs and approvals (e.g. an agent name). */
  agent: string;
  /** System instructions appended for this child (persona and rules). */
  instructions?: string;
  /** Tool names; `*` allows every tool the parent has. Applied on top of the parent's tools. */
  tools?: { allow?: string[]; deny?: string[] };
  /** Child model selector (`provider/model` or an unambiguous model id); inherits when omitted. */
  model?: string;
  readOnly?: boolean;
  permission?: { write?: PermissionLevel; process?: PermissionLevel };
  /** Workspace root for the child (e.g. a git worktree); defaults to the parent's. */
  workspace?: string;
  maxTurns?: number;
  timeoutMs?: number;
  maxTokens?: number;
  /** Per-call output token budget for the child; beats the global agent-loop budget. */
  maxOutputTokens?: number;
}
export interface ChildSessionInfo {
  id: string;
  parentId: string;
  depth: number;
  agent: string;
  title: string;
  status: SessionStatus;
  model: string;
  provider: string;
  workspace: string;
  usage: { input: number; output: number };
  /** Effective capabilities after narrowing. */
  capabilities: { write: boolean; process: boolean; approvals: boolean };
  createdAt: number;
  updatedAt: number;
}
export interface ChildRunResult {
  id: string;
  status: SessionStatus;
  text: string;
  usage: { input: number; output: number };
  error?: string;
  /** True when the child hit its turn limit: `text` is a usable partial result, not an error. */
  turnsExceeded?: boolean;
}
/** Generic tree node contributed to an interactive panel (e.g. running agents). */
export interface PanelNode {
  id: string;
  parentId?: string;
  label: string;
  /** Named color: red, green, yellow, blue, magenta, cyan, gray. */
  color?: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  tokens?: number;
  /** One-line live summary. */
  detail?: string;
  /** Session to open in a read-only view when the node is selected. */
  sessionId?: string;
}
export interface PanelProvider {
  title: string;
  /** Nodes under the given root session, parents before children. */
  nodes(context: { sessionId: string }): PanelNode[];
  /** UI actions: cancel a node (and its subtree) or move foreground work to the background. */
  action?(
    action: "cancel" | "background",
    nodeId: string | undefined,
    context: { sessionId: string },
  ): void | Promise<void>;
}
export interface SelectRequest {
  title: string;
  options: Array<{ value: string; label: string; description?: string }>;
}
export interface QuestionOption {
  /** Stable value returned by `ui.askQuestions`; not necessarily shown to the user. */
  value: string;
  label: string;
  description?: string;
  /** At most one option per question should be marked recommended. A suggestion, never forced. */
  recommended?: boolean;
  /**
   * Choosing this option also asks for free text (for example "Add context"). The text travels
   * back as the extra answer key `"<questionId>:text"`; clients that do not know the field show
   * a plain option and the answer simply carries no text.
   */
  textInput?: { placeholder?: string };
}
/**
 * A plan waiting for the user's decision (`exit_plan`). Carried by `AskQuestionsRequest.plan` and
 * `PendingInteraction.request.plan`: clients that know it render the plan and the three decisions;
 * clients that do not still show the single question with its options.
 */
export interface PlanReview {
  /** Stable id of this proposal; one per `exit_plan` call. */
  planId: string;
  /** 1 for the first proposal of a session, then one more for every `exit_plan` call. */
  revision: number;
  /** `sha256` of the Markdown: the approved snapshot is the one with this hash. */
  hash: string;
  title: string;
  /** The whole plan in Markdown (the same text as the `plan.md` artifact). */
  markdown: string;
  /** The published `plan.md` artifact (absent when publishing failed). */
  artifact?: ArtifactRef;
}
/** Lifecycle of a background task (`bg_run`); a terminal state is never left. */
export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "lost";
/** `shell` is a `bg_run` command; `subagent` is a read-only mirror of a subagent task. */
export type BackgroundTaskKind = "shell" | "subagent";
/** Who aborted a task: the user (UI), the model (`bg_stop`), the watchdog or the shutdown. */
export type BackgroundTaskAbortOrigin = "user" | "model" | "timeout" | "shutdown";
/** A background task as shown by tools, routes and UIs (no secrets, no log path). */
export interface BackgroundTaskInfo {
  id: string;
  kind: BackgroundTaskKind;
  label: string;
  status: BackgroundTaskStatus;
  /** Shell tasks: the command line and the directory it ran in. */
  command?: string;
  cwd?: string;
  exitCode?: number;
  signal?: string;
  /** `timeout` (watchdog) or `spawn_failed`. */
  errorCode?: string;
  abortOrigin?: BackgroundTaskAbortOrigin;
  /** Session that started it (a child session for delegated work). */
  sessionId: string;
  /** Subagent mirrors: the parent task or session. */
  parentId?: string;
  /** Operating-system process id (shell tasks, while known; useful to find a `lost` task). */
  pid?: number;
  /** Bytes of output stored so far. */
  bytes: number;
  /** The stored log was cut at its size limit. */
  truncated?: boolean;
  timeoutMs?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** The owner agent has been told about the end (or read the output after it). */
  delivered?: boolean;
}
/** One incremental read of a task log (`bg_output`, `GET …/tasks/:tid/output`). */
export interface BackgroundTaskOutput {
  text: string;
  /** Pass it back as `offset` to continue; equals the input offset when nothing new arrived. */
  nextOffset: number;
  /** The task is over and everything has been read. */
  eof: boolean;
  status: BackgroundTaskStatus;
  exitCode?: number;
  truncated?: boolean;
}
/** The state of a session goal (`/goal`); `complete` and `budget_limited` are final unless re-armed. */
export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";
/** Why a goal is in its state: a closed set of codes (the UIs translate them). */
export type GoalReason =
  | "created"
  | "resumed"
  | "edited"
  | "user_paused"
  | "user_interrupt"
  | "model_complete"
  | "model_blocked"
  | "policy_denied"
  | "run_error"
  | "token_budget"
  | "max_turns"
  | "max_wall"
  | "no_progress"
  | "restart";
/** What an active goal is waiting for before its next continuation (never stored: computed). */
export type GoalWaiting = "approval" | "question" | "user_input" | "plan_mode" | "background_tasks";
/** What the user can do to a goal (the actions the UIs offer per state). */
export type GoalAction = "pause" | "resume" | "edit" | "clear" | "budget";
/** One piece of evidence the model gives with `update_goal` (`denied` = a permission denial). */
export interface GoalEvidence {
  kind: "file" | "test" | "log" | "command" | "denied" | "other";
  detail: string;
}
/** A session goal as shown by routes and UIs. */
export interface GoalInfo {
  sessionId: string;
  goalId: string;
  objective: string;
  status: GoalStatus;
  reason?: GoalReason;
  /** Short context of the reason (the error text of a failed run, which breaker paused it). */
  detail?: string;
  /** Compare-and-set counter: changes with every status, objective or budget change. */
  epoch: number;
  /** Tokens (input + output of every request) the goal may spend; absent = no token budget. */
  tokenBudget?: number;
  tokensUsed: number;
  /** Runs spent (a goal turn is one run: the kickoff, a continuation or a prompt of the user). */
  turnsUsed: number;
  maxTurns: number;
  /** Time spent in runs, in milliseconds, and its cap. */
  activeMs: number;
  maxWallMs: number;
  /** The model's last `update_goal` report. */
  summary?: string;
  evidence?: GoalEvidence[];
  /** What the next continuation waits for (set by the host: it knows the live state). */
  waiting?: GoalWaiting;
  /** The user actions allowed in this state. */
  actions: GoalAction[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
export interface Question {
  id: string;
  /** Short chip label (e.g. shown as a breadcrumb/heading), distinct from the full `question` text. */
  header: string;
  question: string;
  /** 2-4 options. */
  options: QuestionOption[];
  multiSelect?: boolean;
}
export interface AskQuestionsRequest {
  /** 1-4 questions, asked one after another. */
  questions: Question[];
  /** Session asking (a child session when delegated). */
  session?: string;
  /** Who is asking, e.g. an agent path such as "general › explore". */
  label?: string;
  /** Set by `exit_plan`: the plan these questions decide on (see `PlanReview`). */
  plan?: PlanReview;
  signal?: AbortSignal;
}
/** Each question id maps to the chosen value(s), or undefined when the question was skipped. */
export type AskQuestionsResult = Record<string, string | string[] | undefined>;
/** Where a command was invoked (the interactive UI's current session, when known). */
export interface CommandContext {
  sessionId?: string;
}
export interface CommandOptions {
  description?: string;
  argumentHint?: string;
}
/** Where a data view runs: the session the web asked about (already validated by the host). */
export interface ViewContext {
  sessionId: string;
  /** Workspace of that session. */
  workspace: string;
  /** Aborted when the host timeout for the view expires. */
  signal: AbortSignal;
}
/**
 * A named, read-only data view a plugin exposes to hosts (the web UI reads them through
 * `GET /api/sessions/:sid/views/:plugin/:view`). Read-only is a CONTRACT, not a sandbox: the host
 * only enforces the method, the validated parameters, a timeout and a response size cap.
 */
export interface ViewDefinition {
  /** Lowercase letters, digits and dashes, starting with a letter (max 40 characters). */
  id: string;
  description: string;
  /**
   * JSON Schema of the query parameters: `type: "object"` whose properties are primitives
   * (`string`, `integer`, `number`, `boolean`). Query strings are coerced to these types and
   * unknown keys are rejected. Omitted means "no parameters".
   */
  params?: JsonSchema;
  /** Returns JSON-serializable data. Throw `ViewParamsError` for a parameter the schema cannot express. */
  handler(params: Record<string, unknown>, context: ViewContext): unknown | Promise<unknown>;
}
/** `ViewDefinition.handler` failure caused by the caller's parameters (becomes a 400). */
export class ViewParamsError extends Error {
  readonly code = "view_invalid_params";
  constructor(message = "Invalid view parameters") {
    super(message);
    this.name = "ViewParamsError";
  }
}
export interface PluginAPI {
  tools: { register(tool: ToolDefinition): () => void };
  commands: {
    register(
      name: string,
      handler: (args: string, context?: CommandContext) => Promise<string>,
      options?: CommandOptions,
    ): () => void;
  };
  events: { on(handler: (event: Readonly<RunEvent>) => void): () => void };
  context: { register(provider: () => Promise<string>): () => void };
  resources: {
    skills(path: string): void;
    prompts(path: string): void;
    /** A directory of agent definitions (Markdown + frontmatter) for delegation plugins. */
    agents(path: string): void;
    /** Directories registered by every plugin for a resource kind, with the plugin id. */
    list(kind: "skills" | "prompts" | "agents"): Array<{ plugin: string; dir: string }>;
  };
  state: { get(key: string): unknown; set(key: string, value: unknown): void };
  /** Contribute to core context compaction (hooks run with a host timeout; failures are isolated). */
  compaction: { register(hooks: CompactionHooks): () => void };
  session: {
    /** Returned text is injected once at the start of a new, empty session. */
    onStart(handler: (info: SessionInfo) => Promise<string | undefined | void>): () => void;
    /** Called when an interactive session ends (/clear, /exit, quit), bounded by a timeout. */
    onEnd(handler: (info: SessionInfo) => Promise<void>): () => void;
  };
  /** Provider-agnostic text completion; plugins never import provider SDKs. */
  model: { complete(request: CompletionRequest): Promise<string> };
  /** Credential-free access to configured `/connect` provider models. */
  models: {
    list(signal?: AbortSignal): Promise<AvailableProviderModel[]>;
    resolve(reference: string, signal?: AbortSignal): Promise<ResolvedProviderModel>;
  };
  /** Register a selectable model provider; unlike extensions, registrations do not compete. */
  providers: { register(provider: ProviderRegistration): () => void };
  /** Opens a private (0600) SQLite file, creating parent directories (0700). */
  storage: { sqlite(path: string): SqlDatabase };
  /**
   * Named read-only data views for hosts such as the web UI. Absent on a core that predates it:
   * feature-detect with `api.views?.register(...)` so the plugin keeps working there.
   */
  views?: { register(view: ViewDefinition): () => void };
  /** Provide an implementation for a named extension point (e.g. mascot, startup-screen). */
  extensions: {
    register<K extends keyof ExtensionPoints>(
      point: K,
      provider: ExtensionPoints[K],
      options?: ExtensionOptions,
    ): () => void;
  };
  /**
   * Child sessions: separate conversations (fresh context) that run with narrowed permissions,
   * persisted with parent links. Aborting a parent run aborts running descendants.
   */
  sessions: {
    spawn(spec: ChildSessionSpec): ChildSessionInfo;
    /** Resolves an optional model selector before creating the child. */
    create(spec: ChildSessionSpec): Promise<ChildSessionInfo>;
    run(id: string, prompt: string, options?: { signal?: AbortSignal }): Promise<ChildRunResult>;
    get(id: string): ChildSessionInfo | undefined;
    children(parentId: string): ChildSessionInfo[];
    /** Ancestor ids, nearest first (empty for a root session). */
    ancestors(id: string): string[];
    /** Cancels a session's run and all running descendants; returns how many were running. */
    cancel(id: string): number;
    /** Queues a user message for the session's next turn (or next run when idle). */
    enqueue(id: string, text: string): void;
    isRunning(id: string): boolean;
    /** Effective capabilities of a (root or child) session. */
    capabilities(id: string): {
      write: boolean;
      process: boolean;
      approvals: boolean;
      readOnly: boolean;
    };
    /** Model a new child would inherit from this session. */
    model(id: string): string;
    workspace(id: string): string;
    setStatus(id: string, status: SessionStatus): void;
  };
  ui: {
    /** Short status text shown by interactive UIs (footer); `detail` feeds /stats. */
    status(key: string, text: string | undefined, detail?: string): void;
    /** A collapsible tree panel (interactive UIs only). */
    panel(id: string, provider: PanelProvider): () => void;
    /** Ask the user to choose; resolves undefined when no interactive UI is available. */
    select(request: SelectRequest): Promise<string | undefined>;
    /**
     * Ask the user one or more multiple-choice questions. Resolves every question id to
     * undefined when no interactive UI is available (never hangs headless).
     */
    askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
    /** Open a session in a read-only view (interactive UIs only). */
    open(sessionId: string): boolean;
    /** True when an interactive UI is bound at all (globally, not per-session). */
    interactive(): boolean;
  };
}
export interface Plugin {
  /** Stable, unique plugin id (lowercase, dots and dashes). Plugins are identified by `id`. */
  id: string;
  version: string;
  apiVersion: 1;
  /** Provider-neutral catalog metadata. Hosts may derive additional categories from registrations. */
  name?: string;
  description?: string;
  /** Optional catalog categories; any value of the `PluginCategory` union. */
  categories?: PluginCategory[];
  /** Declarative sugar for `api.extensions.register(point, provider)` at priority 0. */
  extensions?: { [K in keyof ExtensionPoints]?: ExtensionPoints[K] };
  setup(api: PluginAPI): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
// ---------------------------------------------------------------------------------------------
// Web protocol v1 (`alisio serve`). Types only: the server validates requests at runtime and the
// browser imports these with `import type`. Draft until `@alisio/server` ships; changes stay
// additive once it does. `protocolVersion` is independent of `RunEvent.schemaVersion`.
// ---------------------------------------------------------------------------------------------
/** Derived status of a root session as shown by web clients (never persisted). */
export type SessionUiStatus = "idle" | "queued" | "running" | "awaiting_input" | "locked" | "error";
/** A content-addressed upload (for example an image attached from the web composer). */
export interface BlobRef {
  /** Lowercase hex sha256 of the bytes. */
  hash: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}
/** One entry of `GET /api/workspaces/:wid/tree` (paths are workspace-relative, `/`-separated). */
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  /** Bytes, for files. */
  size?: number;
  /** Last modification, ms epoch. */
  mtime?: number;
}
/** A page of a directory listing; `next` is an opaque cursor for the following page. */
export interface FileTreePage {
  entries: FileEntry[];
  next?: string;
}
/** A file the session changed (write-effect tool calls), for the Changes dock. */
export interface SessionChange {
  path: string;
  lastRunId?: string;
  effect: "write";
  /** `git status --porcelain` code when the workspace is a git repository (`M`, `A`, `D`, `??`…). */
  gitStatus?: string;
}
/** Session metadata carried by snapshot frames. */
export interface SessionDetailWire {
  id: string;
  /** Opaque, stable workspace id (never a filesystem path in URLs). */
  workspaceId: string;
  /** Absolute workspace path, for display. */
  workspace: string;
  provider: string;
  model: string;
  status: SessionUiStatus;
  title?: string;
  parentId?: string;
  /** Persisted child-session status, shown verbatim for child sessions. */
  childStatus?: SessionStatus;
  createdAt?: number;
  updatedAt?: number;
}
/** In-flight state of a running run, rebuilt by the server for snapshots. */
export interface InflightState {
  runId: string;
  status: "queued" | "running";
  /** Epoch milliseconds when the run started executing; lets a reloaded client show elapsed time. */
  startedAt?: number;
  /** Assistant text streamed since the last `turn_completed`. */
  text: string;
  /** Reasoning streamed since the last `turn_completed` (never persisted). */
  reasoning: string;
  tools: Array<{
    id: string;
    name: string;
    arguments: string;
    effect: Effect;
    startedAt: number;
    /** Latest progress output, bounded. */
    tail: string;
  }>;
}
/** An approval waiting for a decision from a web client. */
export interface PendingApproval {
  /** `<sessionId>:<callId>` for tool effects; `<sessionId>:dir:<uuid>` for directories. */
  approvalId: string;
  sessionId: string;
  /** Root of `sessionId`, so child-session approvals show in the root session view. */
  rootSessionId: string;
  runId?: string;
  kind: "effect" | "directory";
  callId?: string;
  name?: string;
  effect?: "write" | "process" | "external";
  label?: string;
  directory?: string;
  /** Pretty-printed tool input, truncated to 4 KB. */
  input: string;
  expiresAt?: number;
  /** The approval is for this capability (for example running Python), not the whole effect. */
  capability?: AnalysisCapability;
  /** A short preview for capability approvals (the first 40 lines of the script). */
  preview?: string;
  /** Capability approvals: `managed` (not sandboxed) or `oci` (container). */
  runtime?: "managed" | "oci";
  /** `analysis.install` approvals: only `once` and `deny` are offered. */
  install?: InstallPreview;
}
/** A plugin UI request (`ui.select` / `ui.askQuestions`) waiting for a web client. */
export interface PendingInteraction {
  interactionId: string;
  /** Present when the request names a session (`AskQuestionsRequest.session`). */
  sessionId?: string;
  workspaceId: string;
  request:
    | { kind: "select"; select: SelectRequest }
    | { kind: "questions"; questions: Question[]; label?: string; plan?: PlanReview };
}
/** One entry of the shared slash-command catalog. */
export interface CommandDescriptor {
  name: string;
  description: string;
  aliases?: string[];
  argumentHint?: string;
  source: "builtin" | "plugin" | "prompt" | "skill" | "agent";
  /** Plugin id or resource owner, when not built in. */
  owner?: string;
  surfaces: Array<"tui" | "web" | "api">;
  /** `core` commands run through the catalog; `surface` commands are handled by each UI. */
  execution: "core" | "surface";
}
/** One JSON object per SSE `data:` line. Clients ignore unknown `t` values. */
export type ServerFrame =
  | { t: "hello"; protocolVersion: 1; streamId: string; serverTime: number }
  | {
      t: "snapshot";
      sessionId: string;
      /** `MAX(events.seq)` of the session when the snapshot was taken. */
      cursor: number;
      session: SessionDetailWire;
      messages: {
        items: Array<{ seq: number; message: Message; compacted: boolean }>;
        hasMore: boolean;
      };
      inflight?: InflightState;
      pending: { approvals: PendingApproval[]; interactions: PendingInteraction[] };
      /** The session's goal, when it has one (so a reload shows the goal bar at once). */
      goal?: GoalInfo;
    }
  /** Durable event; its SSE `id` is `event.eventId`. */
  | { t: "event"; sessionId: string; event: RunEvent }
  /** Coalesced ephemeral output; carries no SSE `id`. */
  | {
      t: "delta";
      sessionId: string;
      runId: string;
      text?: string;
      reasoning?: string;
      progress?: Array<{ toolId: string; chunk: string }>;
    }
  | {
      t: "tool_result";
      sessionId: string;
      runId: string;
      callId: string;
      result: ToolResult;
      truncated?: boolean;
    }
  | { t: "message"; sessionId: string; seq: number; message: Message }
  | { t: "approval"; approval: PendingApproval }
  | {
      t: "approval_withdrawn";
      approvalId: string;
      reason: "cancelled" | "timeout" | "resolved_elsewhere";
    }
  | { t: "interaction"; interaction: PendingInteraction }
  | { t: "interaction_withdrawn"; interactionId: string }
  | {
      t: "session_status";
      sessionId: string;
      workspaceId: string;
      status: SessionUiStatus;
      title?: string;
      updatedAt?: number;
    }
  | {
      t: "catalog_changed";
      workspaceId: string;
      scope: "commands" | "plugins" | "skills" | "mcp" | "models" | "agents";
    }
  | { t: "resync"; sessionId?: string; reason: "overflow" | "gap" | "server_restart" }
  /** A persisted capability grant of this root session was added or revoked. */
  | { t: "capabilities_changed"; sessionId: string }
  /** A dataset uploaded from the web finished ingesting (root session). */
  | { t: "dataset_ready"; sessionId: string; dataset: DatasetRef }
  /** A dataset upload could not be ingested. */
  | { t: "dataset_failed"; sessionId: string; name: string; error: string }
  /** A background task of this root session appeared or changed state (additive; `bg_run`). */
  | { t: "tasks_changed"; sessionId: string; task: BackgroundTaskInfo }
  /** The goal of this root session changed (`null` = cleared). Additive; `/goal`. */
  | { t: "goal_changed"; sessionId: string; goal: GoalInfo | null };
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "forbidden_host"
  | "validation_failed"
  | "not_found"
  | "unknown_command"
  | "session_busy"
  | "session_locked"
  | "workspace_limit"
  /** A known workspace whose folder was deleted, moved or is no longer accessible (404). */
  | "workspace_missing"
  | "payload_too_large"
  | "unsupported_media_type"
  | "path_outside_workspace"
  | "not_a_git_repo"
  | "approval_resolved"
  | "capability_ceiling"
  | "not_manageable"
  | "mcp_not_permitted"
  | "runs_active"
  | "provider_unavailable"
  | "protocol_mismatch"
  | "shutting_down"
  /** Too many concurrent event streams (SSE) for this server. */
  | "stream_limit"
  /** The workspace is archived: unarchive it before starting new sessions (409). */
  | "workspace_archived"
  /** A native folder dialog is already open on the server machine (409). */
  | "picker_busy"
  /** No native folder dialog / folder browser on this server (remote bind, no desktop) (503). */
  | "picker_unavailable"
  /** The server user may not read that directory (403). */
  | "permission_denied"
  /** The request was cancelled before it finished, e.g. a `/btw` side question (409). */
  | "cancelled"
  /** The artifact does not exist or belongs to another session (404). */
  | "artifact_not_found"
  /** The artifact exceeds a size limit for this operation (413). */
  | "artifact_too_large"
  /** No usable Python runtime (503). */
  | "runtime_unavailable"
  /** The file is not a supported dataset, or needs a runtime that is missing (415/503 body code). */
  | "dataset_unsupported"
  /** A data query was rejected by the read-only guard (400). */
  | "query_rejected"
  /** A data query exceeded `analysis.data.queryTimeoutMs` (408). */
  | "query_timeout"
  /** A plugin data view threw while running (502; the message never carries its internals). */
  | "view_failed"
  /** A plugin data view exceeded the host timeout (504). */
  | "view_timeout"
  /** A plugin data view answered more than the host response cap (502). */
  | "view_too_large"
  /** The background task does not exist or belongs to another session (404). */
  | "task_not_found"
  /** The session has no goal (404). */
  | "goal_not_found"
  /** The goal changed since the client read it, or the action is not allowed in its state (409). */
  | "goal_conflict"
  /** Goals are turned off (`goal.enabled`) (409). */
  | "goal_disabled"
  | "internal";
/** `GET /api/health` (the only unauthenticated API route). */
export interface HealthInfo {
  name: "alisio";
  version: string;
  protocolVersion: 1;
  capabilities: {
    sse: boolean;
    websocket: boolean;
    multiWorkspace: boolean;
    attachments: boolean;
    uiBlocks: string[];
    mcpApps: boolean;
    automation: boolean;
    /** The server listens on a non-loopback address (`--allow-remote`). */
    remote: boolean;
    /**
     * `POST /api/workspaces/pick` can open a native folder dialog on this machine (loopback only,
     * with a desktop session and a dialog tool). Absent on older servers.
     */
    nativePicker?: boolean;
    /** `GET /api/fs/dirs` lists directory names for the in-app folder browser (loopback only). */
    folderBrowser?: boolean;
  };
}
/** `POST /api/workspaces/pick`: the folder chosen in the native dialog, or a cancellation. */
export type FolderPickResult = { path: string } | { cancelled: true };
/** One page of the in-app folder browser (`GET /api/fs/dirs`): subdirectory names only. */
export interface DirectoryListing {
  /** Absolute path listed (the server's own separators; `""` for the drive list on Windows). */
  path: string;
  /** Parent directory, absent at a filesystem root (and at the drive list). */
  parent?: string;
  /** Breadcrumbs from the root to `path`, built by the server (no separator assumptions). */
  segments: Array<{ name: string; path: string }>;
  /** Subdirectories (names and absolute paths; never files, never contents). */
  entries: Array<{ name: string; path: string; hidden: boolean }>;
  /** The server user's home directory (where browsing starts). */
  home: string;
  /** Path separator of the server platform. */
  separator: "/" | "\\";
  /** More than the listing cap: the rest is not shown. */
  truncated?: boolean;
}
/** A workspace known to the server (`GET /api/workspaces`). */
export interface WorkspaceInfo {
  /** Opaque, stable id: a short sha256 of the canonical path. */
  id: string;
  /** Canonical absolute path (display only; URLs use `id`). */
  path: string;
  label?: string;
  pinned: boolean;
  /** An `Application` is open for it in the server right now. */
  open: boolean;
  /**
   * The folder is still an accessible directory. A workspace known from old sessions may have been
   * deleted or moved: its sessions stay readable, but it cannot be opened (`workspace_missing`).
   */
  exists: boolean;
  /** Project resources load (trusted from the terminal or by a launch flag). */
  trusted: boolean;
  /** The directory has project resources that are not trusted (shown as "untrusted"). */
  untrustedResources: boolean;
  /** Archived: hidden from the default list; its sessions stay readable, new ones are refused. */
  archived: boolean;
  lastOpenedAt?: number;
}
/** Permission presets of the web composer (RF-08). */
export type PermissionPresetId = "read-only" | "ask" | "workspace-write" | "full-access";
/**
 * The permission mode shared by the TUI and the web presets: `ask` (every effect asks), `auto`
 * (workspace edits run without asking; commands, network and external directories still ask) and
 * `full` (nothing asks). A mode is NOT a sandbox.
 */
export type PermissionMode = "ask" | "auto" | "full";
export interface PermissionPresetInfo {
  id: PermissionPresetId;
  /** The mode this preset implements (`read-only` has none). */
  mode?: PermissionMode;
  /** Selectable under the server's launch flags (its capability ceiling). */
  available: boolean;
  /** Why it is unavailable, or which effects still ask because of the ceiling. */
  reason?: string;
  /** Effects allowed without asking once the ceiling is applied. */
  policy: { write: boolean; process: boolean; external: boolean };
  /** Whether non-allowed effects ask for approval (false: they are denied). */
  approvals: boolean;
}
/** One section (`Added`, `Changed`, `Fixed`…) of a changelog entry. */
export interface ChangelogSection {
  title: string;
  items: string[];
}
/** One released (or `Unreleased`) version of `CHANGELOG.md`. */
export interface ChangelogEntry {
  /** A semantic version such as `1.2.3-alpha.4`, or `Unreleased`. */
  version: string;
  date?: string;
  unreleased?: boolean;
  sections: ChangelogSection[];
}
/** `GET /api/changelog`: the entries asked for and whether there is news since `lastSeen`. */
export interface ChangelogView {
  /** The running Alisio (CLI) version. */
  current: string;
  /** Newest first. */
  entries: ChangelogEntry[];
  /** `false` when a `version` was asked for and the changelog has no such entry. */
  found: boolean;
  /** Present when `lastSeen` is older than `current` and the changelog has entries in between. */
  news?: { latest: string; versions: string[] };
}
export type ReloadArea = "config" | "agents" | "skills" | "prompts" | "mcp" | "plugins";
/** What `/reload` refreshed in one area: counts and the ids that appeared or disappeared. */
export interface ReloadAreaReport {
  area: ReloadArea;
  before: number;
  after: number;
  added: string[];
  removed: string[];
  /** Items present in both whose definition changed (config: the changed sections). */
  changed?: string[];
}
/** Answer of `/reload` and `POST /api/workspaces/:wid/reload`. */
export interface ReloadReport {
  refreshed: ReloadAreaReport[];
  /** What a reload cannot refresh (for example plugin code that was already imported). */
  restartRequired: string[];
  warnings: string[];
}
/** A row of the session list (`GET /api/sessions`). */
export interface SessionSummary extends SessionDetailWire {
  pinned: boolean;
  archived: boolean;
}
/** `GET /api/sessions/:sid` and the result of creating or patching a session. */
export interface SessionDetail extends SessionSummary {
  preset: PermissionPresetId;
  effort?: string;
  agent?: string;
  presets: PermissionPresetInfo[];
  children: SessionDetailWire[];
}
/** Answer of `POST /api/sessions/:sid/prompts`. */
export type PromptAccepted =
  | { runId: string; status: "queued" | "running"; duplicate?: false }
  | { runId: string; status: string; duplicate: true }
  | { status: "enqueued"; duplicate?: boolean };
/**
 * Answer of `POST /api/sessions/:sid/commands`. A command either reports (`output`, Markdown),
 * points the client at another session (`/clear`, `/resume`) or expands into a prompt the client
 * sends through `POST .../prompts` (prompt templates, skills, `/ask`). A repeated `requestId`
 * answers `{duplicate: true}` without running the command again.
 */
export interface CommandOutcome {
  output?: string;
  /** `notice` is a short status line; `info` (default) a report. */
  tone?: "info" | "notice";
  sessionId?: string;
  prompt?: { text: string; display: string };
  /** What changed, e.g. `"model"` or `"effort"`, so clients refresh the session. */
  effects?: string[];
  duplicate?: boolean;
}
/**
 * One `/btw` side question: a tool-less question about a session answered outside its
 * conversation (never persisted as messages, events, runs or session usage). Answer of
 * `POST /api/sessions/:sid/btw`; `GET /api/sessions/:sid/btw` lists them, oldest first.
 */
export interface SideQuestionEntry {
  id: string;
  question: string;
  /** Markdown answer. */
  answer: string;
  /** Model that answered (the session's model at the time). */
  model: string;
  usage: { input: number; output: number };
  /** Epoch milliseconds. */
  createdAt: number;
  /** The provider cut the answer at the output-token budget. */
  truncated?: boolean;
}
/** `GET /api/sessions/:sid/models`: models of the session's provider (credential-free). */
export interface SessionModels {
  provider: string;
  model: string;
  /** Session reasoning effort, when set. */
  effort?: string;
  models: ModelInfo[];
  /** The provider could not list its models (the current model still works). */
  unavailable: boolean;
}
/** `GET /api/sessions/:sid/context`: estimated tokens of the next request and the budget. */
export interface SessionContextUsage {
  estimated: number;
  /** Model context window, when known. */
  total?: number;
  basis: "window" | "unknown";
  /** Percentage of `total` at which auto-compaction triggers. */
  compactionAt: number;
}
/** `GET /api/plugins`: one plugin of a workspace (credential- and path-safe). */
export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version?: string;
  categories: string[];
  builtin: boolean;
  source: string;
  status: "active" | "inactive" | "failed" | "restart-required";
  enabled: boolean;
  /** Whether the web may toggle it (else `diagnostic` says why). */
  manageable: boolean;
  diagnostic?: string;
  /** Tools it contributes, without the namespacing prefix. */
  tools: string[];
  /** Slash commands it contributes. */
  commands: string[];
  /** Prefix of its namespaced tool names (`p_<hash>`), to label tool calls. */
  toolPrefix: string;
}
/** `GET /api/skills`: one discovered skill (no file paths). */
export interface SkillInfo {
  id: string;
  name: string;
  displayId: string;
  description: string;
  scope: "project" | "config" | "user" | "plugin";
  source: string;
  owner?: { id: string; name: string };
  manageable: boolean;
  locked: boolean;
  enabled: boolean;
  effective: boolean;
  shadowedBy?: string;
  approximateTokens: number;
}
/** One MCP server of a workspace; commands, arguments and URLs are never sent. */
export interface McpServerWire {
  name: string;
  displayName: string;
  /** Configuration layer that defines it (`global`, `project`, …). */
  source: string;
  status: string;
  enabled: boolean;
  transport: "stdio" | "http";
  capabilities: string[];
  counts: { tools: number; resources: number; prompts: number };
  diagnostic?: string;
}
/**
 * `GET /api/analysis`: the state of the data-analysis runtime for Settings (read only). Never
 * carries a script or a repository path; interpreter paths are the user's own.
 */
export interface AnalysisStatus {
  /** `analysis.enabled` and not `--read-only`: python_run is registered. */
  enabled: boolean;
  readOnly: boolean;
  mode: "managed" | "oci";
  /** The discovered (or `--python`) interpreter and the extras environment. */
  python:
    | {
        found: true;
        path: string;
        version: string;
        source: string;
        extras: string[];
        runtimeVersion?: string;
      }
    | {
        found: false;
        reason: string;
        /** Installation guidance for this system (commands are shown, never run). */
        hints: {
          system: string;
          heading?: string;
          primary: string;
          alternatives: string[];
          notes: string[];
        };
      };
  /** Container settings; `available` is probed only when the mode is `oci` or an image is set. */
  oci: {
    engine: "docker" | "podman";
    image?: string;
    memoryMb: number;
    cpus: number;
    available?: boolean;
    version?: string;
    reason?: string;
  };
  limits: { timeoutMs: number };
  retention: {
    jobsDays: number;
    intermediateDays: number;
    artifactsDays: number;
    lastSweep?: number;
  };
}
/** `GET /api/mcp`: the workspace's MCP runtime permission and servers. */
export interface McpOverview {
  permission: "granted" | "not-granted" | "read-only";
  /** Global consent (`mcp.allow`) is persisted for this user. */
  persisted: boolean;
  servers: McpServerWire[];
}
/** `GET /api/agents`: a selectable main-session agent. */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  instructions?: string;
  model?: string;
  readOnly?: boolean;
  source: "builtin" | "user" | "plugin";
  /** The workspace default (`agents.active`) used by sessions without their own agent. */
  default: boolean;
}
/** One user-facing setting (`SettableSettingKey`) and its effective value. */
export interface SettingInfo {
  key: string;
  kind: "boolean" | "number" | "string" | "enum";
  options?: string[];
  value?: string | number | boolean;
}
/** `GET /api/settings`: effective settings and where configuration lives. */
export interface SettingsOverview {
  /** Highest-priority configuration file of the workspace (it may not exist yet). */
  configPath: string;
  /** Global file that setting changes are written to. */
  settingsPath: string;
  /** Provider profiles (`providers.json`); credentials live apart, never shown. */
  providersPath: string;
  trusted: boolean;
  readOnly: boolean;
  settings: SettingInfo[];
}
/** A credential as the web sees it: never the value, at most a short masked tail. */
export interface CredentialStatus {
  configured: boolean;
  source?: "file" | "env";
  /** Last characters behind an ellipsis (`…71B`), only for long stored secrets. */
  tail?: string;
}
/** One stored provider profile (non-secret values only). */
export interface ProviderProfileInfo {
  name: string;
  provider: string;
  model: string;
  values: Record<string, ProviderConfigurationValue>;
  /** The globally active profile (`providers.json`). */
  active: boolean;
  credentials: Record<string, CredentialStatus>;
}
/** A provider type a profile can use, with its configuration fields. */
export interface ProviderTypeInfo {
  id: string;
  name: string;
  description?: string;
  fields: ProviderConfigurationField[];
}
/** `GET /api/providers`. */
export interface ProvidersOverview {
  active?: string;
  profiles: ProviderProfileInfo[];
  /** Provider types of the requested workspace (empty without `?workspace=`). */
  types: ProviderTypeInfo[];
  /** What the requested workspace's application currently runs. */
  current?: { provider: string; model: string; profile?: string };
}
/** `GET /api/models`: models of every configured profile (credential-free). */
export interface ProviderModelsInfo {
  profile: string;
  provider: string;
  title: string;
  configuredModel: string;
  models: ModelInfo[];
  unavailable: boolean;
}
/** Output format of an agent's answers (`text.format.type`). */
export type AgentTextFormatType = "text" | "json_object" | "json_schema";
/** Reasoning summary preference of an agent (`reasoning.summary`). */
export type AgentReasoningSummary = "auto" | "none" | "concise" | "detailed";
/** Answer verbosity preference of an agent (`text.verbosity`). */
export type AgentVerbosity = "low" | "medium" | "high";
/**
 * Where a user agent file lives: `project` is `<workspace>/.agents/agents/<id>.md`, `global` is
 * `~/.agents/agents/<id>.md`. A project agent overrides a global one with the same id.
 */
export type AgentScope = "project" | "global";
/** Body of `POST /api/agents` and `PUT /api/agents/:id`: a user agent definition. */
export interface AgentDefinitionInput {
  /** Display name; the stable id is derived from it once, on creation. */
  name: string;
  description?: string;
  /** System prompt appended to the session instructions when the agent is active. */
  instructions?: string;
  /** Model selector (`provider/model` or an unambiguous model id). */
  model: string;
  reasoning?: { effort?: string; summary?: AgentReasoningSummary };
  text?: { format?: { type: AgentTextFormatType }; verbosity?: AgentVerbosity };
}
/** A stored user agent definition (`GET /api/agents/definitions`). Times are epoch ms. */
export interface AgentDefinitionInfo extends AgentDefinitionInput {
  /** File slug: the frontmatter `name` other harnesses use as the agent identifier. */
  id: string;
  scope: AgentScope;
  description: string;
  instructions: string;
  /** Absolute path of the Markdown file. */
  path: string;
  createdAt: number;
  updatedAt: number;
  /** A project agent that takes precedence over the global agent with the same id. */
  overridesGlobal?: boolean;
  /** A global agent hidden by the project agent with the same id. */
  overriddenByProject?: boolean;
}
/**
 * Answer of agent writes. `live`: the running Alisio already uses the change (its agent registry
 * reloaded and loaded the file); false means it is saved but needs a restart (or a trusted
 * workspace / the subagents plugin) before sessions can use it.
 */
export interface AgentSaveResult {
  agent: AgentDefinitionInfo;
  live: boolean;
}
/** `GET /api/agents/definitions`: both scopes merged, plus where new agents go by default. */
export interface AgentDefinitionsOverview {
  agents: AgentDefinitionInfo[];
  scopes: AgentScope[];
  defaultScope: AgentScope;
  /** Directory of each available scope. */
  dirs: Partial<Record<AgentScope, string>>;
  /** Project agents load only in trusted workspaces. */
  trusted: boolean;
}
/** A predefined starting point for a new agent (`GET /api/agents/templates`). */
export interface AgentTemplateInfo {
  id: string;
  name: string;
  description: string;
  instructions: string;
  reasoning?: { effort?: string; summary?: AgentReasoningSummary };
  text?: { format?: { type: AgentTextFormatType }; verbosity?: AgentVerbosity };
}
/** What a model supports for the agent editor, derived from its catalog metadata. */
export interface AgentModelCapabilities {
  /** The catalog declared any capability metadata; otherwise every option is offered. */
  known: boolean;
  reasoning: boolean;
  /** Reasoning effort levels to offer (empty when reasoning is unsupported). */
  effortLevels: string[];
  defaultEffort?: string;
  summary: boolean;
  verbosity: boolean;
  textFormats: AgentTextFormatType[];
  /** Declared tool calling support; absent when unknown. */
  tools?: boolean;
  /** Declared image input support; absent when unknown. */
  vision?: boolean;
}
/** A configured model the agent editor can select (`GET /api/agents/models`). */
export interface AgentModelOption {
  /** Canonical selector `<provider>/<model>`. */
  reference: string;
  provider: string;
  profile: string;
  providerName: string;
  id: string;
  name?: string;
  /** The workspace application runs this model right now. */
  active: boolean;
  capabilities: AgentModelCapabilities;
  /** Short capability labels such as "Reasoning", "Tools", "Vision". */
  labels: string[];
}
/** Answer of `POST /api/agents/draft`: a definition drafted by the active model. */
export interface AgentDraft {
  name: string;
  description: string;
  instructions: string;
  reasoning?: { effort?: string; summary?: AgentReasoningSummary };
  text?: { format?: { type: AgentTextFormatType }; verbosity?: AgentVerbosity };
  /** The model that wrote the draft. */
  generatedBy: string;
  /** Authoring guidance used: `skill:<name>` (a discovered skill) or `bundled:create-agent`. */
  guidance: string;
}
/** Body of every non-2xx web API response. */
export interface ApiError {
  error: { code: ApiErrorCode; message: string; details?: unknown };
  correlationId: string;
}
export function definePlugin<T extends Plugin>(plugin: T): T {
  return plugin;
}
/** `OutputTruncatedError.code`: a provider's reply was cut off by the output-token limit. */
export const OUTPUT_TRUNCATED_CODE = "output_truncated";
/**
 * A provider that cannot yield a usable `completed` message because the output-token limit cut
 * the response before anything usable existed (no text and no complete tool call) throws this,
 * so the host can recover instead of failing the run. Hosts match on `code` (not `instanceof`),
 * because a plugin may bundle its own copy of this package. Prefer yielding `completed` with
 * `truncated: true` whenever the partial message is representable.
 */
export class OutputTruncatedError extends Error {
  readonly code = OUTPUT_TRUNCATED_CODE;
  constructor(message = "The response was cut off by the output-token limit.") {
    super(message);
    this.name = "OutputTruncatedError";
  }
}
export const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});
/**
 * Text-only view of a tool result: the content filtered to its text parts, order preserved.
 * This is what the runner hands to providers, what compaction summarizes and what headless
 * output shows; `ui`/`image` parts stay only in the persisted transcript for TUI replay, so
 * raw bytes or structured blocks never reach the model prompt.
 */
export function textProjection(result: ToolResult): ToolResult {
  if (result.content.every((part) => part.type === "text")) return result;
  return { ...result, content: result.content.filter((part) => part.type === "text") };
}
