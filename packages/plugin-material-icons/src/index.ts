/**
 * Material Icon Theme provider for the Alisio web UI. The package is self-contained: it ships the
 * Material Icon Theme SVGs and the VSCode-style manifest under its own directory (no dependency on
 * the `material-icon-theme` npm package), and registers an `icon-theme` extension point pointing at
 * those vendored files with absolute paths. Installing and selecting it is all the host needs.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin, type Plugin } from "@alisio/sdk";
import { loadVersion } from "./version.ts";

/** Stable theme id used by `web.iconTheme` and the `GET /api/icon-themes` catalog. */
export const MATERIAL_ICONS_THEME_ID = "material-icon-theme";
/** Human label shown by the web theme picker. */
export const MATERIAL_ICONS_THEME_LABEL = "Material Icon Theme";

/**
 * This package's root directory: `src/index.ts` in the source tree and `dist/index.js` in the
 * built package both sit one level below it, so the vendored `material-icons.json` and `icons/`
 * resolve identically before and after the build (and once installed from npm).
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createMaterialIconsPlugin(): Plugin {
  return definePlugin({
    id: "material-icons",
    name: "Material Icon Theme",
    description: "Material Icon Theme icons for the web UI",
    categories: ["ui"],
    version: loadVersion(import.meta.url),
    apiVersion: 1,
    setup(api) {
      api.extensions.register("icon-theme", {
        id: MATERIAL_ICONS_THEME_ID,
        label: MATERIAL_ICONS_THEME_LABEL,
        manifestPath: join(packageRoot, "material-icons.json"),
        iconsDir: join(packageRoot, "icons"),
      });
    },
  });
}

/** Ready-to-load instance: external plugins are imported by their default export. */
export default createMaterialIconsPlugin();
