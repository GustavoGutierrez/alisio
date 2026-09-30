# Architecture

Alisio is a pnpm monorepo with nine publishable packages. The OpenAI SDK adapter lives in
`@alisio/plugin-openai-compatible`; core contains only provider contracts, the additive registry,
activation and persistence.

<div class="architecture-diagram" role="region" aria-label="Scrollable Alisio package architecture diagram" tabindex="0">
  <img src="/assets/architecture.en.svg" alt="Alisio package dependencies: the CLI wires core, SDK, memory and subagents; core depends on SDK, while the plugins use SDK as a peer dependency." width="690" height="972" />
</div>

| Package | Role | Depends on |
| --- | --- | --- |
| `@alisio/sdk` | Public plugin contract: types plus `definePlugin` and `textResult`. No runtime or provider imports | Nothing |
| `@alisio/core` | Provider-neutral runner, provider registry/activation/persistence, tools, runtime adapters, plugin host, child sessions, configuration and MCP | `@alisio/sdk`, MCP client, `ajv`, `yaml`, `zod` |
| `@alisio/plugin-openai-compatible` | Built-in Chat Completions/Responses adapter and model discovery | `@alisio/sdk` (peer), `openai` |
| `@alisio/plugin-memory` | Built-in persistent memory plugin | `@alisio/sdk` (peer), `zod` |
| `@alisio/plugin-subagents` | Built-in [subagents](/subagents) plugin: agent definitions, delegation tools, limits, git worktrees and the agent tree | `@alisio/sdk` (peer), `yaml`, `zod` |
| `alisio` | CLI, TUI and built-in registry wiring the provider, memory and subagents plugins | `@alisio/core`, all built-in plugins, `@alisio/sdk`, `@earendil-works/pi-tui`, `commander` |

Dedicated model providers (DeepSeek, OpenCode Console (Zen), OpenCode Go) are `@alisio/plugin-*`
packages published from the [alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins)
monorepo and installed separately with `alisio install npm:@alisio/plugin-...`.

Provider SDKs and runtime-specific imports stay out of the public SDK and the agent-core contracts.

## Storage port

Plugins never import a SQLite driver. `api.storage.sqlite(path)` returns the `SqlDatabase` port
defined in `@alisio/sdk` (`exec`, `prepare`, `transaction`, `close`), implemented by `@alisio/core`
over `node:sqlite` with FTS5. The memory plugin is written only against this port, which is why it
depends on nothing but the SDK and `zod`.

## Built-in and external plugins

| | Built-in | External |
| --- | --- | --- |
| Source | Registry in the CLI (`packages/cli/src/builtin.ts`) | `--plugin`, `plugins` config, global or trusted project plugin directories |
| Trust path | Host's trusted path, also under `--read-only`, without `--trust-project` | Explicit trust only; disabled by `--read-only` |
| Names | Unprefixed tools and commands | `p_<hash>_` tool prefix, `id:name` commands |
| `internal` effect | Allowed | Downgraded to `external` |
| Configuration | `builtinPlugins.<id>`; disabled with `enabled: false` or `--disable-plugin <id>` | Plugin-specific |

The core contains no references to memory: the CLI passes its registry to `createApplication`. Adding
another built-in means appending an entry to that registry.

## Child sessions

