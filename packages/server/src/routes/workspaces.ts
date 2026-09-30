import { isAbsolute } from "node:path";
import type { WorkspaceHost } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";

/** `GET/POST /api/workspaces`, `PATCH /api/workspaces/:wid`. */
export function registerWorkspaceRoutes(
  router: Router,
  ctx: { workspaces: WorkspaceHost; catalog: import("@alisio/core").SQLiteStore },
): void {
  router.get("/api/workspaces", async () => ({ body: await ctx.workspaces.list() }));

  router.post("/api/workspaces", async ({ req }) => {
    const { path } = validate<{ path: string }>(await readJson(req), {
      path: { check: is.nonEmpty(4096), required: true },
    });
    if (!isAbsolute(path))
      throw new HttpError("validation_failed", "path must be absolute", { fields: ["path"] });
    const canonical = await ctx.workspaces.canonical(path);
    const opened = await ctx.workspaces.openPath(canonical);
    return { body: await ctx.workspaces.info(opened.path) };
  });

  router.patch("/api/workspaces/:wid", async ({ req, params }) => {
    const patch = validate<{ label?: string | null; pinned?: boolean }>(await readJson(req), {
      label: { check: is.nullableString(200) },
      pinned: { check: is.boolean() },
    });
    const path = await ctx.workspaces.pathOf(params.wid ?? "");
    if (!path) throw new HttpError("not_found", "Workspace not found");
    ctx.catalog.recordWorkspace(path, {
      ...(patch.label !== undefined ? { label: patch.label?.trim() || null } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    });
    return { body: await ctx.workspaces.info(path) };
  });
}
