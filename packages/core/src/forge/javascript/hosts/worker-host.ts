/**
 * `WorkerIsolateHost` (spec §6.3, D-20, D-21): the VM runs in a `node:worker_threads` worker.
 *
 * Stopping a worker never depends on the guest listening: the parent sets the shared flag the
 * guest's interrupt handler reads (value 1 = cancelled, 2 = deadline); if the worker has not left
 * 50 ms later it is terminated, and the stop is only "confirmed" when the `exit` event is seen.
 * `terminate()` stops a WASM loop on Node (~1 ms, measured); on Bun it does not, which is why Bun
 * uses the process host.
 */
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  IsolateExit,
  IsolateHost,
  IsolateSession,
  TerminationReason,
  TerminationReport,
} from "../../ports.ts";
import type { WorkerIsolateData } from "./isolate-main.ts";

export const WORKER_TERMINATE_AFTER_MS = 50;
/** How long to wait for `exit` after `terminate()` before reporting the stop as unconfirmed. */
const EXIT_CONFIRM_MS = 2_000;

/** The worker entry next to this file: `.ts` when running from sources, `.js` from `dist`. */
export function workerEntryUrl(base: string = import.meta.url): URL {
  const extension = base.endsWith(".ts") ? "ts" : "js";
  return new URL(`./worker-entry.${extension}`, base);
}

export interface WorkerHostOptions {
  module: WebAssembly.Module;
  /** Overrides the entry (tests of failure paths). */
  entry?: URL;
  terminateAfterMs?: number;
}

export class WorkerIsolateHost implements IsolateHost {
  readonly kind = "worker" as const;
  readonly #options: WorkerHostOptions;

  constructor(options: WorkerHostOptions) {
    this.#options = options;
  }

  start(): IsolateSession {
    const flagBuffer = new SharedArrayBuffer(4);
    const flag = new Int32Array(flagBuffer);
    const data: WorkerIsolateData = {
      forgeIsolate: 1,
      module: this.#options.module,
      flag: flagBuffer,
    };
    const worker = new Worker(this.#options.entry ?? workerEntryUrl(), {
      workerData: data,
      env: {},
      stdout: true,
      stderr: true,
    });
    // Nothing the guest prints reaches the parent's streams.
    worker.stdout.resume();
    worker.stderr.resume();
    let messageHandler: (raw: unknown) => void = () => {};
    let exitState: IsolateExit | undefined;
    let workerError: string | undefined;
    const exited = new Promise<IsolateExit>((resolve) => {
      worker.once("exit", (code) => {
        exitState = { code, signal: null, ...(workerError ? { error: workerError } : {}) };
        resolve(exitState);
      });
    });
    worker.on("message", (raw: unknown) => messageHandler(raw));
    worker.on("error", (error: Error) => {
      workerError = error.message;
    });
    const terminateAfter = this.#options.terminateAfterMs ?? WORKER_TERMINATE_AFTER_MS;

    return {
      kind: "worker",
      onMessage(handler) {
        messageHandler = handler;
      },
      onStreamError() {
        // Structured clone cannot deliver a malformed frame.
      },
      send(message) {
        if (!exitState) worker.postMessage(message);
      },
      exited,
      async stop(reason: TerminationReason): Promise<TerminationReport> {
        const started = performance.now();
        if (exitState) return { confirmed: true, method: "interrupt", elapsedMs: 0 };
        Atomics.store(flag, 0, reason === "timeout" ? 2 : 1);
        Atomics.notify(flag, 0);
        let method: TerminationReport["method"] = "interrupt";
        const timer = setTimeout(() => {
          method = "terminate";
          void worker.terminate();
        }, terminateAfter);
        let confirmTimer: ReturnType<typeof setTimeout> | undefined;
        const confirmed = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => {
            confirmTimer = setTimeout(() => resolve(false), terminateAfter + EXIT_CONFIRM_MS);
          }),
        ]);
        clearTimeout(timer);
        clearTimeout(confirmTimer);
        return {
          confirmed,
          method,
          elapsedMs: Math.round(performance.now() - started),
          ...(confirmed ? {} : { settled: exited.then(() => undefined) }),
        };
      },
    };
  }
}

/** Path of the worker entry, for diagnostics. */
export const workerEntryPath = (): string => fileURLToPath(workerEntryUrl());
