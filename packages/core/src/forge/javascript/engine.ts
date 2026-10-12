/**
 * `JavaScriptEngine` (spec §6, D1-D5): the `ExecutionEngine` strategy that runs a script in a
 * QuickJS-WASM VM inside an isolate host. It owns the transport and the lifecycle of the isolate;
 * what the guest's messages MEAN (tool calls, state, output, budget) is the kernel's broker.
 *
 * Host-side checks, whatever the guest says: every message passes `GuestMessageValidator`
 * (schema, sequence, correlation, size, depth, forbidden keys, capability gate); a violation or a
 * handler error terminates the isolate and fails the execution with the matching code.
 */
import { access } from "node:fs/promises";
import type { EngineDescriptor } from "@alisio/sdk";
import { type ForgeErrorCode, isForgeError } from "../errors.ts";
import type { GuestLimits } from "../limits.ts";
import type {
  EngineOutcome,
  ExecutionEngine,
  ExecutionRequest,
  HostReply,
  IsolateHost,
  IsolateSession,
  KernelChannel,
  PreparedExecution,
  TerminationReason,
  TerminationReport,
  TrustedExecutionContext,
} from "../ports.ts";
import { GuestMessageValidator } from "../protocol.ts";
import type { IsolateHostFactory } from "./hosts/factory.ts";
import { resolveIsolateCommand } from "./hosts/process-host.ts";
import { workerEntryUrl } from "./hosts/worker-host.ts";
import { PRELUDE_HASH } from "./prelude.ts";
import { FORGE_PROTOCOL_VERSION, JAVASCRIPT_ENGINE_VERSION } from "./runtime-manifest.ts";
import { loadQuickJsModule } from "./wasm.ts";

export interface PreparedJavaScript extends PreparedExecution {
  readonly source: string;
  /** The state snapshot the script starts with. */
  readonly state: Record<string, unknown>;
  readonly catalogSize: number;
  readonly host: IsolateHost;
  session?: IsolateSession;
  /** Ends the run with a host verdict; set by `run`, used when a stop cannot be confirmed. */
  forceEnd?: () => void;
}

export interface JavaScriptEngineOptions {
  hosts: IsolateHostFactory;
  /** The verified module; defaults to the process-wide cache. */
  loadModule?: () => Promise<WebAssembly.Module>;
}

const GUEST_LIMIT_KEYS = [
  "timeoutMs",
  "memoryBytes",
  "stackBytes",
  "maxToolCalls",
  "maxConcurrency",
  "maxCallInputBytes",
  "maxCallResponseBytes",
  "maxRetainedOutputBytes",
] as const satisfies readonly (keyof GuestLimits)[];

const guestLimits = (limits: PreparedExecution["limits"]): GuestLimits =>
  Object.fromEntries(GUEST_LIMIT_KEYS.map((key) => [key, limits[key]])) as unknown as GuestLimits;

export class JavaScriptEngine implements ExecutionEngine {
  readonly id = "javascript-quickjs" as const;
  readonly #options: JavaScriptEngineOptions;

  constructor(options: JavaScriptEngineOptions) {
    this.#options = options;
  }

  #module(): Promise<WebAssembly.Module> {
    return (this.#options.loadModule ?? loadQuickJsModule)();
  }

