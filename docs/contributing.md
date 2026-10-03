# Contributing

Contributions are welcome. The repository is
[GustavoGutierrez/alisio](https://github.com/GustavoGutierrez/alisio); the contributor instructions
also live in `AGENTS.md` and `CONTRIBUTING.md`.

## Tooling

- **pnpm** (11.25.0) for dependencies. Keep only `pnpm-lock.yaml`; do not add other lockfiles.
- **Bun** for development (`pnpm dev`) and the standalone binary; the built packages run on
  **Node.js >= 22.16** or **Bun >= 1.4.2**.
- **Biome** for lint and formatting, **Vitest** for tests, **TypeScript** (`tsc`) for types and builds.

```sh
pnpm install --frozen-lockfile
pnpm dev --help
```

## Checks

Run these before opening a pull request:

| Command | What it checks |
| --- | --- |
| `pnpm typecheck` | TypeScript across packages, tests, fixtures, scripts and the docs config |
| `pnpm lint` | Biome lint and formatting |
| `pnpm test` | Vitest suite (some fixtures also run on Bun) |
| `pnpm build` | `tsc` build of every package |
| `pnpm test:cli` | The built CLI under Node against a local fake provider |
| `pnpm test:compiled` | Builds the standalone binary and runs the end-to-end fixture against it |
| `pnpm pack:check` | Contents of the npm packages |
| `pnpm docs:check` | Internal links, `#anchors` and English/Spanish parity |
| `pnpm docs:build` | This documentation site, including `docs:check` and the dead-link check |

`pnpm check` runs all of them in order.

## Development rules

- **Strict TDD**: write the failing test first, then the implementation.
- Test behavior at module boundaries. Do not add snapshot tests that merely restate the
  implementation.
- Keep provider SDKs and runtime-specific imports out of `@alisio/sdk` and the agent-core contracts.
- Preserve tool call IDs, provider continuation data and persisted session consistency.
- Never treat a plugin manifest or a subprocess as a sandbox.
- Code, comments and tests are written in English; this site is written in English and Spanish.
  `docs/implementation-status.md` is written in Spanish and records limitations and verification scope; update it when those change.

## Decision Intelligence {#decision-intelligence}

Before adding a Decision Pack or any use of `ctx.decisions`, the change has to pass the
[admission rule](/decision-intelligence#admission-rule): four questions about whether the decision
is closed, frequent, worth resolving this way and safe to fall back from, and eight written answers
in the pull request (the decision, the LLM work removed, the metric, the fallback, the behavior
without a provider, how the output is validated, why deterministic code is not enough, and what goes
into `state`). Features that cannot answer them do not use the decision engine.

## Versioning

Versions and changelogs are managed with [changesets](https://github.com/changesets/changesets).
Add a changeset to every pull request that changes a published package:

```sh
pnpm changeset
```

On `main`, the release workflow opens a version pull request and, once it is merged, publishes to
npm with provenance and attaches standalone binaries to a GitHub Release.

## Documentation

The site lives in `docs/` and is built with VitePress:

```sh
pnpm docs:dev     # local preview
pnpm docs:check   # internal links, anchors and EN/ES parity
pnpm docs:build   # production build with dead-link check
```

English pages are at `docs/<page>.md` and Spanish pages at `docs/es/<page>.md`. Internal links use
site paths (`/configuration` in English, `/es/configuration` in Spanish). `specification.md`,
`herdr.md`, `implementation-status.md`, `validation.txt`, `benchmark.json` and `README.md` in
`docs/` are excluded from the site; link to them with absolute GitHub URLs.

### Docs parity checklist

- [ ] Every page exists in both locales (`docs/<page>.md` and `docs/es/<page>.md`), and both are
      listed in the sidebar of `docs/.vitepress/config.ts`.
- [ ] Both versions have the same headings in the same order and the same code blocks; commands,
      flags and configuration keys are identical.
- [ ] Prose is translated faithfully; neither side is a summary of the other.
- [ ] English and Spanish are updated in the same pull request.
- [ ] `docs/es/limitations.md` still includes `docs/implementation-status.md`, and the English
      `docs/limitations.md` reflects its current content.
- [ ] `pnpm docs:build` passes with no dead links (`pnpm docs:check` validates `#anchors` and parity,
      which VitePress’s own dead-link check does not).
