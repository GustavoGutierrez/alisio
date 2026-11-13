---
"@alisio/core": patch
"@alisio/server": patch
"@alisio/sdk": patch
---

MCP catalog phase 3 (install): a non-executable install planner, a private npm installer (exact
version, `--ignore-scripts`, lockfile, never global or `npx`) and Streamable HTTP services with
protected keys, install jobs with the specified state machine, a deadline, cancellation of the whole
process tree and crash reconciliation, uninstall by scope with artifact reference counting, a
`SecretStore` backed by a 0600 file (`mcp-secrets.json`), a `node <bin>` runtime resolved at connect
time, an SSRF guard for catalog addresses, the `/api/mcp/install/*` and `/api/mcp/bindings/*` routes,
and Settings → MCP: Install/Connect from Explore and a "Connected" list with separate execution and
scope badges, connection test and scope-aware removal. OAuth sign-in is not part of this phase.
