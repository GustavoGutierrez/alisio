---
name: alisio-plugins
description: "How to create, change, test and publish an Alisio plugin: Plugin object and manifest, PluginAPI surface (tools, commands, views, hooks, storage, sessions, extensions, providers), permissions/effects, limits, the @alisio/sdk-only dependency rule, packaging and a minimal skeleton. Use this skill whenever you write or edit anything under packages/plugin-*, examples/plugins, the plugin host, plugin docs, or when the user asks to extend Alisio with a tool, command, view or provider."
---

# Alisio plugins

Reference page: `docs/plugins.md` (+ `docs/es/plugins.md`). Contract: `packages/sdk/src/index.ts`
(`Plugin`, `PluginAPI`, `ToolDefinition`, `ToolContext`). Host: `packages/core/src/plugins/host.ts`.
Related: `alisio-pkg-sdk`, `alisio-coding-standards`.

## Non-negotiables

- A plugin depends ONLY on `@alisio/sdk` (declared as **peerDependency**, also a devDependency).
  It never imports `@alisio/core`, another plugin, or files outside its own package dir.
  Enforced by `tests/plugin-boundaries.test.ts` for every `packages/plugin-*`.
- Plugins are trusted, in-process code with the full privileges of the Alisio process. A manifest,
  an `effect` label or a subprocess is NOT a sandbox. Never document or imply isolation.
- New SDK/host capabilities are optional in the contract: feature-detect (`api.views?.register`,
  `api.decisions?`, `api.paths?`, `api.options?`, `api.proof?`) so a plugin runs on an older core.
- Use the storage port (`api.storage.sqlite`), never a SQLite driver; no provider SDK or Bun
  global in plugin code except a provider plugin's own client (e.g. `openai` in
  `plugin-openai-compatible`).

## The `Plugin` object

`definePlugin({ id, version, apiVersion: 1, name?, description?, categories?, extensions?, setup(api), dispose?() })`.

- `id`: `^[a-z0-9][a-z0-9.-]{0,63}$`, unique. `version`: semver. `apiVersion`: always `1`.
- `setup` registers everything (async allowed); failure rolls back partial registrations; every
  `register`/`on` returns an unregister function.
- `dispose` runs only on close (not on disable or `/reload`), limit `pluginHooks.disposeTimeoutMs`.
- `categories` from `PluginCategory` (`model-provider`, `memory`, `subagents`, `search`, `tools`,
  `security`, `analytics`, `mcp`, `storage`, `ui`, `decisions`, `methodology-harness`).

## What a plugin CAN do (`PluginAPI`)

| Need | API |
|---|---|
| Tool for the model | `api.tools.register({ name, description, inputSchema, effect, execute })`; return `textResult(text, isError?)`, optional `{type:"ui", block}` parts (keep a text part too) |
| Slash command | `api.commands.register(name, handler, { description, argumentHint })` |
| Observe run events | `api.events.on(handler)` (ignore unknown event types) |
| Add model context / skills / prompts / agents | `api.context.register`, `api.resources.skills/prompts/agents(path)` |
| Compaction, session hooks | `api.compaction.register`, `api.session.onStart/onEnd` (timeouts `pluginHooks.*`) |
| Small state, private SQLite | `api.state.get/set`, `api.storage.sqlite(path)` (0600, FTS5), `api.paths` |
| Read-only data for web | `api.views?.register({ id, description, params, handler })` |
| Model access | `api.model.complete`, `api.models.list/resolve`, `api.providers.register` |
| Child sessions | `api.sessions.*` (narrowed permissions; see `plugin-subagents`) |
| UI | `api.ui.status/panel/select/askQuestions` (no-op or `undefined` when headless) |
| Replace a host piece | `api.extensions.register("mascot" \| "startup-screen" \| "websearch", provider, { priority })` |
| Decisions | `api.decisions?.registerProvider` (see Decision Intelligence rule in `alisio-coding-standards`) |
| Proof verifier | `api.proof?.registerVerifier({ id, describe, run(input, ctx) })` -> `{ ok, outputHash, callId? }`; no traceable evidence = `manual_review`; `ctx.callTool` goes through the core gate (no extra permission) |

