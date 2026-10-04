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
pnpm docs:check
pnpm docs:build
```

## Rules

- Strict TDD: write the failing test first.
- Test behavior at module boundaries; no snapshot tests that merely restate the implementation.
  One exception: the small hand-reviewed golden specs in `tests/golden/dashboard/*.json` (the
  `DashboardSpec` the planner returns for a few datasets of at most 40 rows, or the example CSVs).
  They are planner behavior at its boundary; a rule change that moves one needs a human review.
  Never snapshot the generated HTML: assert its structure.
- Keep provider SDKs and runtime-specific imports out of `@alisio/sdk` and the agent-core contracts.
- Preserve tool call IDs, provider continuation data and persisted session consistency.
- Never treat a plugin manifest or a subprocess as a sandbox.
- Code, comments and tests are in English. `docs/implementation-status.md` is in Spanish and records
  limitations and verification scope; update it when those change.

## Decision Intelligence

The decision engine is for closed choices that deterministic code cannot make well. Before creating
a Decision Pack or using `ctx.decisions`, answer in order: (1) does the decision have a closed set
of outcomes (if not, use the LLM or ordinary code)? (2) does it come up often enough? (3) does
resolving it here reduce tokens, cost, latency or variability? (4) is there a safe fallback (if
not, do not automate it)?

The pull request must also answer in writing: (1) which closed decision it solves; (2) what LLM
work it removes; (3) which metric improves; (4) its fallback; (5) what happens without a provider;
(6) how its output is validated; (7) why deterministic code would not be enough; (8) what goes into
`state` and why a remote provider could receive it. If they cannot be answered clearly, the
feature does not use the decision engine. Deterministic code comes first. See
[Decision Intelligence](https://gustavogutierrez.github.io/alisio/decision-intelligence#admission-rule).

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
- [ ] `pnpm docs:build` passes with no dead links (`pnpm docs:check` validates `#anchors` and EN/ES
      parity).

## Generated files

- `packages/core/src/analysis/python/sources.ts` embeds `alisio_runtime/*.py`: regenerate with
  `node --experimental-strip-types scripts/analysis-runtime-sources.ts`.
- `packages/core/src/analysis/data/engine-source.ts` embeds the data engine (the modules listed in
  `scripts/analysis-data-engine-inputs.ts`, bundled with `bun build`): regenerate with
  `node --experimental-strip-types scripts/analysis-data-engine.ts` after changing any of them.
  Tests fail when either file is stale.
