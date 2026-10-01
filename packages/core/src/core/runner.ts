import {
  type Attachment,
  type DatasetRef,
  type InstallApprover,
  isEphemeralRunEventType,
  type Message,
  type ModelProvider,
  type RunEvent,
  type RunEventDataMap,
  type RunEventType,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  textProjection,
  textResult,
} from "@alisio/sdk";
import type { PathAccess } from "../runtime/access.ts";
import {
  checkpointInstructions,
  estimateTokens,
  MAX_TRUSTED_WINDOW,
  parseCheckpointOutput,
  planCompaction,
  reduceMessagesToBudget,
  shouldCompactContext,
  summarize,
  summaryMessage,
} from "./compaction.ts";
import type {
  ApprovalHandler,
  ArtifactPublisherFactory,
  CapabilityGate,
  ContextSource,
  HookFailure,
  Policy,
  RunnerExtensions,
  SessionStore,
  TerminalRunStatus,
} from "./contracts.ts";
import { type OutputLimit, resolveMaxOutputTokens } from "./output-limit.ts";
import type { ToolRegistry } from "./registry.ts";
import { isTimeoutReason, providerLabel, RunTimeoutError } from "./timeout.ts";
import {
  incompleteCalls,
  isOutputTruncationError,
  lowerEffort,
  RunTruncationError,
  TRUNCATION_NOTICE,
} from "./truncation.ts";

/** Pause before a silent request is sent again; short, and cut off by a stop or the run limit. */
const FIRST_TOKEN_RETRY_PAUSE_MS = 250;
/** Pause before a cut-off turn is requested again; short, and cut off by a stop or the run limit. */
const TRUNCATION_RETRY_PAUSE_MS = 100;
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
export interface CompactionSettings {
  /** Compact automatically when context usage crosses `threshold` of a known window. */
  auto?: boolean;
  threshold?: number;
  keepTurns?: number;
  /**
   * Per-call output token budget for the summarizer. Defaults to 4096 when unset; never falls
   * back to the agent-loop `maxOutputTokens`. A truncated summary is accepted as partial.
   */
  maxOutputTokens?: number;
}
export interface RunnerOptions {
  /** Provider bound to this persisted session. */
  provider: ModelProvider;
  providerFor?: (session: import("./contracts.ts").Session) => Promise<ModelProvider>;
  registry: ToolRegistry;
  store: SessionStore;
  context: ContextSource;
  policy: Policy;
  workspace: string;
  maxTurns?: number;
  timeoutMs?: number;
  /** See `RunnerSettingsPatch.firstTokenTimeoutMs`. */
  firstTokenTimeoutMs?: number;
  /** See `RunnerSettingsPatch.firstTokenRetries`. */
  firstTokenRetries?: number;
  /** See `RunnerSettingsPatch.truncationRecoveries`. */
  truncationRecoveries?: number;
  /**
   * Reasoning effort levels a model advertises (`ModelInfo.effort`), when known. Lets a recovery
   * from an exhausted reasoning budget request one level lower; without it effort is unchanged.
   */
  effortLevels?: (
    model: string,
  ) => { supportedLevels: string[]; defaultLevel?: string } | undefined;
  maxContextChars?: number;
  /**
   * Output-token budget the USER set (`limits.maxOutputTokens`). Left unset, the budget of each
   * request is the model's declared maximum (`modelOutputLimit`, capped), else
   * `fallbackMaxOutputTokens`. See `resolveMaxOutputTokens`.
   */
  maxOutputTokens?: number;
  /**
   * The maximum output a model's catalog declares (`ModelInfo.maxOutputTokens`), when known.
   * May be async (a catalog still loading); a failure counts as unknown. Called for the model
   * of every request, so a model switch changes the budget.
   */
  modelOutputLimit?: (model: string) => number | undefined | Promise<number | undefined>;
  /** Budget when neither the user nor the catalog says anything (4096 for bare embedders). */
  fallbackMaxOutputTokens?: number;
  maxTokens?: number;
  onEvent?: (event: RunEvent) => void;
  readConcurrency?: number;
  /** Context window in tokens for a model, when known. Drives auto-compaction at `threshold`; when
   *  unknown (or absurdly large, see `MAX_TRUSTED_WINDOW`) the char budget falls back. */
  contextWindow?: (model: string) => number | undefined;
  compaction?: CompactionSettings;
  /** When set, write/process tools not allowed by the policy are offered and ask first. */
  approve?: ApprovalHandler;
  /**
   * Mediated path policy (workspace plus declared extra directories and external approval).
   * When set, declared tool paths outside the allowed roots ask before the effect gate runs.
   */
  pathAccess?: PathAccess;
  /** Generic hooks (implemented by the plugin host) for compaction and session start. */
  extensions?: RunnerExtensions;
  /** Persisted capability grants (`analysis.run`); without it capabilities only follow `effect`. */
  capabilities?: CapabilityGate;
  /** Artifact publisher of each tool call (`ToolContext.artifacts`). */
  artifacts?: ArtifactPublisherFactory;
  /**
   * Provider-native tool definitions (for example a hosted `web_search` tool) appended to every
   * request's `tools` alongside the registry's function tools. Opt-in, set once for the whole
   * runner; only meaningful for a provider that documents an equivalent server-side tool.
   */
  nativeTools?: Array<Record<string, unknown>>;
  /**
   * Default reasoning effort level (a value from the current model's `ModelInfo.effort`), sent on
   * every run unless overridden per-run. Providers that do not advertise effort levels ignore it.
   */
  reasoningEffort?: string;
}
/** The settings a running TUI can change live; merged into the runner options on apply. */
export interface RunnerSettingsPatch {
  /** Compaction settings; merged over the current ones (any subset). */
  compaction?: Partial<CompactionSettings>;
  /** Maximum turns per run. */
  maxTurns?: number;
  /** Per-call max output tokens budget. */
  maxOutputTokens?: number;
  /** Post-compaction context budget in characters. */
  maxContextChars?: number;
  /** Per-run timeout in milliseconds; the next run honors it. */
  timeoutMs?: number;
  /**
   * Stop a model request that stays completely silent (no text, reasoning or tool-call delta)
   * for this many milliseconds. `0` or unset disables it: only the run timeout applies.
   */
  firstTokenTimeoutMs?: number;
  /**
   * How many times the same request is sent again after a silent timeout (`firstTokenTimeoutMs`).
   * `0` or unset disables it. A retry is not a turn; it only happens while nothing at all was
   * received for the request.
   */
  firstTokenRetries?: number;
  /**
   * How many times a turn is requested again after the response was cut off by the output-token
   * limit before it was usable. `0` or unset disables it. A recovery is not a turn.
   */
  truncationRecoveries?: number;
}
/**
 * Per-run overrides used by embedders and child sessions. Callers must only NARROW: `policy`
 * and `toolFilter` are applied on top of the runner's policy and tools.
 */
