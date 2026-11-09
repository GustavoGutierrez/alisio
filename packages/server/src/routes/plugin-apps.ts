import { randomBytes } from "node:crypto";
import { PluginAppError } from "@alisio/core";
import { PLUGIN_APP_LIMITS, type PluginAppInfo } from "@alisio/sdk";
import type { ApprovalBridge } from "../bridges/approval-bridge.ts";
import type { SessionService } from "../host/sessions.ts";
import { type WorkspaceHost, workspaceId } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import type { Logger } from "../log.ts";

/** One message for every "no such app" reason, so a probe cannot tell which plugins exist. */
const NOT_FOUND = "App not found";
const NONCE_MARKER = "__ALISIO_NONCE__";
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const KEY_MAX = 128;

export interface PluginAppRouteContext {
  sessions: SessionService;
  workspaces: WorkspaceHost;
  logger: Logger;
  /** Where "ask" decisions of app actions are put to the person (same as chat tool approvals). */
  approvals?: ApprovalBridge;
  /** Lowered in tests. */
  limits?: Partial<{ htmlBytes: number; requestBytes: number; resultBytes: number }>;
  actionTimeoutMs?: number;
}

/** CSP of an app frame: no network, only data/blob assets, nonce-gated scripts, same-origin framing. */
export function appFrameCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data: blob:",
    "media-src data: blob:",
    "connect-src blob:",
    "worker-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
    // Also opaque-origin when the URL is opened directly (the iframe attribute does the same).
    "sandbox allow-scripts allow-downloads allow-modals allow-popups",
  ].join("; ");
}

/**
 * Plugin apps: the workspace catalog, the app HTML (`.../frame`) and validated actions. Same
 * auth/Host/Origin rules as every `/api` route. Plugin enablement is re-checked on every request;
 * inputs and results are never logged. Backend plugins stay trusted in-process code: the frame's
 * browser sandbox is not a Node sandbox.
 */
