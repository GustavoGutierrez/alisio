import {
  type Attachment,
  type Message,
  type ModelProvider,
  type RunEvent,
  type ToolDefinition,
  type ToolResult,
  textProjection,
  textResult,
} from "@alisio/sdk";
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
  ContextSource,
  HookFailure,
  Policy,
  RunnerExtensions,
  SessionStore,
} from "./contracts.ts";
import type { ToolRegistry } from "./registry.ts";
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
  maxContextChars?: number;
  maxOutputTokens?: number;
  maxTokens?: number;
  onEvent?: (event: RunEvent) => void;
  readConcurrency?: number;
  /** Context window in tokens for a model, when known. Drives auto-compaction at `threshold`; when
   *  unknown (or absurdly large, see `MAX_TRUSTED_WINDOW`) the char budget falls back. */
  contextWindow?: (model: string) => number | undefined;
  compaction?: CompactionSettings;
  /** When set, write/process tools not allowed by the policy are offered and ask first. */
  approve?: ApprovalHandler;
  /** Generic hooks (implemented by the plugin host) for compaction and session start. */
  extensions?: RunnerExtensions;
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
  /** Reasoning effort level for this run; beats the runner-level default when set. */
  reasoningEffort?: string;
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
  effect === "read" || effect === "internal" || !!policy[effect as keyof Policy];
export interface CompactionResult {
  replaced: number;
  before: number;
  after: number;
  summary: Extract<Message, { role: "user" }>;
}
type Emit = (type: string, data: unknown) => void;
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
  private emitter(sessionId: string): Emit {
    const runId = crypto.randomUUID();
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
      if (type !== "text_delta" && type !== "tool_progress" && type !== "reasoning_delta")
        this.options.store.event(sessionId, runId, type, data);
      try {
        this.options.onEvent?.(event);
      } catch {
        /* An observer cannot invalidate an executed operation. */
      }
    };
  }
  /** Tools offered to the model under the current policy (and optional run narrowing). */
  availableTools(run: RunOptions = {}): ToolDefinition[] {
    const o = this.options;
    const policy = run.policy ?? o.policy;
    const approvals = !!o.approve && run.approvals !== false;
    return o.registry.list().filter((t) => {
      if (run.toolFilter && !run.toolFilter(t)) return false;
      const effect = t.effect ?? "external";
      if (allowed(policy, effect)) return true;
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
    const o = this.options,
      emit = this.emitter(sessionId);
    const limit = o.maxContextChars ?? 800_000;
    let tokens = 0,
      lastText = "",
      acquired = false;
    const usageTotal = { input: 0, output: 0 };
    const timeout = AbortSignal.timeout(options.timeoutMs ?? o.timeoutMs ?? 300_000);
    const combined = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]);
    const context = options.context ?? o.context;
    const workspace = options.workspace ?? o.workspace;
    const policy = options.policy ?? o.policy;
    const approvals = !!o.approve && options.approvals !== false;
    const withPersona = async () => {
      const base = await context.instructions(sessionId);
      return options.instructions ? `${base}\n\n${options.instructions}` : base;
    };
    try {
      o.store.acquire(sessionId);
      acquired = true;
      o.store.reconcile(sessionId);
      const session = o.store.get(sessionId);
      const provider = await (o.providerFor?.(session) ?? o.provider);
      if (session.provider !== provider.id || session.workspace !== workspace)
        throw new Error("Session provider/workspace mismatch");
      // The session records the model; switching models is explicit via setModel.
      const model = session.model;
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
        const tools = this.availableTools(options);
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
        const providerMessages = messages.map((m) =>
          m.role === "tool" ? { ...m, result: textProjection(m.result) } : m,
        );
        for await (const e of provider.stream({
          instructions,
          messages: providerMessages,
          tools,
          maxOutputTokens: options.maxOutputTokens ?? o.maxOutputTokens ?? 4096,
          signal: combined,
          model,
          sessionId,
          ...(o.nativeTools?.length ? { nativeTools: o.nativeTools } : {}),
          ...((options.reasoningEffort ?? o.reasoningEffort)
            ? { reasoningEffort: options.reasoningEffort ?? o.reasoningEffort }
            : {}),
        })) {
          combined.throwIfAborted();
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
        if (!completion) throw new Error("Provider stream ended without a completed response");
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
              maxOutputTokens: options.maxOutputTokens ?? o.maxOutputTokens ?? 4096,
            });
            final.truncated = true;
          }
          emit("run_completed", final);
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
        const execute = async (p: (typeof prepared)[number]): Promise<ToolResult> => {
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
            if (contextUpdate && effect !== "read")
              throw new Error(
                `Context changed; reconsider this call before retrying.\n${contextUpdate}`,
              );
            if (tokens >= budget) throw new Error("Token budget exhausted; tool was not executed");
            if (options.toolFilter && !options.toolFilter(p.tool))
              throw new Error(`Tool ${call.name} is not available in this session`);
            if (!allowed(policy, effect)) {
              if (
                !o.approve ||
                !approvals ||
                (effect !== "write" && effect !== "process" && effect !== "external")
              )
                throw new Error(`Capability denied: ${effect}`);
              emit("approval_requested", {
                id: call.id,
                name: call.name,
                effect,
                ...(options.label ? { label: options.label } : {}),
              });
              const decision = await o.approve({
                call,
                effect,
                input: p.input,
                signal: combined,
                session: sessionId,
                ...(options.label ? { label: options.label } : {}),
              });
              combined.throwIfAborted();
              emit("approval_resolved", { id: call.id, name: call.name, effect, decision });
              if (decision === "deny")
                throw new Error(`Capability ${effect} denied by the user for this call`);
              if (decision === "session") policy[effect] = true;
            }
            o.store.beginCall(sessionId, call);
            result = await p.tool.execute(p.input, {
              signal: combined,
              workspace,
              session: sessionId,
              emit: (data) => emit("tool_progress", { id: call.id, data }),
              ...(options.label ? { label: options.label } : {}),
            });
            if (JSON.stringify(result).length > 48_000)
              result = textResult(
                `${JSON.stringify(result).slice(0, 40_000)}\n[tool output truncated]`,
                result.isError,
              );
            if (pendingUpdate && effect === "read") {
              result = {
                ...result,
                content: [
                  ...result.content,
                  { type: "text", text: `\n<instructions>\n${pendingUpdate}\n</instructions>` },
                ],
              };
              pendingUpdate = undefined;
            }
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
        };
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
        if (tokens >= budget) throw new Error("Token budget exhausted");
      }
      // Turn cap reached. This is NOT a failure: everything produced up to this point stays in
      // the transcript and the run returns a successful-but-marked partial result, so the user
      // can simply prompt again to continue in the same session. The real hard stops remain the
      // token budget (`maxTokens`) and the timeout; the turn count is a safety rail.
      emit("run_turns_exceeded", { turns: maxTurns, maxTurns });
      return { sessionId, text: lastText, status: "turns-exceeded", usage: usageTotal };
    } catch (error) {
      // On cancellation report the abort reason, not the transport's secondary error.
      const cause = combined.aborted ? (combined.reason ?? error) : error;
      emit(combined.aborted ? "run_cancelled" : "run_failed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw error;
    } finally {
      if (acquired) o.store.release(sessionId);
      this.active.delete(sessionId);
    }
  }
}
