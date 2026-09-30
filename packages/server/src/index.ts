/**
 * @alisio/server: the local HTTP + SSE server behind `alisio serve`. Loaded only through a
 * dynamic `import("@alisio/server")`, so `alisio`, `alisio run` and the TUI never pay for it.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppOptions } from "@alisio/core";
import { AuthGuard, isLoopbackHost } from "./auth/guard.ts";
import { HttpError, toApiError } from "./http/errors.ts";
import { type RouteContext, Router } from "./http/router.ts";
import { StaticAssets } from "./http/static.ts";
import { createLogger, type Logger } from "./log.ts";
import { registerHealthRoutes, type ServerStats } from "./routes/health.ts";

export { isLoopbackHost } from "./auth/guard.ts";
export { HttpError } from "./http/errors.ts";
export { contentSecurityPolicy, PLACEHOLDER_HTML } from "./http/static.ts";
export { createLogger, type Logger, type LogLevel, logLevel } from "./log.ts";
export { PROTOCOL_VERSION } from "./routes/health.ts";

export interface ServerOptions {
  /** Bind address (default `127.0.0.1`). Anything but loopback requires `allowRemote`. */
  host?: string;
  /** Port; `0` picks a free one (default 4317). */
  port?: number;
  /** Required to bind a non-loopback address (no TLS; prefer an SSH tunnel). */
  allowRemote?: boolean;
  /** Launch token (a fresh 256-bit secret by default). */
  token?: string;
  /** Version reported by `/api/health` (the CLI passes its own). */
  version?: string;
  /** Directory with the web UI build (default: `dist/web` next to the server). */
  webRoot?: string;
  logger?: Logger;
  /**
   * Base options for every workspace `Application` (launch flags, builtins, prompts, db). The
   * policy flags are the capability ceiling of every web session.
   */
  app?: ServerAppOptions;
  /** Listed as a workspace even before it has sessions (the CLI passes its cwd). */
  defaultWorkspace?: string;
  /** Maximum workspace applications open at once (default 4). */
  maxOpenWorkspaces?: number;
  /** Maximum runs executing at once across all sessions (default 4). */
  maxConcurrentRuns?: number;
}

/** `AppOptions` minus what the server owns per workspace (cwd, events, approvals). */
export type ServerAppOptions = Omit<
  AppOptions,
  "cwd" | "onEvent" | "approve" | "approveExternalDirectory"
>;

export interface RunningServer {
  host: string;
  port: number;
  /** Base URL of the server, e.g. `http://127.0.0.1:4317`. */
  url: string;
  /** The launch token (exchanged once for the session cookie). */
  token: string;
  /** `url` plus `/?token=…`: what the CLI prints and opens. */
  launchUrl: string;
  /** Whether the web UI build is installed (otherwise a placeholder page is served). */
  webInstalled: boolean;
  close(): Promise<void>;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Security headers of §11.2 (the CSP comes from the served web build). */
function securityHeaders(res: ServerResponse, csp: string, api: boolean) {
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (api) res.setHeader("Cache-Control", "no-store");
}

/** Starts the server and resolves once it listens. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host) && !options.allowRemote)
    throw new Error(
      `Refusing to listen on ${host}: it is not a loopback address. Pass --allow-remote to expose the server on the network (no TLS; prefer an SSH tunnel).`,
    );
  const logger = options.logger ?? createLogger();
  const assets = new StaticAssets(options.webRoot);
  const router = new Router();
  let guard: AuthGuard | undefined;
  let closing = false;
  const stats = (): ServerStats => ({
    shuttingDown: closing,
    activeRuns: 0,
    queuedRuns: 0,
    openWorkspaces: 0,
    subscribers: 0,
    pendingApprovals: 0,
    sseDropped: 0,
  });
  registerHealthRoutes(router, {
    version: options.version ?? "dev",
    remote: !isLoopbackHost(host),
    stats,
  });
  const server = createServer((req, res) => void handle(req, res));

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now();
    const header = req.headers["x-request-id"];
    const correlationId =
      typeof header === "string" && REQUEST_ID.test(header) ? header : randomUUID();
    res.setHeader("X-Request-Id", correlationId);
    const url = new URL(req.url ?? "/", "http://localhost");
    const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
    securityHeaders(res, assets.csp, api);
    const method = req.method ?? "GET";
    try {
      if (!guard) throw new HttpError("shutting_down", "Server is not ready");
      guard.checkHost(req);
      guard.checkOrigin(req);
      if (!api) {
        if (method !== "GET" && method !== "HEAD") throw new HttpError("not_found", "Not found");
        const token = url.searchParams.get("token");
        if (url.pathname === "/" && token !== null) {
          if (!guard.validToken(token)) throw new HttpError("unauthorized", "Invalid token");
          res.writeHead(303, { Location: "/", "Set-Cookie": guard.sessionCookie() });
          res.end();
          return;
        }
        await assets.serve(res, url.pathname, method === "HEAD");
        return;
      }
      const matched = router.match(method, url.pathname);
      if (!matched) throw new HttpError("not_found", "Not found");
      const isHealth = url.pathname === "/api/health" && method === "GET";
      if (!isHealth && !guard.authenticated(req))
        throw new HttpError("unauthorized", "Open the launch URL printed by `alisio serve`");
      if (matched === "method") throw new HttpError("not_found", "Method not supported");
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        const type = String(req.headers["content-type"] ?? "")
          .split(";")[0]
          ?.trim();
        if (type !== "application/json")
          throw new HttpError("unsupported_media_type", "Content-Type must be application/json");
      }
      if (closing && !isHealth && url.pathname !== "/api/ready")
        throw new HttpError("shutting_down", "Server is shutting down");
      const ctx: RouteContext = { req, res, url, params: matched.params, correlationId };
      const result = await matched.handler(ctx);
      if (result) sendJson(res, result.status ?? 200, result.body);
    } catch (error) {
      const { status, body } = toApiError(error, correlationId);
      if (status === 500)
        logger.error("request failed", {
          correlationId,
          route: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        });
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    } finally {
      logger.debug("request", {
        correlationId,
        route: `${method} ${url.pathname}`,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4317, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  guard = new AuthGuard({ host, port, ...(options.token ? { token: options.token } : {}) });
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${displayHost.includes(":") ? `[${displayHost}]` : displayHost}:${port}`;
  return {
    host,
    port,
    url,
    token: guard.token,
    launchUrl: `${url}/?token=${guard.token}`,
    webInstalled: assets.installed,
    async close() {
      closing = true;
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** Writes a JSON response. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}
