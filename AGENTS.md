# Alisio contributor instructions

Use pnpm for dependencies and Bun for runtime/build. Keep only pnpm-lock.yaml.
Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` and `pnpm test:compiled` before delivery.
Keep provider SDKs and runtime-specific imports out of the public SDK and agent-core contracts.
Preserve tool call IDs, provider continuation data and persisted session consistency.
Never treat a plugin manifest or a subprocess as a sandbox.
Test behavior at module boundaries. Do not add snapshot tests that merely restate implementation.
Document limitations and verification scope in docs/implementation-status.md.
