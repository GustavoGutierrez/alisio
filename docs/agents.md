# Agents

Agents are reusable personas: a name, instructions (a system prompt), a model and a few model
settings. Alisio stores them as Markdown files that other harnesses (Claude Code, OpenCode) can
read too, and lets you create, edit, try and switch them from the web UI and the terminal.

## Where agents live

| Scope | Path | Loaded when |
| --- | --- | --- |
| Project | `<workspace>/.agents/agents/<id>.md` | the workspace is trusted (from the web or the terminal) |
| Global | `~/.agents/agents/<id>.md` | always |

An untrusted workspace still saves project agents but does not load them; trust it from the
sidebar's workspace **⋯** menu or the button in the editor, and they load at once.

When the same id exists in both scopes, the project agent overrides the global one; the lists show
both with a Project/Global badge and mark the override. New agents go to the project scope when a
workspace is open, otherwise to the global scope.

Alisio keeps reading its other agent locations (`.alisio/agents`, `<config>/agents`,
`.claude/agents`, `.opencode/agent(s)`); the Agents window and `/agents manage` only write and list
the two `.agents/agents` scopes.

## File format

```markdown
---
name: code-reviewer
description: Reads a diff and reports bugs, risky changes and missing tests.
model: openai-compatible/gpt-5
mode: all
tools: Read, Grep
alisio:
  displayName: Code Reviewer
  reasoning:
    effort: high
    summary: auto
  text:
    format:
      type: text
    verbosity: medium
---

You are a meticulous code reviewer working inside the user's repository.
```

`name` is the id (lowercase letters, digits and hyphens), `description` and `model` follow the
common subagent convention, and the body is the instructions. Alisio-only settings live under
`alisio:`, which other tools ignore. When Alisio edits a file another tool created, every other key
and comment is kept as it was.

## Web: the Agents window

Open **Agents** in the sidebar, right above **Settings**.

- **Your agents** lists project and global agents; click one to edit it, or delete it.
- **Templates** start a new agent prefilled: Code Reviewer, Test Writer, Refactoring Assistant,
  Documentation Writer, Security Auditor, Bug Triage & Debugger, Migration Assistant, Research
  Agent, Customer Support Agent, DevOps Assistant, Meeting Assistant and Analytics Agent.
- **Create** opens the editor. Describe the agent and press **Create with Alisio**: the active model
  writes the role, goal, scope, tool rules, constraints and output format while the "Building with
  Alisio" dialog shows progress (Cancel stops the model call). The new agent is saved and you can
  **Try it in a new chat** or **Stay in editor**. With existing instructions (a template or a saved
  agent) the button becomes **Refine with Alisio** and applies your requested changes.
- The **Setup** tab has the definition (name, description, instructions, scope) and the model
  settings. The model list comes from your configured providers; text format, reasoning effort,
  verbosity and summary follow what the selected model declares, and every option is offered when
  the provider declares nothing. **Save agent definition** is enabled only for a valid definition
  with unsaved changes.
- **Agent config** shows the same definition as a request to Alisio's own API, ready to copy.
- The **Sessions** tab lists the chats that use the agent and starts a new one.

The writing guidance comes from a skill named `create-agent` (or `agent-creator`) when your project
or user skills have one; otherwise Alisio uses its bundled `create-agent` guidance.

## Switching agents

Every loaded agent is also a command, `/agent:<id>`; the `agent:` prefix never collides with
built-in commands, plugin commands, prompt templates or skills. `/agents` opens a searchable picker
that marks the current agent and offers `build` to return to the default Alisio agent. In the web,
the agent badge in the chat header opens the same picker.

The switch applies from the next prompt, never in the middle of a turn: the agent's instructions,
read-only mode and default reasoning effort take effect then. An explicit effort (`/effort`, or the
chat's own setting) wins over the agent's. The agent's model is applied in the same chat only when
it belongs to the chat's provider; otherwise start a new chat with the agent.

## Terminal: `/agents`

```text
/agents                       picker: switch agent, + Create agent…, ✎ Manage saved agents…
/agents new [description]     create (with a description: written by Alisio right away)
/agents templates             start from a template
/agents manage                edit, activate, try or delete saved agents
/agents edit <id> [project|global]
/agents delete <id> [project|global]
/agents reload                rediscover agent files (subagents plugin)
/agent:<id>                   activate an agent from the next prompt
```

The editor is a list of fields; Enter edits one. Instructions are edited on one line, with `\n` for
line breaks, or rewritten with **✦ Refine with Alisio**. While the model writes, the hint line shows
"Building with Alisio" and Esc cancels. After creating an agent, Alisio offers to try it in a new
session.

## API

```sh
curl -X POST http://127.0.0.1:4317/api/agents \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:4317" \
  -H "Cookie: alisio_session_4317=<session cookie>" \
  -d '{"workspace":"<workspace id>","scope":"project","name":"Code Reviewer","model":"openai-compatible/gpt-5","instructions":"You review diffs.","reasoning":{"effort":"high"},"text":{"format":{"type":"text"},"verbosity":"medium"}}'
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/agents/definitions?workspace=` | both scopes, default scope and directories |
| `POST` | `/api/agents` | create (`scope`, optional `workspace`) |
| `GET` / `PUT` / `DELETE` | `/api/agents/:id?scope=&workspace=` | read, update, delete |
| `GET` | `/api/agents/templates` | templates |
| `GET` | `/api/agents/models?workspace=` | configured models with capabilities |
| `POST` | `/api/agents/draft` | draft or refine with the active model |
| `GET` | `/api/sessions?agent=<id>` | sessions that use an agent |

Writes answer `{ agent, live }`. `live: true` means the running Alisio already uses the change: after
every write the agent registry is reloaded and clients receive `catalog_changed`. `live: false`
(the subagents plugin is off, the workspace is not trusted, or another location shadows the file)
means the file is saved and Alisio must restart to use it; the UI says so.

See [Known limitations](/limitations) for what is not wired yet.
