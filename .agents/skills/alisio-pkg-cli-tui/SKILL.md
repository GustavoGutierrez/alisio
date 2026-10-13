---
name: alisio-pkg-cli-tui
description: "Working in packages/cli (@alisio/alisio-code, the `alisio` binary): commander commands and flags, headless `run`, the pi-tui based TUI, built-in plugin wiring, prompts, standalone binary packaging and e2e tests. Use this skill whenever you edit anything under packages/cli, add or change a CLI flag/command, a TUI feature or slash command behavior."
---

# `@alisio/alisio-code` (`packages/cli`)

Binary `alisio` (`dist/main.js`). Depends on core, server, sdk, the three built-in plugins,
`@earendil-works/pi-tui` (patched, see `patches/`) and `commander`. Related: `alisio-architecture`,
`alisio-plugins`, `alisio-pkg-server`.

## Layout (`src/`)

| File/dir | Role |
|---|---|
| `main.ts` | commander program: default TUI, `run`, `resume`, `serve`, `setup`, `doctor`, `analysis`, `forge`, `trust`, `sessions`, `skills`, `plugins`, `mcp`, `install`... |
| `builtin.ts` | `BUILTIN_PLUGINS` registry; add a built-in by appending an entry |
| `serve.ts` | loads `@alisio/server` only for `serve` (lazy) |
| `tui/` | interactive UI: `app.ts` (main loop), `state.ts` (command set, `reservedCommandNames`), feature modules (`agents`, `goal`, `tasks`, `plan-review`, `settings-menu`...) |
| `prompts/` | built-in prompt templates (`/init`, ...) |
| `banner.ts`, `forge.ts`, `analysis.ts`, `version.ts` | startup screen host, subcommand helpers |

## Rules and gotchas

- The CLI decides policy flags (`--allow-write`, `--allow-process`, `--read-only`, `--trust-project`,
  `--plugin`); permission logic itself stays in core. Headless runs cannot ask: an effect no flag
  grants is denied (`core/src/permissions/decide.ts`). `--json` output is JSONL of `RunEvent`s;
  keep it additive and stable.
- Slash commands shared with web/API belong in core's `commands/catalog.ts`; TUI-only ones go in
  `tui/state.ts`. Keep `tests/command-catalog-tui-parity.test.ts` green.
- Keep startup cheap: lazy `import()` for heavy modules (see `cliDefaults`, `serve.ts`).
- Runs on Node >= 22.16 and Bun; no Bun globals. `pnpm dev` runs from source with Bun
  (`--conditions=alisio-source`); `pnpm build:binary` builds the standalone binary.
- TUI text: English; width-aware, no assumptions about color/unicode (use terminal capabilities).
- New flag or command: update `--help`, `docs/` EN/ES (`docs/tui.md`, `docs/configuration.md`...).

## Testing

Unit/integration in `tests/` (`tui-*.test.ts`, `cli-*.test.ts`, `command-catalog*.test.ts`).
End-to-end: `pnpm test:cli` (built CLI under Node against `fixtures/` fake provider) and
`pnpm test:compiled` (standalone binary). `pnpm pack:check` validates published tarballs.
