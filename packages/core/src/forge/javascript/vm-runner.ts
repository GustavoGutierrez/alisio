/**
 * The guest side of the JavaScript engine (spec §6, D-26): runs INSIDE the isolate (a worker
 * thread or a child process). It creates one QuickJS VM per execution, evaluates the prelude,
 * bridges `tools.call`, `catalog.*`, `state.*`, `text`, `progress` to protocol messages and drives
 * the VM's job queue until the root promise settles.
 *
 * The host never trusts anything produced here: every message is validated against the protocol,
 * the call budget and the sizes again on the other side. This runner only has to be a faithful
 * and well-behaved guest; if it is not, the host ends the execution.
 *
 * Erasable TypeScript only (D-33): the isolate entry loads this file under Node's type stripping.
 */
import { JSValueHandle, QuickJS } from "quickjs-wasi";
import type { GuestLimits } from "../limits.ts";
import { PRELUDE_HASH, PRELUDE_SOURCE } from "./prelude.ts";
import { FORGE_PROTOCOL_VERSION } from "./runtime-manifest.ts";

/** How the isolate talks to its host. Messages are plain JSON-compatible objects. */
export interface GuestTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

export interface GuestOptions {
  /** The pinned, already verified and compiled QuickJS module. */
  module: WebAssembly.Module;
  transport: GuestTransport;
  /**
   * The cancel flag shared with the parent (worker host only): 1 = cancelled, 2 = deadline. A
   * process host has no shared memory and relies on the local deadline plus `SIGKILL`.
   */
  flag?: Int32Array;
  now?: () => number;
}

interface StartPayload {
  source: string;
  state: Record<string, unknown>;
  limits: GuestLimits;
  catalogSize: number;
}

interface RunInfo {
  ok: boolean;
  value?: unknown;
  code?: string;
  name?: string;
  message?: string;
  /** Set by the prelude only for an error of the engine's own type (a QuickJS limit). */
  limit?: "MEMORY_LIMIT" | "STACK_LIMIT";
}

type Deferred = ReturnType<QuickJS["newPromise"]>;

/** What a failed script reports: a limit only when the engine's own error type said so (L7). */
const classify = (info: RunInfo): { code: string; message: string } => {
  const message = info.message ?? "";
  if (info.limit === "MEMORY_LIMIT" || info.limit === "STACK_LIMIT")
    return { code: info.limit, message };
  return { code: info.code ?? "SCRIPT_RUNTIME", message };
};

/** The VM itself failed outside the script (the exception comes from the engine, not from guest text). */
const classifyEngineFailure = (message: string): string => {
  if (/out of memory/i.test(message)) return "MEMORY_LIMIT";
  if (/call stack size/i.test(message)) return "STACK_LIMIT";
  return "SCRIPT_RUNTIME";
};

/**
 * Runs one execution to its terminal message (`complete` or `fatal`) and returns. The caller closes
 * the transport (and exits the process) afterwards.
 */
