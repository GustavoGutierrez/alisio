# @alisio/alisio-code

**Alisio is an extensible, provider-agnostic coding-agent harness for your terminal.** It pairs a fast
TUI with any OpenAI-compatible model, runs local tools behind explicit permissions, compacts long
conversations into structured checkpoints, remembers decisions across sessions with an Engram-style
memory plugin, and exposes a typed plugin SDK.

## What it is

`alisio` is the CLI of the Alisio project. It connects to any OpenAI-compatible endpoint (Chat
Completions or Responses), drives its own agent tool loop, and runs interactively as a TUI or
headless for scripts and CI. Provider SDKs stay out of the harness: the CLI ships built-in DeepSeek,
OpenAI-compatible, OpenCode Console (Zen) and OpenCode Go providers, plus memory and subagents
plugins.

## Installation

```sh
npm i -g @alisio/alisio-code        # or: pnpm add -g @alisio/alisio-code · bun add -g @alisio/alisio-code
alisio                              # the binary is installed as `alisio`
```

Standalone binaries (Bun embedded, no Node required) are attached to GitHub releases.

## Quick start

The fastest path is the TUI's `/connect` form: pick a provider, enter its settings and key, choose a
model, and Alisio persists the selection globally (`/model` re-opens the same selector). A plain
config start looks like:

```sh
alisio setup                        # writes a secret-free .alisio/config.json in .alisio/
export DEEPSEEK_API_KEY=...         # keys come from environment variables or /connect, never config files
alisio --config .alisio/config.json
```

Run one prompt headless, emitting versioned JSONL events:

```sh
alisio run "Summarize this repository" --json
alisio run "/init" --allow-write    # generate AGENTS.md from the built-in /init template
```

## Commands

| Command | Description |
| --- | --- |
| `alisio` | Interactive TUI (readline with `--no-tui`) |
| `alisio run <prompt>` | Headless run; `/name args` runs a prompt template |
| `alisio resume <session> [prompt]` | Resume a session |
| `alisio setup` | Write a secret-free example `.alisio/config.json` |
| `alisio doctor` | Environment and provider diagnostics |
| `alisio trust list` / `trust revoke <path>` | Inspect or revoke per-directory project trust |
| `alisio sessions list` / `sessions recover <id> --acknowledge` | List sessions; recover after a crash |
| `alisio skills list` / `skills validate` | Discover and validate Agent Skills |
| `alisio plugins list` / `plugins doctor` | List/load plugins and show their tools and commands |
| `alisio mcp list` / `mcp doctor <server>` | List configured MCP servers; connect to one (`--allow-mcp`) |
| `alisio context explain <path>` | Show which `AGENTS.md` files apply to a path |
| `alisio install npm:<package>` | Install an npm plugin into the global plugins directory |

## Permissions and key flags

Reads run by default; anything else needs a flag or interactive approval:

| Flag | Effect |
| --- | --- |
| `--allow-write` | Allow file writes |
| `--allow-process` | Allow arbitrary subprocesses (not sandboxed) |
| `--allow-external` | Allow network tools: `webfetch`, `websearch`, provider-native search |
| `--allow-mcp` | Allow configured MCP servers and remote tool calls |
| `--allow-agents` | Allow messaging neighboring agents through Herdr |
| `--read-only` | Disable writes, subprocesses, network tools, executable plugins and MCP |
| `--plugin <path…>` / `--trust-project` | Load explicitly trusted plugins / trust project config |
| `--disable-plugin <ids…>` | Disable built-in plugins (e.g. `memory`) |
| `--json` | Emit versioned JSONL events (headless) |

Other global flags: `--cwd`, `--config`, `--model`, `--base-url`, `--api-mode`, `--db`,
`--no-tui`, `--no-banner`, `--no-herdr`, `--agents <json>`, `--quiet`, `-V`, `-h`.

## In the TUI

`/connect` adds a provider; `/model` picks a saved provider/model; `/compact`, `/stats`, `/clear`,
`/sessions`, `/resume` manage conversations; `/plugins`, `/skills`, `/mcp`, `/settings` manage
extensions and preferences; `/memory` and `/agents` drive the built-in plugins; `/init` writes
`AGENTS.md`.

## Requirements

Node.js **>= 22.16** (`node:sqlite` with FTS5) or Bun **>= 1.4.2**. Git and ripgrep on `PATH` for the
Git and search tools; `alisio doctor` reports what it detects.

## Docs

Documentation (EN/ES): <https://gustavogutierrez.github.io/alisio/> — [quick start](https://gustavogutierrez.github.io/alisio/quick-start),
[configuration](https://gustavogutierrez.github.io/alisio/configuration), [plugins](https://gustavogutierrez.github.io/alisio/plugins),
[subagents](https://gustavogutierrez.github.io/alisio/subagents), [memory](https://gustavogutierrez.github.io/alisio/memory),
[TUI](https://gustavogutierrez.github.io/alisio/tui).

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.