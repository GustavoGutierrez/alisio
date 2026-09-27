# @alisio/sdk

**The typed plugin contract for [Alisio](https://github.com/GustavoGutierrez/alisio).** Types plus
two tiny helpers (`definePlugin`, `textResult`) — no runtime dependencies and no provider SDKs.

## What it is

`@alisio/sdk` is what plugins depend on. It declares the `Plugin` and `PluginAPI` shapes, the tool
and provider contracts, compaction and session hooks, the SQLite storage port and the extension
points. A plugin ships JavaScript, declares the `alisio-plugin` npm keyword and lists
`@alisio/sdk` as a peer dependency. Because the package is types-only plus helpers, it is safe to
import from any runtime Alisio runs on.

## Installation

```sh
npm i @alisio/sdk        # peer dependency of every plugin; use it in devDependencies too
```

## Quick start: your first plugin

```ts
import { definePlugin, textResult } from "@alisio/sdk";

export default definePlugin({
  id: "acme.hello",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.tools.register({
      name: "hello",
      description: "Greets the user.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return textResult("Hello!");
      },
    });
  },
});
```

Load it with `alisio --plugin ./dist/index.js` (path) or `alisio install npm:acme-hello` (npm
package). See [Writing plugins](https://gustavogutierrez.github.io/alisio/plugins) for the full
walkthrough including tool permissions, naming/prefix rules and an example package.

## The PluginAPI

Everything a plugin registers is removed automatically when it unloads; every `register`/`on`
returns an unregister function.

- **tools** — `tools.register(ToolDefinition)`; effects `read | write | process | external |
  internal`, optional `paths()` for write checks, `concurrent` for same-turn parallel calls.
- **commands** — `commands.register(name, handler, { description?, argumentHint? })`, invoked as
  `/command plugin.id:name args`.
- **events** — versioned `RunEvent`s (`schemaVersion: 1`).
- **context** — `context.register(() => Promise<string>)` adds text to the model context.
- **resources** — `skills(path)`, `prompts(path)`, `agents(path)` and `list(kind)` for skill,
  prompt-template and agent-definition directories.
- **state** — small per-plugin JSON state persisted in the session database.
- **compaction** — `compaction.register({ beforeCompact, afterCompact })` contributes instructions,
  extra summarizer output fields, recalled context and reports.
- **session** — `session.onStart(info)` (text injected on a fresh session) and
  `session.onEnd(info)` (called on `/clear`, `/exit`, quit; bounded by a timeout).
- **model** — provider-agnostic `model.complete(request)`; plugins never import provider SDKs.
- **models** — credential-free `models.list()` / `models.resolve(reference)` over configured
  `/connect` profiles.
- **providers** — `providers.register(registration)` adds a selectable model provider to `/connect`;
  registrations coexist instead of competing.
- **storage** — `storage.sqlite(path)` opens a private (0600) SQLite file (FTS5 available); the
  host provides the driver, so plugins never depend on a specific runtime.
- **sessions** — child sessions (`spawn`, `create`, `run`, `get`, `children`, `cancel`, `enqueue`,
  …): separate conversations with fresh context and narrowed permissions that never exceed the
  parent.
- **ui** — `status`, `panel`, `select`, `askQuestions`, `open`, `interactive()`; interactive-only
  calls resolve `undefined` headless instead of hanging.

## Extension points

Typed, generic extension points let plugins replace parts of the experience without core changes.
Today: `mascot`, `startup-screen` and `websearch`.

```ts
api.extensions.register("mascot", {
  id: "kite",
  render: ({ terminal }) => (terminal.unicode ? ["  ◢◣", " ◢██◣", " ◥██◤", "  ◥◤"] : ["  /\\", " /  \\", " \\  /", "  \\/"]),
}, { priority: 10 });
```

The highest `priority` wins; ties break by plugin `id`, then registration order (reported as
`extension_conflict`). A renderable provider receives only its context (`terminal.color`,
`unicode`, `columns`); output is sanitized and clamped, and a failing provider falls back to the
default. `websearch` fully replaces Alisio's built-in search-provider resolution while registered.
A declarative `extensions` field on the plugin is accepted too, at priority 0. Plugins are
identified by `id`, not `name`.

## Prompt templates

`api.resources.prompts("./prompts")` registers a directory of Markdown templates that become slash
commands (for example `/review src/app.ts`):

```md
---
description: Review a file for bugs
argument-hint: <path>
requires: [write]   # optional: write | process
---
Review $1 carefully. Extra focus: $ARGUMENTS
```

`$ARGUMENTS` is the whole argument string and `$1`..`$9` are shell-like positional arguments.
Precedence: built-in < plugin < user (`~/.config/alisio/prompts`) < trusted project
(`.alisio/prompts`).

## Publishing

Publish plugins as JavaScript with the `alisio-plugin` keyword and `@alisio/sdk` as a peer
dependency; the entry resolves from `exports["."]`, then `main`, then `./index.js`. Guide:
[Writing plugins](https://gustavogutierrez.github.io/alisio/plugins) ·
[Publishing](https://gustavogutierrez.github.io/alisio/publishing).

## Requirements

Node.js **>= 22.16** (types-only package; consumers run on Node or Bun).

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.