Config: `pluginOverrides[id].options` is read via `api.options` (global only, <= 8 KB, snapshot at
`setup`, never put secrets there).

## What a plugin CANNOT do (or is bounded)

- Cannot gain a permission its parent session lacks; child sessions only narrow.
- External tool `effect: "internal"` is downgraded to `external`; only built-ins keep `internal`.
  Unknown/undeclared effect = `external`. Declare `read` only for side-effect-free tools.
- `capability` and `ToolContext.artifacts/approveInstall/emitEvent` are built-in-only.
- External names are prefixed: tools `p_<10 hex of sha256(id)>_<name>`, commands `<id>:<name>`.
- Views: read-only by contract (not isolation); <= 1 MiB JSON, 5 s timeout, <= 16 query params.
- Startup mascot/screen providers: no globals/env/fs, <= 250 ms, 12/60 lines, output sanitized.
- Hooks run in-process: a timeout cannot stop blocking synchronous code.
- Disabled via `--read-only` (external plugins), untrusted project, or `--disable-plugin`.
- Local `.ts` plugins need Bun or Node >= 22.18 (erasable syntax only); published plugins ship JS.

## Loading and trust

`--plugin <path|package>`, `plugins` in trusted config, `<config home>/plugins/`,
`<workspace>/.alisio/plugins/` (only with `--trust-project`). npm packages must have the
`alisio-plugin` keyword; a directory needs `alisio-plugin.json` (`{ "apiVersion": 1, "entry": "./index.js" }`,
entry inside the directory). Built-ins are registered in `packages/cli/src/builtin.ts`
(`BuiltinPlugin` with `create(options, context)`); toggle with `builtinPlugins.<id>.enabled` or
`--disable-plugin`. Inspect with `alisio plugins list` / `alisio plugins doctor --plugin <path>`.

## Skeleton (package layout from `packages/plugin-memory`, `examples/plugins/custom-mascot`)

```
packages/plugin-foo/   package.json  README.md  LICENSE  tsconfig.build.json  src/index.ts  src/version.ts
```

`package.json` essentials (copy from `packages/plugin-memory/package.json`): `type: module`,
`keywords: ["alisio-plugin", ...]`, `exports["."]` with `alisio-source: ./src/index.ts`,
`types`/`import` -> `dist`, `publishConfig.exports` -> dist only, `files: [dist, README.md, LICENSE]`,
`peerDependencies: { "@alisio/sdk": "workspace:^" }` + devDependency `workspace:*`,
`scripts.build: tsc -p tsconfig.build.json`. `tsconfig.build.json` extends `../../tsconfig.base.json`
(`rootDir: src`, `outDir: dist`, `declaration: true`, `noEmit: false`).

```ts
import { definePlugin, textResult } from "@alisio/sdk";

export default definePlugin({
  id: "acme.hello",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.tools.register({
      name: "hello",
      description: "Greets a person by name.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(input) {
        return textResult(`Hello, ${String(input.name)}!`);
      },
    });
  },
});
```

A built-in exports a factory instead (`createMemoryPlugin(rawOptions, context): Plugin`) that
parses options with zod, then returns `definePlugin({...})`; register it in `builtin.ts`.

## Testing

Put tests in root `tests/` (e.g. `tests/memory.test.ts`, `tests/plugin-paths-options.test.ts`).
Drive the plugin through `PluginHost.activate(plugin, base)` with `ToolRegistry`/`ProviderRegistry`
from `packages/core/src/index.ts`, or through `createApplication` with a scripted `ModelProvider`;
assert registered tools/commands and their results, rollback on failed `setup`, and disposal.
Use temp dirs with `ALISIO_CONFIG_HOME`/`ALISIO_STATE_HOME` stubbed. Test at the plugin boundary,
not internals.

## Publishing

Repo packages release together via `alisio-publish` (never `npm publish` directly). External
plugins: set `peerDependencies["@alisio/sdk"]` to the current minor (`^0.x`: caret accepts only that
minor), build to JS, `npm publish`. Docs for a plugin-facing change go in `docs/plugins.md` and
`docs/es/plugins.md` (parity).
