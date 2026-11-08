# Desktop app

Alisio Desktop is the easiest way to use Alisio: install it like any other program and open it. No
terminal is needed. It is made for everyday work (writing a thesis, preparing an exam, analyzing a
spreadsheet, producing a report) on your own files, and it always asks permission before it reads
or changes anything.

::: warning Experimental
The desktop app is a thin Electron shell around the same local server as
[`alisio serve`](/web). It is built from the repository and is **not published to npm**. There is no
auto-update and the installers are not code-signed. See [Known limitations](#limitations).
:::

The desktop app opens the [Web UI](/web) in its own window. It adds no features of its own: sessions,
configuration, plugins and the session database are the ones the CLI uses.

## Download and install

Download the file for your system from the [Alisio 0.11.2 release](https://github.com/GustavoGutierrez/alisio/releases/tag/v0.11.2) (the same links
are on the [home page](/)):

| System | Download | How to install |
| --- | --- | --- |
| Windows 10/11 (x64) | [`Alisio-Setup-0.11.2-x64.exe`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-Setup-0.11.2-x64.exe) | Run it and follow the wizard |
| macOS Apple Silicon (arm64) | [`Alisio-0.11.2-arm64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-0.11.2-arm64.dmg) | Open it and drag Alisio to Applications |
| macOS Intel (x64) | [`Alisio-0.11.2-x64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-0.11.2-x64.dmg) | Open it and drag Alisio to Applications |
| Linux, any distribution | [`Alisio-0.11.2-x86_64.AppImage`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-0.11.2-x86_64.AppImage) | Make it executable (`chmod +x`) and run it |
| Debian and Ubuntu | [`Alisio-0.11.2-amd64.deb`](https://github.com/GustavoGutierrez/alisio/releases/download/v0.11.2/Alisio-0.11.2-amd64.deb) | Install it with your package manager |

Each release also lists `SHA256SUMS-desktop.txt`, so you can verify a download. To build the
installers yourself, see [Building the installers](#building-the-installers).

**Windows.** The assisted installer is built with NSIS 3 and Modern UI 2. It installs per user, so
it needs no administrator rights, and it lets you choose the folder. It creates desktop and Start
menu shortcuts, runs Alisio when it finishes, and is available in Spanish and English.

**Linux.** The window and the launcher show as "Alisio" with its icon (taken from
`packages/web/public/favicon.png`).

### Unsigned installers: SmartScreen and Gatekeeper {#unsigned}

The installers are not code-signed, so your system warns you the first time:

- **Windows (SmartScreen):** when "Windows protected your PC" appears, choose **More info**, then
  **Run anyway**.
- **macOS (Gatekeeper):** the app is ad-hoc signed, not notarized. If macOS says the app cannot be
  opened, open **System Settings**, then **Privacy & Security**, and choose **Open Anyway** for
  Alisio. You can also Control-click the app and choose **Open**. If macOS still reports that the
  app is damaged, run `xattr -cr /Applications/Alisio.app` in a terminal once and open it again.

Only do this with an installer you built yourself or one downloaded from the official release.

## First launch

Open Alisio from the desktop shortcut, the Start menu, the Applications folder or your launcher. The
app starts its local server in the background and opens the window by itself. When you quit, the
server is stopped.

## Connect a model

Alisio works with the model you choose; it ships with no default model or credentials. Open
**Settings**, then **Models**, add a profile for your provider (OpenAI-compatible, DeepSeek,
OpenRouter and others), enter its key and activate a model. Keys are stored as credentials, never in
plain configuration files. See [Web UI](/web) and [Configuration](/configuration) for every field.

## Open a folder

By default the workspace is your home directory. Use the workspace picker to open the folder with
the files you want to work on. Alisio reads by default and asks before it writes, so you stay in
control of every change. See [Tools & permissions](/tools#permission-flags).

## Install profession plugins

Plugins give Alisio skills for a profession. They are published from the public
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) repository and install with
`alisio install npm:<package>`; or open **Settings → Plugins** and use the **Plugin catalog** tab:
one click installs a plugin and it appears in **Installed plugins** at once. **Install from file**
installs a private plugin from a `.tgz`. The assistant can also install one for you through its
permissioned `plugin_install` tool, after you approve it. The app bundles npm, so installing plugins
needs no Node.js on your system; when you update a plugin that is already loaded, a banner asks you
to restart and **Restart now** restarts the app's background process and reloads the window. See
[Plugin catalog, install and updates](/web#plugin-catalog).

| Plugin | For |
| --- | --- |
| `@alisio/plugin-thesis` | Students: plans, researches, drafts and typesets university theses into PDF with Typst |
| `@alisio/plugin-literature-research` | Students: scholarly metadata search |
| `@alisio/plugin-evalua` | Teachers: printable exams (school math only for now) |
| `@alisio/plugin-cardsmith` | Office staff: certificates, cards and charts |

These plugins are **not bundled in the desktop app yet**; you install them yourself. Plugins run
with your user privileges and are not sandboxed, so install only code you trust. See
[Writing plugins](/plugins).

## How it works

The Electron main process starts a background host: the Alisio server running on the Electron binary
as plain Node (`ELECTRON_RUN_AS_NODE=1`), bound to `127.0.0.1` on a free port. The host reports its
launch URL to the main process, which opens it in a sandboxed `BrowserWindow` (context isolation on,
Node integration off, no preload script). Links that leave the app are opened in your default
browser. When you quit, the host is stopped.

Nothing else changes: Alisio still uses `node:sqlite`, with no native addons, and the same Host,
Origin and launch-token checks as `alisio serve`.

## Where data lives

The desktop app shares its data with the CLI and the TUI:

| Data | Location |
| --- | --- |
| Configuration | `~/.config/alisio` (`ALISIO_CONFIG_HOME`) |
| Sessions and state | `~/.local/state/alisio` (`ALISIO_STATE_HOME`) |

## Run it from a checkout

```sh
pnpm install
pnpm desktop:dev
```

`pnpm desktop:dev` builds the workspace packages and the desktop app, then starts Electron against
the development paths.

## Building the installers

This section is for maintainers.

```sh
pnpm desktop:package:dir
pnpm desktop:package
```

`pnpm desktop:package:dir` produces an unpacked app in `apps/desktop/release/` (quick to check).
`pnpm desktop:package` builds the installers for the current platform with `electron-builder`:
`AppImage` and `deb` on Linux, an assisted `nsis` per-user installer on Windows and a `dmg` on macOS.
Build each platform on its own operating system: the macOS `.dmg` must be built on a Mac or on a
macOS CI runner. The official installers are built by the `Desktop release` GitHub workflow (see
[Releasing Alisio Desktop](/publishing#releasing-alisio-desktop)).

The packaging step runs `pnpm deploy --legacy --prod --config.node-linker=hoisted` to assemble a
self-contained, flat `node_modules` tree under `apps/desktop/build/runtime`. It ships next to the
app (outside the asar archive) because Alisio's worker processes run real files. The build fails if
that tree contains any symlink, because installers cannot rely on them.

## Limitations {#limitations}

- The profession plugins are not bundled with the app.
- Git features need `git` installed.
- Folder selection uses the same native picker as `alisio serve` (a system tool), not an Electron
  dialog.
- Global plugin discovery derives its prefix from the executable path, which is meaningless inside
  Electron: plugins installed with a global package manager are not found from the desktop app.
  Plugins installed through Alisio and project plugins are not affected.
- There is no auto-update. Install a newer build over the old one.
- The installers are not signed: Windows SmartScreen and macOS Gatekeeper show warnings. The macOS
  app is only ad-hoc signed and not notarized.
- The app has not been verified on Windows or macOS; only Linux builds were exercised.
