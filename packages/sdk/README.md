# @alisio/sdk

The typed plugin contract for [Alisio](https://github.com/GustavoGutierrez/alisio). Types plus two tiny
helpers (`definePlugin`, `textResult`); no runtime dependencies and no provider SDKs.

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

## Extension points

Typed, generic extension points let plugins replace parts of the experience without core
changes. Today: `mascot` and `startup-screen`.

```ts
api.extensions.register("mascot", {
  id: "kite",
  render: ({ terminal }) => (terminal.unicode ? ["  ◢◣", " ◢██◣", " ◥██◤", "  ◥◤"] : ["  /\\", " /  \\", " \\  /", "  \\/"]),
}, { priority: 10 });
```

The highest `priority` wins; ties break by plugin `id`, then registration order, and are reported
as `extension_conflict`. Providers receive only their context (`terminal.color`, `unicode`,
`columns`); output is sanitized and clamped, and a failing provider falls back to the default.
A declarative `extensions: { mascot, "startup-screen" }` field on the plugin is also accepted.
Plugins are identified by `id` (not `name`).

## Prompt templates

`api.resources.prompts("./prompts")` registers a directory of Markdown templates that become
slash commands (for example `/review src/app.ts`):

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

## Child sessions, panels and choices

Generic building blocks used by the built-in subagents plugin and available to any plugin:

- `api.sessions.spawn/run/cancel/enqueue/...`: child sessions with a parent link, fresh context
  and narrowed permissions (a child never exceeds its parent); aborting a parent aborts them.
- `api.ui.panel(id, { title, nodes, action })`: a collapsible tree under the TUI editor.
- `api.ui.select({ title, options })`: ask the user (resolves `undefined` headless).
- `api.ui.open(sessionId)`, `api.resources.agents(dir)`, `api.resources.list(kind)`.
- `ToolDefinition.concurrent`: run alongside other read/concurrent calls of the same turn.

The API covers tools, commands, events, context providers, compaction hooks, session start/end
hooks, provider-agnostic `model.complete`, a SQLite storage port and UI status. Publish plugins as
JavaScript with the `alisio-plugin` keyword and `@alisio/sdk` as a peer dependency. Guide:
[Writing plugins](https://gustavogutierrez.github.io/alisio/plugins).

Maintainer: Gustavo Gutiérrez · License: MIT
