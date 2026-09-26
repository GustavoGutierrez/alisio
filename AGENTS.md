# Alisio contributor instructions

Use pnpm for dependencies (keep only pnpm-lock.yaml). The runtime is Node-first (Node >=22.16)
and must keep working on Bun; Bun also builds the optional standalone binary.
Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`,
`pnpm pack:check` and `pnpm docs:build` before delivery.
Keep provider SDKs and runtime-specific imports out of the public SDK and agent-core contracts.
Use only portable Node APIs (node:fs, node:child_process, node:sqlite) in packages; no Bun globals.
Plugins depend only on @alisio/sdk (peer) and never import @alisio/core internals.
Preserve tool call IDs, provider continuation data and persisted session consistency.
Never treat a plugin manifest or a subprocess as a sandbox.
Test behavior at module boundaries. Do not add snapshot tests that merely restate implementation.
Document limitations and verification scope in docs/implementation-status.md.
Keep the English and Spanish documentation pages in parity (see CONTRIBUTING.md).