export interface RunOptions {
  /** What UIs show instead of the prompt (e.g. `/init`). */
  display?: string;
  /** Images attached to this turn's user message, sent as vision content parts. */
  attachments?: Attachment[];
  /** Datasets attached to this turn (UI chips); their text summary is part of the prompt. */
  datasets?: DatasetRef[];
  /** Extra system instructions for this run (e.g. an agent persona). */
  instructions?: string;
  toolFilter?: (tool: ToolDefinition) => boolean;
  policy?: Policy;
  /** Allow interactive approvals for this run (default: when the runner has a handler). */
  approvals?: boolean;
  /** Shown with approval requests, e.g. the agent path of a child session. */
  label?: string;
  workspace?: string;
  context?: ContextSource;
  maxTurns?: number;
  maxTokens?: number;
  /** Per-call output token budget for this run; beats the runner-level budget when set. */
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Silent-request limit for this run; beats the runner-level `firstTokenTimeoutMs`. */
  firstTokenTimeoutMs?: number;
  /** Silent-request retries for this run; beats the runner-level `firstTokenRetries`. */
  firstTokenRetries?: number;
  /** Output-truncation recoveries for this run; beats the runner-level `truncationRecoveries`. */
  truncationRecoveries?: number;
  /** Reasoning effort level for this run; beats the runner-level default when set. */
  reasoningEffort?: string;
  /** Run id to use for this run's events (e.g. preassigned by an embedder); a UUID otherwise. */
  runId?: string;
  /** Copied to every event of this run as `RunEvent.correlationId` (e.g. an HTTP request id). */
  correlationId?: string;
}
/**
 * Default cumulative token budget for one run: several context windows (each turn re-sends the
 * context), clamped; 1M tokens when the window is unknown.
 */
export function defaultTokenBudget(contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0) return 1_000_000;
  return Math.min(8_000_000, Math.max(400_000, contextWindow * 8));
}
/** Extension output appended to history is capped regardless of what hooks return. */
const MAX_INJECT_CHARS = 24_000;
/**
 * Floor for the post-compaction transcript target: retained messages are never reduced below
 * this many characters, so a pathological session (instructions alone crowding out the limit)
 * fails with an actionable error instead of silently losing the whole history.
 */
const MIN_MESSAGE_BUDGET_FLOOR = 4_000;
const allowed = (policy: Policy, effect: string) =>
  effect === "read" ||
  effect === "internal" ||
  ((effect === "write" || effect === "process" || effect === "external") && !!policy[effect]);
/** A tool's capability is pre-allowed by the policy alone (`--allow-analysis`). */
const capabilityAllowed = (policy: Policy, tool: ToolDefinition) =>
  tool.capability === "analysis.run" && !!policy.analysis;
/** First 40 lines of a script input, for capability approvals. */
const scriptPreview = (input: Record<string, unknown>): string | undefined =>
  typeof input.code === "string" ? input.code.split(/\r?\n/).slice(0, 40).join("\n") : undefined;
