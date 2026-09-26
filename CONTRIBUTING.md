# Contributing to Alisio

Thanks for your interest in Alisio. The full guide is published at
<https://gustavogutierrez.github.io/alisio/contributing> (Spanish:
<https://gustavogutierrez.github.io/alisio/es/contributing>).

## Setup

- **pnpm** 11.25.0 for dependencies. Keep only `pnpm-lock.yaml`.
- **Bun** for development (`pnpm dev`) and the standalone binary. Packages run on
  **Node.js >= 22.16** or **Bun >= 1.4.2**.

```sh
pnpm install --frozen-lockfile
pnpm dev --help
```

## Checks

Run before opening a pull request (`pnpm check` runs them all):

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:cli
pnpm test:compiled
pnpm pack:check
pnpm docs:build
```

## Rules

- Strict TDD: write the failing test first.
- Test behavior at module boundaries; no snapshot tests that merely restate the implementation.
- Keep provider SDKs and runtime-specific imports out of `@alisio/sdk` and the agent-core contracts.
- Preserve tool call IDs, provider continuation data and persisted session consistency.
- Never treat a plugin manifest or a subprocess as a sandbox.
- Code, comments and tests are in English. `docs/implementation-status.md` is in Spanish and records
  limitations and verification scope; update it when those change.

## Versioning

Add a changeset to every pull request that changes a published package:

```sh
pnpm changeset
```

The release workflow opens a version pull request and, once merged, publishes to npm with provenance
and attaches standalone binaries to a GitHub Release.

## Documentation

The VitePress site lives in `docs/` (`pnpm docs:dev`, `pnpm docs:build`). English pages are
`docs/<page>.md`; Spanish pages are `docs/es/<page>.md`.

### Docs parity checklist

- [ ] Every page exists in both locales (`docs/<page>.md` and `docs/es/<page>.md`) and both are in
      the sidebar of `docs/.vitepress/config.ts`.
- [ ] Same headings in the same order and the same code blocks; commands, flags and configuration
      keys are identical.
- [ ] Prose is translated faithfully; neither side summarizes the other.
- [ ] English and Spanish are updated in the same pull request.
- [ ] `docs/es/limitations.md` still includes `docs/implementation-status.md`, and the English
      `docs/limitations.md` reflects its current content.
- [ ] `pnpm docs:build` passes with no dead links.
