/**
 * `ExecutionKernel` (spec D1, §5.2): the fixed lifecycle every Forja execution follows, whatever the
 * engine. Template Method:
 *
 *   validate -> admit -> select -> prepare -> run (with deadline) -> collect -> cleanup (always)
 *
 * The kernel owns what must not depend on an engine: limits, the concurrency slots, the journal
 * (every transition and nested call), the cross-execution state (committed only on success), the
 * deadline and cancellation with the host's OWN clock, the output bound and the single terminal
 * state. The engine only knows how to run code in an isolate.
 */
import { createHash } from "node:crypto";
import type { EngineId, EngineLanguage, ForgeProgress, PermissionMode } from "@alisio/sdk";
import { newUuid } from "../runtime/ids.ts";
import { CapabilityBroker } from "./broker.ts";
import { BudgetLedger } from "./budget.ts";
import { ForgeError, isForgeError } from "./errors.ts";
import type { SqliteExecutionJournal } from "./journal.ts";
import { DEFAULT_FORGE_LIMITS, type ForgeLimits, type LimitLayers, mergeLimits } from "./limits.ts";
import type { NestedCallDispatcher } from "./nested.ts";
import type {
  EngineOutcome,
  ExecutionEngine,
  ExecutionRequest,
  HostReply,
  TerminationReason,
  TerminationReport,
} from "./ports.ts";
import { ProgressCoalescer } from "./progress.ts";
import type { EngineRegistry } from "./registry.ts";
import { type ForgeResult, hintFor } from "./result.ts";
import {
  type EngineSelector,
  type JavaScriptSelectionContext,
  type Selection,
} from "./selector.ts";
import type { SlotTable } from "./slots.ts";
import { StateDelta, type StateSnapshot } from "./state-delta.ts";
import { type ExecutionState, ExecutionStateMachine } from "./state-machine.ts";
import type { SqliteStateStore } from "./state-store.ts";
import { TaskLog } from "./task-log.ts";
import { type Verdict, verdictOf } from "./verdict.ts";

export interface KernelConfig {
  /** `forge.javascript.enabled`. */
  enabled: boolean;
  /** The configured limits (the global layer; project config only ever lowered them already). */
  limits: Partial<ForgeLimits>;
  /** `forge.state.enabled`. */
  stateEnabled: boolean;
}

export interface KernelDeps {
  engines: EngineRegistry;
  selector: EngineSelector<JavaScriptSelectionContext, EngineId>;
  journal: SqliteExecutionJournal;
  state?: SqliteStateStore;
  slots: SlotTable;
  config: () => KernelConfig;
  now?: () => number;
  newId?: () => string;
  /** How long the end of an execution waits for nested calls the script left running. */
  drainMs?: number;
}

/** Everything the core knows about the call that asks for the execution; the model controls none of it. */
export interface KernelCallContext {
  toolCallId: string;
  session: string;
  rootSessionId: string;
  workspace: string;
  signal: AbortSignal;
  permissionMode: PermissionMode;
  allowAnalysis: boolean;
  allowProcess: boolean;
  /** Absent for an engine that cannot call tools (Python): the kernel then offers none. */
  dispatcher?: NestedCallDispatcher;
  /** Delivers `ForgeProgress` to the run (already coalesced to 4 per second). */
  emit: (progress: ForgeProgress) => void;
  /** `<sessionDir>/tasks/<executionId>.log` is written under this folder when given. */
  tasksDir?: string;
}

export interface KernelInvocation {
  source: string;
  title?: string;
  requestedLimits?: Partial<ForgeLimits>;
  call: KernelCallContext;
  /** Language of `source`; JavaScript when omitted. */
  language?: EngineLanguage;
  /**
   * A selection the caller already made (Python's backend selector). It replaces the JavaScript
   * chain; the engine must be registered. The model never provides it.
   */
  selection?: Selection<EngineId>;
  /** Per-engine request extensions, handed to `prepare` next to the state snapshot. */
  payload?: Record<string, unknown>;
  /**
   * Limits set by the core after the merge (Python's own timeout and source size, which the
   * JavaScript maxima do not describe). Never built from model input.
   */
  limitOverrides?: Partial<ForgeLimits>;
}

