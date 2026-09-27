# @alisio/plugin-memory

**Engram-style persistent memory for [Alisio](https://github.com/GustavoGutierrez/alisio).** The
model saves decisions, bug fixes and discoveries across sessions, and recalls them with context;
compaction and session end turn meetings into structured, searchable memory.

## What it is

Shipped as a built-in plugin of the `alisio` CLI (disable with `--disable-plugin memory` or
`builtinPlugins.memory.enabled: false`). It depends only on `@alisio/sdk` and stores data through
the SDK storage port — a local SQLite database with FTS5 trigram indexing, BM25 ranking combined
with recency; no embeddings and no network. The file lives at `<state home>/memory.sqlite` with
0600 permissions.

## Installation

Preinstalled in the `alisio` CLI. For an embedded host, register it through `createApplication`'s
`builtins` list (the CLI wires it for you).

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Save or upsert an observation |
| `memory_search` | Full-text search; AND by default, `match: "any"` and `all_projects` available |
| `memory_get` | Full observation by ID |
| `memory_context` | Recent memory context (summaries, prompts, pinned, recent) |
| `memory_timeline` | Chronological neighbours of a memory within a session |
| `memory_pin` | Pin (or unpin) a memory so it always appears in memory context |
| `memory_forget` | Soft delete; `hard: true` removes it permanently |

An observation has a title, a type (`decision`, `bugfix`, `discovery`, `pattern`, `architecture`,
`config`, `preference`, `learning`), a **What / Why / Where / Learned** body, a `project` or
`personal` scope and an optional `topic_key` for upserts. All memory tools use the `internal`
effect: they only touch the memory database, never the workspace, so they stay available under
`--read-only`.

## Behaviour

- **Memory-aware compaction** — in the same summarizer call, observations are extracted from the
  discarded span (with upsert/dedup), the checkpoint is archived as the session summary, and
  relevant memories are injected within a token budget.
- **Session summaries** — on `/clear`, `/exit` or quitting the TUI, writes a structured
  Goal/Instructions/Discoveries/Accomplished/Next Steps/Relevant Files summary (option
  `autoSummary`, on by default).
- **`/memory` command** — `/memory` (recent), `/memory <query>`, and
  `/memory show|forget|pin|unpin <id>`; a `mem N` counter in the TUI status bar.

## Configuration

Under `builtinPlugins.memory`:

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable the plugin |
| `dbPath` | `<state home>/memory.sqlite` | Database path; relative paths resolve from the config file |
| `injectBudgetTokens` | `1500` | Token budget (100–20000) for injected memory context |
| `recallLimit` | `8` | Memories recalled after compaction (0–20) |
| `autoSummary` | `true` | Write a session summary on session end |
| `defaultScope` | `project` | `project` or `personal` |

## Docs

[Memory plugin](https://gustavogutierrez.github.io/alisio/memory) ·
[Configuration](https://gustavogutierrez.github.io/alisio/configuration).

## Requirements

Node.js **>= 22.16** or Bun **>= 1.4.2**.

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.