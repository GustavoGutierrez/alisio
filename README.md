# Alisio

<p align="center">
  <img src="docs/assets/banner.png" alt="Alisio — your assistant for everyday work, on the model you choose" width="720">
</p>

[![CI](https://github.com/GustavoGutierrez/alisio/actions/workflows/ci.yml/badge.svg)](https://github.com/GustavoGutierrez/alisio/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@alisio/alisio-code?label=npm)](https://www.npmjs.com/package/@alisio/alisio-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20ES-8A2BE2)](https://gustavogutierrez.github.io/alisio/)

**Alisio — your assistant for everyday work, on the model you choose.** It is a desktop AI harness
for the everyday work of non-technical people: teachers, students, secretaries and office staff,
accountants and the home. It installs with one click, works on your own files and always asks
permission. It specializes through plugins per profession and delivers ready-to-use results: PDFs,
spreadsheets, charts, reports and dashboards. It connects to any OpenAI-compatible model (DeepSeek,
OpenRouter and others). Programming is still possible, as an advanced, secondary use: a terminal UI,
a headless mode for scripts and CI, subagents, code editing and **Forja** code mode.

> **Status: stable, tested and documented, still pre-1.0.** Until 1.0.0 the usual 0.x semver rules
> apply: fixes ship as patch releases and a new minor release may include breaking changes. The npm badge above always shows the latest published version; see the
> [limitations](https://gustavogutierrez.github.io/alisio/limitations) and
> [Stability and versioning](https://gustavogutierrez.github.io/alisio/publishing#stability-and-versioning).

## Everyday work

Alisio is built around five ideas: it is **easy** (a desktop app, no terminal needed), it keeps
**your files under your control** (local-first, with explicit permissions), it specializes through
**plugins per profession**, it delivers **results you can use** (documents, spreadsheets, charts and
dashboards) and it works with **any model**. This is what exists today, no more:

| Who | What Alisio can do today | Backed by |
| --- | --- | --- |
| Students | Draft a thesis, research sources, study | `@alisio/plugin-thesis` (plans, researches, drafts and typesets university theses into PDF with Typst), `@alisio/plugin-literature-research` and the built-in persistent memory |
| Teachers | Create printable exams (school **math** only for now) | `@alisio/plugin-evalua` |
| Accountants | Working papers and spreadsheet analysis | Forja Python analysis |
| Office and secretaries | Analyze Excel and CSV data, charts, certificates, reports | Forja and analysis, `@alisio/plugin-cardsmith` |
| Home | Budgets, charts, organizing information | Forja (no dedicated plugin) |

The profession plugins live in the public [alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins)
repository and install with `alisio install npm:<package>`. They are **not bundled in the desktop app
yet**. See the [desktop app guide](docs/desktop.md).

## Highlights for developers and advanced use

- **Terminal UI**: streaming Markdown, tool blocks with spinners, durations and diffs, a context/token
  bar, slash commands with autocomplete, model switching, interactive approvals and copy-on-select.
- **Web UI**: `alisio serve` opens a local, token-protected browser workspace for several workspaces
  and sessions, with streaming conversations, approvals, files, changes, artifacts and the plan
  viewer, on the same agent core.
- **Any OpenAI-compatible provider**: Chat Completions and Responses APIs, DeepSeek-style endpoints, local servers.
  Keys are read from environment variables only. Dedicated DeepSeek, OpenCode Console (Zen) and
  OpenCode Go providers are separate plugins: `alisio install npm:@alisio/plugin-deepseek`,
  `alisio install npm:@alisio/plugin-opencode`, `alisio install npm:@alisio/plugin-opencode-go`.
- **Local tools with explicit permissions**: reads by default; the TUI asks before every
  write/process/network call unless you pass `--allow-write`/`--allow-process`/`--allow-external`
  (skip asking) or `--read-only` (never even offered). Alisio as a whole is not a sandbox, and it
  says so: only Forja isolates code. A repository's
  own `.alisio/config.json` and plugins load only after a one-time per-directory trust prompt (or
  `--trust-project`).
- **Context compaction**: a structured checkpoint (goal, constraints, discoveries, state, next steps,
  files) that never splits tool calls from their results.
- **Persistent memory**: SQLite FTS5 observations, topic-key upserts, memory-aware compaction and
  session summaries, shipped as the disableable `@alisio/plugin-memory`.
- **Agents**: create agents with the active model's help (or from templates), stored as portable
  Markdown in `.agents/agents` (project) or `~/.agents/agents` (global), reloaded without a restart
  and switched with `/agents` or `/agent:<id>` in the web UI and the TUI.
- **Plan mode and plan viewer**: a read-only plan agent proposes a plan (with optional Mermaid diagrams)
  that you approve before anything changes; the web UI opens it in a plan viewer.
- **Forja, code mode picked by goal**: `js_run` runs JavaScript in a fresh QuickJS WebAssembly VM with
  no file, network or process access, to combine tool calls, filter results and transform data under
  the agent's own permissions. `python_run` handles data analysis, statistics, scikit-learn, charts
  and custom dashboards in a container (`oci`) or a restricted Pyodide process (`wasm`) when
  available, and `analysis.isolation: required` keeps it off your host. Guides load on demand with
  `forge_guide`, and each session gets a private scratchpad. See the
  [Forja docs](https://gustavogutierrez.github.io/alisio/forja) for the isolation limits.
- **Dashboards and charts**: Python analysis publishes dashboards, reports and spreadsheets as
  artifacts, with interactive charts from an embedded Chart.js that works offline.
- **Reliability Lab**: `alisio eval` runs task suites k times with deterministic verifiers, reports
  pass rates with Wilson intervals, compares reports and config variants, and replays recorded
  cassettes to catch harness regressions without a model (replay measures the harness, not the
  model). See the [Reliability Lab docs](https://gustavogutierrez.github.io/alisio/eval).
- **Proof**: acceptance criteria whose status comes from evidence Alisio captured from the commands,
  file reads and data queries the agent really ran, not from what the model says. Shown in the web UI,
  the terminal and `alisio run --proof` (exit codes 0/10/11, `proof/v1` JSON). It does not prove the
  code is correct. See the [Proof docs](https://gustavogutierrez.github.io/alisio/proof).
- **Typed plugin SDK**: tools, commands, context, compaction and session hooks, provider-agnostic
  completions and a storage port. Load plugins from a path or an npm package — install them
  globally with `alisio install npm:<package>` (or let the agent do it via the permissioned
  `plugin_install` tool).
- **Also**: headless JSONL mode, MCP servers (with an optional persistent global `mcp.allow` consent
  that auto-connects enabled servers on every start, or per-session grants from the TUI), AGENTS.md
  scopes, Agent Skills, Herdr integration.
- **Runs on Node.js >= 22.16 or Bun**; standalone binaries for Linux, macOS and Windows. The Pyodide
  (`wasm`) Python backend needs Node.js >= 22.22, >= 24.13 or >= 25.3.

## Install

The main way to install Alisio is the **desktop app**. Download it from the
[Alisio Desktop 0.9.0 release](https://github.com/GustavoGutierrez/alisio/releases/tag/desktop-v0.9.0):

- Windows 10/11 (x64): [`Alisio-Setup-0.9.0-x64.exe`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.9.0/Alisio-Setup-0.9.0-x64.exe)
- macOS Apple Silicon: [`Alisio-0.9.0-arm64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.9.0/Alisio-0.9.0-arm64.dmg) · Intel: [`Alisio-0.9.0-x64.dmg`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.9.0/Alisio-0.9.0-x64.dmg)
- Linux: [`Alisio-0.9.0-x86_64.AppImage`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.9.0/Alisio-0.9.0-x86_64.AppImage) · Debian/Ubuntu: [`Alisio-0.9.0-amd64.deb`](https://github.com/GustavoGutierrez/alisio/releases/download/desktop-v0.9.0/Alisio-0.9.0-amd64.deb)

The installers are not signed, so Windows SmartScreen and macOS Gatekeeper ask for one extra step the
first time (see [docs/desktop.md](docs/desktop.md)).

**For developers:** the command line below is the advanced path (Node.js >= 22.16).

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
| [`@alisio/core`](packages/core) | [npm](https://www.npmjs.com/package/@alisio/core) | Embeddable agent core: runner, compaction, provider, tools, Forja, plugin host |
| [`@alisio/server`](packages/server) | [npm](https://www.npmjs.com/package/@alisio/server) | Local HTTP + SSE server behind `alisio serve` (the Web UI) |
| [`@alisio/sdk`](packages/sdk) | [npm](https://www.npmjs.com/package/@alisio/sdk) | Typed plugin contract, zero runtime dependencies |
| [`@alisio/plugin-memory`](packages/plugin-memory) | [npm](https://www.npmjs.com/package/@alisio/plugin-memory) | Built-in persistent memory plugin |
| [`@alisio/plugin-subagents`](packages/plugin-subagents) | [npm](https://www.npmjs.com/package/@alisio/plugin-subagents) | Subagent delegation plugin |
| [`@alisio/plugin-openai-compatible`](packages/plugin-openai-compatible) | [npm](https://www.npmjs.com/package/@alisio/plugin-openai-compatible) | Built-in generic OpenAI-compatible model provider |

Dedicated model providers are independent plugins published from the
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) monorepo and installed
separately: `alisio install npm:@alisio/plugin-deepseek`,
`alisio install npm:@alisio/plugin-opencode`, `alisio install npm:@alisio/plugin-opencode-go`.

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

Third-party notice: [Chart.js](https://www.chartjs.org/) 4.5.1 (MIT, © Chart.js Contributors) is
bundled in `@alisio/core` for dashboard charts. Its copyright header stays in the bundled file and
its license text is kept in
`packages/core/src/analysis/python/alisio_runtime/chart.LICENSE.txt`.
