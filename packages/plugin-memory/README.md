# @alisio/plugin-memory

Engram-style persistent memory for [Alisio](https://github.com/GustavoGutierrez/alisio), shipped as a
built-in plugin of the `alisio` CLI (disable with `--disable-plugin memory`). It depends only on
`@alisio/sdk` and stores data through the SDK storage port (SQLite + FTS5 trigram, BM25 with recency).

- Observations with title, type, What/Why/Where/Learned body, project or personal scope and topic-key upserts.
- Tools: `memory_save`, `memory_search`, `memory_get`, `memory_context`, `memory_timeline`, `memory_pin`, `memory_forget`.
- Memory-aware compaction: extracts observations in the same summarizer call, archives the checkpoint
  and injects budgeted recall; session summaries on exit; `/memory` command.

Configuration lives under `builtinPlugins.memory`. Docs: [Memory plugin](https://gustavogutierrez.github.io/alisio/memory).

Maintainer: Gustavo Gutiérrez · License: MIT
