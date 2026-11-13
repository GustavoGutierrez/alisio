---
"@alisio/core": patch
"@alisio/server": patch
"@alisio/sdk": patch
---

MCP catalog phase 2 (browse only): a provider-neutral `CatalogSource` port with Alisio's own domain
model, an anti-corruption adapter for the official registry (`/v0.1`, three schema revisions), a local
SQLite + FTS5 index with bounded, cancellable, incremental background sync, a keyword category
classifier with visible provenance, `GET /api/mcp/catalog`, `/detail` and `POST /api/mcp/catalog/sync`,
the global-only `mcp.catalog` source setting and an Explore tab in Settings → MCP (lazy chunk, EN/ES).
Installing from the catalog is not available yet.
