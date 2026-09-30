import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { listDirectories } from "../host/dir-listing.ts";
import type { FolderPicker } from "../host/folder-picker.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";

export interface FolderRouteOptions {
  /** Native dialog; `undefined` when disabled (remote bind). */
  picker: FolderPicker | undefined;
  /** In-app folder browser (directory names of the server user); loopback only. */
  browser: boolean;
  /** Aborted on shutdown: closes an open dialog. */
  signal: AbortSignal;
}

const TITLE = "Open a workspace — Alisio";

/**
 * `POST /api/workspaces/pick` (native OS folder dialog on the server's desktop) and
 * `GET /api/fs/dirs` (subdirectory names for the in-app browser). Both only exist for a loopback
 * server: the dialog opens on the machine running `alisio serve`, and the browser exposes the
 * server user's directory names (the same trust as the loopback CLI).
 */
export function registerFolderRoutes(router: Router, options: FolderRouteOptions): void {
  router.post("/api/workspaces/pick", async ({ req }) => {
    const { start } = validate<{ start?: string }>(await readJson(req), {
      start: { check: is.nonEmpty(4096) },
    });
    if (!options.picker || !(await options.picker.available()))
      throw new HttpError("picker_unavailable", "No native folder dialog on this server");
    if (start !== undefined) {
      const valid =
        isAbsolute(start) &&
        (await stat(start).then(
          (s) => s.isDirectory(),
          () => false,
        ));
      if (!valid)
        throw new HttpError("validation_failed", "Invalid start directory", { fields: ["start"] });
    }
    const outcome = await options.picker.pick({
      title: TITLE,
      ...(start ? { start } : {}),
      signal: options.signal,
    });
    return { body: outcome };
  });

  router.get("/api/fs/dirs", async ({ url }) => {
    if (!options.browser)
      throw new HttpError("picker_unavailable", "The folder browser is only available on loopback");
    return {
      body: await listDirectories({
        path: url.searchParams.get("path"),
        hidden: url.searchParams.get("hidden") === "true",
      }),
    };
  });
}
