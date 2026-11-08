import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderAuthLoopback, ProviderAuthLoopbackOptions } from "@alisio/sdk";

/** Longest life of a listener, and the default: a sign-in not finished by then is over (D2). */
export const LOOPBACK_MAX_MS = 900_000;

/** Failure of the loopback helper; `code` is a stable string. */
export class LoopbackError extends Error {
  constructor(
    readonly code: "loopback_unavailable" | "loopback_timeout" | "loopback_closed",
    message: string,
  ) {
    super(message);
    this.name = "LoopbackError";
  }
}

export interface OpenLoopbackOptions extends ProviderAuthLoopbackOptions {
  /** Closes the listener and rejects `wait()` when it aborts (the flow's signal). */
  signal?: AbortSignal;
}

/** Fixed pages: nothing the request carried is ever echoed back (the URL holds the code). */
const PAGE = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
  `<body style="font-family:system-ui,sans-serif;margin:3rem"><h1>${title}</h1><p>${text}</p></body></html>`;
const SUCCESS = PAGE("Signed in", "You can close this tab and return to Alisio.");
const REJECTED = PAGE("Request rejected", "This sign-in link is not valid. Return to Alisio.");

/** Digest comparison in constant time: the length of the state never shows in the timing. */
function sameState(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function reply(
  res: ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    Connection: "close",
    ...extra,
  });
  return new Promise<void>((resolve) => res.end(body, resolve));
}

/**
 * Starts the one-shot callback listener a sign-in method redirects to (D2, §5.6). It binds
 * `127.0.0.1` only (never a wildcard or `::1`), serves exactly one matching `GET`, checks `state`
 * in constant time and closes after that use. A request with a missing or different `state` gets
 * 400 and consumes nothing: there is deliberately no failure cap, since a cap would let any local
 * process shut the listener down with bad requests (F8). It ends on its own after `timeoutMs`
 * (at most 15 minutes), when the signal aborts or on `close()`. The host validates `state` only;
 * the PKCE verifier stays with the plugin.
 */
export async function openLoopback(options: OpenLoopbackOptions): Promise<ProviderAuthLoopback> {
  const { port, path, state, signal } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new TypeError("loopback: port must be an integer between 0 and 65535");
  if (typeof path !== "string" || !path.startsWith("/") || /[?#]/.test(path))
    throw new TypeError("loopback: path must start with / and carry no query or fragment");
  if (typeof state !== "string" || state.length === 0)
    throw new TypeError("loopback: state must be a non-empty string");
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  const timeoutMs = Math.min(
    Math.max(1, Math.floor(options.timeoutMs ?? LOOPBACK_MAX_MS)),
    LOOPBACK_MAX_MS,
  );
  const redirectHost = options.redirectHost ?? "127.0.0.1";

  // Loaded on first use: every CLI start imports this module through the core index, and the
  // zero-overhead startup test (T-12) requires that `node:http` is not loaded by then.
  const { createServer } = await import("node:http");
  const server = createServer();
  let used = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let settle!: { resolve(value: Record<string, string>): void; reject(error: unknown): void };
  const waited = new Promise<Record<string, string>>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Nobody may be awaiting `wait()` when the listener ends: that is not an unhandled rejection.
  waited.catch(() => {});

  /** Stops listening at once and drops open connections; idempotent. */
  const shut = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    void shut().then(() => {
      server.closeAllConnections();
      settle.reject(error);
    });
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        new LoopbackError(
          "loopback_unavailable",
          `The loopback listener could not start (${error.code ?? "error"})`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  server.on("error", () => {});
  const actual = (server.address() as AddressInfo).port;

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const host = String(req.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${actual}` && host !== `localhost:${actual}`)
        return void (await reply(res, 400, REJECTED));
      if (req.method !== "GET") return void (await reply(res, 405, REJECTED, { Allow: "GET" }));
      let url: URL;
      try {
        url = new URL(req.url ?? "/", `http://127.0.0.1:${actual}`);
      } catch {
        return void (await reply(res, 400, REJECTED));
      }
      if (url.pathname !== path) return void (await reply(res, 404, REJECTED));
      const states = url.searchParams.getAll("state");
      if (states.length !== 1 || !sameState(states[0] as string, state))
        return void (await reply(res, 400, REJECTED));
      if (used) return void (await reply(res, 410, REJECTED));
      used = true;
      finished = true;
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) if (!(key in params)) params[key] = value;
      // Stop accepting connections before answering: a second callback finds the port closed.
      const closed = shut();
      await reply(res, 200, SUCCESS);
      await closed;
      server.closeAllConnections();
      settle.resolve(params);
    })().catch(() => res.destroy());
  });

  timer = setTimeout(
    () => fail(new LoopbackError("loopback_timeout", "The loopback listener timed out")),
    timeoutMs,
  );
  timer.unref?.();
  if (signal) {
    onAbort = () => fail(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    redirectUri: `http://${redirectHost}:${actual}${path}`,
    wait: () => waited,
    close: () => fail(new LoopbackError("loopback_closed", "The loopback listener was closed")),
  };
}
