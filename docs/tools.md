# Tools & permissions

Every tool declares an **effect**. The effect decides whether the tool is available, asks for
approval or is disabled.

| Effect | Meaning | Default |
| --- | --- | --- |
| `read` | No side effects | Enabled |
| `write` | Modifies workspace files | Needs `--allow-write` (or TUI approval) |
| `process` | Runs arbitrary processes | Needs `--allow-process` (or TUI approval) |
| `external` | MCP, Herdr, external plugin tools | Enabled only when MCP, agents or external plugins are active, and never with `--read-only` |
| `internal` | Writes only Alisio-owned state (never the workspace or network) | Always allowed; honored only for built-in plugins |

Unknown or plugin operations default to `external`. `/tools` in the TUI shows the current state of
each tool (`enabled`, `ask`, `disabled`).

## Built-in tools

| Tool | Effect | Purpose |
| --- | --- | --- |
| `read_file` | `read` | Read a text file |
| `list_files` | `read` | List files |
| `search_text` | `read` | Search with ripgrep |
| `git_status` | `read` | `git status --porcelain=v1` |
| `git_diff` | `read` | `git diff --no-ext-diff --no-textconv` |
| `skill_load`, `skill_search`, `skill_resource` | `read` | Agent Skills catalog, activation and resources |
| `context_explain` | `read` | Explain which `AGENTS.md` files apply to a path (see [Context](/context)) |
| `write_file` | `write` | Write a file |
| `edit_file` | `write` | Replace an exact, unique match in a file |
| `run_process` | `process` | Run a command with an argument array |
| `shell` | `process` | Run a shell command |

Edits require a SHA-256 fingerprint of the file and an exact, unique match. Writes use a temporary
file plus an atomic replace on the same filesystem. Mediated operations reject paths outside the
workspace and symlinks; this does not protect against hostile processes changing paths concurrently,
and it does not confine a free shell.

Editable files and the initial read scan are limited to 1 MiB; tool outputs are bounded and a
truncated result is marked explicitly. Independent reads run in batches of up to four; operations
with effects are serialized.

Built-in plugins add more tools: `memory_*` from [Persistent memory](/memory) and `task`,
`task_status`, `task_wait` and `send_message` from [Subagents](/subagents), all with the `internal`
effect.

## Permission flags

| Flag | Effect |
| --- | --- |
| (none) | Read and search tools only |
| `--allow-write` | Enables `write_file` and `edit_file` |
| `--allow-process` | Enables `run_process` and `shell` |
| `--allow-mcp` | Starts/connects configured MCP servers and exposes their capabilities |
| `--allow-agents` | Enables Herdr messaging tools |
| `--read-only` | Disables writes, arbitrary processes, MCP, agent messaging and executable (external) plugins |

`--read-only` wins over every `--allow-*` flag. Built-in plugins (for example `memory`) remain
active under `--read-only` because their tools only use the `internal` effect; use
`--disable-plugin memory` for a strictly write-free mode.

## Interactive approval

In the TUI, `write` and `process` tools that were not allowed by flags are offered to the model and
Alisio asks before running each call: allow once, allow that effect for the session, or deny.
Headless modes (`run`, `resume <id> "prompt"`, `--json`) never ask. See
[Terminal UI](/tui#interactive-approvals).

## Not a sandbox

::: danger
Alisio does **not** provide an OS sandbox. `--allow-process` gives the model arbitrary processes with
your user privileges. Plugins run in-process with full privileges; a plugin manifest or a
subprocess is not an isolation boundary, and the `effect` field does not isolate anything.
:::

## MCP

MCP servers are configured in [`mcp.servers`](/configuration#mcp-servers) and are only started or
contacted with `--allow-mcp` (and never with `--read-only`).

- `mcp_connect` connects on demand and registers the server's tools; `mcp_resource` and `mcp_prompt`
  list and read resources and prompts.
- Exposed tools must use schemas supported by the registry. Schema changes require a restart; a
  call is never executed with a stale schema.
- There is no interactive OAuth and no automatic retry of operations with effects.

```sh
alisio mcp list --config ./my-api.json
alisio mcp doctor my-server --config ./my-api.json --allow-mcp
```

## Herdr

Inside a [Herdr](https://github.com/GustavoGutierrez/alisio/blob/main/docs/herdr.md) pane, lifecycle
reports are enabled by Herdr's variables (`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`,
`HERDR_SOCKET_PATH`). Alisio reports `custom:alisio`, its state and session, and releases that
authority on exit. `--no-herdr` disables the reports.

```sh
alisio --config /path/to/my-api.json --allow-agents
```

With `--allow-agents`, the model gets `herdr_agents`, `herdr_prompt`, `herdr_read` and `herdr_wait`.
Use pane IDs or unique agent names. Arguments are sent as arrays, never interpolated into a shell,
and ambiguous messages are not retried.

Alisio is a custom integration: do not use `herdr agent start --kind alisio` (Herdr 0.9.1 has no
such kind). Start it in an existing pane or with `herdr pane run`, and resume manually with
`alisio resume`.
