---
"@alisio/core": patch
"@alisio/server": patch
"@alisio/sdk": patch
---

MCP catalog phase 4 (OAuth and the finished experience): sign-in to Streamable HTTP services with the
SDK's maintained OAuth utilities (discovery, PKCE, resource indicator, issuer checks, refresh) and the
loopback helper of the provider sign-in, tokens only behind the `SecretStore` and only sent to the
resource they were granted for; sign-out removes local tokens only. An isolated connection test (no
tool is called, MCP consent required, never touches the live connection) with stages, a recovery
action and out-of-date detection; an editable settings form with write-only keys; an Update button;
a detail card in Explore; "On the computer running Alisio" for web and headless servers; and an
optional browser E2E (`pnpm test:e2e`, Playwright) outside the default checklist.
