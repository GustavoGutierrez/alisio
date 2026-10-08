/**
 * The active icon theme of a workspace for the web dock. The catalog and the manifest are fetched
 * once per workspace and kept in signals; `iconFor` resolves an entry to an SVG URL with the
 * VSCode order (exact name, longest extension, default) and returns `undefined` when no theme is
 * active, so the caller can fall back to the inline icon set. The web never bundles the icons: the
 * server serves them from the active plugin.
 */
import { signal } from "@preact/signals";
import type { IconThemeManifest } from "../net/api.ts";
import { api } from "./app.ts";

export type { IconThemeManifest };

export interface IconThemeCatalogTheme {
  id: string;
  label: string;
}
export interface IconThemeCatalog {
  active: string;
  themes: IconThemeCatalogTheme[];
}

/** The slice of the API client the store needs (injectable in tests). */
export interface IconThemeApi {
  iconThemes(workspace: string): Promise<IconThemeCatalog>;
  iconThemeManifest(workspace: string): Promise<IconThemeManifest>;
}

export interface IconOptions {
  /** Resolve a folder instead of a file. */
  dir?: boolean;
  /** Prefer the expanded folder icon (an open folder in the tree). */
  expanded?: boolean;
}

/** The active theme id (`none` when no theme is selected). */
export const iconThemeActive = signal<string>("none");
/** The themes available in the workspace (feeds the Settings selector). */
export const iconThemeThemes = signal<IconThemeCatalogTheme[]>([]);
/** The active theme's manifest, or undefined while no theme is loaded. */
export const iconThemeManifest = signal<IconThemeManifest | undefined>(undefined);
export const iconThemeLoading = signal(false);
export const iconThemeError = signal<string | undefined>(undefined);

/** One load per workspace: the next call for the same one is a no-op. */
let loadedWorkspace: string | undefined;
let loadingWorkspace: string | undefined;
/** The workspace the loaded manifest belongs to; the icon URL must name it for the server. */
let activeWorkspace: string | undefined;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The candidate extension keys of a file, longest chain first (`foo.d.ts` → `d.ts`, then `ts`). */
function extensionChain(name: string): string[] {
  const first = name.indexOf(".");
  if (first === -1) return [];
  const keys: string[] = [];
  for (let dot = first; dot !== -1; dot = name.indexOf(".", dot + 1))
    keys.push(name.slice(dot + 1));
  return keys.sort((a, b) => b.length - a.length);
}

/** A lookup that also accepts the lowercased key (manifest keys are lowercase by convention). */
const at = (map: Record<string, string> | undefined, key: string): string | undefined =>
  map?.[key] ?? map?.[key.toLowerCase()];

/** The SVG basename behind an icon-definition key, or undefined when the key is missing. */
function definitionFile(manifest: IconThemeManifest, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const iconPath = manifest.iconDefinitions?.[key]?.iconPath;
  if (!iconPath) return undefined;
  return iconPath.replace(/\\/g, "/").split("/").pop() || undefined;
}

/**
 * The SVG basename `name` resolves to, or undefined. Files: exact name, then the longest matching
 * extension, then the default. Folders: exact name (the expanded variant when `expanded`), then the
 * expanded/default folder. Pure: the caller owns the manifest.
 */
export function resolveIcon(
  manifest: IconThemeManifest | undefined,
  name: string,
  options: IconOptions = {},
): string | undefined {
  if (!manifest) return undefined;
  if (options.dir) {
    const exact = options.expanded
      ? (at(manifest.folderNamesExpanded, name) ?? at(manifest.folderNames, name))
      : at(manifest.folderNames, name);
    const fallback = options.expanded
      ? (manifest.folderExpanded ?? manifest.folder)
      : manifest.folder;
    return definitionFile(manifest, exact ?? fallback);
  }
  let key = at(manifest.fileNames, name);
  if (!key)
    for (const extension of extensionChain(name)) {
      key = at(manifest.fileExtensions, extension);
      if (key) break;
    }
  return definitionFile(manifest, key ?? manifest.file);
}

/** The icon URL of `name`, or undefined while no theme is active or the manifest lacks the key. */
export function iconFor(name: string, options: IconOptions = {}): string | undefined {
  if (iconThemeActive.value === "none" || !activeWorkspace) return undefined;
  const file = resolveIcon(iconThemeManifest.value, name, options);
  return file ? api.iconThemeIconUrl(activeWorkspace, file) : undefined;
}

/**
 * Loads the catalog once per workspace and, when a theme is active, its manifest. `404` on the
 * manifest (a theme removed meanwhile) is treated as no theme; a catalog failure is kept in
 * `iconThemeError` and leaves the store inactive.
 */
export async function loadIconTheme(workspace: string, client: IconThemeApi = api): Promise<void> {
  if (loadedWorkspace === workspace || loadingWorkspace === workspace) return;
  loadingWorkspace = workspace;
  iconThemeLoading.value = true;
  iconThemeError.value = undefined;
  activeWorkspace = workspace;
  try {
    const catalog = await client.iconThemes(workspace);
    if (catalog.active === "none") {
      iconThemeActive.value = "none";
      iconThemeThemes.value = catalog.themes;
      iconThemeManifest.value = undefined;
    } else {
      try {
        const manifest = await client.iconThemeManifest(workspace);
        iconThemeThemes.value = catalog.themes;
        iconThemeActive.value = catalog.active;
        iconThemeManifest.value = manifest;
      } catch {
        iconThemeActive.value = "none";
        iconThemeThemes.value = catalog.themes;
        iconThemeManifest.value = undefined;
      }
    }
    loadedWorkspace = workspace;
  } catch (error) {
    iconThemeError.value = errorText(error);
  } finally {
    loadingWorkspace = undefined;
    iconThemeLoading.value = false;
  }
}

/** Drops the loaded theme (the workspace changed, or the selection was just updated). */
export function resetIconTheme(): void {
  loadedWorkspace = undefined;
  loadingWorkspace = undefined;
  activeWorkspace = undefined;
  iconThemeActive.value = "none";
  iconThemeThemes.value = [];
  iconThemeManifest.value = undefined;
  iconThemeLoading.value = false;
  iconThemeError.value = undefined;
}
