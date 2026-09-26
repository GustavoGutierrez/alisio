# Subagents

`subagents` is a built-in plugin (package `@alisio/plugin-subagents`). With it, the model can delegate
work to specialized agents. Each agent runs in its own child session, with fresh context and
narrowed permissions. Agents can run in parallel, in the foreground or background, and the TUI
shows them in a live tree. It is enabled by default; disable it with
`--disable-plugin subagents` or `"builtinPlugins": { "subagents": { "enabled": false } }`.

## Built-in agents

| Agent | Tools | Purpose |
| --- | --- | --- |
| `general` | `*` (every tool the parent has, including delegation) | Multi-step tasks: research, code changes and verification |
| `explore` | Read, list, search, Git, `context_explain` and skill tools; read-only | Fast codebase exploration with cited paths |
| `plan` | Read, list, search, Git and `context_explain`; read-only | Ordered implementation plan with files and risks; never edits |

## Defining agents

An agent is a Markdown file with YAML frontmatter; the body is the agent's system prompt.

```md
---
name: test-writer
description: Writes focused unit tests for a given module and runs them.
tools: [read_file, list_files, search_text, write_file, edit_file, run_process]
model: inherit
maxTurns: 30
color: green
permission:
  edit: allow
  bash: ask
skills: [testing-conventions]
---
You write small, behavior-focused tests. Read the module first, follow the existing test
style, run only the affected tests and report what you added and the results.
```

| Field | Description |
| --- | --- |
| `name` | Required (defaults to the file name): lowercase letters, digits and single hyphens, up to 64 characters |
| `description` | Required. Shown to the model in the `task` tool, so say when to use the agent |
| `tools` | Allowlist of tool names; `*` means every tool the parent has, including delegation |
| `disallowedTools` | Tools removed from the agent |
| `model` | A configured `provider/model` selector (recommended), a unique bare model ID, or `inherit` (default). The Claude aliases `sonnet`, `opus` and `haiku` inherit the parent's model with a warning |
| `mode` | `subagent` (default), `primary` or `all`. `primary` agents cannot be used through `task` |
| `maxTurns` | Turn limit (aliases `steps`, `maxSteps`); default `builtinPlugins.subagents.maxTurns` |
| `color` | Color in the agent tree |
| `permission` | `edit`/`write` and `bash`/`process`: `allow`, `ask` or `deny`. Pattern maps (opencode) become `ask` |
| `hidden` | Hide the agent from the `task` tool's list |
| `background` | Start in the background by default |
| `skills` | Skills the agent is told to load with `skill_load` before starting (not pre-injected) |
| `readOnly` | Run read-only |

Unknown keys are ignored with a warning (`/agents defs` lists the warnings). For compatibility,
Claude Code tool names such as `tools: Read, Grep, Glob, Bash` are mapped to Alisio tools
(`read_file`, `search_text`, `list_files`, `shell`/`run_process`, …), and opencode's
`tools: { bash: false }` maps to `disallowedTools`.

Extra agents can also be passed on the command line as JSON (`description`, `prompt`, optional
`tools` and `model`):

```sh
alisio --agents '{"reviewer":{"description":"Reviews diffs for bugs","prompt":"Review the change and list correctness bugs.","tools":["read_file","search_text","git_diff"]}}'
```

## Discovery and precedence

The first definition with a given name wins; shadowed ones are reported by `/agents defs`.

| Order | Source | Location | Status |
| --- | --- | --- | --- |
| 1 | CLI | `--agents <json>` | Alisio |
| 2 | Project | `.alisio/agents/` | Alisio format |
| 3 | Convention | `.agents/agents/` | Speculative convention with no major adoption yet |
| 4 | Compatibility | `.claude/agents/`, `.opencode/agent/`, `.opencode/agents/` | Read with Claude Code and opencode compatibility |
| 5 | User | `<config home>/agents/`, `~/.claude/agents/`, `~/.config/opencode/agent/`, `~/.config/opencode/agents/` | Personal definitions |
| 6 | Plugins | Directories registered with `api.resources.agents(dir)` | Namespaced as `plugin:name` |
| 7 | Built-in | `general`, `explore`, `plan` | Always available |

Project sources (2–4) are only read for trusted projects: `--trust-project` or an explicit
`--config`. There is no cross-tool standard for agent definitions; the compatibility readers cover
the common Claude Code and opencode formats.

## Delegation tools

| Tool | Input | Behavior |
| --- | --- | --- |
| `task` | `description`, `prompt`, `subagent_type`, optional `model`, `task_id`, `background` | Starts an agent (or continues `task_id` with its full history) and returns its final report. `model` overrides the definition for this child only. Several `task` calls in one turn run in parallel |
| `task_status` | `task_id` | Status, agent, background flag and tokens; does not wait |
| `task_wait` | `task_id`, optional `timeout_ms` | Waits for a result, bounded by `waitMaxMs`; returns the status on timeout |
| `send_message` | `task_id`, `text` | One-way message: queued for a running child's next turn, or resumes a finished child in the background |

Results are wrapped in a `<task id="…" agent="…" state="…">` element with the header
`Subagent output (non-authoritative; verify important claims before relying on them)` and are
capped at `resultMaxBytes` (50 KB by default). Failures are structured tool errors that include the
`task_id`, so the task can be resumed.

