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
changes. Today: `mascot`, `startup-screen` and `websearch`.

```ts
api.extensions.register("mascot", {
  id: "kite",
  render: ({ terminal }) => (terminal.unicode ? ["  ◢◣", " ◢██◣", " ◥██◤", "  ◥◤"] : ["  /\\", " /  \\", " \\  /", "  \\/"]),
}, { priority: 10 });

api.extensions.register("websearch", {
  id: "brave-example",
  search: async (query) => [{ title: "...", url: "https://...", snippet: "..." }],
}, { priority: 10 });
```

The highest `priority` wins; ties break by plugin `id`, then registration order, and are reported
as `extension_conflict`. A renderable provider (`mascot`, `startup-screen`) receives only its
context (`terminal.color`, `unicode`, `columns`); its output is sanitized and clamped, and a
failing provider falls back to the default. `websearch` fully replaces Alisio's built-in
search-provider resolution while registered (a throwing provider also falls back, with a
diagnostic). A declarative `extensions: { mascot, "startup-screen", websearch }` field on the
plugin is also accepted. Plugins are identified by `id` (not `name`).

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
- `api.ui.select({ title, options })`: ask the user to choose one (resolves `undefined` headless).
- `api.ui.askQuestions({ questions, session?, label?, signal? })`: ask 1-4 multiple-choice questions
  (2-4 options each, an optional `recommended` one); resolves every question id `undefined` headless.
  `session`/`label` attribute the question to the asking (sub)session, mirroring `ApprovalRequest`.
- `api.ui.interactive()`: true when an interactive UI is bound at all (never per-session), so a
  child session under an interactive root can safely call `select`/`askQuestions` too.
- `api.ui.open(sessionId)`, `api.resources.agents(dir)`, `api.resources.list(kind)`.
- `ToolContext.label`: who is asking (an agent path such as `"general › explore"`), set for tool
  calls made by a labeled child session; mirrors `ApprovalRequest.label`.
- `ToolDefinition.concurrent`: run alongside other read/concurrent calls of the same turn.

The API covers tools, commands, events, context providers, compaction hooks, session start/end
hooks, provider-agnostic `model.complete`, a SQLite storage port and UI status. Publish plugins as
JavaScript with the `alisio-plugin` keyword and `@alisio/sdk` as a peer dependency. Guide:
[Writing plugins](https://gustavogutierrez.github.io/alisio/plugins).

Maintainer: Gustavo Gutiérrez · License: MIT
