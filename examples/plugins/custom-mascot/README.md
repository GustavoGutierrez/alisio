# alisio-plugin-kite-mascot

Example [Alisio](https://github.com/GustavoGutierrez/alisio) plugin that replaces the startup
mascot with a kite using the typed `mascot` extension point (and shows an optional custom
`startup-screen`). It depends only on `@alisio/sdk` (peer dependency) and ships JavaScript.

```sh
npm run build
alisio --plugin ./examples/plugins/custom-mascot/dist/index.js
# or, once published: npm i -g alisio-plugin-kite-mascot && alisio --plugin alisio-plugin-kite-mascot
```

Providers receive only their context (`terminal.color`, `terminal.unicode`, `terminal.columns`):
no globals, environment or filesystem. Output is sanitized and clamped by the host; if a
provider throws or returns invalid output, Alisio falls back to its default mascot/screen.