  /**
   * Cheap self-check (runs at startup): the WASM matches its pinned hash and compiles, and the
   * files the chosen host starts exist. The full spin-up of an isolate is `probe()`.
   */
  async describe(): Promise<EngineDescriptor> {
    const base: EngineDescriptor = {
      id: this.id,
      language: "javascript",
      version: JAVASCRIPT_ENGINE_VERSION,
      isolation: "wasm-isolate",
      ready: true,
      capabilities: {
        cooperativeInterrupt: true,
        hardTermination: true,
        hardMemoryLimit: false,
        networkDeniedByOS: false,
        toolCalls: true,
      },
    };
    const unavailable = (reason: string): EngineDescriptor => ({ ...base, ready: false, reason });
    try {
      await this.#module();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unavailable(
        `the QuickJS runtime failed verification (${message}); reinstall @alisio/core`,
      );
    }
    try {
      if (this.#options.hosts.kind === "worker") await access(workerEntryUrl());
      else {
        const command = resolveIsolateCommand();
        await access(command.execPath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unavailable(`the ${this.#options.hosts.kind} isolate host cannot start (${message})`);
    }
    return base;
  }

  /** The kind of host that runs the isolates (`forge status`). */
  get hostKind(): "worker" | "process" {
    return this.#options.hosts.kind;
  }

  async prepare(
    request: ExecutionRequest,
    ctx: TrustedExecutionContext,
  ): Promise<PreparedJavaScript> {
    await this.#module();
    const payload = request.payload ?? {};
    return {
      executionId: ctx.executionId,
      engine: this.id,
      limits: ctx.limits,
      source: request.source,
      state: (payload.state as Record<string, unknown> | undefined) ?? {},
      catalogSize: typeof payload.catalogSize === "number" ? payload.catalogSize : 0,
      host: await this.#options.hosts.create(),
    };
  }

  async run(prepared: PreparedExecution, channel: KernelChannel): Promise<EngineOutcome> {
    const job = prepared as PreparedJavaScript;
    const session = job.host.start();
    job.session = session;
    const validator = new GuestMessageValidator({ toolCalls: true });
    let hostSeq = 0;
    let settled = false;

    return new Promise<EngineOutcome>((resolve) => {
      const send = (reply: HostReply): void => {
        if (settled) return;
        // Answering a call or a lookup closes its correlation (a second answer is a bug).
        if (reply.type === "result") validator.resolveCall(reply.payload.callId);
        else if (reply.type === "catalog.result") validator.resolveCatalog(reply.payload.requestId);
        session.send({ protocol: FORGE_PROTOCOL_VERSION, seq: hostSeq++, ...reply });
      };
      const finish = (outcome: EngineOutcome, stop?: TerminationReason): void => {
        if (settled) return;
        settled = true;
        validator.close();
        // The guest ends itself after its terminal message; a failure stops it from here.
        if (stop) void session.stop(stop);
        resolve(outcome);
      };
      const fail = (code: ForgeErrorCode, message: string, stop: TerminationReason): void =>
        finish({ kind: "failed", code, message }, stop);
      // The kernel stopped the run (deadline or cancellation) and the isolate never confirmed it
      // is gone: no terminal message and no exit will come, so the host ends the run itself. The
      // kernel's own verdict decides the status; the unconfirmed report is journaled from there.
      job.forceEnd = () =>
        finish({
          kind: "failed",
          code: "ISOLATE_FAILURE",
          message: "the isolate did not confirm that it stopped",
        });

      session.onStreamError((reason) => fail("PROTOCOL_VIOLATION", reason, "protocol_violation"));
      session.exited.then((exit) => {
        if (settled) return;
        const detail =
          exit.error ?? `code ${String(exit.code)}${exit.signal ? `, signal ${exit.signal}` : ""}`;
        finish({
          kind: "failed",
          code: "ISOLATE_FAILURE",
          message: `the isolate exited unexpectedly (${detail})`,
        });
      });
      session.onMessage((raw) => {
        if (settled) return;
        const checked = validator.accept(raw);
        if (!checked.ok)
          return fail("PROTOCOL_VIOLATION", checked.error.message, "protocol_violation");
        const message = checked.message;
        if (message.type === "complete") {
          const value = (message.payload as { value?: unknown }).value;
          return finish({ kind: "completed", ...(value !== undefined ? { value } : {}) });
        }
        if (message.type === "fatal") {
          return finish({
            kind: "failed",
            code: message.payload.code,
            message: message.payload.message,
          });
        }
        if (message.type === "ready") {
          if (message.payload.engine !== this.id || message.payload.preludeHash !== PRELUDE_HASH)
            return fail(
              "PROTOCOL_VIOLATION",
              "the isolate runs an unexpected prelude",
              "protocol_violation",
            );
          send({
            type: "start",
            payload: {
              source: job.source,
              state: job.state,
              limits: guestLimits(job.limits),
              catalogSize: job.catalogSize,
            },
          });
        }
        Promise.resolve()
          .then(() => channel.receive(message))
          .then((reply) => {
            if (reply) send(reply);
          })
          .catch((error: unknown) => {
            if (isForgeError(error)) return fail(error.code, error.message, "limit_exceeded");
            fail(
              "ISOLATE_FAILURE",
              error instanceof Error ? error.message : String(error),
              "limit_exceeded",
            );
          });
      });
      channel.bind(send);
    });
  }

  async terminate(
    prepared: PreparedExecution,
    reason: TerminationReason,
  ): Promise<TerminationReport> {
    const job = prepared as PreparedJavaScript;
    const session = job.session;
    if (!session) return { confirmed: true, method: "interrupt", elapsedMs: 0 };
    const report = await session.stop(reason);
    if (!report.confirmed) job.forceEnd?.();
    return report;
  }

  async dispose(prepared: PreparedExecution): Promise<void> {
    const session = (prepared as PreparedJavaScript).session;
    if (!session) return;
    // A normal run ends with the guest leaving by itself; anything still alive is stopped now.
    const gone = await Promise.race([
      session.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250).unref?.()),
    ]);
    if (!gone) await session.stop("limit_exceeded");
  }

  /**
   * Full self-test (`alisio forge status`): starts a real isolate, runs `return 1` and reports how
   * long it took. Nothing here is on the hot path of a normal execution.
   */
  async probe(): Promise<{
    ok: boolean;
    reason?: string;
    bootMs?: number;
    host: "worker" | "process";
  }> {
    const host = this.#options.hosts.kind;
    const started = performance.now();
    try {
      const { probeIsolate } = await import("./probe.ts");
      const module = await this.#module();
      await probeIsolate(await this.#options.hosts.create(), module);
      return { ok: true, host, bootMs: Math.round(performance.now() - started) };
    } catch (error) {
      return { ok: false, host, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
