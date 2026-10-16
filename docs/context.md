# Context: AGENTS.md and skills

Alisio builds the model's instructions from project instruction files (`AGENTS.md`, following the
[agents.md](https://agents.md/) convention) and exposes Agent Skills
through progressive disclosure.

## AGENTS.md

### Which files are read

| Scope | Files |
| --- | --- |
| Global | `<config home>/AGENTS.md`; `<config home>/AGENTS.override.md` replaces it when present |
| Project | One file per directory, walking from the workspace root down to the working directory |

In each directory the first existing file wins:

| Order | File | `context_explain` kind |
| --- | --- | --- |
| 1 | `AGENTS.override.md` | `override` |
| 2 | `AGENTS.md` | `agents` |
| 3 | `AGENT.md` (legacy alias, kept for compatibility) | `legacy` |
| 4 | `CLAUDE.md`, only with `context.claudeMdFallback: true` | `claude` |

`Agente.md` is no longer read. Files are concatenated root-first, under a header telling the model
that the closest file wins when instructions conflict and that explicit user prompts override them.

### Nested files

Instruction files in directories below the working directory are attached lazily, when a tool
touches a path below them:

- once per session per file, and again if the file changes;
- for read tools, the instructions are attached to the tool result;
- for write or process calls, the call is returned to the model with the new instructions so it can
  reconsider before retrying.

### Size limit

All instruction files together are capped at `context.maxBytes` (default 32 KiB). The closest files
are kept; farther ones are truncated or dropped with a truncation notice.

```json
{
  "context": { "claudeMdFallback": false, "maxBytes": 32768 }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `claudeMdFallback` | `false` | Use `CLAUDE.md` in directories without an `AGENTS` file |
| `maxBytes` | `32768` | Total bytes of instruction files (1024–1048576) |

`alisio context explain <path>` (and the `context_explain` tool) shows which files apply to a path
and their kind. The built-in [`/init`](/prompt-templates#built-in-init) template creates or updates
the root `AGENTS.md`.

## Skills

Skills are directories containing a `SKILL.md` file with `name` and `description` frontmatter.

### Discovery

Roots are searched in this order; the first skill with a given name wins, and later ones are
reported as shadowed:

| Order | Roots | When |
| --- | --- | --- |
| 1 | `.agents/skills`, `.alisio/skills`, `.claude/skills` in each directory from the working directory up to the workspace root | Trusted projects only (`--trust-project` or an explicit `--config`) |
| 2 | Paths in the `skills` configuration key | Always |
| 3 | `~/.agents/skills`, `<config home>/skills` | Always |
| 4 | Directories registered by plugins (`api.resources.skills`) | When the plugin is loaded |

Scanning is bounded: at most 5 levels deep and 2000 directories.

### Validation

Names follow the Agent Skills specification: 1–64 lowercase letters and digits with single hyphens,
no leading or trailing hyphen. The description is required (up to 1024 characters). A directory name
that does not match the skill name only produces a warning. `alisio skills validate [path]` reports
all diagnostics.

### Progressive disclosure

Only each skill's name and description are included in the context at first. The body is loaded
with the `skill_load` tool or `/skill:name`, and supporting files with `skill_resource`.
`skill_search` searches the catalog.

In the TUI, `/skills` opens the effective catalog without loading skill bodies. It
shows scope/source, enabled and shadowed status, and an approximate token cost (`~`, estimated from
file bytes at four characters per token). Project, configured and user winners are enabled by
default and can be toggled immediately. The project-local override is saved atomically in
`.alisio/config.json`; an existing file must be trusted. Plugin skills use a namespaced display such
as `vercel:nextjs`, are locked to their owning plugin, and direct you to `/plugins`.

```sh
alisio skills list
alisio skills validate ./.agents/skills
```

The headless commands include source/status metadata and trusted diagnostic paths. The ordinary TUI
catalog never shows absolute paths or skill bodies.

## Context Governor {#context-governor}

The Context Governor is an **experimental, opt-in** projection of the conversation history. Long
sessions keep re-sending tool results that a later result has made redundant; with the governor
`on`, those results are replaced in the request by a one-line stub. It is off by default
(`context.governor: "off"`) and then changes nothing.

| Mode | What is sent to the provider | What it computes |
| --- | --- | --- |
| `off` | The history, exactly as before | Nothing |
| `shadow` | The history, byte for byte as before | What `on` would elide and how many tokens that would save |
| `on` | The history with redundant tool results replaced by stubs | The same, and applies it |

### What is elided

Only successful tool results, and only when a later successful result makes them redundant:

| Reason | A result is replaced when | Stub |
| --- | --- | --- |
| `superseded_read` | A later `write_file` or `edit_file` changed the same path, or a later `read_file` of that path returned a different `sha256` | `[elided: read_file "src/a.ts"@1a2b3c4d; re-read to view]` (with ` lines 10+50` before the `;` when `startLine` or `limit` were given; `@unknown` when the read had no `sha256`) |
| `stale_bg_output` | A later `bg_output` of the same task has identical arguments (the `offset` defaults to 0 and the `limit` to its default), or the earlier poll returned empty text | `[elided: bg_output "task-id" offset 0; a later bg_output covers it]` |
| `duplicate_search` | A later `search_text` has the same arguments and the same matches (the exit code and the `match`/`context` lines; the elapsed time is ignored) | `[elided: search_text "pattern"; identical to a later result]` |

A `bg_output` poll that continues from a previous `next_offset` is **never** elided: background
output is read incrementally, so every chunk is new information.

Never elided: the latest result for a path, anything in the last turn, results that are errors,
user messages, compaction checkpoints and assistant messages. A result is replaced only once it is
`elide.minAgeTurns` assistant messages old. Stubs are one line of ASCII (paths and patterns are
JSON-quoted) and depend only on the elided call, so the same history always produces the same stub. A result is never replaced when its stub would not be shorter than the original.

### Guarantees

- The stored transcript is never changed. The projection exists only in the request.
- Tool call IDs, roles, ordering and provider continuation data are untouched: a result keeps its
  `callId`, and only its text changes.
- `shadow` sends exactly the bytes `off` sends.
- Compaction triggers, the hard context limit, the context bar and the summarizer input use the
  **full** history, not the projection.
- Applied to sub-agent sessions too, each with its own history.

### Settings

```json
{
  "context": {
    "governor": "shadow",
    "elide": { "minAgeTurns": 2, "epochMessages": 32 }
  }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `governor` | `"off"` | `"off"`, `"shadow"` or `"on"` |
| `elide.minAgeTurns` | `2` | Assistant messages (1–20) a redundant result must be older than before it is replaced |
| `elide.epochMessages` | `32` | The projection grows in steps of this many messages (0–1000); `0` projects as eagerly as possible |
| `policyVersion` | unset | Optional pin of the elision rules (an integer from 1 to the current version, which is 1); unset follows this build |

With `epochMessages` greater than 0, only the first `floor(length / epochMessages) * epochMessages`
messages are eligible. Between two epochs the request grows only by appending, so a provider prompt
cache keeps hitting; at an epoch boundary the newly redundant results are elided at once.

### Limits of the guarantees

The projection is stable when messages are appended, with these exceptions, each of which rewrites
or reinterprets the history on purpose:

- A compaction replaces old messages with a checkpoint.
- The in-place reduction of an over-limit transcript clips tool results; clipping the later result
  that justified an elision can make the earlier one visible again.
- Changing the mode or the `elide` settings changes the policy.

Paths are compared as written: `./a.ts` and `a.ts` are different files to the governor, which only
costs a missed saving. A `read_file` result without a `sha256` (files over 1 MiB) can only be
elided by a later write or edit. The token figures are estimates (about four characters per
token), not provider usage. In this version the decisions are kept in memory only; no event or
screen exposes them yet.