/** What an engine without tool calls sees as its nested-call port: nothing. */
const NO_NESTED_CALLS: NestedCallDispatcher = {
  catalog: () => [],
  knows: () => false,
  call: async () => ({
    ok: false,
    nestedCallId: "",
    code: "TOOL_UNAVAILABLE",
    message: "this engine cannot call tools",
  }),
};

/** The result plus the bound on what the model sees of it (the effective `maxOutputChars`). */
export interface KernelOutcome {
  result: ForgeResult;
  maxOutputChars: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export class ExecutionKernel {
  readonly #deps: KernelDeps;

  constructor(deps: KernelDeps) {
    this.#deps = deps;
  }

  async execute(invocation: KernelInvocation): Promise<KernelOutcome> {
    const deps = this.#deps;
    const now = deps.now ?? Date.now;
    const call = invocation.call;
    const startedAt = now();
    const id = (deps.newId ?? (() => `fx_${newUuid()}`))();
    const config = deps.config();
    const descriptors = deps.engines.descriptors();
    const language: EngineLanguage = invocation.language ?? "javascript";
    const dispatcher = call.dispatcher ?? NO_NESTED_CALLS;

    // select (cheap and pure, so it precedes the journal row, which needs the engine and the reason)
    let selection: Selection<EngineId> | undefined;
    let selectionError: ForgeError | undefined;
    try {
      selection =
        invocation.selection ??
        deps.selector.select({
          language,
          javascriptEnabled: config.enabled,
          descriptors,
        });
    } catch (error) {
      selectionError = isForgeError(error)
        ? error
        : new ForgeError(
            "ENGINE_UNAVAILABLE",
            error instanceof Error ? error.message : String(error),
          );
    }
    const engineId: EngineId = selection?.engine ?? "javascript-quickjs";
    const isolation = descriptors[engineId]?.isolation ?? "none";
    const selectionReason = selection?.reason ?? selectionError?.message ?? "no engine";

    deps.journal.open({
      id,
      rootSessionId: call.rootSessionId,
      sessionId: call.session,
      toolCallId: call.toolCallId,
      engine: engineId,
      isolation,
      selectionReason,
      codeSha256: sha256(invocation.source),
    });
    const machine = new ExecutionStateMachine();
    const advance = (to: ExecutionState): void => {
      machine.transition(to);
      deps.journal.transition(
        id,
        to as Exclude<ExecutionState, "succeeded" | "failed" | "cancelled" | "timed_out">,
      );
    };

    const log = call.tasksDir ? new TaskLog(`${call.tasksDir}/${id}.log`) : undefined;
    const progress = new ProgressCoalescer(call.emit);
    const base = { kind: "forge", executionId: id, engine: engineId } as const;
    const phase = (name: ForgeProgress["phase"], message?: string): void =>
      progress.terminal({ ...base, phase: name, ...(message ? { message } : {}) });

    let limits: ForgeLimits | undefined;
    let release: (() => void) | undefined;
    let engine: ExecutionEngine | undefined;
    let prepared: Awaited<ReturnType<ExecutionEngine["prepare"]>> | undefined;
    let broker: CapabilityBroker | undefined;
    let verdict: Verdict = {
      status: "failed",
      error: { code: "ISOLATE_FAILURE", message: "execution did not finish" },
    };
    let report: TerminationReport | undefined;
    let queueMs = 0;
    const abort = new AbortController();
    let stop: "cancelled" | "timeout" | undefined;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let termination: Promise<TerminationReport> | undefined;
    const requestStop = (reason: "cancelled" | "timeout"): void => {
      if (!running || stop) return;
      stop = reason;
      // Nested calls hear it first: a guest waiting on one executes no bytecode and cannot notice.
      abort.abort(new Error(reason === "timeout" ? "deadline" : "cancelled"));
      const why: TerminationReason = reason === "timeout" ? "timeout" : "cancelled";
      if (engine && prepared) termination = engine.terminate(prepared, why);
    };
    const onUserAbort = (): void => requestStop("cancelled");

    try {
      // validate
      if (selectionError) throw selectionError;
      const layers: LimitLayers = {
        global: config.limits,
        ...(invocation.requestedLimits ? { request: invocation.requestedLimits } : {}),
      };
      limits = { ...mergeLimits(layers), ...invocation.limitOverrides };
      if (Buffer.byteLength(invocation.source, "utf8") > limits.maxSourceBytes)
        throw new ForgeError(
          "INVALID_INPUT",
          `the script is larger than ${limits.maxSourceBytes} bytes`,
        );
      if (invocation.source.trim() === "")
        throw new ForgeError("INVALID_INPUT", "the script is empty");

      // admit (the slots are the JavaScript engine's: Python runs are not Forja script hosts, and a
      // `js_run` that calls `python_run` holds its session's slot while the Python run starts)
      if (language === "javascript") release = deps.slots.acquire(call.session);
      advance("preparing");
      phase("preparing");
      const snapshot: StateSnapshot =
        config.stateEnabled && deps.state
          ? deps.state.snapshot(call.rootSessionId)
          : { values: {}, revisions: {} };
      const delta = config.stateEnabled && deps.state ? new StateDelta(snapshot) : undefined;

      // prepare
      engine = deps.engines.get(engineId);
      const request: ExecutionRequest = {
        language,
        source: invocation.source,
        ...(invocation.title ? { title: invocation.title } : {}),
        engineHint: engineId,
        payload: {
          ...invocation.payload,
          state: snapshot.values,
          catalogSize: dispatcher.catalog().length,
        },
      };
      prepared = await engine.prepare(request, {
        executionId: id,
        toolCallId: call.toolCallId,
        rootSessionId: call.rootSessionId,
        workspace: call.workspace,
        permissionMode: call.permissionMode,
        allowAnalysis: call.allowAnalysis,
        allowProcess: call.allowProcess,
        signal: call.signal,
        limits,
      });
      if (prepared.analysisExecutionId)
        deps.journal.linkAnalysisExecution(id, prepared.analysisExecutionId);

      broker = new CapabilityBroker({
        dispatcher,
        ledger: new BudgetLedger(limits),
        limits,
        journal: deps.journal,
        executionId: id,
        signal: abort.signal,
        state: delta,
        update: (event) => progress.update(event),
        terminal: (event) => progress.terminal(event),
        engine: engineId,
        log: (line) => log?.write(line),
        now,
      });
      const activeBroker = broker;
      let send: (reply: HostReply) => void = () => {};
      activeBroker.bind((reply) => send(reply));

      // run (the deadline starts here and covers compute and nested calls)
      let outcome: EngineOutcome;
      if (call.signal.aborted) {
        // Cancelled before it ever ran: preparing -> cancelled.
        outcome = { kind: "failed", code: "CANCELLED", message: "cancelled" };
        verdict = verdictOf(outcome, "cancelled", limits.timeoutMs);
      } else {
        advance("running");
        running = true;
        queueMs = now() - startedAt;
        phase("running");
        log?.write(`started ${id} (${selectionReason})`);
        call.signal.addEventListener("abort", onUserAbort, { once: true });
        timer = setTimeout(() => requestStop("timeout"), limits.timeoutMs);
        outcome = await engine.run(prepared, {
          receive: (message) => activeBroker.receive(message),
          bind: (next) => {
            send = next;
          },
          signal: abort.signal,
        });
        running = false;
        // The engine's own collection (artifacts to publish) comes before the state commit, and
        // only for an execution the host did not stop.
        let collecting = false;
        if (!stop && engine.collect) {
          if (outcome.kind === "completed") {
            advance("collecting");
            phase("collecting");
            collecting = true;
          }
          outcome = await engine.collect(prepared, outcome);
        }
        verdict = verdictOf(outcome, stop, limits.timeoutMs);
        if (stop) {
          // The host's own stop decides the terminal state; wait until the guest is confirmed gone.
          report = await (termination ??
            engine.terminate(prepared, stop === "timeout" ? "timeout" : "cancelled"));
        } else if (outcome.kind === "failed") {
          report = await engine.terminate(prepared, "limit_exceeded");
        }
        abort.abort(new Error("execution ended"));
        await activeBroker.drain(deps.drainMs ?? 2_000);
        if (verdict.status === "succeeded") {
          if (!collecting) {
            advance("collecting");
            phase("collecting");
          }
          try {
            if (delta && deps.state) deps.state.commit(call.rootSessionId, snapshot, delta.ops());
          } catch (error) {
            if (isForgeError(error))
              verdict = { status: "failed", error: { code: error.code, message: error.message } };
            else throw error;
          }
        }
      }
    } catch (error) {
      running = false;
      const forge = isForgeError(error) ? error : undefined;
      verdict = {
        status: "failed",
        error: {
          code: forge?.code ?? "ISOLATE_FAILURE",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timer);
      call.signal.removeEventListener("abort", onUserAbort);
      abort.abort(new Error("execution ended"));
      if (broker) await broker.drain(deps.drainMs ?? 2_000);
      if (engine && prepared) {
        try {
          await engine.dispose(prepared);
        } catch {
          /* The isolate is already stopped or unreachable; nothing more to do from here. */
        }
      }
      progress.close();
    }

    // The terminal state is reached exactly once, with the state machine's blessing.
    const unconfirmed = report ? !report.confirmed : false;
    const stats = broker?.stats ?? { total: 0, failed: 0, denied: 0 };
    const output = broker?.output ?? [];
    const outputBytes = output.reduce(
      (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
      0,
    );
    const wallMs = now() - startedAt;
    try {
      if (verdict.status === "cancelled" && machine.state === "running") advance("cancelling");
      if (verdict.status === "timed_out" && machine.state === "running")
        advance("timed_out_pending");
      deps.journal.close(id, {
        status: verdict.status,
        ...(verdict.error ? { errorCode: verdict.error.code } : {}),
        metrics: {
          wallMs,
          queueMs,
          calls: stats,
          outputBytes,
          ...(broker?.progressDropped ? { progressDropped: broker.progressDropped } : {}),
        },
        terminationUnconfirmed: unconfirmed,
      });
    } catch (error) {
      // The row is already terminal (a reconciliation raced us); the result still goes back.
      log?.write(`journal: ${error instanceof Error ? error.message : String(error)}`);
    }
    log?.write(`${verdict.status}${verdict.error ? `: ${verdict.error.code}` : ""} (${wallMs} ms)`);
    await log?.flush();
    // A guest that could not be confirmed gone keeps its slot until it is (or the process ends).
    if (unconfirmed && report?.settled) void report.settled.then(() => release?.());
    else release?.();

    const result: ForgeResult = {
      schemaVersion: 1,
      executionId: id,
      engine: engineId,
      isolation,
      selectionReason,
      status: verdict.status,
      output,
      ...(verdict.value !== undefined ? { value: verdict.value } : {}),
      ...(verdict.error
        ? {
            error: {
              ...verdict.error,
              ...(() => {
                const hint =
                  language === "javascript"
                    ? hintFor(verdict.error.code, verdict.error.message, invocation.source)
                    : undefined;
                return hint ? { hint } : {};
              })(),
            },
          }
        : {}),
      calls: stats,
      truncated: false,
      metrics: { wallMs, queueMs, outputBytes },
    };
    return {
      result,
      maxOutputChars: limits?.maxOutputChars ?? DEFAULT_FORGE_LIMITS.maxOutputChars,
    };
  }
}
