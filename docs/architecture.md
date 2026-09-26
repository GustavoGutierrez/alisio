# Architecture

Alisio is a pnpm monorepo with four packages.

```text
                      ┌──────────────────────────────┐
                      │ @alisio/sdk                  │
                      │ plugin contract, zero deps   │
                      └──────────────▲───────────────┘
                 depends on          │           peer dependency
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
┌───────┴──────────────────────┐     │     ┌──────────────────────┴───────┐
│ @alisio/core                 │     │     │ @alisio/plugin-memory        │
│ runner, compaction, provider,│     │     │ @alisio/sdk (peer) + zod     │
│ tools, runtime adapters      │     │     │ uses the storage port        │
│ (node:sqlite, fs,            │     │     └──────────────▲───────────────┘
│ child_process), plugin host, │     │                    │
│ config, createApplication    │     │                    │
└───────▲──────────────────────┘     │                    │
        │                            │                    │
        │             ┌──────────────┴───────────────┐    │
        └─────────────┤ alisio (CLI)                 ├────┘
                      │ bin, TUI, clipboard,         │
                      │ built-in registry wiring     │
                      │ plugin-memory                │
                      └──────────────────────────────┘
```

| Package | Role | Depends on |
| --- | --- | --- |
| `@alisio/sdk` | Public plugin contract: types plus `definePlugin` and `textResult`. No runtime or provider imports | Nothing |
| `@alisio/core` | Agent runner and tool loop, compaction, OpenAI-compatible provider, standard tools, runtime adapters (`node:sqlite`, `fs`, `child_process`), plugin host, extension registry, startup rendering, configuration, MCP client, Herdr bridge and `createApplication` | `@alisio/sdk`, `openai`, MCP client, `ajv`, `yaml`, `zod` |
| `@alisio/plugin-memory` | Built-in persistent memory plugin | `@alisio/sdk` (peer), `zod` |
| `alisio` | CLI: `bin`, TUI, clipboard adapter and the built-in plugin registry that wires `plugin-memory` | `@alisio/core`, `@alisio/plugin-memory`, `@alisio/sdk`, `@earendil-works/pi-tui`, `commander` |

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
