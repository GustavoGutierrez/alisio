/**
 * @alisio/server: the local HTTP + SSE server behind `alisio serve`. Loaded only through a
 * dynamic `import("@alisio/server")`, so `alisio`, `alisio run` and the TUI never pay for it.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { BlobStore, SQLiteStore, stateHome } from "@alisio/core";
import type { ServerFrame } from "@alisio/sdk";
import { AuthGuard, isLoopbackHost } from "./auth/guard.ts";
import { ApprovalBridge } from "./bridges/approval-bridge.ts";
import { InteractionBridge } from "./bridges/interaction-bridge.ts";
import { createNativePicker, type FolderPicker } from "./host/folder-picker.ts";
import { RunScheduler } from "./host/run-scheduler.ts";
import { SessionService } from "./host/sessions.ts";
import { type ServerAppOptions, WorkspaceHost, workspaceId } from "./host/workspace-host.ts";
import { HttpError, toApiError } from "./http/errors.ts";
import { type RouteContext, Router } from "./http/router.ts";
import { StaticAssets } from "./http/static.ts";
import { createLogger, type Logger } from "./log.ts";
import { registerApprovalRoutes } from "./routes/approvals.ts";
import { registerBlobRoutes } from "./routes/blobs.ts";
import { registerCommandRoutes } from "./routes/commands.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerFolderRoutes } from "./routes/folders.ts";
import { registerHealthRoutes, type ServerStats } from "./routes/health.ts";
import { registerManagementRoutes, WorkspaceRecycler } from "./routes/management.ts";
import { registerPromptRoutes } from "./routes/prompts.ts";
import { registerProviderRoutes } from "./routes/providers.ts";
import { registerSessionViewRoutes } from "./routes/session-views.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { SseHub } from "./sse/hub.ts";
import { InflightTracker } from "./sse/inflight.ts";

export { isLoopbackHost } from "./auth/guard.ts";
export { ApprovalBridge } from "./bridges/approval-bridge.ts";
export { InteractionBridge } from "./bridges/interaction-bridge.ts";
export {
  createNativePicker,
  type FolderPicker,
  type PickerStrategy,
  selectPicker,
} from "./host/folder-picker.ts";
export {
  type Application,
  type OpenWorkspace,
  type ServerAppOptions,
  WorkspaceHost,
  workspaceId,
} from "./host/workspace-host.ts";
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
  /** Close a workspace app after this long without activity (default 10 min). */
  idleEvictMs?: number;
  /** SSE heartbeat interval (default 15 s). */
  heartbeatMs?: number;
  /** Delta coalescing window, clamped to 16–50 ms (default 33 ms). */
  coalesceMs?: number;
  /** Maximum concurrent event streams (default 16). */
  maxStreams?: number;
  /** Deny an approval when nobody watches its session for this long (default 30 s). */
  approvalGraceMs?: number;
  /** Deny an approval after this long even when watched (default 10 min; 0 = no limit). */
  approvalTimeoutMs?: number;
  /**
   * Native folder dialog for "Open a workspace" (default: detected for this OS). Injectable for
   * tests. Always off when the server is bound for remote access.
   */
  folderPicker?: FolderPicker;
}

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
  const base = options.app ?? {};
  // Server-level connection to the shared session database (lists, metadata, snapshots).
  const dbPath = base.db ?? join(stateHome(), "sessions.sqlite");
  const catalog = new SQLiteStore(dbPath);
  // The same content-addressed store every workspace app resolves attachments from.
  const blobs = new BlobStore({
    root: dbPath !== ":memory:" ? join(dirname(dbPath), "blobs") : join(stateHome(), "blobs"),
    db: catalog.db,
  });
  // Startup reconciliation (RNF-09): runs and child sessions left queued/running by a dead
  // process become interrupted before any client lists them.
  catalog.interruptRuns();
  catalog.interruptStale();
  let shutdown: Promise<void> | undefined;
  let sessions: SessionService | undefined;
  const inflight = new InflightTracker();
  let recycler: WorkspaceRecycler | undefined;
  const scheduler = new RunScheduler({
    ...(options.maxConcurrentRuns ? { maxConcurrent: options.maxConcurrentRuns } : {}),
    onChange: (job, status) => {
      if (status === "finished") {
        inflight.clear(job.sessionId, job.runId);
        // A deferred plugin change applies once the workspace has no runs left.
        setImmediate(() => recycler?.idle(job.workspaceId));
      } else inflight.mark(job.sessionId, job.runId, status);
      sessions?.notify(job.sessionId);
    },
  });
  const workspaceOf = (sessionId: string) => {
    try {
      return workspaceId(catalog.get(sessionId).workspace);
    } catch {
      return undefined;
    }
  };
  let approvals: ApprovalBridge | undefined;
  let interactions: InteractionBridge | undefined;
  const hub = new SseHub({
    onSubscribersChanged: () => {
      approvals?.subscribersChanged();
      interactions?.subscribersChanged();
    },
    snapshot: (sessionId) => {
      const service = sessions as SessionService;
      const session = service.get(sessionId);
      const current = inflight.get(sessionId);
      return {
        t: "snapshot",
        sessionId,
        cursor: catalog.lastEventId(sessionId),
        session: service.wire(session),
        messages: catalog.messagesPage(sessionId, { limit: 50 }),
        ...(current ? { inflight: current } : {}),
        pending: {
          approvals: approvals?.pending(sessionId) ?? [],
          interactions: interactions?.pending(sessionId) ?? [],
        },
      };
    },
    messagesAfter: (sessionId, after) => catalog.messagesPage(sessionId, { after, limit: 200 }),
    toolResult: (sessionId, callId) => catalog.callResult(sessionId, callId),
    workspaceOf,
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.coalesceMs ? { coalesceMs: options.coalesceMs } : {}),
  });
  const workspaces = new WorkspaceHost({
    base,
    catalog,
    wire: () => ({
      onEvent: (event) => {
        inflight.apply(event);
        hub.publish(event);
      },
      ...(approvals
        ? { approve: approvals.handler, approveExternalDirectory: approvals.directoryHandler }
        : {}),
    }),
    onOpen: (entry) => {
      if (interactions) entry.app.plugins.setInteractiveUI(interactions.uiFor(entry.id));
    },
    busy: (id) => scheduler.busyWorkspace(id) || hub.watchesWorkspace(id),
    ...(options.maxOpenWorkspaces ? { maxOpen: options.maxOpenWorkspaces } : {}),
    ...(options.idleEvictMs ? { idleEvictMs: options.idleEvictMs } : {}),
    ...(options.defaultWorkspace ? { defaultWorkspace: options.defaultWorkspace } : {}),
  });
  const sweeper = setInterval(
    () => void workspaces.sweep().catch(() => {}),
    Math.min(60_000, options.idleEvictMs ?? 60_000),
  );
  sweeper.unref();
  sessions = new SessionService({
    catalog,
    workspaces,
    scheduler,
    base,
    broadcast: (frame) => hub.broadcast(frame),
    awaitingInput: (root) => !!approvals?.awaiting(root) || !!interactions?.awaiting(root),
  });
  const service = sessions;
  approvals = new ApprovalBridge({
    hub,
    rootOf: (id) => service.rootOf(id),
    runOf: (id) => scheduler.job(id)?.runId,
    ...(options.approvalGraceMs !== undefined ? { graceMs: options.approvalGraceMs } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { timeoutMs: options.approvalTimeoutMs } : {}),
    onChange: (root) => service.notify(root),
  });
  interactions = new InteractionBridge({
    hub,
    rootOf: (id) => service.rootOf(id),
    workspaceOf,
    ...(options.approvalGraceMs !== undefined ? { graceMs: options.approvalGraceMs } : {}),
    ...(options.approvalTimeoutMs !== undefined ? { timeoutMs: options.approvalTimeoutMs } : {}),
    onOpen: (id) => service.notify(id),
    onChange: (root) => root && service.notify(root),
  });
  const stats = (): ServerStats => ({
    shuttingDown: closing,
    activeRuns: scheduler.counts().active,
    queuedRuns: scheduler.counts().queued,
    openWorkspaces: workspaces.openCount,
    subscribers: hub.size,
    pendingApprovals: approvals?.size ?? 0,
    sseDropped: hub.dropped,
  });
  // The dialog and the directory browser act on the server machine as the server user: only for
  // loopback, where the viewer is that user at that machine.
  const loopback = isLoopbackHost(host);
  const picker = loopback ? (options.folderPicker ?? createNativePicker()) : undefined;
  const pickerAbort = new AbortController();
  registerHealthRoutes(router, {
    version: options.version ?? "dev",
    remote: !loopback,
    stats,
    nativePicker: async () => !!picker && (await picker.available()),
    folderBrowser: loopback,
  });
  registerFolderRoutes(router, { picker, browser: loopback, signal: pickerAbort.signal });
  registerWorkspaceRoutes(router, { workspaces, catalog, scheduler });
  registerSessionRoutes(router, { catalog, workspaces, sessions, scheduler });
  registerSessionViewRoutes(router, { catalog, sessions });
  registerFileRoutes(router, { workspaces, catalog, sessions });
  registerBlobRoutes(router, { blobs });
  registerPromptRoutes(router, { sessions, scheduler });
  registerCommandRoutes(router, { sessions, scheduler, workspaces });
  registerApprovalRoutes(router, { approvals, interactions });
  const management = {
    workspaces,
    scheduler,
    base,
    broadcast: (frame: ServerFrame) => hub.broadcast(frame),
  };
  recycler = new WorkspaceRecycler(management);
  registerManagementRoutes(router, management, recycler);
  registerProviderRoutes(router, management, recycler);
  registerEventRoutes(router, {
    hub,
    sessions,
    ...(options.maxStreams ? { maxStreams: options.maxStreams } : {}),
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
      // Every write is JSON (it forces a CORS preflight) except the raw image upload, which
      // checks its own image content types (also non-safelisted, so also preflighted).
      const upload = method === "POST" && url.pathname === "/api/blobs";
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && !upload) {
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

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 4317, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(sweeper);
    catalog.close();
    throw error;
  }
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
    close() {
      shutdown ??= (async () => {
        // RNF-08: refuse new work (503), abort runs (queued ones are journaled cancelled),
        // withdraw approvals (deny), end the streams, close every app within the core's
        // per-stage teardown caps, then stop listening. Locks are released by the runner.
        const began = Date.now();
        closing = true;
        clearInterval(sweeper);
        pickerAbort.abort();
        const settling = scheduler.shutdown(2_000);
        approvals?.denyAll();
        interactions?.cancelAll();
        await settling;
        hub.closeAll();
        await workspaces.closeAll();
        await new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        });
        catalog.close();
        logger.info("server stopped", { ms: Date.now() - began });
      })();
      return shutdown;
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
