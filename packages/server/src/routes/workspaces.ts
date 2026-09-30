import { isAbsolute } from "node:path";
import type { SQLiteStore } from "@alisio/core";
import type { RunScheduler } from "../host/run-scheduler.ts";
import type { WorkspaceHost } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";

/** `GET/POST /api/workspaces`, `PATCH /api/workspaces/:wid`. */
export function registerWorkspaceRoutes(
  router: Router,
  ctx: { workspaces: WorkspaceHost; catalog: SQLiteStore; scheduler: RunScheduler },
): void {
  router.get("/api/workspaces", async ({ url }) => {
    // Same semantics as `GET /api/sessions`: archived ones are hidden unless asked for.
    const archived = url.searchParams.get("archived") ?? "false";
    if (archived !== "true" && archived !== "false" && archived !== "all")
      throw new HttpError("validation_failed", "Invalid query parameter", {
        fields: ["archived"],
      });
    return { body: await ctx.workspaces.list(archived) };
  });

  router.post("/api/workspaces", async ({ req }) => {
    const { path } = validate<{ path: string }>(await readJson(req), {
      path: { check: is.nonEmpty(4096), required: true },
    });
    if (!isAbsolute(path))
      throw new HttpError("validation_failed", "path must be absolute", { fields: ["path"] });
    const canonical = await ctx.workspaces.canonical(path);
    // Opening a folder explicitly is the user asking for it back: it leaves the archive.
    if (ctx.workspaces.archived(canonical))
      ctx.catalog.recordWorkspace(canonical, { archived: false });
    const opened = await ctx.workspaces.openPath(canonical);
    return { body: await ctx.workspaces.info(opened.path) };
  });

  router.patch("/api/workspaces/:wid", async ({ req, params }) => {
    const patch = validate<{ label?: string | null; pinned?: boolean; archived?: boolean }>(
      await readJson(req),
      {
        label: { check: is.nullableString(200) },
        pinned: { check: is.boolean() },
        archived: { check: is.boolean() },
      },
    );
    const id = params.wid ?? "";
    const path = await ctx.workspaces.pathOf(id);
    if (!path) throw new HttpError("not_found", "Workspace not found");
    if (patch.archived) {
      if (ctx.scheduler.busyWorkspace(id))
        throw new HttpError(
          "runs_active",
          "Wait for the workspace's runs to finish, then archive it",
        );
      // Sessions are kept (and stay readable); only the idle application is released.
      await ctx.workspaces.close(id);
    }
    // Upserts: a workspace known only from its sessions gets a row here.
    ctx.catalog.recordWorkspace(path, {
      ...(patch.label !== undefined ? { label: patch.label?.trim() || null } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    });
    return { body: await ctx.workspaces.info(path) };
  });
}
