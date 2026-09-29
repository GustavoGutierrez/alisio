# Architecture

Alisio is a pnpm monorepo with nine publishable packages. The OpenAI SDK adapter lives in
`@alisio/plugin-openai-compatible`; core contains only provider contracts, the additive registry,
activation and persistence.

```text
                         ┌──────────────────────────────┐
                         │ @alisio/sdk                  │
                         │ plugin contract, zero deps   │
                         └──────────────▲───────────────┘
            depends on                  │                peer dependency
   ┌────────────────────────────────────┼─────────────────────┬──────────────────────┐
   │                                    │                     │                      │
┌──┴───────────────────────────┐        │      ┌──────────────┴───────────┐ ┌────────┴─────────────────┐
│ @alisio/core                 │        │      │ @alisio/plugin-memory    │ │ @alisio/plugin-subagents │
│ runner, compaction, provider,│        │      │ sdk (peer) + zod         │ │ sdk (peer) + yaml + zod  │
│ tools, runtime adapters      │        │      │ uses the storage port    │ │ uses api.sessions        │
│ (node:sqlite, fs,            │        │      └──────────────▲───────────┘ └────────▲─────────────────┘
│ child_process), plugin host, │        │                     │                      │
│ child sessions, config,      │        │                     │                      │
│ createApplication            │        │                     │                      │
└──▲───────────────────────────┘        │                     │                      │
   │                     ┌──────────────┴───────────────┐     │                      │
   └─────────────────────┤ alisio (CLI)                 ├─────┴──────────────────────┘
                         │ bin, TUI, clipboard,         │
                         │ built-in registry wiring     │
                         │ plugin-memory and            │
                         │ plugin-subagents             │
                         └──────────────────────────────┘
```

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
