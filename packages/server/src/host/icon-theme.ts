/**
 * Icon-theme resolution for the web dock: the providers a workspace app contributes through the
 * `icon-theme` extension point, the single one selected by `web.iconTheme`, and its manifest.
 * The manifest is immutable per path, so it is read once and memoized (keyed by path, not id, so
 * two workspaces or tests that reuse a theme id never share a stale entry).
 */
import { readFile } from "node:fs/promises";
import type { IconThemeProvider } from "@alisio/sdk";
import type { Application } from "./workspace-host.ts";

/** The `web.iconTheme` value that keeps the built-in inline icons. */
export const NO_ICON_THEME = "none";

/** Available icon-theme providers of a workspace app, in resolution order (highest priority first). */
export function iconThemes(app: Application): Array<{ id: string; label: string }> {
  return app.plugins.extensions.list("icon-theme").map(({ provider }) => ({
    id: provider.id,
    label: provider.label,
  }));
}

/**
 * The provider selected by `web.iconTheme`, or `undefined` when the setting is `none` or names no
 * registered provider (an unknown id behaves as if no theme were selected).
 */
export function activeTheme(app: Application): IconThemeProvider | undefined {
  const id = app.config.web.iconTheme;
  if (!id || id === NO_ICON_THEME) return undefined;
  return app.plugins.extensions
    .list("icon-theme")
    .map(({ provider }) => provider)
    .find((provider) => provider.id === id);
}

const manifests = new Map<string, unknown>();

/** The parsed manifest of the active theme, or `undefined` when no theme is active. */
export async function activeManifest(app: Application): Promise<unknown | undefined> {
  const provider = activeTheme(app);
  if (!provider) return undefined;
  if (manifests.has(provider.manifestPath)) return manifests.get(provider.manifestPath);
  const manifest: unknown = JSON.parse(await readFile(provider.manifestPath, "utf8"));
  manifests.set(provider.manifestPath, manifest);
  return manifest;
}
