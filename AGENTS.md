# Alisio contributor instructions

## Who Alisio is

Alisio is a coding-agent harness with its own TypeScript core. It connects to any OpenAI-compatible
endpoint, drives its own tool loop and runs in your terminal, either as an interactive TUI or
headless for scripts and CI.

- **Developed in Bogotá, Colombia** by **Ing. Gustavo Gutiérrez Mercado**.
- **npm packages**: published under the alisio organization at
  <https://www.npmjs.com/settings/alisio/packages> (CLI: `@alisio/alisio-code`).
- **Source repository**: <https://github.com/GustavoGutierrez/alisio>.
- **Developer profile**: <https://github.com/GustavoGutierrez> ·
  LinkedIn: <https://www.linkedin.com/in/gustavo-gutierrez-mercado>.
- **Documentation** (EN/ES): <https://gustavogutierrez.github.io/alisio/>.

## Skills index (`.agents/skills/`)

**Before coding in this repo, load `alisio-architecture` and `alisio-coding-standards`, plus the
relevant package or plugin skill.**

| Skill | Load when |
|---|---|
| `alisio-architecture` | Any coding: package map, boundaries, data flow, conventions |
| `alisio-coding-standards` | Any coding: TDD, lint, security rules, delivery checklist, docs parity |
| `alisio-plugins` | Creating or changing a plugin, the plugin host or `packages/plugin-*` |
| `alisio-pkg-core` | Editing `packages/core` |
| `alisio-pkg-sdk` | Editing `packages/sdk` (public contract) |
| `alisio-pkg-server` | Editing `packages/server` (HTTP/SSE API) |
| `alisio-pkg-web` | Editing `packages/web` (browser UI, i18n) |
| `alisio-pkg-cli-tui` | Editing `packages/cli` (CLI, TUI) |
| `alisio-docs-screenshots` | Documenting or changing a Web UI feature (screenshot rule) |
| `alisio-specs` | Writing, executing or archiving a spec under `specs/`; test strategy |
| `alisio-publish` | Publishing, releasing or bumping versions on npm |

## Publishing

Whenever the user asks to publish/release/bump any Alisio package, load the skill
`.agents/skills/alisio-publish/SKILL.md` and follow its canonical flow: manual stable semver bump of
all 7 packages, commit+push, `pnpm run publish -- --all`, verification with HTTP 200 tarballs and real
install. Never run `npm publish` directly; `package@version` is immutable; npm publishes are
async; OTP is entered by the operator, never shared in chat. Produce the commands with the
repo root completed (no absolute user paths inside the skill itself).

## Specs

Specs under `specs/` follow `.agents/skills/alisio-specs/SKILL.md` (numbering, folders, skeleton,
test strategy). Load it before writing or executing one.

## Hard rules (details in the skills)

- Use pnpm for dependencies; keep only `pnpm-lock.yaml`.
- Runtime is Node-first (Node >=22.16) and must keep working on Bun; Bun also builds the optional
  standalone binary. Use only portable Node APIs in packages; no Bun globals.
- Keep provider SDKs and runtime-specific imports out of the public SDK and agent-core contracts.
- Plugins depend only on `@alisio/sdk` (peer) and never import `@alisio/core` internals. Never
  treat a plugin manifest or a subprocess as a sandbox.
- Preserve tool call IDs, provider continuation data and persisted session consistency.
- Keep the English and Spanish documentation pages in parity (see CONTRIBUTING.md); document
  limitations and verification scope in `docs/implementation-status.md`.
- Test behavior at module boundaries; no snapshot tests that merely restate implementation.
- Before delivery run the checklist in `alisio-coding-standards` (`pnpm typecheck`, `lint`, `test`,
  `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build`).
- Web UI features need a real screenshot in the EN and ES docs: see `alisio-docs-screenshots`.