export function registerPluginAppRoutes(router: Router, ctx: PluginAppRouteContext): void {
  const { sessions, workspaces, logger } = ctx;
  const limits = { ...PLUGIN_APP_LIMITS, ...ctx.limits };

  /** The session's open app after the enabled check, or a uniform 404. */
  const resolve = async (sid: string | undefined, plugin: string, app: string) => {
    const session = sessions.get(sid ?? "");
    if (!(await workspaces.pathOf(workspaceId(session.workspace))))
      throw new HttpError("not_found", "Session not found");
    const opened = await sessions.app(session);
    const entry = opened.app.pluginCatalog().find((p) => p.id === plugin);
    // `enabled` follows the user's choice at once, even while the plugin still runs.
    if (!entry?.enabled || !opened.app.plugins.apps.has(plugin, app))
      throw new HttpError("not_found", NOT_FOUND);
    return { session, opened };
  };

  router.get("/api/workspaces/:wid/apps", async ({ params }) => {
    const path = await workspaces.pathOf(params.wid ?? "");
    if (!path) throw new HttpError("not_found", "Workspace not found");
    const opened = await workspaces.openPath(path);
    const apps: PluginAppInfo[] = [];
    for (const entry of opened.app.pluginCatalog())
      if (entry.enabled) apps.push(...opened.app.plugins.apps.appsOf(entry.id));
    return { body: apps };
  });

  router.get("/api/sessions/:sid/apps/:plugin/:app/frame", async ({ res, params }) => {
    const plugin = params.plugin ?? "";
    const app = params.app ?? "";
    const { opened } = await resolve(params.sid, plugin, app);
    let html: string;
    try {
      html = await opened.app.plugins.apps.html(plugin, app);
    } catch (error) {
      if (error instanceof PluginAppError && error.code === "not_found")
        throw new HttpError("not_found", NOT_FOUND);
      logger.warn("plugin app failed to load", { plugin, app });
      throw new HttpError("app_action_failed", "The app could not be loaded");
    }
    const nonce = randomBytes(18).toString("base64");
    const body = Buffer.from(html.split(NONCE_MARKER).join(nonce), "utf8");
    if (Buffer.byteLength(html) > limits.htmlBytes || body.length > limits.htmlBytes)
      throw new HttpError("app_result_too_large", "The app is larger than the server allows");
    // The app's global `X-Frame-Options: DENY` is replaced by `frame-ancestors 'self'` in the CSP.
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Content-Security-Policy": appFrameCsp(nonce),
      "Cache-Control": "no-store",
    });
    res.end(body);
    return undefined;
  });

  router.post(
    "/api/sessions/:sid/apps/:plugin/:app/actions/:action",
    async ({ req, res, params, correlationId }) => {
      const plugin = params.plugin ?? "";
      const app = params.app ?? "";
      const action = params.action ?? "";
      if (!ACTION_NAME.test(action)) throw new HttpError("not_found", NOT_FOUND);
      const { session, opened } = await resolve(params.sid, plugin, app);
      const body = await readJson(req, limits.requestBytes);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new HttpError("validation_failed", "Invalid request", { fields: ["(body)"] });
      const { input, idempotencyKey } = body as { input?: unknown; idempotencyKey?: unknown };
      if (
        idempotencyKey !== undefined &&
        (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > KEY_MAX)
      )
        throw new HttpError("validation_failed", "Invalid request", {
          fields: ["idempotencyKey"],
        });
      // Re-check: the body read may have taken a while and the plugin may be disabled by now.
      const entry = opened.app.pluginCatalog().find((p) => p.id === plugin);
      if (!entry?.enabled) throw new HttpError("not_found", NOT_FOUND);
      const abort = new AbortController();
      res.once("close", () => {
        if (!res.writableFinished) abort.abort(new Error("Client closed the request"));
      });
      const livePolicy = sessions.policy(session);
      let result: unknown;
      try {
        result = await opened.app.plugins.apps.run(
          plugin,
          app,
          action,
          input ?? {},
          {
            sessionId: session.id,
            workspace: session.workspace,
            signal: abort.signal,
            ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
          },
          {
            policy: livePolicy.policy,
            approvals: livePolicy.approvals,
            ...(ctx.approvals
              ? {
                  approve: (request) =>
                    ctx.approvals?.askApp({
                      sessionId: session.id,
                      app: {
                        plugin,
                        pluginName: entry.name,
                        app,
                        label: request.label,
                        action: request.action,
                      },
                      effect: request.effect,
                      signal: request.signal,
                    }) ?? Promise.resolve("deny" as const),
                }
              : {}),
            ...(ctx.actionTimeoutMs ? { timeoutMs: ctx.actionTimeoutMs } : {}),
          },
        );
      } catch (error) {
        if (!(error instanceof PluginAppError)) throw error;
        if (error.code === "not_found") throw new HttpError("not_found", NOT_FOUND);
        if (error.code === "invalid_input")
          throw new HttpError("validation_failed", "Invalid action input");
        if (error.code === "not_permitted")
          throw new HttpError(
            "app_action_denied",
            "The session does not allow this action",
            error.effect ? { effect: error.effect } : undefined,
          );
        if (error.code === "timeout")
          throw new HttpError("app_action_timeout", "The action took too long");
        // Only the error class is logged: its message may quote the data it was handling.
        logger.warn("plugin app action failed", {
          correlationId,
          sessionId: session.id,
          plugin,
          app,
          action,
          error: error.cause instanceof Error ? error.cause.name : "unknown",
        });
        throw new HttpError("app_action_failed", "The action failed");
      }
      const text = `{"result":${JSON.stringify(result ?? null)}}`;
      if (Buffer.byteLength(text) > limits.resultBytes)
        throw new HttpError(
          "app_result_too_large",
          "The action answered more than the server allows",
        );
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
      });
      res.end(text);
      return undefined;
    },
  );
}
