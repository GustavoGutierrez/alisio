import {
  type Message,
  type ModelProvider,
  type RunEvent,
  type ToolDefinition,
  type ToolResult,
  textResult,
} from "@alisio/sdk";
import {
  checkpointInstructions,
  estimateTokens,
  parseCheckpointOutput,
  planCompaction,
  shouldCompact,
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
}
export interface RunnerOptions {
  provider: ModelProvider;
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
  /** Context window in tokens for a model, when known. Unknown disables auto compaction. */
  contextWindow?: (model: string) => number | undefined;
  compaction?: CompactionSettings;
  /** When set, write/process tools not allowed by the policy are offered and ask first. */
  approve?: ApprovalHandler;
  /** Generic hooks (implemented by the plugin host) for compaction and session start. */
  extensions?: RunnerExtensions;
}
/** Extension output appended to history is capped regardless of what hooks return. */
const MAX_INJECT_CHARS = 24_000;
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
  private busy = false;
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
  /** Tools offered to the model under the current policy. */
  availableTools(): ToolDefinition[] {
    const o = this.options;
    return o.registry.list().filter((t) => {
      const effect = t.effect ?? "external";
      if (allowed(o.policy, effect)) return true;
      return !!o.approve && (effect === "write" || effect === "process");
    });
  }
  private toolsText(tools: ToolDefinition[]): string {
    return JSON.stringify(
      tools.map((t) => ({ name: t.name, schema: t.inputSchema, description: t.description })),
    );
  }
  /** Estimated tokens the next request of a session would send. */
  async estimateContext(sessionId: string): Promise<number> {
    const instructions = await this.options.context.instructions();
    return (
      estimateTokens(instructions) +
      estimateTokens(this.options.store.messages(sessionId)) +
      estimateTokens(this.toolsText(this.availableTools()))
    );
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
    if (this.busy) throw new Error("Runner is busy; await current run or cancel it");
    this.busy = true;
    const o = this.options;
    let acquired = false;
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 300_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
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
      this.busy = false;
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
      const raw = await summarize(o.provider, {
        instructions: checkpointInstructions(contribution.instructions, fields),
        messages: plan.summarized,
        focus,
        model,
        maxOutputTokens: o.maxOutputTokens ?? 4096,
        signal,
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
    options: { display?: string } = {},
  ): Promise<{ sessionId: string; text: string; status: string }> {
    if (this.busy) throw new Error("Runner is busy; await current run or cancel it");
    this.busy = true;
    const o = this.options,
      emit = this.emitter(sessionId);
    let tokens = 0,
      lastText = "",
      acquired = false;
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 300_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      o.store.acquire(sessionId);
      acquired = true;
      o.store.reconcile(sessionId);
      const session = o.store.get(sessionId);
      if (session.provider !== o.provider.id || session.workspace !== o.workspace)
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
            workspace: o.workspace,
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
      o.store.append(sessionId, {
        role: "user",
        text: prompt,
        ...(options.display ? { display: options.display } : {}),
      });
      emit("run_started", { model });
      const compaction = o.compaction ?? {};
      for (let turn = 0; turn < (o.maxTurns ?? 20); turn++) {
        combined.throwIfAborted();
        let instructions = await o.context.instructions();
        let messages = o.store.messages(sessionId);
        const tools = this.availableTools();
        const toolsText = this.toolsText(tools);
        const chars = () =>
          instructions.length + JSON.stringify(messages).length + toolsText.length;
        const used = () => {
          const last = this.reported.get(sessionId);
          return last && last.count <= messages.length
            ? last.tokens + estimateTokens(messages.slice(last.count))
            : estimateTokens(instructions) + estimateTokens(messages) + estimateTokens(toolsText);
        };
        const overChars = chars() > (o.maxContextChars ?? 160_000);
        const overWindow =
          compaction.auto !== false &&
          shouldCompact(used(), o.contextWindow?.(model), compaction.threshold ?? 0.85);
        if (overWindow || (overChars && compaction.auto !== false)) {
          await this.compactLocked(sessionId, emit, model, combined, "auto");
          instructions = await o.context.instructions();
          messages = o.store.messages(sessionId);
        }
        if (chars() > (o.maxContextChars ?? 160_000))
          throw new Error(
            "Context budget exceeded and compaction could not reduce it; start a new session.",
          );
        let completion: Extract<Message, { role: "assistant" }> | undefined;
        let usage: { input: number; output: number; cachedInput?: number } | undefined;
        for await (const e of o.provider.stream({
          instructions,
          messages,
          tools,
          maxOutputTokens: o.maxOutputTokens ?? 4096,
          signal: combined,
          model,
        })) {
          combined.throwIfAborted();
          if (e.type === "text_delta") emit("text_delta", { delta: e.delta });
          else if (e.type === "reasoning_delta") emit("reasoning_delta", { delta: e.delta });
          else {
            if (completion) throw new Error("Provider emitted multiple completions");
            completion = e.message;
            usage = e.usage;
            tokens += (e.usage?.input ?? 0) + (e.usage?.output ?? 0);
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
          emit("run_completed", { tokens, text: lastText });
          return { sessionId, text: lastText, status: "completed" };
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
        // Resolve all scopes before any tool executes. Changes return to the model for reconsideration.
        let contextUpdate: string | undefined;
        const paths = prepared.flatMap((p) => p.tool?.paths?.(p.input ?? {}) ?? []);
        if (paths.length) contextUpdate = await o.context.beforePaths(paths);
        const execute = async (p: (typeof prepared)[number]): Promise<ToolResult> => {
          const { call } = p;
          let result: ToolResult;
          const started = Date.now();
          emit("tool_started", { name: call.name, id: call.id, arguments: call.arguments });
          try {
            combined.throwIfAborted();
            if (p.error) throw new Error(p.error);
            if (!p.tool || !p.input) throw new Error("Invalid tool");
            if (contextUpdate)
              throw new Error(
                `Context changed; reconsider this call before retrying.\n${contextUpdate}`,
              );
            if (tokens >= (o.maxTokens ?? 100_000))
              throw new Error("Token budget exhausted; tool was not executed");
            const effect = p.tool.effect ?? "external";
            if (!allowed(o.policy, effect)) {
              if (!o.approve || (effect !== "write" && effect !== "process"))
                throw new Error(`Capability denied: ${effect}`);
              emit("approval_requested", { id: call.id, name: call.name, effect });
              const decision = await o.approve({
                call,
                effect,
                input: p.input,
                signal: combined,
              });
              combined.throwIfAborted();
              emit("approval_resolved", { id: call.id, name: call.name, effect, decision });
              if (decision === "deny")
                throw new Error(`Capability ${effect} denied by the user for this call`);
              if (decision === "session") o.policy[effect] = true;
            }
            o.store.beginCall(sessionId, call);
            result = await p.tool.execute(p.input, {
              signal: combined,
              workspace: o.workspace,
              session: sessionId,
              emit: (data) => emit("tool_progress", { id: call.id, data }),
            });
            if (JSON.stringify(result).length > 48_000)
              result = textResult(
                `${JSON.stringify(result).slice(0, 40_000)}\n[tool output truncated]`,
                result.isError,
              );
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
              .map((c) => c.text)
              .join("\n")
              .slice(0, 2_000),
          });
          return result;
        };
        const results: ToolResult[] = [];
        // Bounded parallel batches only for consecutive declared read operations.
        for (let i = 0; i < prepared.length; ) {
          const current = prepared[i];
          if (!current) break;
          if (current.tool?.effect === "read") {
            const batch: typeof prepared = [];
            while (
              i < prepared.length &&
              prepared[i]?.tool?.effect === "read" &&
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
        if (tokens >= (o.maxTokens ?? 100_000)) throw new Error("Token budget exhausted");
      }
      throw new Error("Maximum turns reached");
    } catch (error) {
      // On cancellation report the abort reason, not the transport's secondary error.
      const cause = combined.aborted ? (combined.reason ?? error) : error;
      emit(combined.aborted ? "run_cancelled" : "run_failed", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      throw error;
    } finally {
      if (acquired) o.store.release(sessionId);
      this.busy = false;
    }
  }
}
