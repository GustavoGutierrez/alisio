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
  | { kind: "markdown"; text: string };
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
  /** Base64-encoded bytes, no `data:` prefix. */
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
  | { role: "user"; text: string; summary?: boolean; display?: string; attachments?: Attachment[] }
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
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
export interface RunEvent {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  seq: number;
  type: string;
  timestamp: string;
  data: unknown;
}
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
export type PluginCategory = "model-provider";
export interface PluginMetadata {
  id: string;
  version: string;
  builtin: boolean;
  name?: string;
  description?: string;
  /** Categories are derived by the host from registrations made by this plugin. */
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
  categories?: PluginCategory[];
  /** Declarative sugar for `api.extensions.register(point, provider)` at priority 0. */
  extensions?: { [K in keyof ExtensionPoints]?: ExtensionPoints[K] };
  setup(api: PluginAPI): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
export function definePlugin<T extends Plugin>(plugin: T): T {
  return plugin;
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
