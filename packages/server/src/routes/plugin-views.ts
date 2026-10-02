import { ViewRunError } from "@alisio/core";
import type { SessionService } from "../host/sessions.ts";
import { type WorkspaceHost, workspaceId } from "../host/workspace-host.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import type { Logger } from "../log.ts";

/** Defaults; both can be lowered through `ServerOptions.views` (tests, constrained hosts). */
export const VIEW_TIMEOUT_MS = 5_000;
export const VIEW_MAX_BYTES = 1024 * 1024;
const MAX_PARAMS = 16;
const MAX_KEY = 64;
const MAX_VALUE = 512;
/** One message for every "no such view" reason, so a probe cannot tell which plugins exist. */
const NOT_FOUND = "View not found";

export interface PluginViewRouteContext {
  sessions: SessionService;
  workspaces: WorkspaceHost;
  logger: Logger;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Plugin data views: `GET /api/sessions/:sid/views/:plugin/:view?<params>`. Views are read-only
 * BY CONTRACT (a plugin is not a sandbox); the server enforces what it can: GET only, the same
 * auth/Host/Origin rules as every `/api` route, enabled plugins only, validated parameters, a
 * timeout and a response size cap. Parameters and results are never logged (they may carry
 * sensitive project data such as memory).
 */
export function registerPluginViewRoutes(router: Router, ctx: PluginViewRouteContext): void {
  const { sessions, workspaces, logger } = ctx;
  const timeoutMs = ctx.timeoutMs ?? VIEW_TIMEOUT_MS;
  const maxBytes = ctx.maxBytes ?? VIEW_MAX_BYTES;

  router.get("/api/sessions/:sid/views/:plugin/:view", async ({ url, params, correlationId }) => {
    const session = sessions.get(params.sid ?? "");
    // The session's workspace must be one this server knows (and its folder must still exist).
    if (!(await workspaces.pathOf(workspaceId(session.workspace))))
      throw new HttpError("not_found", "Session not found");
    const opened = await sessions.app(session);
    const plugin = params.plugin ?? "";
    const view = params.view ?? "";
    const entry = opened.app.pluginCatalog().find((p) => p.id === plugin);
    // `enabled` follows the user's choice at once; a plugin disabled while it still runs
    // (`restart-required`) must stop answering immediately.
    if (!entry?.enabled || !opened.app.plugins.viewsOf(plugin).some((v) => v.id === view))
      throw new HttpError("not_found", NOT_FOUND);

    const query: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of url.searchParams) {
      if (++count > MAX_PARAMS || key.length > MAX_KEY || value.length > MAX_VALUE)
        throw new HttpError("validation_failed", "Invalid view parameters", {
          fields: ["(query)"],
        });
      if (key in query)
        throw new HttpError("validation_failed", "Invalid view parameters", { fields: [key] });
      query[key] = value;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("View timed out"));
        reject(new HttpError("view_timeout", "The view took too long"));
      }, timeoutMs);
    });
    let data: unknown;
    try {
      data = await Promise.race([
        opened.app.plugins.runView(plugin, view, query, {
          sessionId: session.id,
          workspace: session.workspace,
          signal: controller.signal,
        }),
        expired,
      ]);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (controller.signal.aborted) throw new HttpError("view_timeout", "The view took too long");
      if (error instanceof ViewRunError) {
        if (error.code === "not_found") throw new HttpError("not_found", NOT_FOUND);
        if (error.code === "invalid_params")
          throw new HttpError(
            "validation_failed",
            error.message,
            error.fields.length ? { fields: error.fields } : undefined,
          );
        // Only the error class is logged: its message may quote data the view was reading.
        logger.warn("plugin view failed", {
          correlationId,
          sessionId: session.id,
          plugin,
          view,
          error: error.cause instanceof Error ? error.cause.name : "unknown",
        });
        throw new HttpError("view_failed", "The view failed");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const text = JSON.stringify(data ?? null);
    if (Buffer.byteLength(text) > maxBytes)
      throw new HttpError("view_too_large", "The view answered more than the server allows");
    return { body: JSON.parse(text) };
  });
}
