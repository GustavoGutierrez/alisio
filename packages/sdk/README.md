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

The API covers tools, commands, events, context providers, compaction hooks, session start/end
hooks, provider-agnostic `model.complete`, a SQLite storage port and UI status. Publish plugins as
JavaScript with the `alisio-plugin` keyword and `@alisio/sdk` as a peer dependency. Guide:
[Writing plugins](https://gustavogutierrez.github.io/alisio/plugins).

Maintainer: Gustavo Gutiérrez · License: MIT
