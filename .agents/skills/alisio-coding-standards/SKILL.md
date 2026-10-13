---
name: alisio-coding-standards
description: "Alisio development rules: strict TDD and test conventions, TypeScript/Biome, pnpm, error handling and security rules, the delivery checklist commands, docs EN/ES parity, implementation-status duty, changesets, generated files, Decision Intelligence admission. Use this skill whenever you write or change code, tests or docs in this repo, before declaring work done, and when preparing delivery or a PR, even for small fixes."
---

# Alisio coding standards

Pair with `alisio-architecture` (where code goes). Spec-driven work: `alisio-specs`
(its section 8 is the test strategy). Releases: `alisio-publish`. Web UI screenshots:
`alisio-docs-screenshots`. Do not commit unless the owner asks.

## Hard rules

These keep the harness portable, auditable and honest about security; each one exists because
breaking it is expensive to undo (published contracts, user sessions, trust claims).

- **pnpm only** (11.25.0). Keep only `pnpm-lock.yaml`. Dependencies are pinned exact (no `^`).
- **Node-first (>=22.16), Bun-compatible.** Portable APIs only (`node:fs`, `node:child_process`,
  `node:sqlite`); no Bun globals in packages. Bun only for `pnpm dev` and the standalone binary.
- **Provider SDKs and runtime-specific imports stay out of `@alisio/sdk` and agent-core contracts.**
- **Plugins depend only on `@alisio/sdk` (peer)**, never on `@alisio/core` internals (see `alisio-plugins`).
- **Preserve tool call IDs, provider continuation data and persisted session consistency.**
- **Never treat a plugin manifest or a subprocess as a sandbox.** Never claim isolation the code
  does not enforce; docs and errors must say "not a sandbox" where it applies.
- **Docs EN/ES parity** (section "Docs").

## Language

Code, comments, identifiers, tests, error messages: English. `docs/implementation-status.md` is
Spanish. Specs use Spanish prose (see `alisio-specs`). UI text: EN and ES.

## TDD and tests

- Strict TDD: failing test first (fails for the right reason), minimum code, then refactor.
- Test behavior at module boundaries (public function, tool, route, event); prefer real
  dependencies when cheap (real SQLite, real QuickJS); mock only slow/external/nondeterministic.
- No snapshot tests that restate the implementation. Only exception: hand-reviewed dashboard
  goldens in `tests/golden/dashboard/*.json` (a rule change that moves one needs human review);
  never snapshot generated HTML, assert structure.
- Tests live in root `tests/`, named `<area>-<topic>.test.ts`; shared helpers `tests/*-helpers.ts`,
  fixtures in `fixtures/`. Runner: Vitest (`resolve.conditions: alisio-source`, 30 s timeout).
- Slow or real-dependency tests (Docker, network, Pyodide, browsers) sit behind env flags and skip
  by default with a clear message.
- Mutation testing is "lite": Stryker with narrow `mutate`, outside CI, bounded time
  (`pnpm test:mutation`, `stryker.config.mjs`). Add tests only for survivors that expose a real gap.
- Contract tests exist: `tests/plugin-boundaries.test.ts`, `tests/run-events-contract.test.ts`,
  `tests/command-catalog-tui-parity.test.ts`. Keep them green when changing those surfaces.

## TypeScript, lint, format

- `strict`, `noUncheckedIndexedAccess`, ES2023, ESM, `.ts` specifiers in imports.
- Biome (`biome.json`): 2 spaces, line width 100, organized imports, `preset: none` linter.
  Run `pnpm format` to fix; `pnpm lint` to check.
- Public/wire types change additively (optional fields); keep `RunEvent.schemaVersion` and server
  `protocolVersion` stable while additive. SQLite migrations are forward-only and additive.
- Validate untrusted input at the boundary (zod in core/plugins; hand-written checks in
  `packages/server/src/schemas.ts`, which adds no schema library).

## Errors and security

- Fail closed: permissions default to ask/deny; effect gate is `core/src/permissions/decide.ts`
  (one function for every caller). Unknown tool effect = `external`.
- Never log or return secrets, tokens, request bodies or file contents in errors; server failures
  are generic codes (`ApiErrorCode`), details only for validation field paths.
- Project config, plugins, agents and skills load only from trusted projects (`core/src/trust.ts`).
- Executable plugins are trusted in-process code; `--read-only` disables them.
- Subprocesses run with the user's privileges: document it, bound time and output, no shell
  interpolation of untrusted strings.

## Decision Intelligence admission

Use the decision engine (`ctx.decisions`, Decision Packs) only for closed choices deterministic
code cannot make. Before adding one, answer in order: closed outcome set? frequent enough? reduces
tokens/cost/latency/variability? safe fallback? The PR must also state: which decision, what LLM
work it removes, which metric improves, fallback, behavior without a provider, output validation,
why deterministic code is insufficient, and what goes into `state` (a remote provider may receive
it). If unclear, do not use it. Details: `docs/decision-intelligence.md`.

## Docs

- English `docs/<page>.md`, Spanish `docs/es/<page>.md`, both in the sidebar of
  `docs/.vitepress/config.ts`. Same headings in the same order, same code blocks; commands, flags
  and config keys identical; translate faithfully, update both in the same change.
- `docs/es/limitations.md` includes `docs/implementation-status.md`; keep the English
  `docs/limitations.md` aligned with it.
- Duty: record limitations and verification scope in `docs/implementation-status.md` (Spanish)
  whenever they change. Do not claim absolute security.
- Web UI feature docs need a real screenshot: load `alisio-docs-screenshots`.

## Versioning and generated files

- Every PR changing a published package adds a changeset (`pnpm changeset`; `.changeset/`).
- Embedded sources are generated; regenerate after editing their inputs and never hand-edit:
  `node --experimental-strip-types scripts/analysis-runtime-sources.ts`,
  `scripts/analysis-data-engine.ts`, `scripts/pyodide-runner-source.ts`
  (outputs: `core/src/analysis/python/sources.ts`, `analysis/data/engine-source.ts`,
  `forge/python/pyodide-runner-source.ts`). Tests fail when stale.

## Delivery checklist (all must pass)

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm test:cli && pnpm test:compiled && pnpm pack:check
pnpm docs:check && pnpm docs:build
```

`pnpm check` runs everything above except `pnpm docs:check` (it is part of `pnpm docs:build`, but run
it explicitly to see its report). `pnpm docs:check` validates internal links, `#anchors`, local
images and EN/ES parity.