`@alisio/core` provides a generic child sessions service (`packages/core/src/sessions/children.ts`),
exposed to plugins as `api.sessions`. A child session is a persisted conversation with a parent link
that runs through the same runner with narrowed permissions: tools, capabilities and approvals are
intersected with the parent's, a read-only parent makes the subtree read-only, and aborting a parent
aborts its running descendants. On startup, children left running or queued are marked
`interrupted`. The service contains no agent logic: definitions, limits, queues, git worktrees and the
agent tree live in `@alisio/plugin-subagents`, and the TUI only renders generic panels
(`api.ui.panel`) and read-only session views. See [Child sessions](/plugins#child-sessions).

## Extension registry

`@alisio/core` keeps a typed extension registry in the plugin host (`packages/core/src/extensions`).
Plugins register providers for the points declared in `ExtensionPoints` of `@alisio/sdk`
(`mascot`, `startup-screen`). Resolution is deterministic and independent of plugin load order:
highest priority, then plugin ID, then registration order within a plugin; ties at the winning
priority are reported as `extension_conflict` diagnostics. `renderStartup`
(`packages/core/src/startup`) resolves the providers, validates, sanitizes and clamps their output,
and falls back to `DefaultAlisioMascot` and `DefaultStartupScreen` when a provider fails. The CLI
(`packages/cli/src/banner.ts`) only decides when to show the screen and detects the terminal
capabilities. See [Extension points](/plugins#extension-points).

## Runtime

Alisio runs on Node.js >= 22.16 or Bun >= 1.4.2. Both provide `node:sqlite`, which stores sessions
(conversation, events, tool journal, plugin state, session lock) and memory. Node.js 22.16 is the
minimum because earlier 22.x builds lack FTS5.

## Run events {#run-events}

The runner reports progress as `RunEvent`s: to `onEvent` embedders, to plugins (`events.on`) and as
JSONL with `alisio run --json`. `schemaVersion` stays `1` while changes are additive, so consumers
must ignore unknown fields and event types.

| Field | Meaning |
| --- | --- |
| `runId` | One run of the agent loop. Embedders may preassign it (`RunOptions.runId`); otherwise a UUID |
| `seq` | Per-run counter starting at 1; it restarts on every run |
| `eventId` | Optional. The persisted global `events.seq` as a string, unique and increasing across runs. Absent for ephemeral events |
| `correlationId` | Optional. Copied from `RunOptions.correlationId` (for example an HTTP request id) to every event of the run |

`text_delta`, `reasoning_delta` and `tool_progress` are ephemeral (`EphemeralRunEventType`): they
stream to observers but are never stored, so they carry no `eventId`. Every other event is stored
before observers see it. `turn_completed` adds `durationMs` (provider request to completed response)
and `ttftMs` (time to the first streamed delta, absent when the provider streamed nothing).
`RunEventDataMap` and `KnownRunEvent` in `@alisio/sdk` type the payload of every event the core
emits; `tests/run-events-contract.test.ts` checks the runner against them.

## Session database (v4) {#session-database}

`SQLiteStore` migrates forward only and additively: a database written by an older Alisio opens at
schema version 4 without losing rows, and an older binary ignores the new tables and columns.
Version 4 adds:

| Addition | Purpose |
| --- | --- |
| `runs` table | One row per `AgentRunner.run` (`id` = `RunEvent.runId`): `queued` → `running` → `completed`, `turns_exceeded`, `failed`, `cancelled` or `interrupted`, with model, usage, times, error, owner process and an optional `request_id` unique per session |
| `workspaces` table | Optional UI metadata (label, pin, last opened) |
| `blobs` table | Metadata of content-addressed attachment bytes |
| New nullable columns | Session pin/archive, event `created_at`/`correlation_id`, tool call `run_id`/`name`/`effect`/`started_at`/`ended_at` |

The runner journals every run when the store implements the optional `SessionStore` methods
(`beginRun`, `endRun`, `runByRequest`, `runs`, `messagesPage`, `eventsPage`, `interruptRuns`), so TUI
and headless runs are recorded too; other `SessionStore` implementations keep working without them.
Retrying `beginRun` with the same `requestId` in a session returns the existing run instead of
creating one. At startup `createApplication` marks runs left `queued`/`running` by a dead process as
`interrupted`, next to the existing reconciliation of child sessions. Root sessions now record
`createdAt`/`updatedAt`.

## Attachment blobs {#blobs}

`BlobStore` (`app.blobs`) keeps uploaded bytes under `<state home>/blobs/sha256/<aa>/<hash>`
(directories `0700`, files `0600`, written atomically and deduplicated by SHA-256) and their metadata
in the `blobs` table. `Attachment.data` is still required, so a blob never reaches the runner by
reference: the host turns a `BlobRef` into a verified base64 image `Attachment` with
`blobs.attachment(ref)` before `runner.run`. Messages therefore keep storing base64, exactly like
inline attachments, which keep working unchanged.

## Command catalog {#command-catalog}

`CommandCatalog` lists, resolves and runs slash commands for every surface. Its sources are the
built-in commands (`BUILTIN_COMMANDS`), plugin commands, prompt templates and effective skills
(`skill:<id>`); on a name collision the first source in that order wins. Each `CommandDescriptor`
declares its `surfaces` (`tui`, `web`, `api`) and its `execution`: `core` commands (`compact`,
`model`, `effort`, `clear`/`new`, `sessions`, `resume`, `stats`, `tools`, `skills`, `plugins`, `mcp`,
`agents` and plugin commands) run through `execute(name, args, { sessionId })`; `surface` commands
(`help`, `connect`, `settings`, `copy`, `ask`, `exit`, templates and skills) are handled by each UI.
The TUI takes its command list and name resolution from the catalog and delegates `/tools` and
`/sessions` to it; its output is unchanged.

## Source resolution in development

Each package exports its built `dist` files, plus a development-only `alisio-source` export condition
pointing at `src/*.ts`. The root `tsconfig.json` sets `customConditions: ["alisio-source"]` and
`pnpm dev` runs Bun with `--conditions=alisio-source`, so workspace packages resolve to their
TypeScript sources without a build. The condition is removed from the published `exports` through
`publishConfig`.

## Build and release

- **Build**: `pnpm build` runs `tsc -p tsconfig.build.json` in each package, emitting JavaScript and
  declarations to `dist`.
- **Binary**: `pnpm build:binary` compiles `packages/cli/dist/main.js` with `bun build --compile`.
- **Versioning**: [changesets](https://github.com/changesets/changesets). The release workflow opens a
  version PR or publishes to npm with provenance.
- **Binaries**: after a publish, the release workflow cross-compiles standalone binaries with Bun
  (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`), writes `SHA256SUMS`
  and creates a GitHub Release (pre-release for pre-release versions).
- **Docs**: this site is built with VitePress and deployed to GitHub Pages.
