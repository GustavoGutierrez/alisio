---
"@alisio/core": minor
---

Plugin install and uninstall building blocks for the web and desktop apps. New `uninstallPlugin`
(`npm uninstall --prefix`, atomic removal of the `plugins` entry, idempotent), `installLocalPluginTarball`
(copies a private `.tgz` into `<config home>/plugins/local-packages/` and installs from that stable copy,
with full rollback) and `inspectPluginTarball` (gzip and ustar reader in JS, no `tar` binary: only
`package/package.json` is read, with size, entry and path-traversal limits). `installPlugin` gains
`force` (reinstall or downgrade at a given version). npm is resolved through `runNpm`: with
`ALISIO_NPM_CLI` set it runs that `npm-cli.js` through the current executable (Electron as Node), and a
missing npm now says "npm was not found: install Node.js, or use the desktop app, which bundles it".
Also `comparePluginVersions`, `satisfiesRange` and `catalogPluginState` (no dependency) and
`pluginCodeImportedFrom`, which tells whether a plugin's code is already loaded in this process.
