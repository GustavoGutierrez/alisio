import { isAbsolute } from "node:path";
import type { SQLiteStore, StoredEvent } from "@alisio/core";
import type { PermissionPresetId, RunEvent, SessionSummary } from "@alisio/sdk";
import { PRESET_IDS, presetInfo } from "../host/presets.ts";
import type { RunScheduler } from "../host/run-scheduler.ts";
import type { SessionService } from "../host/sessions.ts";
import type { WorkspaceHost } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, queryInt, validate } from "../schemas.ts";

export interface SessionRouteContext {
  catalog: SQLiteStore;
  workspaces: WorkspaceHost;
  sessions: SessionService;
  scheduler: RunScheduler;
}

/** A stored durable event as a `RunEvent` (in pages, `seq` is the global `events.seq`). */
export function storedToRunEvent(sessionId: string, event: StoredEvent): RunEvent {
  return {
    schemaVersion: 1,
    runId: event.runId,
    sessionId,
    seq: Number(event.eventId),
    type: event.type,
    timestamp: new Date(event.createdAt ?? 0).toISOString(),
    data: event.data,
    eventId: event.eventId,
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
  };
}

/** Sessions: list/create/read/patch (no delete: archive instead), messages, events, runs. */
export function registerSessionRoutes(router: Router, ctx: SessionRouteContext): void {
  const { catalog, sessions } = ctx;

  router.get("/api/sessions", ({ url }) => {
    const workspace = url.searchParams.get("workspace");
    // `?agent=<id>`: sessions started with (or switched to) that agent.
    const agent = url.searchParams.get("agent");
    const q = url.searchParams.get("q")?.trim().toLowerCase();
    const archived = url.searchParams.get("archived") ?? "false";
    if (!["true", "false", "all"].includes(archived))
      throw new HttpError("validation_failed", "Invalid query parameter", {
        fields: ["archived"],
      });
    const limit = queryInt(url, "limit", 50, 200) ?? 50;
    const offset = queryInt(url, "cursor", 0) ?? 0;
    const rows = catalog
      .list()
      .filter((session) => !agent || session.options?.agent === agent)
      .map((session) => sessions.summary(session))
      .filter(
        (s) =>
          (!workspace || s.workspaceId === workspace) &&
          (!q || (s.title ?? "").toLowerCase().includes(q) || s.id.startsWith(q)) &&
          (archived === "all" || s.archived === (archived === "true")),
      )
      .sort(bySidebarOrder);
    const items = rows.slice(offset, offset + limit);
    return {
      body: {
        items,
        ...(offset + limit < rows.length ? { next: String(offset + limit) } : {}),
      },
    };
  });

  router.post("/api/sessions", async ({ req }) => {
    const input = validate<{
      workspace: string;
      model?: string;
      agent?: string;
      preset?: PermissionPresetId;
      title?: string;
    }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096), required: true },
      model: { check: is.nonEmpty(300) },
      agent: { check: is.nonEmpty(200) },
      preset: { check: is.oneOf(PRESET_IDS) },
      title: { check: is.string(200) },
    });
    if (input.preset && !presetInfo(input.preset, sessions.ceiling).available)
      throw new HttpError("capability_ceiling", "Preset not available under the server flags");
    const path = isAbsolute(input.workspace)
      ? await ctx.workspaces.canonical(input.workspace)
      : await ctx.workspaces.pathOf(input.workspace);
    if (!path) throw new HttpError("not_found", "Workspace not found");
    if (ctx.workspaces.archived(path))
      throw new HttpError(
        "workspace_archived",
        `Workspace ${path} is archived; unarchive it to start new sessions`,
        { path },
      );
    const opened = await ctx.workspaces.openPath(path);
    let created: Awaited<ReturnType<typeof opened.app.createSession>>;
    try {
      created = await opened.app.createSession(input.model);
    } catch (error) {
      throw new HttpError(
        "validation_failed",
        error instanceof Error ? error.message : "Model is not available",
        { fields: ["model"] },
      );
    }
    catalog.updateSessionMeta(created.id, {
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      options: {
        ...(input.preset ? { preset: input.preset } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      },
    });
    sessions.notify(created.id);
    return { status: 201, body: sessions.detail(sessions.get(created.id)) };
  });

  router.get("/api/sessions/:sid", ({ params }) => ({
    body: sessions.detail(sessions.get(params.sid ?? "")),
  }));

  router.patch("/api/sessions/:sid", async ({ req, params }) => {
    const session = sessions.get(params.sid ?? "");
    const patch = validate<{
      title?: string | null;
      model?: string;
      effort?: string | null;
      preset?: PermissionPresetId;
      agent?: string | null;
      pinned?: boolean;
      archived?: boolean;
    }>(await readJson(req), {
      title: { check: is.nullableString(200) },
      model: { check: is.nonEmpty(300) },
      effort: { check: is.nullableString(50) },
      preset: { check: is.oneOf(PRESET_IDS) },
      agent: { check: is.nullableString(200) },
      pinned: { check: is.boolean() },
      archived: { check: is.boolean() },
    });
    if (patch.preset && !presetInfo(patch.preset, sessions.ceiling).available)
      throw new HttpError("capability_ceiling", "Preset not available under the server flags");
    if (patch.model !== undefined && patch.model !== session.model) {
      if (ctx.scheduler.busy(session.id))
        throw new HttpError("session_busy", "Cannot change the model while a run is active");
      const { app } = await sessions.app(session);
      // Changing the model re-binds the session to the provider that owns it: the persisted
      // transcript is provider-neutral, so a model of the now-active provider is usable even when
      // the session's original provider is gone (no fresh session needed).
      try {
        await app.rebindSession(session.id, patch.model);
      } catch (error) {
        throw new HttpError(
          "validation_failed",
          error instanceof Error ? error.message : String(error),
          {
            fields: ["model"],
          },
        );
      }
    }
    const options: Record<string, unknown> = {};
    if (patch.effort !== undefined) options.effort = patch.effort ?? undefined;
    if (patch.agent !== undefined) options.agent = patch.agent ?? undefined;
    if (patch.preset !== undefined) options.preset = patch.preset;
    catalog.updateSessionMeta(session.id, {
      ...(patch.title !== undefined ? { title: patch.title?.trim() || null } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      ...(Object.keys(options).length ? { options } : {}),
    });
    if (patch.preset !== undefined) sessions.resetPolicy(session.id);
    sessions.notify(session.id);
    if (Object.keys(options).length) sessions.optionsChanged(session.id);
    return { body: sessions.detail(sessions.get(session.id)) };
  });

  router.get("/api/sessions/:sid/messages", ({ params, url }) => {
    const session = sessions.get(params.sid ?? "");
    const before = queryInt(url, "before", undefined);
    const after = queryInt(url, "after", undefined);
    const page = catalog.messagesPage(session.id, {
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      limit: queryInt(url, "limit", 50, 1000) ?? 50,
      compacted: url.searchParams.get("includeCompacted") === "true",
    });
    return { body: page };
  });

  router.get("/api/sessions/:sid/events", ({ params, url }) => {
    const session = sessions.get(params.sid ?? "");
    const types = url.searchParams.get("types")?.split(",").filter(Boolean);
    const page = catalog.eventsPage(session.id, {
      after: queryInt(url, "after", 0) ?? 0,
      limit: queryInt(url, "limit", 200, 5000) ?? 200,
    });
    const last = page.items.at(-1);
    return {
      body: {
        items: page.items
          .filter((event) => !types?.length || types.includes(event.type))
          .map((event) => storedToRunEvent(session.id, event)),
        ...(page.hasMore && last ? { next: last.eventId } : {}),
      },
    };
  });

  router.get("/api/sessions/:sid/runs", ({ params, url }) => {
    const session = sessions.get(params.sid ?? "");
    return { body: catalog.runs(session.id, { limit: queryInt(url, "limit", 20, 500) ?? 20 }) };
  });
}

/** Pinned first, then most recently updated; sessions without `updatedAt` last. */
function bySidebarOrder(a: SessionSummary, b: SessionSummary): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return (b.updatedAt ?? -1) - (a.updatedAt ?? -1);
}
