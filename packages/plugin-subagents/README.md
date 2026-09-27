# @alisio/plugin-subagents

**Subagents for [Alisio](https://github.com/GustavoGutierrez/alisio).** The parent agent delegates
work with the `task` tool to specialized agents that run in separate child sessions: fresh context,
narrowed permissions, their own model and limits.

## What it is

Shipped as a built-in plugin of the `alisio` CLI (disable with `--disable-plugin subagents` or
`builtinPlugins.subagents.enabled: false`). It is built on the generic `api.sessions` service,
`api.ui.panel` and `api.ui.select`, so it depends only on `@alisio/sdk` plus `zod` and `yaml`.

## Installation

Preinstalled in the `alisio` CLI. For an embedded host, register it through `createApplication`'s
`builtins` list.

## Tools

| Tool | Input | Behavior |
| --- | --- | --- |
| `task` | `description`, `prompt`, `subagent_type`, optional `model`, `task_id`, `background` | Start an agent (or continue `task_id` with full history) and return its final report; several calls in one turn run in parallel |
| `task_status` | `task_id` | Status, agent, background flag and tokens; does not wait |
| `task_wait` | `task_id`, optional `timeout_ms` | Wait for a result, bounded by `waitMaxMs` |
| `send_message` | `task_id`, `text` | One-way message: queued for a running child's next turn, or resumes a finished child |

Results are wrapped in `<task …>` elements; background tasks deliver a `<task-notification>` when
they finish. Failures are structured tool errors that keep the `task_id`, so a task can be resumed.

## Agent definitions

Markdown + YAML frontmatter (`name`, `description`, `tools`, `model`, `permission`, `maxTurns`, …)
discovered from `--agents` (JSON), `.alisio/agents`, `.agents/agents`, `.claude/agents`,
`.opencode/agent(s)`, user directories and plugin resources. Built-ins: `general` (multi-step
tasks), `explore` (read-only exploration) and `plan` (read-only implementation plans).

## Parallel writes in git

With `parallelWrites: "worktree"`, each write-capable child works in its own git worktree
(`worktreeDir`, default `<state home>/worktrees`); the TUI `/agents` command offers
`open|cancel|kill|resume` and `merge|discard <id>` for worktrees. `ask`, `serial` and `shared` are
the other modes.

## Configuration

Under `builtinPlugins.subagents`:

| Field | Default | Description |
| --- | --- | --- |
| `maxDepth` | `3` | Maximum nesting (1–8) |
| `maxConcurrentPerParent` | `4` | Running children per parent (1–32) |
| `maxConcurrentTotal` | `8` | Running children in total (1–64) |
| `maxQueued` | `16` | Waiting tasks beyond the concurrency limits (0–256) |
| `maxTurns` | `50` | Default turn limit per child |
| `timeoutMs` | `600000` | Timeout per child run |
| `maxTokensPerChild` | core budget | Per-child cumulative token budget |
| `maxOutputTokensPerChild` | `16384` | Per-child per-call output token budget |
| `parallelWrites` | `ask` | `ask`, `worktree`, `serial` or `shared` |
| `resultMaxBytes` | `50000` | Result size cap |
| `worktreeDir` | `<state home>/worktrees` | Where worktrees are created |

Children never exceed their parent: a read-only parent (or `--read-only`) makes every descendant
read-only, and approvals bubble up to the TUI labeled with the agent path.

## Docs

[Subagents](https://gustavogutierrez.github.io/alisio/subagents) ·
[Configuration](https://gustavogutierrez.github.io/alisio/configuration).

## Requirements

Node.js **>= 22.16** or Bun **>= 1.4.2**.

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.