/**
 * Icon themes for the web dock: the catalog of registered providers, the active theme's manifest
 * and its SVG files. One global setting (`web.iconTheme`) selects at most one theme; an unknown id
 * behaves as none. Icon names are validated against a strict basename pattern and their real path
 * must stay inside the active provider's `iconsDir`, so neither `..`, an absolute path nor a
 * symlinked icon can read a file outside the theme.
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { inside } from "@alisio/core";
import { activeManifest, activeTheme, iconThemes, NO_ICON_THEME } from "../host/icon-theme.ts";
import type { WorkspaceHost } from "../host/workspace-host.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { workspaceApp } from "./management.ts";

/** One SVG basename: no separator, no traversal, `.svg` only. */
const ICON_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$/;
/** Themes are immutable assets keyed by content, so the browser may keep an icon forever. */
const CACHE_CONTROL = "private, max-age=31536000, immutable";

export function registerIconThemeRoutes(router: Router, ctx: { workspaces: WorkspaceHost }): void {
  /** The workspace app named by `?workspace=`; a missing/unknown one is 400/404. */
  const appOf = (url: URL) => workspaceApp(ctx.workspaces, url.searchParams.get("workspace"));

  router.get("/api/icon-themes", async ({ url }) => {
    const opened = await appOf(url);
    return {
      body: {
        active: activeTheme(opened.app)?.id ?? NO_ICON_THEME,
        themes: iconThemes(opened.app),
      },
    };
  });

  router.get("/api/icon-theme/manifest", async ({ url }) => {
    const opened = await appOf(url);
    const manifest = await activeManifest(opened.app);
    if (manifest === undefined) throw new HttpError("not_found", "No active icon theme");
    return { body: manifest };
  });

  router.get("/api/icon-theme/icons/:name", async ({ url, params, req, res }) => {
    const opened = await appOf(url);
    const provider = activeTheme(opened.app);
    if (!provider) throw new HttpError("not_found", "No active icon theme");
    const name = params.name ?? "";
    if (!ICON_NAME.test(name))
      throw new HttpError("validation_failed", "Invalid icon name", { fields: ["name"] });
    const dir = await realpath(provider.iconsDir).catch(() => provider.iconsDir);
    const target = resolve(dir, name);
    // The pattern already forbids separators; containment also stops a symlinked icon escaping.
    if (!inside(dir, target))
      throw new HttpError("path_outside_workspace", "Icon is outside the theme directory");
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      throw new HttpError("not_found", "Icon not found");
    }
    if (!inside(dir, real))
      throw new HttpError("path_outside_workspace", "Icon is outside the theme directory");
    const bytes = await readFile(real);
    const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
    const ifNoneMatch = req.headers["if-none-match"];
    if (
      ifNoneMatch &&
      (ifNoneMatch === "*" || ifNoneMatch.split(",").some((value) => value.trim() === etag))
    ) {
      res.writeHead(304, { ETag: etag, "Cache-Control": CACHE_CONTROL });
      res.end();
      return undefined;
    }
    res.writeHead(200, {
      "Content-Type": "image/svg+xml",
      "Content-Length": bytes.length,
      ETag: etag,
      "Cache-Control": CACHE_CONTROL,
    });
    res.end(bytes);
    return undefined;
  });
}