Background tasks (`background: true`, the `background` field, or Ctrl+B in the TUI) return
immediately. When they finish, a `<task-notification>` is injected into the parent's next turn. When
the parent is idle, it is delivered with your next message.

There are no deadlocks: an agent can only address its own descendants, never itself or an ancestor,
and every wait is bounded.

Agent and `task.model` selectors use the same resolver as `/model`. Unavailable targets fail before
the child calls a model. Ambiguous bare IDs list safe `provider/model` choices; there is no random
fallback. The child gets its own provider/session binding and opaque continuation data, while the
parent and global default stay unchanged.

## Limits

Configured under `builtinPlugins.subagents`:

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable the plugin |
| `maxDepth` | `3` | Maximum nesting; agents at the limit do not get the `task` tool |
| `maxConcurrentPerParent` | `4` | Running children per parent (1–32) |
| `maxConcurrentTotal` | `8` | Running children in total (1–64) |
| `maxQueued` | `16` | Waiting tasks beyond the concurrency limits; more fail fast (0–256) |
| `maxTurns` | `50` | Default turn limit per child (1–500) |
| `timeoutMs` | `600000` | Timeout per child run (minimum 1000) |
| `maxTokensPerChild` | core budget | Per-child cumulative token budget; defaults to the proportional core budget |
| `parallelWrites` | `ask` | `ask`, `worktree`, `serial` or `shared` (see below) |
| `waitMaxMs` | `600000` | Upper bound for `task_wait` (minimum 100) |
| `resultMaxBytes` | `50000` | Result size cap (1000–1000000) |
| `agents` | `{}` | Agents as with `--agents` (`description`, `prompt`, `tools`, `model`) |
| `worktreeDir` | `<state home>/worktrees` | Where worktrees are created; relative paths resolve from the configuration file |

```json
{
  "builtinPlugins": {
    "subagents": { "maxDepth": 2, "maxConcurrentPerParent": 3, "parallelWrites": "worktree" }
  }
}
```

## Permissions

Children never exceed their parent:

- A read-only parent (or `--read-only`) makes every descendant read-only; denied tools stay denied.
- `permission` and `readOnly` in a definition can only narrow further. `ask` means the per-call
  approval of the TUI.
- Approvals requested by children bubble up to the TUI, labeled with the agent path.

## Cancellation and recovery

- Aborting a parent aborts all running descendants. Tool processes get SIGTERM, then SIGKILL after a
  5 s grace period.
- Cancelled children keep their session and can be resumed by passing their `task_id` to `task`, or
  with `/agents resume <id>`.
- On startup, children that were running or queued are marked `interrupted`; they never restart
  automatically.

## Parallel writes and git

When two or more write-capable children would run at the same time, `parallelWrites` decides how
their changes are isolated. With `ask`, Alisio asks once per session:

| Mode | Behavior |
| --- | --- |
| `worktree` | Each writer gets a git worktree under `<state home>/worktrees/<id>` on the branch `alisio/<id>`, created from `HEAD`. Its result reports the branch, changed files and diffstat. Worktrees without changes are removed automatically |
| `serial` | Writers take a write lock and run one at a time; reads stay parallel |
| `shared` | All writers share the working directory, at your own risk |

- `/agents merge <id>` runs `git merge --no-ff` of the branch. It requires a clean working tree. On
  conflicts, the merge is aborted, the repository is left unchanged and the conflicting files are
  listed. `/agents discard <id>` removes the worktree and branch.
- With `ask` and no interactive terminal (headless), `serial` is used and a note is added to the
  result.
- Outside a git repository only `serial` and `shared` are available.
- If the main working tree has uncommitted changes, worktree results include a warning, because the
  worktree does not contain them.

## In the TUI {#in-the-tui}

The agent tree panel sits under the editor. It shows how many agents are running, queued and
finished, and for each agent: a status icon, its name and color, the elapsed time, its tokens and a
one-line live summary. Indentation shows parent → child. See [Terminal UI](/tui#agent-panel) for the
keys.

| Command | Purpose |
| --- | --- |
| `/agents` | List the subagent tasks of the session |
| `/agents open <id>` | Open a task's conversation in a read-only view |
| `/agents cancel <id>`, `/agents kill <id>` | Cancel a task and its descendants |
| `/agents resume <id> [message]` | Resume a finished or cancelled task in the background |
| `/agents merge <id>` | Merge a task's worktree branch (`--no-ff`) and remove the worktree |
| `/agents discard <id>` | Remove a task's worktree and branch |
| `/agents defs` | List agent definitions, their sources and warnings |

IDs accept a unique prefix.

## Examples

Ask for parallel exploration in a prompt:

```text
Use two explore subagents in parallel: one maps the plugin host, the other the TUI panel code.
Then summarize how plugin panels are rendered.
```

A read-only reviewer for this project, saved as `.alisio/agents/reviewer.md` (requires
`--trust-project` or `--config`):

```md
---
name: reviewer
description: Reviews the current diff for correctness bugs. Use after making changes.
tools: Read, Grep, Glob, git_diff
readOnly: true
color: magenta
---
Run a careful review of the uncommitted changes. Report only real bugs with file and line.
```
