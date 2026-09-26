# @alisio/plugin-subagents

Subagents for [Alisio](https://github.com/GustavoGutierrez/alisio), shipped as a built-in plugin of the
`alisio` CLI (disable with `--disable-plugin subagents`). The parent agent delegates work with the
`task` tool to specialized agents that run in separate child sessions: fresh context, narrowed
permissions, their own model and limits. It depends only on `@alisio/sdk` (generic
`api.sessions`, `api.ui.panel`, `api.ui.select`) plus `zod` and `yaml`.

- Agent definitions: Markdown + YAML frontmatter (`name`, `description`, `tools`, `model`,
  `permission`, `maxTurns`, …) from `--agents`, `.alisio/agents`, `.agents/agents`, `.claude/agents`,
  `.opencode/agent(s)`, user directories and plugins; built-ins `general`, `explore`, `plan`.
- Tools: `task`, `task_status`, `task_wait`, `send_message`; parallel and background tasks, bounded
  waits, `<task …>` results, `<task-notification>` on background completion.
- Limits: depth, concurrency per parent and total, bounded queue, turns, timeout and token budget.
- Parallel writes in git: worktree per subagent (merge/discard with `/agents`), serial or shared.
- A live agent tree in the TUI with keyboard navigation and read-only child views.

Docs: [Subagents](https://gustavogutierrez.github.io/alisio/subagents).

Maintainer: Gustavo Gutiérrez · License: MIT
