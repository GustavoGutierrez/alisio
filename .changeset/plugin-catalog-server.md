---
"@alisio/server": minor
---

Plugin catalog, install, update and uninstall from the web. `GET /api/plugin-catalog` (remote catalog
validated and cached 24 hours under the state directory, conditional requests, offline copy),
`GET /api/plugin-catalog/covers/:slug` (covers through the server), `GET /api/plugins/packages`,
`POST /api/plugins/install` (catalog packages only, `confirmed: true`), `DELETE /api/plugins/package/:name`,
`POST /api/plugins/local/inspect` and `POST /api/plugins/local/install` (private `.tgz` with a background
job and phases), `GET /api/plugins/jobs/:jobId`, and `GET|POST /api/server/restart` (only when a
supervisor such as the desktop app sets `ALISIO_SUPERVISED=1`; exit code 75). Installing a package that
is already installed updates it in place. All of it is refused under `--read-only`, serialized, and
needs the usual Origin check. New `ALISIO_PLUGIN_CATALOG_URL` override. The SDK is unchanged.
