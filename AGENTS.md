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

## Publishing (skill)

Whenever the user asks to publish/release/bump any Alisio package, load the skill
`.opencode/skills/alisio-publish/SKILL.md` and follow its canonical flow: manual alpha bump,
commit+push, `pnpm run publish -- --package …`, verification with HTTP 200 tarballs and real
install. Never run `npm publish` directly; `package@version` is immutable; npm publishes are
async; OTP is entered by the operator, never shared in chat. Produce the commands with the
repo root completed (no absolute user paths inside the skill itself).

Use pnpm for dependencies (keep only pnpm-lock.yaml). The runtime is Node-first (Node >=22.16)
and must keep working on Bun; Bun also builds the optional standalone binary.
Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`,
`pnpm pack:check`, `pnpm docs:check` and `pnpm docs:build` before delivery.
Keep provider SDKs and runtime-specific imports out of the public SDK and agent-core contracts.
Use only portable Node APIs (node:fs, node:child_process, node:sqlite) in packages; no Bun globals.
Plugins depend only on @alisio/sdk (peer) and never import @alisio/core internals.
Preserve tool call IDs, provider continuation data and persisted session consistency.
Never treat a plugin manifest or a subprocess as a sandbox.
Test behavior at module boundaries. Do not add snapshot tests that merely restate implementation.
Document limitations and verification scope in docs/implementation-status.md.
Keep the English and Spanish documentation pages in parity (see CONTRIBUTING.md).
