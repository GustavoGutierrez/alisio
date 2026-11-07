---
"@alisio/alisio-code": minor
"@alisio/core": patch
---

Support for the new Electron desktop app (`apps/desktop`, private, not published). The CLI exposes
`cliDefaults()` (built-in plugins, prompt templates and reserved command names) through the new
`@alisio/alisio-code/defaults` subpath, without the commander side effects of the package entry.
Core worker processes (data engine, Forja isolate, Pyodide) now start with `ELECTRON_RUN_AS_NODE=1`
when the host runs on the Electron binary; nothing changes under plain Node or Bun.
