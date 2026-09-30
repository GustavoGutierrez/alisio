/**
 * @alisio/server: the local HTTP + SSE server behind `alisio serve`. Loaded only through a
 * dynamic `import("@alisio/server")`, so `alisio`, `alisio run` and the TUI never pay for it.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpError, toApiError } from "./http/errors.ts";
import { type RouteContext, Router } from "./http/router.ts";
import { createLogger, type Logger } from "./log.ts";

export { HttpError } from "./http/errors.ts";
export { createLogger, type Logger, type LogLevel, logLevel } from "./log.ts";

export interface ServerOptions {
  /** Bind address (default `127.0.0.1`). */
  host?: string;
  /** Port; `0` picks a free one (default 4317). */
  port?: number;
  logger?: Logger;
}

export interface RunningServer {
  host: string;
  port: number;
  /** Base URL of the server, e.g. `http://127.0.0.1:4317`. */
  url: string;
  close(): Promise<void>;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Starts the server and resolves once it listens. */
export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const logger = options.logger ?? createLogger();
  const router = new Router();
  const server = createServer((req, res) => void handle(req, res));

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now();
    const header = req.headers["x-request-id"];
    const correlationId =
      typeof header === "string" && REQUEST_ID.test(header) ? header : randomUUID();
    res.setHeader("X-Request-Id", correlationId);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const matched = router.match(req.method ?? "GET", url.pathname);
      if (!matched) throw new HttpError("not_found", "Not found");
      if (matched === "method") throw new HttpError("not_found", "Method not supported");
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
        route: `${req.method} ${url.pathname}`,
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
  return {
    host,
    port,
    url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
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
