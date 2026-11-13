# Tool validation

This page is a smoke-validation checklist for Alisio's tools: for each tool, one concrete call and
the result that proves it is wired and reachable. It records the verification scope for tools;
runtime and packaging limits are in [Known limitations](/limitations), and the effect model is in
[Tools & permissions](/tools).

## Scope

- Covers the tools Alisio ships: the built-in set plus the tools added by the built-in `memory` and
  `subagents` plugins.
- Third-party MCP tools are out of scope beyond the fact that they depend on their server: the list
  is whatever the connected server exposes.
- Validation is a live call in a real session, not a unit test, and every row is reproducible by a
  user with the same flags.

## Built-in tools

| Tool | Effect | Validation | Expected result |
| --- | --- | --- | --- |
| `read_file` | `read` | Read a tracked file such as `package.json` | Content plus a `sha256` fingerprint |
| `list_files` | `read` | List a directory such as `packages` | Entries with `nextOffset` and `truncated` |
| `search_text` | `read` | Search a literal that exists in the repo | Matches with file and line |
| `git_status` | `read` | Run it inside a Git repository | `git status --porcelain=v1` output |
| `git_diff` | `read` | Run it with pending changes | A unified diff |
| `skill_load` | `read` | Load an installed skill | Skill root plus its instructions |
| `skill_search` | `read` | Search a term | Matching skills, or `[]` when none match |
| `skill_resource` | `read` | Read a file under a skill root | The file content |
| `context_explain` | `read` | Explain the `AGENTS.md` files for a path | The scopes that apply, closest last |
| `ask_user_question` | `read` | Ask 1-4 questions in the TUI | The selected answers, or a fast error headless |
| `write_file` | `write` | Create a scratch file | The new path plus a `sha256` |
| `edit_file` | `write` | Replace one unique match | An updated `sha256` |
| `run_process` | `process` | Run `git rev-parse --short HEAD` | The short commit id |
| `shell` | `process` | Run `pwd && node --version` | The working directory and the Node version |
| `execute` | `process` | Call one read-only tool inside a snippet | That tool's result as JSON |
| `webfetch` | `external` | Fetch `https://example.com` | Status 200 and the page text |
| `websearch` | `external` | Search any query | Ranked results, or a provider error |
| `plugin_install` | `process` | Install a known npm plugin | The installed path and the config entry |

## Plugin tools

| Tool | Effect | Validation | Expected result |
| --- | --- | --- | --- |
| `memory_save` | `internal` | Save an observation | The id and the action (`created`, `updated`, `duplicate`) |
| `memory_search` | `internal` | Search a word already stored | Compact rows, or `[]` |
| `memory_get` | `internal` | Fetch a saved id | The full observation |
| `memory_context` | `internal` | Call it at session start | A bounded context block |
| `memory_timeline` | `internal` | Ask for the neighbours of an id | Older and newer rows |
| `memory_pin` | `internal` | Pin, then unpin, an id | `pinned: true`, then `false` |
| `memory_forget` | `internal` | Soft delete; `hard: true` removes it | `forgotten: true` |
| `task` | `internal` | Delegate a small read-only job | A task id, foreground or background |
| `task_status` | `internal` | Check that id | State, agent and token count |
| `task_wait` | `internal` | Wait for that id | The subagent's final report |
| `send_message` | `internal` | Message a finished task | It resumes in the background |

## Permission-gated tools

`read` tools are always available and `internal` tools only touch Alisio's own state; `write`,
`process` and `external` need a flag or an interactive approval in the TUI. To validate a gated tool,
allow its effect first.

| Effect | Enable with | Headless run with no flag |
| --- | --- | --- |
| `read` | Always enabled | Available |
| `write` | `--allow-write`, or approve in the TUI | Unavailable |
| `process` | `--allow-process`, or approve in the TUI | Unavailable |
| `external` | `--allow-external`, `--allow-mcp`, `--allow-agents`, or approve in the TUI | Unavailable |
| `internal` | Always enabled | Available |

`--read-only` wins over every `--allow-*` flag: the effect is never offered, in the TUI or headless.

## External dependencies

- `list_files` and `search_text` need the `rg` executable on `PATH`.
- `webfetch` and `websearch` need network access. `websearch` uses the configured
  `websearch.provider`, else a public SearXNG instance; public instances may answer with a
  bot-check page instead of results, so configure a provider for reliable use.
- MCP tools exist only after their server is connected (`--allow-mcp`, or the global `mcp.allow`).
- `ask_user_question` needs a bound interactive UI; in a headless run it fails fast and tells the
  model to ask in plain text instead.

## Procedure

```sh
# Interactive: read is immediate; approve write/process/external per call
alisio

# Or start permissive for the session
alisio --allow-write --allow-process --allow-external

# Headless: an unset flag means the effect is unavailable
alisio run "list the available tools" --allow-write --allow-process --allow-external
```

After changing tools, run the repository checks (`pnpm check`) so typecheck, lint, tests, the CLI
end-to-end and the docs gates stay green.

## Last run

Snapshot of 2026-09-27 (Node v22.19.0, commit `ace8def`): every built-in and plugin tool above
answered as expected except `websearch`, which failed because the default public SearXNG instance
returned a bot-check page — a provider problem, not a tool problem. `ask_user_question` was
exercised in the interactive TUI and returned answers. `plugin_install` was not run because it
changes global state.
