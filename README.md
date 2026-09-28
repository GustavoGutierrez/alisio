# Alisio

<p align="center">
  <img src="docs/assets/banner.png" alt="Alisio — extensible, provider-agnostic coding-agent harness" width="720">
</p>

[![CI](https://github.com/GustavoGutierrez/alisio/actions/workflows/ci.yml/badge.svg)](https://github.com/GustavoGutierrez/alisio/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@alisio/alisio-code?label=npm)](https://www.npmjs.com/package/@alisio/alisio-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20ES-8A2BE2)](https://gustavogutierrez.github.io/alisio/)

**Alisio is an extensible, provider-agnostic coding-agent harness for your terminal.** It brings a
fast TUI to any OpenAI-compatible model, runs local tools behind explicit permissions, compacts long
conversations into structured checkpoints, remembers decisions across sessions with Engram-style
persistent memory (a built-in plugin you can disable), and exposes a typed plugin SDK so you can
extend it without touching the core.

> **Status: Usable, tested and documented, but still alpha.** The npm badge above always shows the
> latest published version; see the [limitations](https://gustavogutierrez.github.io/alisio/limitations).

## Highlights

- **Terminal UI**: streaming Markdown, tool blocks with spinners, durations and diffs, a context/token
  bar, slash commands with autocomplete, model switching, interactive approvals and copy-on-select.
- **Any OpenAI-compatible provider**: Chat Completions and Responses APIs, DeepSeek, local servers.
  Keys are read from environment variables only.
- **Local tools with explicit permissions**: reads by default; the TUI asks before every
  write/process/network call unless you pass `--allow-write`/`--allow-process`/`--allow-external`
  (skip asking) or `--read-only` (never even offered). Not a sandbox, and it says so. A repository's
  own `.alisio/config.json` and plugins load only after a one-time per-directory trust prompt (or
  `--trust-project`).
- **Context compaction**: a structured checkpoint (goal, constraints, discoveries, state, next steps,
  files) that never splits tool calls from their results.
- **Persistent memory**: SQLite FTS5 observations, topic-key upserts, memory-aware compaction and
  session summaries, shipped as the disableable `@alisio/plugin-memory`.
- **Typed plugin SDK**: tools, commands, context, compaction and session hooks, provider-agnostic
  completions and a storage port. Load plugins from a path or an npm package — install them
  globally with `alisio install npm:<package>` (or let the agent do it via the permissioned
  `plugin_install` tool).
- **Also**: headless JSONL mode, MCP servers (with an optional persistent global `mcp.allow` consent
  that auto-connects enabled servers on every start, or per-session grants from the TUI), AGENTS.md
  scopes, Agent Skills, Herdr integration.
- **Runs on Node.js >= 22.16 or Bun**; standalone binaries for Linux, macOS and Windows.

## Install

```sh
npm install -g @alisio/alisio-code   # or: pnpm add -g @alisio/alisio-code · bun add -g @alisio/alisio-code
alisio                                  # the CLI binary is installed as `alisio`
# Standalone binary (verifies the SHA-256 checksum):
curl -fsSL https://raw.githubusercontent.com/GustavoGutierrez/alisio/main/scripts/install.sh | sh
```

## Quick start

```sh
alisio setup                                 # writes .alisio/config.json without secrets
export DEEPSEEK_API_KEY='...'                # keys come from the environment
alisio --config .alisio/config.json          # TUI
alisio run "Explain this repository" --config .alisio/config.json --read-only
```

```json
{
  "provider": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "model": "deepseek-chat",
    "streamUsage": true
  }
}
```

## Documentation

- [English docs](https://gustavogutierrez.github.io/alisio/)
- [Documentación en español](https://gustavogutierrez.github.io/alisio/es/)
- [Product specification](docs/specification.md): the product direction, kept in the repository.
- [Validation log](docs/validation.txt) and [benchmark data](docs/benchmark.json): raw validation output.

The documentation site is bilingual (English and Spanish). The detailed implementation status
([docs/implementation-status.md](docs/implementation-status.md)) is maintained in Spanish.

## Packages

All packages are published under the [alisio npm organization](https://www.npmjs.com/settings/alisio/packages):

| Package | npm | Purpose |
| --- | --- | --- |
| [`alisio-code`](packages/cli) | [npm](https://www.npmjs.com/package/@alisio/alisio-code) | The CLI and TUI you install (`alisio` bin) |
| [`@alisio/core`](packages/core) | [npm](https://www.npmjs.com/package/@alisio/core) | Embeddable agent core: runner, compaction, provider, tools, plugin host |
| [`@alisio/sdk`](packages/sdk) | [npm](https://www.npmjs.com/package/@alisio/sdk) | Typed plugin contract, zero runtime dependencies |
| [`@alisio/plugin-memory`](packages/plugin-memory) | [npm](https://www.npmjs.com/package/@alisio/plugin-memory) | Built-in persistent memory plugin |
| [`@alisio/plugin-subagents`](packages/plugin-subagents) | [npm](https://www.npmjs.com/package/@alisio/plugin-subagents) | Subagent delegation plugin |
| [`@alisio/plugin-deepseek`](packages/plugin-deepseek) | [npm](https://www.npmjs.com/package/@alisio/plugin-deepseek) | Dedicated DeepSeek model provider |
| [`@alisio/plugin-openai-compatible`](packages/plugin-openai-compatible) | [npm](https://www.npmjs.com/package/@alisio/plugin-openai-compatible) | Generic OpenAI-compatible model provider |
| [`@alisio/plugin-opencode`](packages/plugin-opencode) | [npm](https://www.npmjs.com/package/@alisio/plugin-opencode) | OpenCode Zen model provider |
| [`@alisio/plugin-opencode-go`](packages/plugin-opencode-go) | [npm](https://www.npmjs.com/package/@alisio/plugin-opencode-go) | OpenCode Go model provider |

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev                 # run the CLI from source (Bun)
pnpm check               # typecheck, lint, tests, build, CLI e2e (Node and binary), packs, docs
pnpm publish -- --all --dry-run   # preview the publishable packages; see docs/publishing.md
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [Publishing](https://gustavogutierrez.github.io/alisio/publishing).

Please read [SECURITY.md](SECURITY.md) before reporting a vulnerability, and follow
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) when participating.

## License

[MIT](LICENSE) · Maintainer: **Gustavo Gutiérrez**
