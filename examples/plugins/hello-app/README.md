# alisio-plugin-hello-app

Example plugin that registers a full-page app with `api.apps.register`. It shows the pieces every
app needs: self-contained HTML with `nonce="__ALISIO_NONCE__"` scripts, the `alisio.app.connect`
handshake over a transferred `MessagePort`, and one `read` action declared with an input schema.

```sh
pnpm install
pnpm build
alisio --plugin ./dist/index.js
```

Enable the plugin for the project, then open **Apps > Hello app** in the left panel. See
`docs/plugins.md` ("Plugin apps") for the contract, the sandbox and its limits.
