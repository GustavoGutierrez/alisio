---
name: alisio-architecture
description: "Alisio monorepo map: what each package does, dependency direction and hard boundaries, runtime constraints (Node-first, Bun-compatible), tool-loop and session data flow, where code belongs and naming conventions. Use this skill before coding anywhere in this repo, and whenever you add a module, file or package, decide where code should live, touch imports between packages, or are unsure which package owns a behavior, even if the user does not mention architecture."
---

# Alisio architecture

Load before any coding. Package-specific detail lives in `alisio-pkg-*` skills; plugins in
`alisio-plugins`; rules and checks in `alisio-coding-standards`.

## Packages (`packages/*`, pnpm workspace)

| Package | Role | Depends on |
|---|---|---|
| `@alisio/sdk` | Public contract: types + `definePlugin`, `textResult` and small runtime helpers (errors, constants). No provider SDKs | nothing |
| `@alisio/core` | Agent runner (tool loop), tools, sessions/store (SQLite), plugin host, providers registry, permissions, config, MCP, Forja, analysis, goal/plan/background | `@alisio/sdk` |
| `@alisio/server` | `alisio serve`: `node:http` + SSE API, auth, serves the web build | `core`, `sdk` (+ `@alisio/web` as devDependency for the build) |
| `@alisio/web` (private) | Preact + signals web UI, built with Vite; copied into `server/dist/web` | `@alisio/sdk` types only (`import type`) |
| `@alisio/alisio-code` (`packages/cli`) | `alisio` binary: commander CLI, TUI (`@earendil-works/pi-tui`), wires built-ins | `core`, `server`, `sdk`, all built-in plugins |
| `@alisio/plugin-memory`, `plugin-subagents`, `plugin-openai-compatible` | Built-in plugins | `@alisio/sdk` as peer only |

Dedicated model providers (DeepSeek, OpenCode...) live in another repo (`alisio-plugins`), not here.

## Dependency direction (never reverse)

```
sdk  <-  core  <-  server  <-  cli        plugins -> sdk (peer)      web -> sdk (types)
```

- `sdk` and the agent-core contracts (`packages/core/src/core/contracts.ts`) import no provider SDK
  and no runtime-specific module.
- Core never references a specific plugin: the CLI passes `BUILTIN_PLUGINS`
  (`packages/cli/src/builtin.ts`) to `createApplication`. Add a built-in by appending there.
- `cli` loads `@alisio/server` lazily (`packages/cli/src/serve.ts`) so `alisio run` and the TUI
  never load the HTTP server.
- Plugins never import `@alisio/core` or another plugin (enforced by `tests/plugin-boundaries.test.ts`).
- Web never imports `@alisio/core`; it shares only wire types from `@alisio/sdk`.

## Runtime constraints

- Node >= 22.16 (FTS5 in `node:sqlite`) first; must also run on Bun >= 1.4.2 (dev uses
  `bun --conditions=alisio-source`; Bun builds the optional standalone binary).
- Portable APIs only: `node:fs`, `node:child_process`, `node:sqlite`, `node:http`. No `Bun.*`
  globals. Bun-only branches are guarded by `process.versions.bun` (see `packages/core/src/forge/`).
- The custom export condition `alisio-source` makes tests/dev resolve `src/*.ts`; published
  builds use `publishConfig.exports` -> `dist/`.

## Data flow

1. Entry (CLI `main.ts`, TUI `tui/app.ts`, or server routes) calls `createApplication`
   (`packages/core/src/application.ts`): loads config, trust, plugins, providers, tools, store.
2. `AgentRunner` (`core/src/core/runner.ts`) runs the loop: build context -> provider stream ->
   tool calls -> permission gate (`permissions/decide.ts`, by tool `effect`) -> execute -> append
   result -> next turn. Every step emits a versioned `RunEvent` (`@alisio/sdk`).
3. `SQLiteStore` (`core/src/runtime/store.ts`) persists sessions, events, tool-call journal
   (`tool_calls` keyed by session + `call_id`), runs, blobs, plugin state. Migrations are
   forward-only and additive (`schema_migrations`, currently up to v10).
4. Server/TUI/web render events; the server fans them out over SSE (`server/src/sse/hub.ts`).

Invariants: tool call IDs and provider continuation data are preserved verbatim; a cut or retried
provider response never leaves a tool call without a result; retries do not append to the session.

## Patterns in use

- Hexagonal ports/adapters: Forja ports (`core/src/forge/ports.ts`), storage port `SqlDatabase`
  in the SDK implemented by `core/src/runtime/sqlite.ts`.
- Template Method: `ExecutionKernel` (`core/src/forge/kernel.ts`).
- Registry + deterministic resolution: providers, extension points (`core/src/extensions/registry.ts`).
- Pure decision functions shared by all callers: `permissions/decide.ts`.
- Pure reducers + signals in the web store; the server validates requests without a schema lib.
- Additive, versioned contracts: new fields optional, `schemaVersion`/`protocolVersion` unchanged.

## Conventions

- ES modules, `.ts` import specifiers (`allowImportingTsExtensions`), kebab-case file names,
  one concern per file, domain folders under `core/src/` (e.g. `goal/`, `plan/`, `forge/`).
- Public API of a package = its `src/index.ts` exports; new core exports go there.
- Tests live in root `tests/` (flat, `<area>-<topic>.test.ts`), not next to sources.
- Specs live in `specs/` (see `alisio-specs`); user docs in `docs/` (EN) and `docs/es/` (ES).
- Generated files (embedded Python/data-engine/Pyodide sources) are rebuilt by scripts listed in
  `CONTRIBUTING.md`; tests fail when stale. Never hand-edit them.
