# Alisio

<p align="center">
  <img src="docs/assets/banner.png" alt="Alisio — extensible, provider-agnostic coding-agent harness" width="720">
</p>

[![CI](https://github.com/GustavoGutierrez/alisio/actions/workflows/ci.yml/badge.svg)](https://github.com/GustavoGutierrez/alisio/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/alisio?label=npm%20alisio)](https://www.npmjs.com/package/alisio)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20ES-8A2BE2)](https://gustavogutierrez.github.io/alisio/)

**Alisio is an extensible, provider-agnostic coding-agent harness for your terminal.** It brings a
fast TUI to any OpenAI-compatible model, runs local tools behind explicit permissions, compacts long
conversations into structured checkpoints, remembers decisions across sessions with Engram-style
persistent memory (a built-in plugin you can disable), and exposes a typed plugin SDK so you can
extend it without touching the core.

> Status: `0.1.0-alpha.1`. Usable, tested and documented, but still alpha. See the
> [limitations](https://gustavogutierrez.github.io/alisio/limitations).

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
  completions and a storage port. Load plugins from a path or an npm package.
- **Also**: headless JSONL mode, MCP servers, AGENTS.md scopes, Agent Skills, Herdr integration.
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

The documentation site is bilingual (English and Spanish). The detailed implementation status
([docs/implementation-status.md](docs/implementation-status.md)) is maintained in Spanish.

## Packages

| Package | Purpose |
| --- | --- |
| [`alisio`](packages/cli) | The CLI and TUI you install (`alisio` bin) |
| [`@alisio/core`](packages/core) | Embeddable agent core: runner, compaction, provider, tools, plugin host |
| [`@alisio/sdk`](packages/sdk) | Typed plugin contract, zero runtime dependencies |
| [`@alisio/plugin-memory`](packages/plugin-memory) | Built-in persistent memory plugin |

## Development

```sh
pnpm install --frozen-lockfile
pnpm dev                 # run the CLI from source (Bun)
pnpm check               # typecheck, lint, tests, build, CLI e2e (Node and binary), packs, docs
pnpm publish -- --all --dry-run   # preview the publishable packages; see docs/publishing.md
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [Publishing](https://gustavogutierrez.github.io/alisio/publishing).

## License

[MIT](LICENSE) · Maintainer: **Gustavo Gutiérrez**
