# @alisio/core

Embeddable core of [Alisio](https://github.com/GustavoGutierrez/alisio): the agent tool loop, structured
context compaction, the OpenAI-compatible provider (Chat Completions and Responses), local tools with
explicit permissions, the MCP client, the plugin host (with hook timeouts and failure isolation) and a
SQLite session store. Runs on Node.js >= 22.16 (`node:sqlite` with FTS5) and on Bun.

```ts
import { createApplication } from "@alisio/core";

const app = await createApplication({ config: "./alisio.json", readOnly: true });
try {
  const session = app.store.create(app.workspace, app.provider.id, app.provider.model);
  const { text } = await app.runner.run(session.id, "Summarize this repository");
  console.log(text);
} finally {
  await app.close();
}
```

Built-in plugins are opt-in for embedders: pass `builtins` (the `alisio` CLI wires
`@alisio/plugin-memory`). See the [architecture](https://gustavogutierrez.github.io/alisio/architecture) and
[configuration](https://gustavogutierrez.github.io/alisio/configuration) docs.

Maintainer: Gustavo Gutiérrez · License: MIT