export function runGuest(options: GuestOptions): Promise<void> {
  const { transport, module } = options;
  const now = options.now ?? (() => performance.now());
  return new Promise<void>((finish) => {
    let seq = 0;
    let started = false;
    let done = false;
    const send = (type: string, payload: unknown): void => {
      if (done && type !== "complete" && type !== "fatal") return;
      transport.send({ protocol: FORGE_PROTOCOL_VERSION, type, seq: seq++, payload });
    };

    let vm: QuickJS | undefined;
    let api:
      | { init: JSValueHandle; run: JSValueHandle; grant: JSValueHandle; waiting: JSValueHandle }
      | undefined;
    let root: JSValueHandle | undefined;
    let deadline = Number.POSITIVE_INFINITY;
    let interrupted: "cancelled" | "timeout" | undefined;
    const calls = new Map<number, Deferred>();
    const catalogs = new Map<number, Deferred>();
    let nextCatalogId = 0;
    /** Credits that arrive while the VM is still being created. */
    let earlyCredits = 0;
    /** A terminal condition the prelude asked for (a spent call budget). */
    let requested: { code: string; message: string } | undefined;

    const end = (type: "complete" | "fatal", payload: unknown): void => {
      if (done) return;
      send(type, payload);
      done = true;
      try {
        vm?.dispose();
      } catch {
        /* The VM is going away with the isolate. */
      }
      finish();
    };
    const fatal = (code: string, message: string): void => end("fatal", { code, message });

    const interruptHandler = (): boolean => {
      const flag = options.flag ? Atomics.load(options.flag, 0) : 0;
      if (flag !== 0) {
        interrupted = flag === 2 ? "timeout" : "cancelled";
        return true;
      }
      if (now() >= deadline) {
        interrupted = "timeout";
        return true;
      }
      return false;
    };

    const bridge = (kind: string, data: string): JSValueHandle | undefined => {
      const machine = vm as QuickJS;
      const body = JSON.parse(data) as Record<string, unknown>;
      switch (kind) {
        case "call": {
          const callId = Number(body.callId);
          const deferred = machine.newPromise();
          calls.set(callId, deferred);
          send("call", { callId, tool: body.tool, input: JSON.parse(String(body.input)) });
          return deferred.handle;
        }
        case "catalog": {
          const requestId = nextCatalogId++;
          const deferred = machine.newPromise();
          catalogs.set(requestId, deferred);
          send("catalog", {
            requestId,
            op: body.op,
            query: body.query,
            ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
          });
          return deferred.handle;
        }
        case "output":
          send("output", body);
          return undefined;
        case "progress":
          send("progress", {
            message: body.message,
            ...(typeof body.completed === "number" ? { completed: body.completed } : {}),
            ...(typeof body.total === "number" ? { total: body.total } : {}),
          });
          return undefined;
        case "state.set":
          send("state.set", { key: body.key, value: JSON.parse(String(body.value)) });
          return undefined;
        case "state.delete":
          send("state.delete", { key: body.key });
          return undefined;
        case "fatal":
          // Ends the execution once the VM is back on the host stack (`pump` looks, never here).
          requested ??= { code: String(body.code), message: String(body.message) };
          return undefined;
        default:
          throw new Error(`unknown bridge request ${kind}`);
      }
    };

    const applyGrant = (credits: number): void => {
      const machine = vm as QuickJS;
      const count = machine.newNumber(credits);
      machine
        .callFunction((api as { grant: JSValueHandle }).grant, machine.undefined, count)
        .dispose();
      count.dispose();
    };

    /** Runs queued promise jobs, then checks how the root promise stands. */
    const pump = (): void => {
      if (done || !vm || !root) return;
      try {
        vm.executePendingJobs();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interrupted)
          return fatal(interrupted === "timeout" ? "TIMEOUT" : "CANCELLED", "interrupted");
        if (requested) return fatal(requested.code, requested.message);
        return fatal(classifyEngineFailure(message), message);
      }
      if (done) return;
      if (requested) return fatal(requested.code, requested.message);
      const exports = vm._getExports();
      const state = exports.qjs_promise_state(root.ptr);
      if (state === 0) {
        if (calls.size + catalogs.size > 0) return;
        const waiting = vm.callFunction(api?.waiting as JSValueHandle, vm.undefined);
        const queued = Number(vm.dump(waiting));
        waiting.dispose();
        if (queued === 0)
          fatal(
            "UNRESOLVABLE_PROMISE",
            "the script is waiting on a promise that nothing can settle",
          );
        return;
      }
      const resultHandle = new JSValueHandle(vm, exports.qjs_promise_result(root.ptr));
      const text = vm.dump(resultHandle);
      resultHandle.dispose();
      if (state === 2) {
        // `run` never rejects; a rejection here means the VM itself failed.
        return fatal("SCRIPT_RUNTIME", `script failed: ${String(text)}`);
      }
      const info = JSON.parse(String(text)) as RunInfo;
      if (info.ok) end("complete", info.value === undefined ? {} : { value: info.value });
      else {
        const { code, message } = classify(info);
        fatal(code, message);
      }
    };

    const start = async (payload: StartPayload): Promise<void> => {
      try {
        deadline = now() + payload.limits.timeoutMs;
        vm = await QuickJS.create({
          wasm: module,
          memoryLimit: payload.limits.memoryBytes,
          maxStackSize: payload.limits.stackBytes,
          interruptHandler,
          moduleLoader: {
            load: () => {
              throw new Error("modules are not available");
            },
          },
        });
        const machine = vm;
        const bridgeFn = machine.newFunction("__forge_bridge", (kind, data) => {
          const result = bridge(String(machine.dump(kind)), String(machine.dump(data)));
          return result ?? machine.undefined;
        });
        const preludeFn = machine.evalCode(PRELUDE_SOURCE, "prelude.js");
        const exported = machine.callFunction(preludeFn, machine.undefined, bridgeFn);
        api = {
          init: exported.getProp("init"),
          run: exported.getProp("run"),
          grant: exported.getProp("grant"),
          waiting: exported.getProp("waiting"),
        };
        const limitsJson = machine.newString(JSON.stringify(payload.limits));
        const stateJson = machine.newString(JSON.stringify(payload.state));
        machine.callFunction(api.init, machine.undefined, limitsJson, stateJson).dispose();
        limitsJson.dispose();
        stateJson.dispose();
        if (earlyCredits > 0) applyGrant(earlyCredits);
        earlyCredits = 0;
        let body: JSValueHandle;
        try {
          body = machine.evalCode(`(async function () {\n${payload.source}\n})`, "js_run.js");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return fatal("SCRIPT_SYNTAX", message);
        }
        root = machine.callFunction(api.run, machine.undefined, body);
        pump();
      } catch (error) {
        if (done) return;
        if (interrupted)
          return fatal(interrupted === "timeout" ? "TIMEOUT" : "CANCELLED", "interrupted");
        fatal("ISOLATE_FAILURE", error instanceof Error ? error.message : String(error));
      }
    };

    transport.onMessage((raw) => {
      if (done) return;
      const message = raw as { type?: string; payload?: Record<string, unknown> };
      try {
        switch (message.type) {
          case "start":
            if (started) return;
            started = true;
            void start(message.payload as unknown as StartPayload);
            return;
          case "result": {
            const payload = message.payload as {
              callId: number;
              ok: boolean;
              value?: unknown;
              error?: unknown;
            };
            const deferred = calls.get(payload.callId);
            if (!deferred || !vm) return;
            calls.delete(payload.callId);
            const value = vm.newString(JSON.stringify(payload.ok ? payload.value : payload.error));
            if (payload.ok) deferred.resolve(value);
            else deferred.reject(value);
            value.dispose();
            pump();
            return;
          }
          case "catalog.result": {
            const payload = message.payload as { requestId: number; entries: unknown[] };
            const deferred = catalogs.get(payload.requestId);
            if (!deferred || !vm) return;
            catalogs.delete(payload.requestId);
            const value = vm.newString(JSON.stringify(payload.entries));
            deferred.resolve(value);
            value.dispose();
            pump();
            return;
          }
          case "grant": {
            const payload = message.payload as { calls: number };
            if (!vm || !api) {
              earlyCredits += payload.calls;
              return;
            }
            applyGrant(payload.calls);
            pump();
            return;
          }
          default:
            return;
        }
      } catch (error) {
        if (interrupted)
          return fatal(interrupted === "timeout" ? "TIMEOUT" : "CANCELLED", "interrupted");
        fatal("ISOLATE_FAILURE", error instanceof Error ? error.message : String(error));
      }
    });

    send("ready", { engine: "javascript-quickjs", preludeHash: PRELUDE_HASH });
  });
}
