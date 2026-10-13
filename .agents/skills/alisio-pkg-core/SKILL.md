---
name: alisio-pkg-core
description: "Working in packages/core (@alisio/core): runner/tool loop, tools and permissions, sessions and the SQLite store with migrations, plugin host, providers, config, Forja (JS/Python execution), analysis, goal/plan/background. Entry points, conventions, gotchas and how to test. Use this skill whenever you edit, review or debug anything under packages/core, add a tool, config key, migration or slash command."
---

# `@alisio/core`

Public API = `packages/core/src/index.ts` (re-exports all of `@alisio/sdk`). Second export
`./forge-isolate` (`src/forge-isolate.ts`) is the process-isolate entry of the compiled binary.
Map and boundaries: `alisio-architecture`. Rules: `alisio-coding-standards`.

## Where things are (`packages/core/src/`)

| Area | Entry points |
|---|---|
| App wiring | `application.ts` (`createApplication`, `BuiltinPlugin`), `config.ts` (zod schema, layered config), `trust.ts` (per-directory project trust) |
| Loop | `core/runner.ts` (`AgentRunner`), `core/contracts.ts` (`SessionStore` etc.), `core/registry.ts` (`ToolRegistry`), `core/compaction.ts`, `core/timeout.ts`, `core/truncation.ts`, `core/human-wait.ts` (pausable clock) |
| Tools | `tools/standard.ts` (fs/shell/search), `tools/webfetch.ts`, `tools/search.ts`, `tools/js-run.ts`, `tools/goal.ts`, `tools/background.ts`, `tools/analysis.ts`, `tools/artifacts.ts` |
| Permissions | `permissions/decide.ts` (single effect gate), `permissions/modes.ts` |
| Persistence | `runtime/store.ts` (`SQLiteStore`), `runtime/sqlite.ts` (port adapter), `runtime/blobs.ts`, `runtime/paths.ts` |
| Plugins | `plugins/host.ts` (`PluginHost`), `plugins/install.ts`, `runtime/modules.ts` (resolution), `extensions/registry.ts` |
| Providers | `providers/registry.ts`, `providers/routing.ts`, `providers/settings.ts` |
| Sessions | `sessions/children.ts` (child sessions), `agents/` (definitions, active agent) |
| Forja | `forge/` (`kernel.ts` lifecycle, `broker.ts` capabilities, `ports.ts`, `javascript/`, `python/`, `journal.ts`, `limits.ts`) |
| Other | `analysis/`, `artifacts/`, `background/`, `goal/`, `plan/`, `decisions/`, `mcp/`, `commands/catalog.ts`, `resources/` (skills, prompts, context), `startup/`, `changelog/` |

## Conventions and gotchas

- Core stays generic: no reference to a specific plugin; plugin features arrive via host APIs.
- Any new tool declares an honest `effect`; the runner, `availableTools`, legacy `execute` and the
  Forja nested dispatcher must all go through `permissions/decide.ts`. No second permission path.
- Runner invariants: every stored tool call has a result; cut/retried responses are never
  persisted half-way; `limits.timeoutMs` counts active time (human waits pause it); events are
  additive (`RunEventDataMap` in the SDK; update `tests/run-events-contract.test.ts`).
- Store: add migrations forward-only and additive (next version after `schema_migrations` 10); old
  binaries must ignore new tables/columns. Never rewrite rows destructively.
- New slash commands go through `commands/catalog.ts` so TUI, web and API share them (see
  `tests/command-catalog-tui-parity.test.ts`).
- New config keys: zod schema in `config.ts`, settings labels in EN and ES for the web
  (`tests/web-i18n.test.ts` fails otherwise), docs EN/ES.
- Forja engines are adapters behind ports; `ExecutionKernel` owns limits, journal, deadline. Never
  claim an engine is more isolated than `IsolationLevel` states. Embedded sources are generated
  (see `alisio-coding-standards`).
- Only portable Node APIs; Bun-specific paths are guarded by `process.versions.bun`.

## Testing

Tests in root `tests/` import from `../packages/core/src/index.ts`. Use a scripted
`ModelProvider` (async generator yielding `ProviderEvent`s), temp dirs, stubbed
`ALISIO_CONFIG_HOME`/`ALISIO_STATE_HOME`, real SQLite. Runner behavior: `tests/runner-*.test.ts`;
Forja: `tests/forge-*.test.ts` (helpers `forge-*-helpers.ts`; real Pyodide/Docker behind env flags).
