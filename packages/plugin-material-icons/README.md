# @alisio/plugin-material-icons

**Material Icon Theme for the [Alisio](https://github.com/GustavoGutierrez/alisio) web UI.** It
registers an `icon-theme` provider so the web dock renders files and folders with the
[Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) SVGs.

## What it is

A self-contained, external plugin. The Material Icon Theme SVGs and the VSCode-style manifest
(`material-icons.json`) are vendored inside this package, so it has no runtime dependency on the
`material-icon-theme` npm package and serves its own files with absolute paths resolved from the
installed location. It depends only on `@alisio/sdk` (peer) and Node built-ins.

## Installation

Install it into Alisio's global plugins directory and add it to the global configuration:

```bash
alisio install npm:@alisio/plugin-material-icons --yes
```

Then select it as the active theme:

```bash
alisio settings set web.iconTheme material-icon-theme
```

Or pick it from the web UI under **Settings → Appearance**. The default is `none`, which keeps the
built-in inline icons; an unknown id behaves as if no theme were selected.

## Attribution and license

The icons and the manifest come from
[`material-icon-theme`](https://github.com/material-extensions/vscode-material-icon-theme)
(Material Extensions), licensed under the MIT License. The upstream license is shipped in
[`LICENSE.material-icon-theme`](./LICENSE.material-icon-theme). This package's own code is MIT.

## Requirements

Node.js **>= 22.16** or Bun **>= 1.4.2**.