export interface CompactionResult {
  replaced: number;
  before: number;
  after: number;
  summary: Extract<Message, { role: "user" }>;
}
/** Typed emitter: payloads are checked against the SDK `RunEventDataMap` contract. */
type Emit = <T extends RunEventType>(type: T, data: RunEventDataMap[T]) => void;
/** A parsed tool call (or the reason it could not be parsed). */
interface PreparedCall {
  call: ToolCall;
  tool?: ToolDefinition;
  input?: Record<string, unknown>;
  error?: string;
}
/** What one tool call needs from the run that issued it. */
interface CallScope {
  sessionId: string;
  runId: string;
  emit: Emit;
  signal: AbortSignal;
  workspace: string;
  policy: Policy;
  approvals: boolean;
  options: RunOptions;
  /** Refuses a call before its gate (e.g. the context changed, the token budget is spent). */
  guard?: (effect: string) => void;
  /** Adjusts the result of an executed call (e.g. pending instructions appended to a read). */
  amend?: (result: ToolResult, effect: string) => ToolResult;
}
/** A short id for a tool call the user started from a UI (alphanumeric, 9 characters). */
const uiCallId = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
};
export class AgentRunner {
  /** Sessions with an active run or compaction (one at a time per session). */
  private active = new Map<string, AbortController>();
  /** Messages queued for a session's next turn (e.g. input for a running child). */
  private inbox = new Map<string, string[]>();
  /** Last provider-reported context size per session and the history length it covered. */
  private reported = new Map<string, { tokens: number; count: number }>();
  constructor(private options: RunnerOptions) {}
  /** Current capability policy (may widen when the user approves an effect for the session). */
  get policy(): Readonly<Policy> {
    return this.options.policy;
  }
  /** Whether write/process tools can be approved interactively. */
  get approvals(): boolean {
    return !!this.options.approve;
  }
  /**
   * Live-update runnable settings so the next `run`/`compact` call honors them without restarting
   * Alisio. Every patch field is merged over the current options; unrelated settings are kept.
   */
  applySettings(patch: RunnerSettingsPatch): void {
    const { compaction, ...rest } = patch;
    this.options = {
      ...this.options,
      ...rest,
      ...(compaction ? { compaction: { ...this.options.compaction, ...compaction } } : {}),
    };
  }
  private emitter(sessionId: string, run: { runId?: string; correlationId?: string } = {}): Emit {
    const runId = run.runId ?? crypto.randomUUID();
    const correlationId = run.correlationId;
    let seq = 0;
    return (type, data) => {
      const event: RunEvent = {
        schemaVersion: 1,
        runId,
        sessionId,
        seq: ++seq,
        type,
        timestamp: new Date().toISOString(),
        data,
      };
      if (!isEphemeralRunEventType(type)) {
        const persisted =
          correlationId !== undefined
            ? this.options.store.event(sessionId, runId, type, data, { correlationId })
            : this.options.store.event(sessionId, runId, type, data);
        if (typeof persisted === "number") event.eventId = String(persisted);
      }
      if (correlationId !== undefined) event.correlationId = correlationId;
      try {
        this.options.onEvent?.(event);
      } catch {
        /* An observer cannot invalidate an executed operation. */
      }
    };
  }
  /**
   * Tools offered to the model under the current policy (and optional run narrowing). With a
   * session, a capability tool is also offered when that session's root holds a persisted grant.
   */
  availableTools(run: RunOptions = {}, sessionId?: string): ToolDefinition[] {
    const o = this.options;
    const policy = run.policy ?? o.policy;
    const approvals = !!o.approve && run.approvals !== false;
    return o.registry.list().filter((t) => {
      if (run.toolFilter && !run.toolFilter(t)) return false;
      const effect = t.effect ?? "external";
      if (allowed(policy, effect)) return true;
      if (t.capability) {
        if (capabilityAllowed(policy, t)) return true;
        if (sessionId && o.capabilities?.granted(t.capability, sessionId)) return true;
      }
      return approvals && (effect === "write" || effect === "process" || effect === "external");
    });
  }
  /** Abort signal of the session's active run, if any (used to cascade cancellation). */
  signal(sessionId: string): AbortSignal | undefined {
    return this.active.get(sessionId)?.signal;
  }
  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }
  /** Aborts the active run (or compaction) of a session. */
  abort(sessionId: string, reason: unknown = new Error("Cancelled")): boolean {
    const controller = this.active.get(sessionId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }
  /** Queues text as a user message for the session's next turn (or next run when idle). */
  enqueue(sessionId: string, text: string): void {
    const queue = this.inbox.get(sessionId) ?? [];
    queue.push(text.slice(0, 50_000));
    this.inbox.set(sessionId, queue.slice(-20));
  }
  private drain(sessionId: string): string[] {
    const queue = this.inbox.get(sessionId) ?? [];
    this.inbox.delete(sessionId);
    return queue;
  }
  private claim(sessionId: string): AbortController {
    if (this.active.has(sessionId))
      throw new Error("Session is busy; await the current run or cancel it");
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    return controller;
  }
  private toolsText(tools: ToolDefinition[]): string {
    return JSON.stringify(
      tools.map((t) => ({ name: t.name, schema: t.inputSchema, description: t.description })),
    );
  }
  /** Estimated tokens the next request of a session would send. */
  async estimateContext(sessionId: string): Promise<number> {
    const instructions = await this.options.context.instructions(sessionId);
    return (
      estimateTokens(instructions) +
      estimateTokens(this.options.store.messages(sessionId)) +
      estimateTokens(this.toolsText(this.availableTools()))
    );
  }
  /**
   * The effective context budget the TUI context bar displays. The model window is the total
   * when known (and not beyond `MAX_TRUSTED_WINDOW`); otherwise the bar reports an honest
   * unknown (`basis: "unknown"`, no fabricated total). `compactionAt` is the percentage of
   * `total` where auto-compaction triggers, so the bar turns red exactly where the engine
   * compacts. The engine's own auto-compaction guardrail still falls back to the char budget
   * internally (see `shouldCompactContext`) — that fallback is never shown as a fake total.
   */
  contextBudget(model: string): {
    total?: number;
    basis: "window" | "unknown";
    compactionAt: number;
  } {
    const window = this.options.contextWindow?.(model);
    if (window !== undefined && window > 0 && window <= MAX_TRUSTED_WINDOW)
      return {
        total: window,
        basis: "window",
        compactionAt: Math.round((this.options.compaction?.threshold ?? 0.85) * 100),
      };
    return { total: undefined, basis: "unknown", compactionAt: 100 };
  }
  /**
   * What a tool-less side call about a session needs (for example a `/btw` side question): the
   * session's provider and model, its system instructions, its ACTIVE history and the current
   * limits. Claims no lock and writes nothing, so it is safe while a run is active.
   */
  async sideContext(sessionId: string): Promise<{
    provider: ModelProvider;
    model: string;
    instructions: string;
    messages: Message[];
    maxContextChars: number;
    maxOutputTokens: number;
    timeoutMs: number;
    /** Context window of the model in tokens, when known and trusted. */
    contextWindow?: number;
    reasoningEffort?: string;
  }> {
    const o = this.options;
    const session = o.store.get(sessionId);
    const provider = await (o.providerFor?.(session) ?? o.provider);
    const window = o.contextWindow?.(session.model);
    return {
      provider,
      model: session.model,
      ...(window !== undefined && window > 0 && window <= MAX_TRUSTED_WINDOW
        ? { contextWindow: window }
        : {}),
      instructions: await o.context.instructions(sessionId),
      messages: o.store.messages(sessionId),
      maxContextChars: o.maxContextChars ?? 800_000,
      maxOutputTokens: (await this.outputLimit(session.model)).value,
      timeoutMs: o.timeoutMs ?? 300_000,
      ...(o.reasoningEffort ? { reasoningEffort: o.reasoningEffort } : {}),
    };
  }
  /** The output-token budget for `model`: user value, else catalog maximum, else fallback. */
  private async outputLimit(model: string, perRun?: number): Promise<OutputLimit> {
    const o = this.options;
    const declared = await Promise.resolve(o.modelOutputLimit?.(model)).catch(() => undefined);
    return resolveMaxOutputTokens({
      explicit: perRun ?? o.maxOutputTokens,
      declared,
      fallback: o.fallbackMaxOutputTokens ?? 4096,
    });
  }
  /** Change the model used by subsequent turns of a session; recorded in the store. */
  setModel(sessionId: string, model: string): void {
    const id = model.trim();
    if (!id) throw new Error("Model ID must not be empty");
    const previous = this.options.store.get(sessionId).model;
    if (previous === id) return;
    this.options.store.setModel(sessionId, id);
    this.reported.delete(sessionId);
    this.emitter(sessionId)("model_changed", { model: id, previous });
  }
  /** Manually compact a session outside a run. */
  async compact(
    sessionId: string,
    request: { focus?: string; signal?: AbortSignal } = {},
  ): Promise<CompactionResult | undefined> {
    const controller = this.claim(sessionId);
    const o = this.options;
    let acquired = false;
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 300_000);
    const signal = AbortSignal.any([
      controller.signal,
      timeout,
      ...(request.signal ? [request.signal] : []),
    ]);
    try {
      o.store.acquire(sessionId);
      acquired = true;
      o.store.reconcile(sessionId);
      const session = o.store.get(sessionId);
      return await this.compactLocked(
        sessionId,
        this.emitter(sessionId),
        session.model,
        signal,
        "manual",
        request.focus,
      );
    } finally {
      if (acquired) o.store.release(sessionId);
      this.active.delete(sessionId);
    }
  }
  private async compactLocked(
    sessionId: string,
    emit: Emit,
    model: string,
    signal: AbortSignal,
    reason: "manual" | "auto",
    focus?: string,
  ): Promise<CompactionResult | undefined> {
    const o = this.options;
    const messages = o.store.messages(sessionId);
    const plan = planCompaction(messages, { keepTurns: o.compaction?.keepTurns ?? 2 });
    const before = await this.estimateContext(sessionId);
    if (!plan) {
      emit("compaction_skipped", { reason, before, detail: "Not enough history to compact" });
      return undefined;
    }
    emit("compaction_started", { reason, before, messages: plan.summarized.length });
    const reportFailures = (failures: HookFailure[]) => {
      for (const f of failures) emit("plugin_hook_failed", { ...f, continued: true });
    };
    try {
      const ext = o.extensions;
      const hookInput = { sessionId, reason, messages: plan.summarized, focus };
      let contribution: Awaited<ReturnType<RunnerExtensions["beforeCompact"]>> = {
        instructions: [],
        fields: {},
        failures: [],
      };
      if (ext)
        try {
          contribution = await ext.beforeCompact(hookInput);
        } catch (error) {
          contribution.failures.push({
            source: "host",
            hook: "beforeCompact",
            error: String(error),
          });
        }
      reportFailures(contribution.failures);
      const fields = Object.fromEntries(
        Object.entries(contribution.fields).map(([name, f]) => [name, f.description]),
      );
      const provider = await (o.providerFor?.(o.store.get(sessionId)) ?? o.provider);
      const { text: raw, truncated: summaryTruncated } = await summarize(provider, {
        instructions: checkpointInstructions(contribution.instructions, fields),
        messages: plan.summarized,
        focus,
        model,
        maxOutputTokens: o.compaction?.maxOutputTokens ?? 4096,
        signal,
        sessionId,
      });
      const output = parseCheckpointOutput(raw, Object.keys(fields));
      let after: Awaited<ReturnType<RunnerExtensions["afterCompact"]>> = {
        inject: [],
        reports: {},
        failures: [],
      };
      if (ext)
        try {
          after = await ext.afterCompact({
            ...hookInput,
            model,
            replaced: plan.cut,
            structured: output.structured,
            ...(output.checkpoint ? { checkpoint: output.checkpoint } : {}),
            checkpointText: output.text,
            extracted: output.extracted,
          });
        } catch (error) {
          after.failures.push({ source: "host", hook: "afterCompact", error: String(error) });
        }
      reportFailures(after.failures);
      const body = [output.text, ...after.inject.map((x) => x.slice(0, MAX_INJECT_CHARS))]
        .filter((x) => x.trim())
        .join("\n\n");
      const summary = summaryMessage(body, plan.cut) as CompactionResult["summary"];
      o.store.compact(sessionId, plan.cut, summary);
      this.reported.delete(sessionId);
      const afterTokens = await this.estimateContext(sessionId);
      emit("compaction_completed", {
        reason,
        before,
        after: afterTokens,
        replaced: plan.cut,
        structured: output.structured,
        summarizedTokens: estimateTokens(plan.summarized),
        checkpointTokens: estimateTokens(summary.text),
        plugins: after.reports,
        ...(summaryTruncated ? { partial: true } : {}),
      });
      return { replaced: plan.cut, before, after: afterTokens, summary };
    } catch (error) {
      emit("compaction_failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  /**
   * Gates and executes one tool call: external-directory paths, the capability/effect gate with
   * its approval, the call journal, artifact publishing and the result bound. Shared by model
   * runs and `runToolCall`, so a call started from a UI passes exactly the same gates.
   */
  private async executeCall(scope: CallScope, p: PreparedCall): Promise<ToolResult> {
    const o = this.options;
    const { sessionId, runId, emit, workspace, policy, approvals, options } = scope;
    const combined = scope.signal;
    const pathAccess = o.pathAccess;
    const { call } = p;
    let result: ToolResult;
    const started = Date.now();
    // `effect` rides along so the TUI can group consecutive calls by capability kind
    // (read batches, write batches, commands…) without a name heuristic. Additive field.
    emit("tool_started", {
      name: call.name,
      id: call.id,
      arguments: call.arguments,
      effect: p.tool?.effect ?? "external",
    });
    try {
      combined.throwIfAborted();
      if (p.error) throw new Error(p.error);
      if (!p.tool || !p.input) throw new Error("Invalid tool");
      const effect = p.tool.effect ?? "external";
      // External-directory prerequisite: declared paths are resolved (and, outside every
      // allowed root, approved for the containing directory) BEFORE the effect gate, so a
      // write still needs its own write policy and a read never hard-throws first. The
      // resolved map keeps "allow once" scoped to this one call, with no shared mutable
      // state that parallel read batches could race on.
      const resolved = new Map<string, string>();
      if (pathAccess)
        for (const declared of p.tool.paths?.(p.input) ?? [])
          if (!resolved.has(declared)) {
            const target = await pathAccess.resolve(declared, {
              workspace,
              session: sessionId,
              ...(options.label ? { label: options.label } : {}),
              signal: combined,
            });
            // Key both the declared input and its resolved form: a write resolves the
            // input once, then re-checks the already-absolute path, and neither lookup may
            // ask a second time for an "allow once" decision.
            resolved.set(declared, target);
            resolved.set(target, target);
          }
      scope.guard?.(effect);
      if (options.toolFilter && !options.toolFilter(p.tool))
        throw new Error(`Tool ${call.name} is not available in this session`);
      const capability = p.tool.capability;
      const gate = o.capabilities;
      if (capability && (allowed(policy, effect) || capabilityAllowed(policy, p.tool))) {
        // A broad process grant or --allow-analysis: allowed, audited as a flag decision.
        gate?.record({
          capability,
          sessionId,
          scope: "once",
          decision: "allow",
          source: "flag",
          callId: call.id,
          runId,
          ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
        });
      } else if (capability && gate?.granted(capability, sessionId)) {
        // A persisted "allow for this session" grant of the root session.
      } else if (!allowed(policy, effect)) {
        if (
          !o.approve ||
          !approvals ||
          (effect !== "write" && effect !== "process" && effect !== "external")
        )
          throw new Error(`Capability denied: ${capability ?? effect}`);
        const preview = capability
          ? (scriptPreview(p.input) ?? (await gate?.preview?.(p.input, sessionId)))
          : undefined;
        emit("approval_requested", {
          id: call.id,
          name: call.name,
          effect,
          ...(options.label ? { label: options.label } : {}),
          ...(capability ? { capability } : {}),
        });
        const decision = await o.approve({
          call,
          effect,
          input: p.input,
          signal: combined,
          session: sessionId,
          ...(options.label ? { label: options.label } : {}),
          ...(capability ? { capability } : {}),
          ...(preview !== undefined ? { preview } : {}),
          ...(capability && gate?.runtime ? { runtime: gate.runtime } : {}),
        });
        combined.throwIfAborted();
        const persisted = !!capability && !!gate && decision === "session";
        if (capability && gate)
          gate.record({
            capability,
            sessionId,
            scope: decision === "session" ? "session" : "once",
            decision: decision === "deny" ? "deny" : "allow",
            source: gate.source ?? "tui",
            callId: call.id,
            runId,
            ...(options.correlationId !== undefined
              ? { correlationId: options.correlationId }
              : {}),
          });
        emit("approval_resolved", {
          id: call.id,
          name: call.name,
          effect,
          decision,
          ...(capability ? { capability } : {}),
          ...(persisted ? { persisted: true } : {}),
        });
        if (decision === "deny")
          throw new Error(`Capability ${capability ?? effect} denied by the user for this call`);
        // A capability grant never widens the effect: only effect approvals do.
        if (decision === "session" && !capability) policy[effect] = true;
      }
      o.store.beginCall(sessionId, call, { runId, effect });
      const publisher = o.artifacts?.({ sessionId, runId, callId: call.id }, (published) =>
        emit("artifact_published", {
          artifact: published.artifact,
          path: published.path,
          callId: call.id,
          ...(published.executionId ? { executionId: published.executionId } : {}),
        }),
      );
      /**
       * `analysis.install`: always asks, `once` only, and no flag or earlier grant covers it. Where
       * nobody can be asked (headless, no approval handler) the answer is `deny`.
       */
      const approveInstall: InstallApprover = async (install) => {
        if (!o.approve || !approvals) return "deny";
        const installCall = { ...call, id: `${call.id}:install` };
        emit("approval_requested", {
          id: installCall.id,
          name: call.name,
          effect: "process",
          ...(options.label ? { label: options.label } : {}),
          capability: "analysis.install",
          install,
        });
        let decision: "once" | "session" | "deny" = "deny";
        try {
          decision = await o.approve({
            call: installCall,
            effect: "process",
            input: { extras: install.extras },
            signal: combined,
            session: sessionId,
            ...(options.label ? { label: options.label } : {}),
            capability: "analysis.install",
            install,
          });
        } finally {
          combined.throwIfAborted();
        }
        // A `session` answer is treated as `once`: an installation permission is never stored.
        const allowedNow = decision !== "deny";
        gate?.record({
          capability: "analysis.install",
          sessionId,
          scope: "once",
          decision: allowedNow ? "allow" : "deny",
          source: gate.source ?? "tui",
          callId: call.id,
          runId,
          ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
        });
        emit("approval_resolved", {
          id: installCall.id,
          name: call.name,
          effect: "process",
          decision: allowedNow ? "once" : "deny",
          capability: "analysis.install",
        });
        return allowedNow ? "once" : "deny";
      };
      result = await p.tool.execute(p.input, {
        signal: combined,
        workspace,
        session: sessionId,
        runId,
        callId: call.id,
        ...(publisher ? { artifacts: publisher } : {}),
        approveInstall,
        emit: (data) => emit("tool_progress", { id: call.id, data }),
        ...(options.label ? { label: options.label } : {}),
        ...(pathAccess
          ? {
              resolvePath: (path: string) => {
                const known = resolved.get(path);
                return known !== undefined
                  ? Promise.resolve(known)
                  : pathAccess.resolve(path, {
                      workspace,
                      session: sessionId,
                      ...(options.label ? { label: options.label } : {}),
                      signal: combined,
                    });
              },
            }
          : {}),
      });
      // The bound applies to what the model sees (the text projection): display-only
      // ui/image parts are bounded by their producers and must not push text over it.
      const projected = textProjection(result);
      if (JSON.stringify(projected).length > 48_000)
        result = textResult(
          `${JSON.stringify(projected).slice(0, 40_000)}\n[tool output truncated]`,
          result.isError,
        );
      result = scope.amend?.(result, effect) ?? result;
      o.store.endCall(sessionId, call, result);
    } catch (error) {
      result = textResult(error instanceof Error ? error.message : String(error), true);
      // A cancellation after execution may have left effects; journal remains pending.
      if (!combined.aborted) o.store.endCall(sessionId, call, result);
    }
    emit("tool_completed", {
      id: call.id,
      name: call.name,
      isError: result.isError ?? false,
      durationMs: Date.now() - started,
      preview: result.content
        .filter((part) => part.type === "text")
        .map((c) => c.text)
        .join("\n")
        .slice(0, 2_000),
    });
    return result;
  }
  /**
   * Runs ONE tool call without a model (spec §20 `runToolCall`): an action the user started from
   * a UI, such as copying an artifact into the workspace. It is a real run of the session
   * (`run_started` → `tool_*` → `run_completed`, journaled) and the call passes exactly the gates
   * of a model call (`write` approval, capabilities, paths). The transcript stays valid for every
   * provider: a user note (shown as `display`), an assistant message with the call, the tool
   * result and a short assistant summary.
   */
  async runToolCall(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
    options: RunOptions & { signal?: AbortSignal } = {},
  ): Promise<{ runId: string; status: "completed"; result: ToolResult }> {
    const controller = this.claim(sessionId);
    const runId = options.runId ?? crypto.randomUUID();
    const o = this.options,
      emit = this.emitter(sessionId, { runId, correlationId: options.correlationId });
    const finish = (status: TerminalRunStatus, error?: string) => {
      try {
        o.store.endRun?.(runId, {
          status,
          usage: { input: 0, output: 0 },
          ...(error ? { error } : {}),
        });
      } catch {
        /* A journal write failure cannot invalidate an executed run. */
      }
    };
    const runTimeoutMs = options.timeoutMs ?? o.timeoutMs ?? 300_000;
    const timeout = AbortSignal.timeout(runTimeoutMs);
    const combined = AbortSignal.any([
      controller.signal,
      timeout,
      ...(options.signal ? [options.signal] : []),
    ]);
    const workspace = options.workspace ?? o.workspace;
    let acquired = false;
    try {
      o.store.beginRun?.({
        id: runId,
        session: sessionId,
        status: "running",
        model: o.store.get(sessionId).model,
        ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
      });
      o.store.acquire(sessionId);
      acquired = true;
      o.store.reconcile(sessionId);
      const session = o.store.get(sessionId);
      if (session.workspace !== workspace) throw new Error("Session workspace mismatch");
      combined.throwIfAborted();
      const call: ToolCall = { id: uiCallId(), name, arguments: JSON.stringify(input) };
      let prepared: PreparedCall;
      try {
        prepared = {
          call,
          tool: o.registry.get(name),
          input: o.registry.parse(name, call.arguments),
        };
      } catch (error) {
        prepared = { call, error: String(error) };
      }
      const note = `The user ran the ${name} tool from the interface.`;
      o.store.append(sessionId, { role: "user", text: note, display: options.display ?? note });
      emit("run_started", { model: session.model });
      o.store.append(sessionId, { role: "assistant", text: "", calls: [call] });
      const result = await this.executeCall(
        {
          sessionId,
          runId,
          emit,
          signal: combined,
          workspace,
          policy: options.policy ?? o.policy,
          approvals: !!o.approve && options.approvals !== false,
          options,
        },
        prepared,
      );
      o.store.append(sessionId, { role: "tool", callId: call.id, result });
      const first = textProjection(result)
        .content.map((part) => (part.type === "text" ? part.text : ""))
        .join(" ")
        .replace(/\s*\n\s*/g, " ")
        .trim()
        .slice(0, 300);
      const text = `${name} ${result.isError ? "failed" : "finished"}${first ? `: ${first}` : ""}`;
      o.store.append(sessionId, { role: "assistant", text, calls: [] });
      emit("run_completed", { tokens: 0, text });
      finish("completed");
      return { runId, status: "completed", result };
    } catch (error) {
      if (combined.aborted && isTimeoutReason(combined.reason)) {
        const failure = new RunTimeoutError({
          kind: "run",
          ms: runTimeoutMs,
          stage: "tool",
          tool: name,
        });
        emit("run_failed", { error: failure.message, code: "timeout", timeout: failure.info });
        finish("failed", failure.message);
        throw failure;
      }
      const cause = combined.aborted ? (combined.reason ?? error) : error;
      const message = cause instanceof Error ? cause.message : String(cause);
      emit(combined.aborted ? "run_cancelled" : "run_failed", { error: message });
      finish(combined.aborted ? "cancelled" : "failed", message);
      throw error;
    } finally {
      if (acquired) o.store.release(sessionId);
      this.active.delete(sessionId);
    }
  }
  async run(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
    options: RunOptions = {},
  ): Promise<{
    sessionId: string;
    text: string;
    status: string;
    usage: { input: number; output: number };
  }> {
    const controller = this.claim(sessionId);
    const runId = options.runId ?? crypto.randomUUID();
    const o = this.options,
      emit = this.emitter(sessionId, { runId, correlationId: options.correlationId });
    /** Run journal (v4 stores only): an auxiliary record that never changes the run outcome. */
    const finish = (status: TerminalRunStatus, error?: string) => {
      try {
        o.store.endRun?.(runId, { status, usage: usageTotal, ...(error ? { error } : {}) });
      } catch {
        /* A journal write failure cannot invalidate an executed run. */
      }
    };
    const limit = o.maxContextChars ?? 800_000;
    let tokens = 0,
      lastText = "",
      acquired = false;
    const usageTotal = { input: 0, output: 0 };
    const runTimeoutMs = options.timeoutMs ?? o.timeoutMs ?? 300_000;
    const firstTokenMs = options.firstTokenTimeoutMs ?? o.firstTokenTimeoutMs ?? 0;
    const firstTokenRetries =
      firstTokenMs > 0 ? Math.max(0, options.firstTokenRetries ?? o.firstTokenRetries ?? 0) : 0;
    const truncationRecoveries = Math.max(
      0,
      options.truncationRecoveries ?? o.truncationRecoveries ?? 0,
    );
    /** Responses of this run cut off by the output limit (the first plus every recovery). */
    let truncations = 0;
    /** Continuation notice and lowered effort for the request that follows a cut-off response. */
    let recoveryNotice: string | undefined;
    let recoveryEffort: string | undefined;
    const runStartedAt = Date.now();
    const timeout = AbortSignal.timeout(runTimeoutMs);
    const combined = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]);
    // What the run was doing, so a timeout can say where it was stuck (see `RunTimeoutError`).
    let stage: "waiting_model" | "streaming" | "tool" | "other" = "other";
    let stageTool: string | undefined;
    let modelId: string | undefined;
    let providerName: string | undefined;
    let requests = 0;
    let silentTimedOut = false;
    /** Sends of the request that is (or was last) waiting for its first token. */
    let silentAttempts = 0;
    const context = options.context ?? o.context;
    const workspace = options.workspace ?? o.workspace;
    const pathAccess = o.pathAccess;
    const policy = options.policy ?? o.policy;
    const approvals = !!o.approve && options.approvals !== false;
    const withPersona = async () => {
      const base = await context.instructions(sessionId);
      return options.instructions ? `${base}\n\n${options.instructions}` : base;
    };
    try {
      o.store.beginRun?.({
        id: runId,
        session: sessionId,
        status: "running",
        model: o.store.get(sessionId).model,
        ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
      });
      o.store.acquire(sessionId);
      acquired = true;
      o.store.reconcile(sessionId);
      const session = o.store.get(sessionId);
      const provider = await (o.providerFor?.(session) ?? o.provider);
      if (session.provider !== provider.id || session.workspace !== workspace)
        throw new Error("Session provider/workspace mismatch");
      // The session records the model; switching models is explicit via setModel.
      const model = session.model;
      modelId = model;
      providerName = providerLabel(provider.id);
      combined.throwIfAborted();
      if (o.extensions && o.store.messages(sessionId).length === 0) {
        // New session: extensions may inject budgeted context once, persisted with the session.
        try {
          const start = await o.extensions.sessionStart({
            sessionId,
            model,
            workspace,
          });
          for (const f of start.failures) emit("plugin_hook_failed", { ...f, continued: true });
          const text = start.inject
            .map((x) => x.text.slice(0, MAX_INJECT_CHARS))
            .filter((x) => x.trim())
            .join("\n\n");
          if (text) {
            o.store.append(sessionId, { role: "user", text, summary: true });
            emit("session_context_injected", {
              tokens: estimateTokens(text),
              sources: start.inject.map((x) => x.source),
            });
          }
        } catch (error) {
          emit("plugin_hook_failed", {
            source: "host",
            hook: "sessionStart",
            error: String(error),
            continued: true,
          });
        }
        combined.throwIfAborted();
      }
      for (const queued of this.drain(sessionId))
        o.store.append(sessionId, { role: "user", text: queued });
      o.store.append(sessionId, {
        role: "user",
        text: prompt,
        ...(options.display ? { display: options.display } : {}),
        ...(options.attachments?.length ? { attachments: options.attachments } : {}),
        ...(options.datasets?.length ? { datasets: options.datasets } : {}),
      });
      emit("run_started", { model });
      const budget =
        options.maxTokens ?? o.maxTokens ?? defaultTokenBudget(o.contextWindow?.(model));
      const compaction = o.compaction ?? {};
      const maxTurns = options.maxTurns ?? o.maxTurns ?? 100;
      for (let turn = 0; turn < maxTurns; turn++) {
        combined.throwIfAborted();
        // Input queued while the run was working (e.g. a parent's message to a child).
        if (turn > 0)
          for (const queued of this.drain(sessionId))
            o.store.append(sessionId, { role: "user", text: queued });
        let instructions = await withPersona();
        let messages = o.store.messages(sessionId);
        const tools = this.availableTools(options, sessionId);
        const toolsText = this.toolsText(tools);
        const chars = () =>
          instructions.length + JSON.stringify(messages).length + toolsText.length;
        // REDUCIBLE content only (instructions + transcript). The fixed tool catalog
        // (`toolsText`) is a deployment reality — a huge MCP catalog with dozens of tools is
        // part of every request regardless of history, so it is deliberately excluded from the
        // post-compaction hard cap: counting it would reduce a small transcript to near-nothing
        // and still fake-fail. Oversized catalogs are a `/plugins` decision, not session growth;
        // auto-compaction above still measures the FULL request (`chars()`), because window
        // thresholds protect what the model really sees, tools included.
        const charsConversation = () => instructions.length + JSON.stringify(messages).length;
        const used = () => {
          const last = this.reported.get(sessionId);
          return last && last.count <= messages.length
            ? last.tokens + estimateTokens(messages.slice(last.count))
            : estimateTokens(instructions) + estimateTokens(messages) + estimateTokens(toolsText);
        };
        // One effective budget: a known window triggers at `used >= window * threshold`; an
        // unknown (or absurdly large, see MAX_TRUSTED_WINDOW) window falls back to the char
        // estimate (`chars / 4 >= maxContextChars / 4`). `maxContextChars` below stays as the
        // post-compaction hard limit.
        if (
          compaction.auto !== false &&
          shouldCompactContext(
            used(),
            chars(),
            o.contextWindow?.(model),
            limit,
            compaction.threshold ?? 0.85,
          )
        ) {
          await this.compactLocked(sessionId, emit, model, combined, "auto");
          instructions = await withPersona();
          messages = o.store.messages(sessionId);
        }
        // A compaction that still leaves the session over the hard limit is reduced in place
        // instead of failing outright: retained content is clipped against a TOTAL character
        // target for the transcript (`limit − instructions`), largest items first, tool results
        // before texts, in descending cap rounds. That also covers sessions with many MEDIUM
        // results (e.g. MCP outputs of a few thousand chars each) that individually stay under
        // the per-message caps; roles/callIds/boundaries stay untouched, so the transcript
        // remains valid and replayable. The hard cap measures ONLY reducible content
        // (`charsConversation`): the fixed tool catalog (see above) never triggers the error on
        // its own. The reduction is persisted either way, so the session stays usable for later
        // prompts. Only if even the reduction floor cannot fit (instructions alone crowd out the
        // limit) the run fails with an actionable error.
        if (charsConversation() > limit) {
          const targetChars = Math.max(MIN_MESSAGE_BUDGET_FLOOR, limit - instructions.length);
          const reduction = reduceMessagesToBudget(messages, targetChars);
          if (reduction.truncated > 0) {
            o.store.overwrite(sessionId, reduction.messages);
            messages = reduction.messages;
            emit("context_reduced", { messages: reduction.truncated });
          }
          if (charsConversation() > limit)
            throw new Error(
              `Context budget exceeded and compaction could not reduce it (approximately ${charsConversation()} characters of conversation; limit ${limit}). Run /compact, trim large tool outputs, start a new session, or disable unneeded MCP servers with /plugins.`,
            );
        }
        let completion: Extract<Message, { role: "assistant" }> | undefined;
        let truncated = false;
        let usage: { input: number; output: number; cachedInput?: number } | undefined;
        // Providers only ever see the text projection of tool results: ui/image parts are a
        // display-only extension of the persisted transcript and never reach a model prompt
        // (raw image bytes included). The store keeps the rich parts for TUI replay.
        const providerMessages: Message[] = messages.map((m) =>
          m.role === "tool" ? { ...m, result: textProjection(m.result) } : m,
        );
        // After a cut-off response the request carries a transient continuation notice (never
        // persisted: the stored transcript only ever holds what the model really answered).
        if (recoveryNotice) providerMessages.push({ role: "user", text: recoveryNotice });
        const requestEffort = recoveryEffort ?? options.reasoningEffort ?? o.reasoningEffort;
        recoveryNotice = undefined;
        recoveryEffort = undefined;
        // Resolved for the model of THIS request (a catalog may still be loading on the first).
        const outputLimit = await this.outputLimit(model, options.maxOutputTokens);
        combined.throwIfAborted();
        /** The provider threw the "cut off by the output limit" signal instead of completing. */
        let cutByError = false;
        let requested = Date.now();
        let firstDelta: number | undefined;
        stage = "waiting_model";
        requests++;
        silentAttempts = 0;
        // The same request is sent again only while the provider stayed completely silent until
        // `firstTokenTimeoutMs`. Nothing was received, appended or accounted for the aborted
        // attempt, so the retry reuses the exact same inputs inside this turn.
        for (;;) {
          silentAttempts++;
          silentTimedOut = false;
          requested = Date.now();
          // A request that stays completely silent can be stopped early (`firstTokenTimeoutMs`).
          const silent = new AbortController();
          let silentTimer: ReturnType<typeof setTimeout> | undefined =
            firstTokenMs > 0
              ? setTimeout(() => {
                  silentTimedOut = true;
                  silent.abort();
                }, firstTokenMs)
              : undefined;
          const stopSilentTimer = () => {
            if (silentTimer) clearTimeout(silentTimer);
            silentTimer = undefined;
          };
          let failure: unknown;
          try {
            for await (const e of provider.stream({
              instructions,
              messages: providerMessages,
              tools,
              maxOutputTokens: outputLimit.value,
              signal: firstTokenMs > 0 ? AbortSignal.any([combined, silent.signal]) : combined,
              model,
              sessionId,
              ...(o.nativeTools?.length ? { nativeTools: o.nativeTools } : {}),
              ...(requestEffort ? { reasoningEffort: requestEffort } : {}),
            })) {
              combined.throwIfAborted();
              stopSilentTimer();
              if (stage === "waiting_model") stage = "streaming";
              if (e.type !== "completed") firstDelta ??= Date.now();
              if (e.type === "text_delta") emit("text_delta", { delta: e.delta });
              else if (e.type === "reasoning_delta") emit("reasoning_delta", { delta: e.delta });
              else {
                if (completion) throw new Error("Provider emitted multiple completions");
                completion = e.message;
                truncated = e.message.truncated === true;
                usage = e.usage;
                tokens += (e.usage?.input ?? 0) + (e.usage?.output ?? 0);
                usageTotal.input += e.usage?.input ?? 0;
                usageTotal.output += e.usage?.output ?? 0;
              }
            }
          } catch (error) {
            failure = error;
          } finally {
            stopSilentTimer();
          }
          const silentFailure =
            silentTimedOut &&
            firstDelta === undefined &&
            !completion &&
            !combined.aborted &&
            silentAttempts <= firstTokenRetries;
          if (!silentFailure) {
            if (failure !== undefined) {
              // A response cut off before anything usable is recovered like a truncated one.
              if (!completion && !combined.aborted && isOutputTruncationError(failure)) {
                cutByError = true;
                break;
              }
              throw failure;
            }
            break;
          }
          // Do not start an attempt the whole-run limit could not let finish.
          const retryPauseMs = FIRST_TOKEN_RETRY_PAUSE_MS;
          if (runTimeoutMs - (Date.now() - runStartedAt) < retryPauseMs + firstTokenMs) {
            if (failure !== undefined) throw failure;
            break;
          }
          // From here the silence is handled: a later stop or run timeout is judged on its own.
          silentTimedOut = false;
          emit("request_retry", {
            attempt: silentAttempts,
            of: firstTokenRetries,
            reason: "first_token_timeout",
            afterMs: Date.now() - requested,
          });
          await abortableDelay(retryPauseMs, combined);
          combined.throwIfAborted();
          stage = "waiting_model";
        }
        stage = "other";
        // A response cut off by the output limit that cannot be used as it is: no visible text
        // and no tool call, or a tool call whose arguments are incomplete. Complete calls of a
        // cut response, and a cut response with usable text, keep their normal handling below.
        let cut: "tool_call_cut" | "empty_response" | undefined;
        if (cutByError) cut = "empty_response";
        else if (!completion) throw new Error("Provider stream ended without a completed response");
        else if (truncated) {
          if (incompleteCalls(completion.calls)) cut = "tool_call_cut";
          else if (!completion.text.trim() && !completion.calls.length) cut = "empty_response";
        }
        if (cut) {
          const maxOutputTokens = outputLimit.value;
          truncations++;
          // Visible text is kept as a normal assistant message; the cut calls are discarded:
          // never executed, never persisted (they would have no result), no provider data.
          const keep = completion?.text ?? "";
          if (keep.trim()) {
            o.store.append(sessionId, { role: "assistant", text: keep, calls: [] });
            lastText = keep;
          }
          if (truncations > truncationRecoveries)
            throw new RunTruncationError({
              attempts: truncations,
              maxOutputTokens,
              source: outputLimit.source,
              ...(modelId ? { model: modelId } : {}),
            });
          // Reasoning exhausted the budget (nothing at all came out): ask for less of it once.
          const levels = o.effortLevels?.(model);
          const lowered =
            truncations === 1 && cut === "empty_response"
              ? lowerEffort(requestEffort ?? levels?.defaultLevel, levels?.supportedLevels)
              : undefined;
          emit("truncation_recovery", {
            attempt: truncations,
            of: truncationRecoveries,
            reason: cut,
            maxOutputTokens,
            ...(lowered ? { effort: lowered } : {}),
          });
          recoveryNotice = TRUNCATION_NOTICE;
          recoveryEffort = lowered;
          await abortableDelay(TRUNCATION_RETRY_PAUSE_MS, combined);
          combined.throwIfAborted();
          // The recovery is not a turn.
          turn--;
          continue;
        }
        if (!completion) throw new Error("Provider stream ended without a completed response");
        const durationMs = Date.now() - requested;
        const ids = completion.calls.map((c) => c.id);
        const previousIds = new Set(
          messages.flatMap((m) => (m.role === "assistant" ? m.calls.map((c) => c.id) : [])),
        );
        if (ids.some((id) => previousIds.has(id)))
          throw new Error("Provider reused a tool call ID across turns");
        if (new Set(ids).size !== ids.length)
          throw new Error("Provider returned duplicate tool call IDs");
        if (completion.calls.length > 64) throw new Error("Too many tool calls in one turn");
        o.store.append(sessionId, completion);
        if (usage)
          this.reported.set(sessionId, {
            tokens: usage.input + usage.output,
            count: messages.length + 1,
          });
        lastText = completion.text;
        emit("turn_completed", {
          turn: turn + 1,
          tokens,
          calls: completion.calls.length,
          model,
          ...(usage ? { usage } : {}),
          durationMs,
          ...(firstDelta !== undefined ? { ttftMs: firstDelta - requested } : {}),
        });
        if (!completion.calls.length) {
          const final: { tokens: number; text: string; truncated?: boolean } = {
            tokens,
            text: lastText,
          };
          if (truncated) {
            // The adapter kept a usable answer, but the token budget cut it off.
            emit("response_truncated", {
              turn: turn + 1,
              maxOutputTokens: outputLimit.value,
              source: outputLimit.source,
            });
            final.truncated = true;
          }
          emit("run_completed", final);
          finish("completed");
          return { sessionId, text: lastText, status: "completed", usage: usageTotal };
        }
        const prepared = completion.calls.map((call) => {
          try {
            const tool = o.registry.get(call.name),
              input = o.registry.parse(call.name, call.arguments);
            return { call, tool, input };
          } catch (error) {
            return { call, error: String(error) };
          }
        });
        // Resolve scopes before tools execute. New nested instructions are attached to the first
        // read result; state-changing calls return to the model for reconsideration instead.
        let contextUpdate: string | undefined;
        const paths = prepared.flatMap((p) => p.tool?.paths?.(p.input ?? {}) ?? []);
        if (paths.length) contextUpdate = await context.beforePaths(paths, sessionId);
        let pendingUpdate = contextUpdate;
        const scope: CallScope = {
          sessionId,
          runId,
          emit,
          signal: combined,
          workspace,
          policy,
          approvals,
          options,
          guard: (effect) => {
            if (contextUpdate && effect !== "read")
              throw new Error(
                `Context changed; reconsider this call before retrying.\n${contextUpdate}`,
              );
            if (tokens >= budget) throw new Error("Token budget exhausted; tool was not executed");
          },
          amend: (result, effect) => {
            if (!pendingUpdate || effect !== "read") return result;
            const update = pendingUpdate;
            pendingUpdate = undefined;
            return {
              ...result,
              content: [
                ...result.content,
                { type: "text", text: `\n<instructions>\n${update}\n</instructions>` },
              ],
            };
          },
        };
        stage = "tool";
        stageTool = prepared[0]?.call.name;
        const execute = (p: (typeof prepared)[number]) => this.executeCall(scope, p);
        const results: ToolResult[] = [];
        // Bounded parallel batches for consecutive read or explicitly concurrent tools.
        const parallel = (p: (typeof prepared)[number] | undefined) =>
          !!p?.tool && (p.tool.effect === "read" || p.tool.concurrent === true);
        for (let i = 0; i < prepared.length; ) {
          const current = prepared[i];
          if (!current) break;
          if (parallel(current)) {
            const batch: typeof prepared = [];
            while (
              i < prepared.length &&
              parallel(prepared[i]) &&
              batch.length < (o.readConcurrency ?? 4)
            ) {
              const p = prepared[i++];
              if (p) batch.push(p);
            }
            results.push(...(await Promise.all(batch.map(execute))));
          } else {
            results.push(await execute(current));
            i++;
          }
          combined.throwIfAborted();
        }
        for (let i = 0; i < completion.calls.length; i++) {
          const c = completion.calls[i],
            r = results[i];
          if (c && r) o.store.append(sessionId, { role: "tool", callId: c.id, result: r });
        }
        stage = "other";
        stageTool = undefined;
        if (tokens >= budget) throw new Error("Token budget exhausted");
      }
      // Turn cap reached. This is NOT a failure: everything produced up to this point stays in
      // the transcript and the run returns a successful-but-marked partial result, so the user
      // can simply prompt again to continue in the same session. The real hard stops remain the
      // token budget (`maxTokens`) and the timeout; the turn count is a safety rail.
      emit("run_turns_exceeded", { turns: maxTurns, maxTurns });
      finish("turns_exceeded");
      return { sessionId, text: lastText, status: "turns-exceeded", usage: usageTotal };
    } catch (error) {
      const timedOut = silentTimedOut
        ? { kind: "first_token" as const, ms: firstTokenMs, attempts: Math.max(1, silentAttempts) }
        : combined.aborted && isTimeoutReason(combined.reason)
          ? { kind: "run" as const, ms: runTimeoutMs }
          : undefined;
      if (timedOut && !(combined.aborted && !isTimeoutReason(combined.reason))) {
        const failure = new RunTimeoutError({
          ...timedOut,
          ...(modelId ? { model: modelId } : {}),
          ...(providerName ? { provider: providerName } : {}),
          stage,
          ...(stage === "tool" && stageTool ? { tool: stageTool } : {}),
          ...(requests <= 1 ? { firstRequest: true } : {}),
        });
        emit("run_failed", { error: failure.message, code: "timeout", timeout: failure.info });
        finish("failed", failure.message);
        throw failure;
      }
      if (error instanceof RunTruncationError) {
        emit("run_failed", {
          error: error.message,
          code: "output_truncated",
          truncation: error.info,
        });
        finish("failed", error.message);
        throw error;
      }
      // On cancellation report the abort reason, not the transport's secondary error.
      const cause = combined.aborted ? (combined.reason ?? error) : error;
      const message = cause instanceof Error ? cause.message : String(cause);
      emit(combined.aborted ? "run_cancelled" : "run_failed", { error: message });
      finish(combined.aborted ? "cancelled" : "failed", message);
      throw error;
    } finally {
      if (acquired) o.store.release(sessionId);
      this.active.delete(sessionId);
    }
  }
}
