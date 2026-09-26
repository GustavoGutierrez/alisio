# alisio

**Alisio is an extensible, provider-agnostic coding-agent harness for your terminal.** It pairs a
fast TUI with any OpenAI-compatible model, runs local tools behind explicit permissions, compacts
long conversations into structured checkpoints, remembers decisions across sessions with an
Engram-style memory plugin, and exposes a typed plugin SDK.

```sh
npm install -g @alisio/alisio-code        # or: pnpm add -g @alisio/alisio-code · bun add -g @alisio/alisio-code
alisio                                      # the CLI binary is installed as `alisio`
export DEEPSEEK_API_KEY=...  # keys are read from environment variables only
alisio --config ./alisio.json
```

- Terminal UI: streaming Markdown, tool blocks with diffs, context/token bar, slash commands, copy-on-select.
- Headless: `alisio run "prompt" --json` emits versioned JSONL events.
- Permissions: reads by default; `--allow-write`, `--allow-process` or interactive approval; `--read-only`.
- Built-in memory plugin (disable with `--disable-plugin memory`); npm plugins via `--plugin <package>`.
- Runs on Node.js >= 22.16 or Bun; standalone binaries are attached to GitHub releases.

Documentation: [English](https://gustavogutierrez.github.io/alisio/) · [Español](https://gustavogutierrez.github.io/alisio/es/)

Maintainer: Gustavo Gutiérrez · License: MIT
