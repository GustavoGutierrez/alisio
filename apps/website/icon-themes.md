# How to create an icon-theme plugin

An icon theme replaces the inline file and folder icons of the web dock with SVGs from a
VSCode-style icon set. A plugin contributes one theme; the user activates at most one at a time
through the `web.iconTheme` setting, and the server serves only the active theme's files. Alisio
never bundles an icon set, so the plugin owns its assets.

## The `icon-theme` extension point

Register a provider on the `icon-theme` extension point. Paths are absolute because the host
resolves them against the plugin's own installation, not the workspace.

```ts
interface IconThemeProvider {
  /** Stable id: lowercase letters, digits and dashes. This is the `web.iconTheme` value. */
  id: string;
  /** Human label shown by the theme picker. */
  label: string;
  /** Absolute path to the VSCode icon-theme manifest JSON. */
  manifestPath: string;
  /** Absolute directory that holds the SVG files. */
  iconsDir: string;
}
```

## A minimal plugin

`setup` registers the provider once. Resolve both paths from the plugin's own location so they work
whether the module runs from `src/` or `dist/`.

```ts
import { definePlugin } from "@alisio/sdk";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export default definePlugin({
  id: "acme.icon-theme",
  name: "Acme Icons",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.extensions.register("icon-theme", {
      id: "acme",
      label: "Acme Icons",
      manifestPath: join(root, "material-icons.json"),
      iconsDir: join(root, "icons"),
    });
  },
});
```

::: tip One provider, one theme
A plugin may register several providers, but the user activates at most one. Keep `id` stable: it is
the value stored in `web.iconTheme`.
:::

## The manifest format

The manifest follows the VSCode icon-theme shape. `iconDefinitions` maps an internal key to an SVG
path (relative to `iconsDir` or to the manifest directory); the lookup maps point a file, folder or
extension to one of those keys.

```json
{
  "iconDefinitions": {
    "_ts": { "iconPath": "./file_type_typescript.svg" },
    "_folder": { "iconPath": "./folder.svg" },
    "_folderOpen": { "iconPath": "./folder-open.svg" }
  },
  "file": "_ts",
  "folder": "_folder",
  "folderExpanded": "_folderOpen",
  "fileNames": { "package.json": "_ts" },
  "fileExtensions": { "ts": "_ts", "d.ts": "_ts" },
  "folderNames": { "src": "_folder" },
  "folderNamesExpanded": { "src": "_folderOpen" }
}
```

## How Alisio resolves and serves icons

The web resolves each entry in this order: a folder name in `folderNames` (its
`folderNamesExpanded` variant when open), then the `folderExpanded`/`folder` default; a file name
in `fileNames`, then the longest matching `fileExtensions` key, then the `file` default. A missing
key falls back to the inline icons, so the dock keeps working with a partial set. The server reads
the manifest once and only serves the active theme:

```text
GET /api/icon-themes              -> { active, themes: [{ id, label }] }
GET /api/icon-theme/manifest      -> the active manifest JSON (404 when none)
GET /api/icon-theme/icons/:name   -> one image/svg+xml with a strong ETag (404 when none)
```

Icon names are validated against `^[A-Za-z0-9][A-Za-z0-9._-]*\.svg$` and confined to `iconsDir`, so
`..`, absolute paths and non-SVG names are rejected. See the [plugin contract](/plugins) for the
rest of the API.

## Install and select a theme

Install a theme plugin like any other, then pick it in **Settings → Appearance → Icon theme**.

```bash
alisio install npm:@alisio/plugin-material-icons
alisio serve
```

Selecting a theme writes the global `web.iconTheme` setting; `None` restores the inline icons.

## Licensing and attribution

An icon set is someone else's work. Follow its license: copy the upstream `LICENSE` and attribution
into the plugin and its README, keep the original icon paths unchanged, and do not relicense the
icons. Alisio ships no icon set and takes no position on the ones you install.
