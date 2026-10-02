# Persistent memory

`memory` is a built-in plugin (package `@alisio/plugin-memory`) that gives the model persistent
memory backed by local SQLite and FTS5. It is enabled by default and can be disabled.

## Observations

Each memory is an observation with:

- a title and a type: `decision`, `bugfix`, `discovery`, `pattern`, `architecture`, `config`,
  `preference` or `learning`;
- a body structured as **What / Why / Where / Learned**;
- a project, a scope (`project` or `personal`) and an optional `topic_key`
  (`family/description`, kebab-case).

## Storage

- SQLite + FTS5 (trigram tokenizer, BM25 ranking combined with recency and access counts). No
  embeddings, no network.
- One database per user at `<state home>/memory.sqlite` (`ALISIO_STATE_HOME`/XDG), independent of
  `--db`, so memory survives sessions, runs and projects (`personal` scope). The file is local with
  0600 permissions.
- The project is identified as `<name>-<hash8>` of the realpath of the Git root or the working
  directory.
- The same `topic_key` in the same project and scope updates the row (`revision_count`); exact
  duplicates within 15 minutes increment `duplicate_count`. Deletion is soft by default.
  `<private>…</private>` is stored as `[REDACTED]`. Content is limited to 50 000 characters.

## Tools

| Tool | Purpose |
| --- | --- |
| `memory_save` | Save or upsert an observation |
| `memory_search` | Compact rows; AND by default, `match: "any"` and `all_projects` available |
| `memory_get` | Full observation by ID |
| `memory_context` | Recent memory context (session summaries, prompts, pinned and recent observations) |
| `memory_timeline` | Chronological neighbours of a memory within the same session |
| `memory_pin` | Pin (or unpin) a memory so it is always included in memory context |
| `memory_forget` | Soft delete; `hard: true` removes it permanently |

These tools use the `internal` effect: they only write to Alisio's memory database, never to the
workspace, so they stay available with `--read-only`.

## Behaviour

- **System prompt protocol**: save decisions, bug fixes, discoveries, conventions, configuration and
  preferences; recall with context → search → detail.
- **New session**: injects a `memory_context` block (last session summary, recent prompts, pinned and
  recent observations) within `injectBudgetTokens`.
- **Compaction**: in the same model call, observations are extracted from the discarded span (with
  upsert/dedup), the checkpoint is archived as the session summary with outcome
  `confirmed`/`failed`/`unknown`, and relevant memories (with IDs) are added within the budget. With
  invalid JSON the checkpoint stays text-only and nothing is extracted.
- **Session end** (`/clear`, `/exit`, quitting the TUI) with activity: writes a summary with
  Goal / Instructions / Discoveries / Accomplished / Next Steps / Relevant Files, bounded by
  `pluginHooks.sessionEndTimeoutMs`.
- **TUI**: `/memory` (recent), `/memory <query>`, `/memory show|forget|pin|unpin <id>`; a `mem N`
  counter in the status bar; details in `/stats`.

## Web tab {#web-tab}

In the web UI (`alisio serve`) a read-only **Memory** tab shows what this plugin holds for the open
chat; it exists only while the plugin is enabled (see [Memory tab](/web#memory-tab)). The plugin
registers three [data views](/plugins#data-views) (`records`, `summary`, `context`) that the tab
reads, and each section has its own source:

| Section | Where it comes from |
| --- | --- |
| **Saved in this chat** | Observations whose `session` is the chat's session id (saved by `memory_save`, by compaction or by the end-of-session summary) and that were not forgotten, pinned first and then by `updated_at`, newest first. Filtering by type and the text search (title, content and `topic_key`, case-insensitive, any length) run in the database. |
| **Session summary** | The summary stored for the session: at most one, overwritten by compaction and by the end-of-session summary. |
| **Context loaded** | The exact text the plugin returned from its session-start hook when the chat began. The plugin remembers it in its own database (table `injected_context`, schema version 101), so nothing parses the transcript. |

The views only read: they do not change access counts or timestamps. A memory with a `topic_key`
that another chat updates moves to that chat, so it can leave this chat's list. Chats started
before this version have no **Context loaded**, and the context recovered after a compaction is not
recorded. The remembered context is what the plugin returned: the runner truncates very long
injections and does not report whether it persisted them.

## Configuration

```json
{
  "builtinPlugins": {
    "memory": {
      "enabled": true,
      "dbPath": "./memory.sqlite",
      "injectBudgetTokens": 1500,
      "recallLimit": 8,
      "autoSummary": true,
      "defaultScope": "project"
    }
  },
  "pluginHooks": { "timeoutMs": 15000, "sessionEndTimeoutMs": 10000 }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable the plugin |
| `dbPath` | `<state home>/memory.sqlite` | Relative paths resolve from the configuration file |
| `injectBudgetTokens` | `1500` | Budget (100–20000) for injected context at session start and after compaction |
| `recallLimit` | `8` | Memories recalled after compaction (0–20) |
| `autoSummary` | `true` | Write a session summary on `/clear`, `/exit` or quit (TUI) |
| `defaultScope` | `project` | `project` or `personal` |

## Disabling

```sh
alisio --disable-plugin memory
```

or `"builtinPlugins": { "memory": { "enabled": false } }`. When disabled there are no tools, prompt,
hooks, command, status or database file, and compaction works in its generic mode.

## Limits

Search uses the trigram tokenizer, so terms shorter than 3 characters are ignored, and there is no
semantic search. The automatic end-of-session summary only runs in the TUI (not in headless `run`).
See [Known limitations](/limitations) for storage, search and lifecycle constraints.
