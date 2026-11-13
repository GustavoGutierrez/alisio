---
"@alisio/core": patch
"@alisio/server": patch
"@alisio/sdk": patch
---

MCP catalog phase 1 (config per scope): a shared MCP config writer with a per-file lock, revision
conflicts (`mcp_config_conflict`) and canonical/alias form preservation; project writes re-seal the
stored trust (the enable switch no longer drops a trusted project to `needsPrompt`) and fail with
`mcp_scope_untrusted` on untrusted projects. Registry-name aliases, minimal project overrides,
`GET /api/mcp` now reports `effective`, `editable` and hidden `shadows`, global changes recycle the
other open workspaces that use the entry, stdio MCP children join the process registry, and the
schema accepts secret references (`headers`, `secretEnv`) that are not resolved yet.
