/**
 * Full self-test of an isolate host (`alisio forge status`, spec D17): starts a real isolate, runs
 * `return 1` through the whole protocol and checks the answer. Rejects with the reason otherwise.
 */
import { DEFAULT_FORGE_LIMITS } from "../limits.ts";
import type { IsolateHost } from "../ports.ts";
import { PRELUDE_HASH } from "./prelude.ts";
import { FORGE_PROTOCOL_VERSION } from "./runtime-manifest.ts";

export async function probeIsolate(
  host: IsolateHost,
  _module: WebAssembly.Module,
  timeoutMs = 10_000,
): Promise<void> {
  const session = host.start();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the isolate did not answer in time")),
        timeoutMs,
      );
      const done = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      session.onStreamError((reason) => done(new Error(reason)));
      void session.exited.then((exit) =>
        done(new Error(`the isolate exited early (${exit.error ?? `code ${String(exit.code)}`})`)),
      );
      session.onMessage((raw) => {
        const message = raw as { type?: string; payload?: Record<string, unknown> };
        if (message.type === "ready") {
          if (message.payload?.preludeHash !== PRELUDE_HASH)
            return done(new Error("the isolate runs an unexpected prelude"));
          const { timeoutMs: _t, ...rest } = DEFAULT_FORGE_LIMITS;
          session.send({
            protocol: FORGE_PROTOCOL_VERSION,
            type: "start",
            seq: 0,
            payload: {
              source: "return 1",
              state: {},
              limits: { ...rest, timeoutMs },
              catalogSize: 0,
            },
          });
        } else if (message.type === "complete") {
          const value = (message.payload as { value?: unknown }).value;
          done(value === 1 ? undefined : new Error("the isolate answered something else"));
        } else if (message.type === "fatal") {
          done(new Error(String(message.payload?.message ?? "the isolate failed")));
        }
      });
    });
  } finally {
    await session.stop("limit_exceeded");
  }
}
