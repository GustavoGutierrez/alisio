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
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
export type Message =
  /** `summary` marks a compaction summary that replaced earlier history. */
  | { role: "user"; text: string; summary?: boolean }
  | { role: "assistant"; text: string; calls: ToolCall[]; providerData?: unknown[] }
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
  contextWindow?: number;
}
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
  }): AsyncIterable<ProviderEvent>;
  /** Optional model catalog. Implementations must not expose credentials. */
  listModels?(signal: AbortSignal): Promise<ModelInfo[]>;
}
export interface ToolContext {
  signal: AbortSignal;
  workspace: string;
  emit: (data: unknown) => void;
  /** Session that issued the call, when run by the agent loop. */
  session?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Unknown/plugin operations default to external; only declare read for side-effect-free tools. */
  effect?: Effect;
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
export interface PluginMetadata {
  id: string;
  version: string;
  builtin: boolean;
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
/** Typed map of extension points; new points are added here without breaking existing ones. */
export interface ExtensionPoints {
  mascot: MascotProvider;
  "startup-screen": StartupScreenProvider;
}
export interface ExtensionOptions {
  /** Higher wins (default 0). Ties break by plugin id, then registration order. */
  priority?: number;
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
      handler: (args: string) => Promise<string>,
      options?: CommandOptions,
    ): () => void;
  };
  events: { on(handler: (event: Readonly<RunEvent>) => void): () => void };
  context: { register(provider: () => Promise<string>): () => void };
  resources: { skills(path: string): void; prompts(path: string): void };
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
  /** Short status text shown by interactive UIs (footer); `detail` feeds /stats. */
  ui: { status(key: string, text: string | undefined, detail?: string): void };
}
export interface Plugin {
  /** Stable, unique plugin id (lowercase, dots and dashes). Plugins are identified by `id`. */
  id: string;
  version: string;
  apiVersion: 1;
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
