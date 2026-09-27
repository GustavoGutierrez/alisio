# @alisio/core

**The embeddable core of [Alisio](https://github.com/GustavoGutierrez/alisio): a provider-agnostic
agent you can drive from your own program.** No TUI, no CLI — just the tool loop, compaction, MCP
and plugin host as a library.

## What it is

`@alisio/core` wires the agent tool loop, structured context compaction, the OpenAI-compatible
provider (Chat Completions and Responses), local tools behind explicit permissions, the MCP client,
the plugin host (hook timeouts and failure isolation) and a SQLite session store into one
`createApplication` entry point. It runs on Node.js >= 22.16 (`node:sqlite` with FTS5) and on Bun,
and uses only portable Node APIs.

## Installation

```sh
npm i @alisio/core        # or: pnpm add @alisio/core · bun add @alisio/core
```

## Quick start

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

## What you get

- **Runner**: `AgentRunner` with turn limits, timeouts, token budgets and versioned `RunEvent`
  output (`schemaVersion: 1`).
- **Context compaction**: `planCompaction`, `summarize`, `renderCheckpoint`,
  `shouldCompactContext` and checkpoint helpers; memory plugins hook in via `CompactionHooks`.
- **Providers**: `ProviderRegistry` / `ActiveProvider` for OpenAI-compatible, DeepSeek, OpenCode
  Console and OpenCode Go; `ProviderSettingsStore` for non-secret profiles plus a separate
  credentials store.
- **Local tools**: reads by default, `--allow-write`/`--allow-process`-style policy, path checks
  and standard tools (`ToolRegistry`, `registerStandard`).
- **MCP**: `McpConnector`, server discovery and tool projection.
- **Plugin host**: `PluginHost` with built-in plugin catalogs, npm install (`installPlugin`,
  `cliInstall`), hook timeouts and failure isolation.
- **Sessions**: `SQLiteStore` with reconciliation and crash recovery.
- **Skills and prompts**: `Skills`, `ProjectContext` (`AGENTS.md`), `loadPromptTemplates`.
- **Trust**: `resolveTrust` / `setTrust` / `listTrust` for per-directory project trust.
- **Startup screen**: reusable `renderStartup` sections and the default mascot.

Built-in plugins are opt-in for embedders: pass `builtins` (the `alisio` CLI wires
`@alisio/plugin-memory` and `@alisio/plugin-subagents`).

## Docs

Architecture: <https://gustavogutierrez.github.io/alisio/architecture> ·
Configuration: <https://gustavogutierrez.github.io/alisio/configuration>.

## Requirements

Node.js **>= 22.16** or Bun **>= 1.4.2**.

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.