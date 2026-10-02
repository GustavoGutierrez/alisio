# Terminal UI

Without a subcommand, and with stdin and stdout attached to a terminal, Alisio opens a TUI built
with [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). It accepts
the same global flags as the rest of the CLI (`--config`, `--model`, `--allow-write`,
`--allow-process`, `--read-only`, and so on).

```sh
alisio --config ./my-api.json
alisio resume <id>        # TUI on an existing session
alisio --no-tui           # plain readline mode instead of the TUI
```

`run`, `resume <id> "prompt"` and `--json` never open the TUI. The TUI uses the terminal's alternate
screen; on exit it prints the conversation and the session ID. Exiting is fast: an in-flight turn
gets up to 3 seconds, session-end hooks ~1.5 seconds (during exit; `/clear` still honors the full
`pluginHooks.sessionEndTimeoutMs`), and teardown of MCP servers, provider and plugins runs in
parallel with short caps — a hanging server or plugin never stalls the exit.

## Quick path

| I want to… | Go to |
| --- | --- |
| Choose or switch provider and model | [`/connect`, `/model`](#commands) |
| Paste text or an image | [Paste: text and images](#paste-text-and-images) |
| Approve or deny a write/process call | [Interactive approvals](#interactive-approvals) |
| Answer a multiple-choice question | [Asking the user](#ask-user-question) |
| Grant or revoke MCP consent | [MCP manager](#mcp) |
| Watch or cancel a subagent | [Agent panel](#agent-panel) |
## Startup screen

Interactive sessions open with a startup screen: the mascot (by default "Ali", a trade-wind cloud
spirit), the version, a welcome line, the model, the provider host (never keys), the working
directory, access (`write`/`process` state or `read-only`), whether memory is on, the loaded plugins
and two rotating tips. It is laid out side by side when the terminal is wide and stacked when it is
narrow; below 40 columns the mascot becomes a single line. In the TUI it is the first block of the
conversation and scrolls away; in `--no-tui` mode it is printed to stderr.

It is shown only in the interactive TUI (stdout is a terminal) or in readline mode (only when stderr
is a terminal). It is never shown for `run`, `resume <id> "prompt"`, `--json`, `--quiet`,
`--no-banner`, when the `CI` environment variable is set, or when the target stream is not a
terminal. JSONL output is never affected, even when plugins register a mascot.

```sh
alisio --no-banner        # interactive, without the startup screen
alisio --quiet            # no startup screen and no non-essential hints
```

`TERM=dumb` renders it in ASCII without color, `NO_COLOR` disables color, and a `C`/`POSIX` locale
switches to ASCII. Plugins can replace the mascot or the whole screen through
[extension points](/plugins#extension-points).

## Layout {#layout}

The screen reflows when the terminal is resized, and every line is truncated or wrapped to the width.

| Area | Content |
| --- | --- |
| Header | **Alisio Code** and the running package version (the same value `--version` prints), **model · provider · effort** (the model name in bold cyan, the provider name in magenta, the effort level in yellow when the active model advertises supported levels), provider host (never the key or path), API mode, shortened working directory, short session ID, the git branch of the working directory when it is inside a git repository (`⎇ main`, or the commit SHA on a detached HEAD) and colored permissions (`write`/`process`: `on`, `ask` or `off`; `mcp:on` when the effective runtime permission is granted, `mcp:off` otherwise; `read-only`) |
| Conversation | Highlighted user messages; streamed assistant answers rendered as Markdown: bold bright-cyan headings, width-aware tables with aligned columns (separator rows with em/en dashes are normalized back to `---`), lists, inline and block code — block code is indented and syntax-colored per language (TypeScript/JavaScript, JSON, Bash, Python, YAML, CSS, HTML, Markdown) without any highlighter dependency, and links. A dim `⎘ copy · /copy` hint sits under every completed response. Visible reasoning sent by the provider (for example DeepSeek `reasoning_content`) is shown dimmed while it arrives, then collapsed to one line; it is never persisted or sent back |
| Tool blocks | One block per call: name, summarized argument (path, command, pattern), spinner while running, ✓/✗ status, duration and a truncated preview. `edit_file`/`write_file` show a `+`/`-` diff computed from the arguments. Tools that return structured data (for example MCP) render **native blocks**: aligned tables with wrapped cells, two-column key-value, trees with branch glyphs, syntax-highlighted code blocks, markdown blocks, and inline images when the terminal supports them (dim `[image: …]` placeholder otherwise) |
| Status bar | **Active agent line** below the editor: `agent: <name> · <model> · <provider> · <effort>` (model bold cyan, provider magenta, effort yellow; the effort appears only when the active model advertises supported levels; the lowest-priority pieces drop first on narrow terminals). Context used versus the **effective budget**, `used / total (pct%)`, with a green/yellow/red bar that turns red exactly where auto-compaction triggers; accumulated input/output tokens and cached tokens (`⚡`) when reported; turns; current turn duration; state; plugin status (for example `mem N`) |
| Run state | While a run is live the state piece names what it is doing instead of a bare "streaming": `waiting for the model`, `thinking`, `writing the answer`, `running Python (analysis.py)`, `reading your data (sales.csv)`, `publishing the artifact (dashboard.html)`, `running <tool>`, `compacting context`, `the model did not respond; retrying (1/1)` (a silent request is being sent again, see `limits.firstTokenRetries`), `the response was cut off; retrying in smaller steps (1/2)` (the output-token limit cut the response, see `limits.truncationRecoveries`), `waiting for your approval` or `a sub-agent is working`, followed by the elapsed time. Only titles and file names are shown, never commands or URLs. After 15 s without any event it adds `no response for 20.0s`, and after 60 s `(stuck?)` in yellow; Esc interrupts as usual. Waiting for you or for a sub-agent is never reported as quiet |
| Pickers | Selectable lists for `/model`, `/plugins`, `/skills`, `/resume` and approvals |

Errors appear in red inside the conversation without closing the TUI.

The context bar measures the **same effective metric the engine uses** for auto-compaction. With a
known context window (the `context_window`/`context_length` field of `GET /models`,
`provider.contextWindow` for the configured model, or the active `/connect` profile's
`values.contextWindow` override for its model), the total is that window and the bar turns red
at `threshold` of it (default 85 %). The catalog is loaded lazily at startup and refreshed after
every provider/model switch, so the active model's real window is shown whenever discovery exposes
it. The per-profile override exists for local servers (for example llama.cpp) that omit
`context_window`: `/connect` asks for it in tokens when the catalog cannot name the selected model's
window, and the override wins over the catalog. When the window genuinely cannot be known, the bar
shows an honest `~9.9k / ?` instead of a fabricated total or percentage — the char-budget fallback
remains an auto-compaction guardrail inside the engine, never a displayed total.
Used context is the last `prompt + completion` reported by the provider; without `usage`, an
estimate marked with `~` (about 4 characters per token) is shown.

## Commands

Typing `/` opens autocompletion: `/skills` suggests the effective skills by name or
description, and `/resume` suggests matching session IDs.

### Commands at a glance

| Command | Purpose |
| --- | --- |
| `/help` | Commands and keys |
| `/connect` | Open a focused provider form with paste-friendly URL input, masked secret input, an API key environment-variable field (the connection remembers its name for the environment fallback), cursor editing and explicit submit/cancel help; then show that provider's titled, provider-prefixed model list, persist the choice globally and start a fresh session |
| `/model`, `/models` | Open the global provider/model selector. Entries are grouped and prefixed by provider title, the active pair is marked, and unavailable catalogs remain visible without hiding healthy profiles. A different pair is persisted and starts a fresh session; the active pair is a no-op. Legacy root provider configuration is not listed |
| `/compact [focus]` | Summarize older history with the current model, with optional focus instructions |
| `/stats` | Tokens (input, output, cached), turns, calls and errors per tool, duration, models, context and plugin details |
| `/clear` (`/new`) | Start a new session with the current model |
| `/sessions` | Recent sessions of the workspace |
| `/resume <id>` | Resume by ID or prefix; without an argument, shows a picker |
| `/tools` | Tools and their state according to permissions (`enabled`, `ask`, `disabled`) |
| `/plugins` | Filter active, inactive and failed plugins; inspect metadata/source and persist a project enable/disable override. Changes are marked `restart required`; external actions require project trust and confirmation, and the active model provider cannot be disabled. Plugins are grouped under non-selectable category headers (`model-provider ›`, `memory ›`…); while filtering, a header only remains when its group still has matches, and `↑`/`↓` skip headers |
| `/skills` | Browse the bounded effective skills catalog; search with `/`, cycle name/source/token sorting with `t`, inspect safe details, and enable/disable manageable skills immediately. Plugin skills are locked and managed through `/plugins` |
| `/mcps` | Browse servers by source; separately inspect configured/enabled, session permission, connection and loaded-tool states; view annotations; connect/reconnect; and persist enable/disable in the defining file. Without startup `--allow-mcp` (or global `mcp.allow`), Connect/Enable shows process/network consequences and can grant access for this TUI session only, or remember it globally (`mcp.allow`) for every session. A "Revoke global MCP consent" row clears that preference and disconnects servers. `--read-only` blocks it |
| `/settings` (`/prefs`) | Settings menu: an OpenCode-style list of real, wired preferences (compaction, context, MCP consent, limits, editor padding, transcript inset) plus navigation rows for the managers below. Two-column rows (name + current value), type-to-search filter, `(n/total)` counter, footer with the highlighted row's description; Enter/Space changes a value, Esc leaves. Persisted to your user configuration and applied to the running session |
| `/copy` | Copy the last assistant response to the clipboard as raw text (unformatted, without the ANSI colors you see on screen) |
| `/ask <question>` | Turn your own question into a multiple-choice `ask_user_question` call; see [Asking the user](#ask-user-question) |
| `/btw [question]` | Ask a side question about the current session without adding it to the conversation: one tool-less call of the session's model sees the active history (oldest messages dropped to fit the context budget) and answers in a panel above the editor, never in the transcript, runs, events or session tokens. It works while a turn is running; Esc cancels a pending question or closes the panel. Without a question it shows your most recent side answer, `←`/`→` browse earlier ones (`2/5`), `↑`/`↓` scroll; with none yet it prints `Usage: /btw <question>`. The last 20 per session are kept and shared with the web UI. In `--no-tui` mode the answer is printed |
| `/agents` | Open the active-agent picker: every selectable main-session agent with its description, current/default/read-only markers. Selecting one persists `agents.active`, takes effect from the next prompt, and switches the session model when the agent declares one; see [Active agent and effort](#active-agent-and-effort). With an argument (`list`, `open`, `cancel`, `kill`, `resume`, `merge`, `discard`, `defs`) it routes to the subagents plugin's task management, see [Subagents](/subagents#in-the-tui) |
| `/effort [level]` | Set the reasoning effort for the active model when it advertises `effort.supportedLevels`: no argument opens a picker (the model's default is marked), an argument is validated and persisted (`agents.effort`). The level is sent from the next prompt; see [Active agent and effort](#active-agent-and-effort) |
| `/init [focus]` | Built-in [prompt template](/prompt-templates#built-in-init): analyze the repository and create or update the root `AGENTS.md` |
| `/artifacts [filter]` | Browse the artifacts of the session (newest first, filterable), then Preview here, Open with default app, Copy path, Reveal in folder, Copy to workspace…, Reveal analysis sources, Details or Delete; see [Artifacts](#artifacts) |
| `/permission [ask\|auto\|full\|status]` (`/permissions`) | One menu with **Use ask mode**, **Use auto mode**, **Use full access mode**, **Status** and **Manage saved permissions…** (review and revoke the permissions saved for the session, for example Python analysis allowed for this session). With an argument it sets the mode or prints the status directly; see [Permission modes](#permission-modes) |
| `/reload` | Reload the configuration, agents, skills, prompt templates and MCP servers between turns; a broken configuration leaves the session untouched; see [Reload and changelog](#reload-and-changelog) |
| `/changelog [version]` | Scrollable panel with what changed in recent releases (offline); see [Reload and changelog](#reload-and-changelog) |
| `/tasks` | Panel with this session's [background tasks](/tools#background-tasks) (`bg_run`) and a read-only view of its subagents: a list, the live output of one and a Stop key; see [Background tasks](#tasks) |
| `/goal [objective \| pause \| resume \| edit \| clear \| help \| budget=<n>]` | Start or manage the current Session Goal: with a goal it opens a menu (status, pause, resume, edit, budget, clear, help); with an objective it starts one that the agent keeps working on until it is done, blocked, paused or out of budget; see [Session goals](#goals) |
| `/exit` (`/quit`) | Exit |
| `/skill:name request` | Load a skill and send the request |
| `/command plugin.id:name args` | Run a plugin command |
| `/memory …` | Command of the built-in memory plugin; see [Persistent memory](/memory) |
| `/agents …` | Legacy subagent task management (built-in subagents plugin): `list`, `open`, `cancel`, `kill`, `resume`, `merge`, `discard`, `defs`; still reachable with an argument as above — see [Subagents](/subagents#in-the-tui) |
| `/agents new [description]` | Create an agent in `.agents/agents` (project or global). With a description, the active model writes the instructions right away ("Building with Alisio", Esc cancels); afterwards Alisio offers to try it in a new session. See [Agents](/agents#terminal-agents) |
| `/agents templates` | Start a new agent from a template (Code Reviewer, Test Writer, Security Auditor, …). See [Agents](/agents) |
| `/agents manage` | Edit, activate, try or delete saved agents; `/agents edit <id> [project\|global]` and `/agents delete <id> [project\|global]` go straight to one |
| `/agents reload` | Rediscover agent files changed outside Alisio |
| `/agent:<id>` | Activate a loaded agent from the next prompt; one command per loaded agent, and the `agent:` prefix never collides with other commands |

`/init` is a prompt template that generates or updates `AGENTS.md` from the repository; it is
unrelated to the `alisio setup` command, which only scaffolds an example `.alisio/config.json`.
Other [prompt templates](/prompt-templates) appear in their own section of
`/help` and in autocompletion.

Other plugin commands are routed the same way and listed in `/help` and autocompletion. While a turn
is running, prompts and the `/model`, `/agents` (picker), `/effort`, `/plugins`, `/skills`, `/mcps`, `/settings`, `/compact`, `/clear`, `/resume` and `/reload` commands wait: press Esc to
interrupt first. The subagent task-management verbs (`/agents open …`, `/agents list`, …) and `/btw` keep working during a run.

### Skills catalog and autocompletion

The skills catalog uses `↑`/`↓`, PgUp/PgDn, Home/End and the mouse wheel. It keeps the selection
visible after filtering, sorting and resizing, renders only the rows that fit, and reports clipped
rows as `↑ N more above` / `↓ N more below`. Enter or Space toggles the selected manageable skill;
Esc closes it. Skills also appear directly in the editor's slash autocomplete: starting to type
`/ski…` (or the skill's own name, like `/branch-pr…`) shows every effective skill as a
`skill:<name>` command with a scope marker (`[u]` user, `[p]` project, `[c]` config, `[l]` plugin)
and its description, OpenCode-style; selecting one inserts `skill:<name>` and submits it. In
addition, `/skills <prefix>` autocompletes catalog
entries by name or description (disabled, locked and shadowed entries stay listed with a status
hint); selecting a suggestion only fills the argument, so submitting still opens the catalog. The
`skill:<name>` slash entries can be hidden with the `tui.skillSlashCommands` setting (see below);
the `/skills` manager and its argument completion keep working either way.

### Settings menu (`/settings`)

`/settings` opens an OpenCode-style settings list. Each row is a setting name with its current
value in a right-hand column; the header shows the active provider/model. The list supports
type-to-search (matching name, key, category and description), `↑`/`↓`/Home/End/PgUp/PgDn
navigation, Enter or Space to change the highlighted setting, a `(n/total)` counter and a footer
with the highlighted row's description. Esc returns to the editor. Typing a space after starting a
search inserts a space into the filter. Under `--read-only` every row is shown but marked
read-only: nothing is persisted.

Every setting below is real and wired: it persists to your **user** configuration
(`~/.config/alisio/config.json`) through the same atomic writer used for MCP consent and is
applied to the running session. Values that are not in the offered list (for example a
hand-edited `compaction.threshold: 0.87`) move to the next offered candidate on your first Enter.

| Setting | Values | Default | Takes effect |
| --- | --- | --- | --- |
| Auto-compact (`compaction.auto`) | `true` / `false` | `true` | next run |
| Compaction threshold (`compaction.threshold`) | 50% – 95% in 5% steps | `85%` | next run |
| Keep latest turns (`compaction.keepTurns`) | 0 – 20 | `2` | next run |
| Compaction max output tokens (`compaction.maxOutputTokens`) | 8k / 12k / 16k / 24k / 32k | `16000` | next run |
| CLAUDE.md fallback (`context.claudeMdFallback`) | `true` / `false` | `false` | next turn |
| AGENTS.md max bytes (`context.maxBytes`) | 4 KiB – 1 MiB in 4 KiB steps | `32768` | next turn |
| Web search provider (`websearch.provider`) | `searxng` / `duckduckgo-instant` / `duckduckgo-html` / `tavily` / `brave` / `serpapi` / `native` | unset (fallback chain) | next search call |
| Remember MCP consent (`mcp.allow`) | `true` / `false` | `false` | immediately |
| Max turns (`limits.maxTurns`) | 5 / 10 / 15 / 20 / 30 / 50 / 100 | `100` | next run |
| Agent max output tokens (`limits.maxOutputTokens`) | 1k / 2k / 4k / 8k / 16k | `16384` | next run |
| Context char budget (`limits.maxContextChars`) | 80k / 120k / 160k / 240k / 320k / 800k | `800000` | next run |
| Run timeout (`limits.timeoutMs`) | 30 s – 600 s in 30 s steps (persisted as ms) | `300000 ms` (5 min) | next run |
| Plugin hook timeout (`pluginHooks.timeoutMs`) | 1 s – 120 s in 1 s steps (persisted as ms) | `15000 ms` | next hook call |
| Editor padding (`tui.paddingX`) | 0 – 4 | `1` | immediately |
| Content inset (`tui.contentPaddingX`) | 0 – 12 | `2` | immediately |
| Skill slash commands (`tui.skillSlashCommands`) | `true` / `false` | `true` | immediately |

"Remember MCP consent" toggles the same persisted consent as the `/mcps` grant flow: turning it on
writes `mcp.allow` and grants runtime permission (enabled servers auto-connect from the next
start; use `/mcps` to connect now), turning it off revokes the consent and disconnects servers.

The bottom rows navigate: Provider & model, Connect provider, Compact context now, Plugins,
Skills, MCP servers and Session statistics. Rows that open a manager leave Esc/back to that
manager; one-shot actions (compact, statistics) return to the settings list.

**Not included (honest list):** several settings commonly seen in other coding agents do not exist
in Alisio yet, so they are NOT offered here — telemetry (Alisio collects none), Mermaid diagram
rendering, steering/follow-up mode, double-Esc to exit, automatic transport selection (stdio/http
handshake), HTTP idle timeout for MCP, install telemetry, collapsed changelog entries, hardware
cursor, clearing on terminal shrink, terminal progress reporting, theme switching, warning
levels, a tree filter, a persisted trust default, and a global model-provider context window (that
one is per-profile in `/connect`). The active agent and the reasoning effort live in `/agents` and
`/effort`; a persisted trust default remains out of scope for now. If a setting is missing it
means Alisio does not implement the feature; no row is a stub.

In `--no-tui` mode the supported commands are `/exit`, `/new`, `/skill:name request` and
`/command plugin.id:name args`. Lines are processed sequentially; Ctrl+C cancels and exits.

### Active agent and effort

The **active agent** drives the main session: its system prompt is appended to every prompt, and a
read-only agent (like the built-in `plan`) narrows the run to reads (no write/process tools, no
approvals). Two built-ins ship with Alisio:

| Agent | Description |
| --- | --- |
| `build` (default) | Full-power general agent: edits code and files, runs processes and verifies its work through the normal permission flow. The default adds no persona, so out-of-the-box behavior is unchanged |
| `plan` | Read-only planning agent: analyzes the codebase and returns an implementation plan without modifying anything |

`/agents` (`/agents help`: the active-agent picker) lists every selectable agent with its
description: the built-ins plus any main-capable definition from the [subagents](/subagents) system
(definitions marked `mode: primary` or `mode: all`), including `--agents <json>` definitions and
agent Markdown files. The current agent is marked, `build` shows its `(default)` marker and read-only
agents show `read-only`. Selecting one persists `agents.active` in your user configuration and takes
effect **from the next prompt** (the current session is kept). When the chosen agent declares a
`model`, the session model is switched through the normal provider routing (a fresh session starts,
exactly like `/model`); an agent without a model keeps the current model — override it any time with
`/model`. A persisted agent id that no longer resolves (for example its definition was removed)
falls back to `build`.

**Reasoning effort.** When the active model advertises `effort.supportedLevels` in its catalog (for
example DeepSeek models), `/effort` selects the level that is sent with every subsequent prompt:
without an argument it opens a picker over the supported levels (the model's `defaultLevel` is
marked, plus an *Auto · provider default* entry that clears the saved value); with an argument the
level is validated and persisted (`agents.effort`). The provider receives it as
`reasoning_effort` (Chat Completions) or `reasoning.effort` (Responses); providers without an
effort concept ignore it. If the model later changes to one that does not support the stored level,
the model's default is used silently with a one-time notice. The chosen level is also shown in the
header and the status line, in yellow.

### Cycling agents with Shift+Tab {#cycle-agents}

**Shift+Tab** switches the active agent without opening a menu: `build` → `plan` → every other main
agent (definitions marked `mode: primary` or `mode: all`, sorted by name) and back to `build`. The
order is stable, whatever order the plugins discovered the agents in. The status row below the
editor shows `agent: <name>` and the hint names the new agent (`Agent: plan (read-only) · Shift+Tab
cycles agents`). The choice is persisted like `/agents` (`agents.active`) and applies **from the next
prompt**.

- During a turn the key only shows a hint (*A turn is running: wait for it to finish before
  switching agents*): an agent switch never changes a run that has already started.
- With a picker, the autocomplete list or the agent panel open the key is left alone.
- Unlike the `/agents` picker, cycling never switches the model and never starts a new session. If
  the agent declares a model different from the current one, the hint says so; run `/agents` to
  apply it.
- Under `--read-only` settings cannot be written, so the choice only lasts while the process runs.
- Some terminals do not report Shift+Tab as a separate key; `/agents` and `/agent:<id>` always work.
- Permissions are a separate axis: see [Permission modes](#permission-modes).

### Plan mode and plan review {#plan-review}

With the **plan** agent active (Shift+Tab, `/agents` or `/agent:plan`) the model investigates with
read-only tools and ends by calling `exit_plan` with the whole plan in Markdown. Alisio prints the
plan in full in the transcript, saves it as a `plan.md` artifact (`/artifacts` lists it) and opens
the decision panel **Plan complete. What would you like to do?**:

- `↑`/`↓` choose, `Enter` confirms.
- **Agree and start implementation**: after the plan turn ends Alisio switches to the `build`
  agent (persisted like `/agents`) and runs one implementation turn whose message carries the
  approved plan. The permission mode is not changed. Pressing Enter twice starts one turn.
- **Skip for now** (or `Esc`): the agent stays `plan` and nothing else happens.
- **Add context**: a one-line field opens (`←`/`→`/Home/End edit, `Enter` sends, `Esc` goes back to
  the choices); the text goes back to the model, which keeps planning and proposes a new revision.

Cancelling the turn (`Esc` in the editor) withdraws a pending review and drops an approval that had
not started yet. While the panel is open Shift+Tab does nothing, and the plan agent stays read-only
in every [permission mode](#permission-modes). With `--read-only`, or in `alisio run`, there is no
review: the tool tells the model so and the plan is its final answer.

## Permission modes {#permission-modes}

`/permission` opens one menu: **Use ask mode**, **Use auto mode**, **Use full access mode**,
**Status** and **Manage saved permissions…**. `/permissions` is an alias of the same menu, and
`/permission ask`, `/permission auto`, `/permission full` and `/permission status` skip it. The
current mode is always visible: `mode:<name>` in the header and `mode: <name>` in the status row.

| Mode | Runs without asking | Still asks | Web preset |
| --- | --- | --- | --- |
| `ask` | reads | writes, commands, network and external tools | `ask` |
| `auto` | reads and file edits inside the workspace | commands, network, external tools and directories outside the workspace | `workspace-write` |
| `full` | everything except paths outside the workspace and the install of optional packages | those two | `full-access` |

`auto` uses fixed rules: there is no model that classifies requests. `full` shows a confirmation
that says it is **not a sandbox**: anything the agent runs has your user's permissions. The same
table drives the web presets, so a mode behaves the same in both interfaces.

- **Initial mode.** It is derived from the launch flags and only labels the state: no flags is
  `ask`, `--allow-write` alone is `auto`, `--allow-write --allow-process --allow-external` is `full`
  and any other combination is `custom`. Nothing is changed at startup. If plugins or MCP were
  already allowed to reach outside at startup, `/permission status` says that `external` is on.
- **Applies between turns.** Changing the mode during a turn is refused with a hint. A mode takes
  effect from the next tool call and resets the "Always allow in this session" approvals.
- **`--read-only` locks the modes.** There is no approval handler to widen, so every mode is
  refused with *Permission modes are locked: Alisio was started with --read-only.*; **Status**
  still works.
- **Status** prints the mode and, per effect, whether it runs (`on`), asks (`ask`) or is denied
  (`off`).
- Saved permissions (Python analysis allowed for a session) are managed from **Manage saved
  permissions…**; `/permission` does not change them.

## Reload and changelog {#reload-and-changelog}

### `/reload` {#reload}

`/reload` re-reads the configuration layers, agent files, skills, prompt templates and MCP servers
without leaving the session. It only runs **between turns**: it is refused while a turn, a subagent,
an approval or a [background task](#tasks) is waiting. Everything is validated **before** anything is applied: the
configuration is parsed first and a new application is built next to the current one, so a broken
file leaves your session exactly as it was (the error says why). When it succeeds the report lists,
per area, what changed (counts, added, removed or updated names), refreshes the slash completion
and keeps the permission mode you picked.

Plugin code that was already imported cannot be unloaded: the report names the external plugins
that need a restart to pick up source changes, and the launch flags (`--allow-write`,
`--read-only`, `--model`…) keep their startup values. `alisio run` has no `/reload`.

### `/changelog` {#changelog}

`/changelog` opens a scrollable panel (↑/↓, PgUp/PgDn, Home/End, Esc to close) with the newest
entries of the shipped `CHANGELOG.md`; `/changelog alpha.26` (or the full version) shows one entry.
It works offline: the changelog is converted at build time and ships inside the package. After an
upgrade Alisio prints **one** line (*Alisio updated to … · 3 new entries · /changelog*); the last
version seen is stored in `tui-state.json` next to the session database, so a first run stays
silent. Entries are in English in every language. `alisio run` has no `/changelog`.

## Background tasks {#tasks}

When the agent starts a command with [`bg_run`](/tools#background-tasks) it keeps working and the
command runs in the background. `/tasks` opens a panel with the session's tasks — shell commands plus
a **read-only** view of the status of its [subagents](/subagents) (their own
[agent panel](#agent-panel) manages them) — and works during a turn.

| Where | Key | Action |
| --- | --- | --- |
| List | ↑ / ↓, Home / End | Move |
| List | Enter | Open the task |
| List, detail | `s` | Stop the task (asks `y`/`n`; only a running shell task) |
| List, detail | `q` | Close the panel |
| List | Esc | Close the panel |
| Detail | ↑ / ↓, PgUp / PgDn, Home | Scroll the output (this stops following the end) |
| Detail | End | Follow the end of the output again (it follows by default while the task runs) |
| Detail | Esc | Back to the list |

The detail view shows the command, the directory, the status (`running`, `done`, `failed · exit 2`,
`failed · time limit`, `stopped · by user`, `lost`…) and the output, read incrementally once a second
while the task runs (control characters and colors are removed so output cannot move the cursor).
Your stop ends the task `cancelled`, never `failed`.

When a task ends on its own, one coalesced message wakes the agent (a normal run of the session
shows *Background task finished: …*); it waits while a turn runs, a question or approval is on
screen or another session is open. Tasks are **not sandboxed** and **end when Alisio exits**; if it
was killed abruptly they show as `lost` next time. `/reload` is refused while tasks run (it would
close the old application and kill them): stop them or wait. `alisio run` waits for no task: it
stops the ones still running and says so.

## Session goals {#goals}

`/goal <objective>` gives the agent one objective for the whole session and lets it keep working on
it, turn after turn, until it is done, blocked, paused or out of budget. You write the objective once:
Alisio sends the full contract the first time and a short, stable reminder on every later turn, and the
**runtime** (not the prompt) enforces the limits. The agent decides when it is finished and says so
with [`update_goal`](/tools#goal-tools), with evidence; only **you** pause, resume, edit or clear a
goal or change its budget. There is no separate evaluator model in v1.

> **Cost.** A goal keeps spending tokens by itself. Every request of every turn counts, and each turn
> sends the whole context again. A goal **without a token budget is stopped only by its turn and time
> limits** (`goal.maxTurns`, 50, and `goal.maxMinutes`, 120): give long or open-ended objectives a
> budget (`budget=50k`) and watch the bar.

| Command | What it does |
| --- | --- |
| `/goal` | With a goal: opens the menu (status, pause, resume, edit, budget, clear, help). Without one: says how to start it |
| `/goal <objective>` | Creates the goal and starts working. One goal per session: if there is one, asks before replacing it |
| `/goal <objective> budget=50k` | Same, with a token budget (`50k`, `1.5M`, `250000`) |
| `/goal pause` | Stops continuing automatically; the turn in progress finishes |
| `/goal resume` | Continues a paused or blocked goal |
| `/goal edit [<objective>]` | Changes the objective (without text it puts the current one in the editor); the contract is sent again on the next turn |
| `/goal clear` | Removes the goal |
| `/goal budget=50k` | Sets the token budget of the current goal; `budget=clear` (also `none`, `off`, `0`) removes it |
| `/goal help` | The syntax with budget examples |

The objective can have up to 4 000 characters; `budget=` may appear once (a duplicate is rejected) and is
never part of the objective. The menu rows **Edit objective…** and **Set token budget…** leave
`/goal edit …` or `/goal budget=…` in the editor for you to finish.

### The goal bar {#goal-bar}

While a session has a goal, a two-line bar sits above the editor: the **status** and the objective, then
the **tokens** used against the budget, the **turn** `n/max`, the time spent in runs, **why it waits or
stopped**, and the actions for that state (`/goal pause · /goal edit · /goal clear`). When a goal stops
by itself one line also appears in the transcript.

### States {#goal-states}

| State | Reason codes | You can |
| --- | --- | --- |
| **Active** | `created`, `resumed` | pause, edit, budget, clear |
| **Paused** | `user_paused`, `user_interrupt` (you pressed Esc), `max_turns`, `max_wall`, `no_progress` (`repeated_reply` or `no_tool_turns`), `restart` | resume, edit, budget, clear |
| **Blocked** | `model_blocked`, `policy_denied`, `run_error` (the error is shown) | resume, edit, budget, clear |
| **Budget reached** | `token_budget` | raise or clear the budget (it continues); edit, clear. Not resumable otherwise |
| **Complete** | `model_complete` (with the agent's summary and evidence) | edit, budget, clear. Not resumable: start a new goal |

Resuming after `max_turns` or `max_wall` grants one more allowance of that limit. Two windows (or the
terminal and the web) cannot fight: every change is a compare-and-set, so an action based on an
out-of-date view is refused.

### Limits {#goal-limits}

- **Token budget (hard).** Counted over all the runs of the goal: the input and output tokens of
  every request, so a long context is paid again each turn. Each run is started with what is left as
  its own cap, and the runner refuses further tool calls once it is spent; the goal then goes to
  *Budget reached* and **nothing more runs** (there is no closing turn). If the provider reports no
  usage, the text of the replies is used as an estimate. Raising or clearing the budget re-arms a goal
  that stopped for it; lowering it to what was already spent stops an active one at once.
- **Turns** (`goal.maxTurns`, 50) and **time** (`goal.maxMinutes`, 120, time inside runs): the goal
  pauses. A continuation's own timeout shrinks to what is left of the time.
- **Breakers.** Pause with `no_progress` after the same final reply repeats
  (`goal.repeatedReplyLimit`, 3) or after consecutive turns without a tool call (`goal.noToolTurnsLimit`,
  3). The first occurrence is logged, the second adds a nudge to the next continuation, the limit
  pauses.
- **Blocked.** The agent must report the same blocker, with evidence, in consecutive turns
  (`goal.blockedRepeats`, 2), except a permission denial, which blocks at once. A turn that **fails**
  blocks the goal with the error as the reason, except a provider timeout (the runner already retried
  it), which only counts as a turn.

### What never continues on its own {#goal-waits}

One ordered list decides, in this order: the goal is not active (or goals are off); a turn is running
or a continuation is already claimed; you have text in the editor (you go first); a **permission**
waits (*Waiting for permission*); a **question** or plan review waits (*Waiting for your answer*); the
active agent is the **plan agent** (a goal never runs in plan mode); **background tasks** of the session
are running (*Waiting for background tasks*: it continues when the last one ends, also if you stopped
it). Pressing **Esc** during a turn pauses the goal (`user_interrupt`). These are waits, not states:
the goal stays active and continues when the cause is gone.

### Safety and restart {#goal-safety}

A goal never widens permissions: its turns use the same policy, approvals and permission mode as any
other turn, and never run in plan mode. The objective is **your text** and goes into the prompt as
quoted data, never as instructions that outrank the rules around it; the transcript shows only its
first 140 characters. Every continuation is a normal persisted user message started with an idempotent
request id (`goal-<id>-<n>`), so a double trigger starts one run and tool call ids and provider
continuation data stay consistent.

If Alisio stops while a goal is active (closed, killed), the next start brings it back **paused** with
reason `restart`: it never resumes by itself, run `/goal resume`. `alisio run` (headless) has no
`/goal` in v1.

## MCP manager {#mcp}

`/mcps` in the TUI lists servers by source and, for the selected one, separates configured/enabled,
session permission, connection and loaded-tool states, showing tool annotations. Without startup
`--allow-mcp` (or the global `mcp.allow`), **Connect**/**Enable** explains the process/network
consequences and offers a **session-only** grant or **Grant and remember** (which writes `mcp.allow`
and auto-connects enabled servers from the next start); a **Revoke global MCP consent** row clears
that preference and disconnects servers. `--read-only` blocks the whole manager. See
[Tools & permissions](/tools#mcp) for server configuration and
[Configuration](/configuration#mcp-servers) for `mcp.allow`.
## Keys

| Key | Action |
| --- | --- |
| Enter | Send |
| Shift+Enter, Alt+Enter, Ctrl+J | Insert a new line (depends on the terminal) |
| Tab | Autocomplete |
| ↑ / ↓ | Input history |
| Esc | Interrupt the running turn |
| Ctrl+C | Clear the input; interrupt an active turn; pressed twice on an empty input, exit |
| Ctrl+D | Exit when the input is empty |
| `c` / `y` | Copy the last assistant response as raw text (when the input is empty) |
| `x` | Expand or collapse the nearest collapsible row — a finished **Thought** section, a grouped batch of tool calls, or a long command output (when the input is empty; see [Tool & reasoning display](#tool-reasoning-display)) |
| Mouse click | On a collapsible header row, expand or collapse it (see [Tool & reasoning display](#tool-reasoning-display)) |
| PgUp / PgDn, mouse wheel | Scroll the conversation |
| Shift+Tab | Cycle the main agents: `build`, `plan`, then your own primary agents, wrapping around (see [Cycling agents](#cycle-agents)) |
| Ctrl+X | Focus the [agent panel](#agent-panel) |
| Ctrl+B | Move running foreground agents to the background (during a turn) |
| Ctrl+K | Cancel the selected or viewed agent |
| Ctrl+V | Attach a clipboard image (see [Paste](#paste-text-and-images)) |
| Ctrl+R | Remove the most recently attached image |

`/exit`, double Ctrl+C on an empty input and Ctrl+D all go through the same bounded shutdown:
whatever is still running is aborted, waited for at most ~3 seconds, session-end hooks get ~1.5
seconds, and the app teardown itself is capped — exit feels instant even with many MCP servers.

## Tool & reasoning display {#tool-reasoning-display}

The transcript follows the display conventions of other coding agents, so a busy turn reads as a
story instead of a wall of raw calls:

- **Humanized tool names.** `read_file` renders as **Read File**, `search_text` as **Search Text**,
  `mcp_devforge_time_diff` as **MCP · Devforge Time Diff**. Known acronyms stay uppercase (HTTP,
  API, CLI…). The machine name remains available dimmed in each grouped call's detail row, and in
  the `/tools` and `/stats` reports.
- **Collapsible reasoning.** While the model thinks, the row shows the live `✻ thinking…` tail.
  Once the thought section finishes it folds to **`+ Thought · 2.9s`** (the duration approximates
  the thinking interval from the event stream; replayed sessions omit it). Expanding shows the
  full thinking text, bounded to 40 wrapped lines.
- **Grouped tool batches.** Consecutive calls of the same kind (`read`, `write`, `process`, `mcp`)
  appear as **one row once they all finish**: `✓ Read File — 3 reads · 60ms` for a uniform batch,
  or `✓ Explored — 3 reads` when the batch mixes read tools. Expanding lists each call with its
  status, duration, summary, a capped output preview and its exit-code line. A batch that shares a
  name keeps the humanized tool name plus a per-kind count noun (`reads`, `files`, `commands`,
  `calls`, `tasks`). Running or approval-pending calls always stay individual rows with their own
  spinner and live state — a batch collapses into its group row only once every call has finished.
- **Long command output.** A tool preview longer than the collapsed cap (3 clean lines on success,
  6 on error) folds to the familiar shell view: the first lines, `… N more lines`, and a closing
  line **`Command exited with code 0.`** (green) or `Command exited with code 1.` (red) when the
  tool reported an exit code (run_process, shell, search_text). Expanding reveals the full output.
  Edit diffs, images and native ui blocks (tables, trees…) keep their previous rendering; rich
  blocks are not folded because they are already bounded.

Collapsibles are toggled by pressing **`x`** with an **empty input** (never while typing a
message — the same empty-input convention as `c`/`y`), or by **clicking the header row** of a
collapsible with the mouse (drag-selection and copy-on-select are unaffected: a plain click
without movement toggles, a drag still selects). The nearest collapsible means the last one in the
transcript, so during streaming `x` folds the most recent finished block. Collapsed rows show a
dim `+`, expanded ones a dim `−`.

## Agent panel {#agent-panel}

When [subagents](/subagents) run, a collapsible tree panel appears under the editor. Its header shows
how many agents are running, queued, **waiting** and finished; each row shows a status icon, the
agent name and color, the elapsed time, tokens and a one-line live summary. Indentation shows
parent → child.

A row shows **waiting** (◆, distinct from the running spinner) instead of running while that agent
is blocked on `ask_user_question` or a write/process approval — currently shown, or queued behind
another prompt. This is a display-only status computed from the same
[interactive queue](#ask-user-question) that serializes prompts; it is never persisted, so it
disappears again as soon as the agent's prompt is answered or withdrawn.

| Focus | Key | Action |
| --- | --- | --- |
| Editor | Ctrl+X, or ↓ on an empty editor when agents exist | Focus the panel |
| Editor | Ctrl+X then ↓ within 800 ms | Open the first agent directly |
| Panel | ↑ / ↓ | Move the selection |
| Panel | → | Expand, or enter the children |
| Panel | ← | Collapse, or go to the parent |
| Panel | Enter | Open the agent's conversation in a read-only view |
| Panel | Esc, Tab | Back to the editor |
| Child view | ↑ | Parent agent (from a top-level agent, back to the root conversation) |
| Child view | ↓ | First child |
| Child view | ← / → | Previous / next sibling |
| Child view | Esc | Back to the root conversation |
| Panel or child view | Ctrl+K | Cancel the selected or viewed agent (asks y/n when it has descendants) |
| Any | Ctrl+B | Move running foreground agents to the background |

In a child view the footer shows the agent path, its index and the total, context percentage, tokens
and key hints. Typing while the panel is focused returns focus to the editor.

## Copy on select

The TUI captures the mouse. Dragging selects text and copies it to the clipboard with the first
available tool, without a shell:

| Platform | Tools tried in order |
| --- | --- |
| Linux | `wl-copy`, `xclip -selection clipboard`, `xsel -b` (plus the Windows tools under WSL) |
| macOS | `pbcopy` |
| Windows | `clip.exe`, PowerShell `Set-Clipboard` |

If none works, Alisio sends an OSC 52 escape sequence and reports it as **unverified**, because the
terminal cannot confirm it. `/copy` copies the last assistant response the same way.

### Copying a response

Every completed assistant response shows a dim **`⎘ copy · /copy`** hint under it (ASCII
`[copy] · /copy` on terminals without Unicode) — it only tells you the response can be copied, it
does not trigger anything by itself. Pressing **`c`** (or **`y`**) with an **empty input** copies
the last assistant response the same way `/copy` does — as **raw, unformatted text** (the Markdown
source, never the colored rendering) — and flashes the same `Copied (<tool>)` confirmation. Typing
`c` or `y` mid-message types normally: the hotkey only fires on an empty input while no
autocomplete is showing and no turn is running. The hint appears only once the answer is complete
(it never shows while streaming).

While mouse capture is active, native terminal selection usually requires **Shift+drag**.

## Rich tool results {#rich-tool-results}

Tools that answer with structured data — MCP servers first among them — stop flattening their
output into raw JSON text. The connector maps verified shapes into Alisio's own `ui` blocks and
the TUI renders them natively under the tool head:

- **Tables** render as aligned columns: the header is bold, cells wrap to their column width
  (long values wrap instead of being cut), and a dim separator line sits under the header. An
  optional caption shows dimmed above the block.
- **Key-value** renders as two columns: bright-cyan keys on the left, values wrapped on the right.
- **Trees** render with branch glyphs (`├─`/`└─`/`│`) and fall back to ASCII (`|-`/`` `- ``/`|`)
  on terminals without Unicode. A dim `(meta)` annotation follows the label when present.
- **Code** renders as a mini code block reusing the response highlighter: a dim ` ```lang ` fence,
  highlighted lines, and the closing fence.
- **Markdown** renders through the regular response Markdown renderer (headings, lists, tables…).
- **Images** render inline when the terminal supports the kitty or iTerm2 graphics protocol
  (pi-tui 0.87.1 auto-detection). Without image support — or with `NO_COLOR` — a dim placeholder
  `[image: image/png 640x480]` is shown instead.

Every block has a canonical **text projection** that is always part of the tool result, so the
model, `/copy`, compaction summaries and every headless path see plain text only (image bytes never
reach the model prompt). The transcript also stores the projection, so `resume` replays rich
results natively. This is a display layer: the raw JSON is not shown once a block renders, and
unrecognized shapes keep the previous preview behavior.

## Paste: text and images {#paste-text-and-images}

**Text.** Pasting, including multi-line text, inserts as a single atomic edit at the cursor: it
never fragments into keystrokes, never submits early on an embedded newline, and undoes in one
step. Long pastes (over 10 lines or 1000 characters) collapse into a marker like
`[paste #1 +42 lines]` that expands back to the full text when the message is sent. This comes
from the editor component itself (bracketed paste), not from Alisio-specific code.

**Images.** `Ctrl+V` attaches whatever image is on the system clipboard to the message you are
composing:

| Key | Action |
| --- | --- |
| Ctrl+V | Attach the clipboard image (PNG, JPEG, GIF or WebP) |
| Ctrl+R | Remove the most recently attached image |

Attached images appear above the editor: as an inline thumbnail on terminals that support the
Kitty or iTerm2 graphics protocol, otherwise as a compact line such as
`[1] image/png 1024x768, 42.0 KB`. Up to **4 attachments** per message, **5 MB** raw bytes per
image; going over either limit shows an inline message and rejects only the offending image — it
never crashes the TUI. Attachments ride along with the very next message you send (any command
that reaches the model, including a rendered prompt template) and are cleared afterward.

Sent attachments become standard OpenAI-compatible vision content parts (`image_url` in chat mode,
`input_image` in Responses mode) alongside your text, using the provider already configured —
there is no separate vision setting. Alisio does not check whether a model supports images before
sending; if it does not, the provider's own rejection appears as a normal inline error, the same
as any other request failure. Attachments are persisted with the message, so `/resume` and
compaction both see them; a summarized (discarded) image is described to the checkpoint model by
its type and dimensions only — its bytes are never sent again and never appear in the checkpoint
text.

Image clipboard access depends on a native platform helper and is not guaranteed everywhere:

| Platform | Native image clipboard | Typical gaps |
| --- | --- | --- |
| Linux (X11) | Yes, via a bundled helper | Falls back to `wl-paste` on Wayland; unavailable over plain SSH without X11 forwarding or a running Wayland/X11 session |
| Linux (Wayland) | Via `wl-paste` | Same SSH/remote-session limitation |
| macOS | Yes, via a bundled helper | Not verified over SSH by this project |
| Windows | Yes, via a bundled helper | Not verified over SSH by this project |

When no helper is available, `Ctrl+V` does nothing harmful: it reports that image clipboard access
is not available and leaves the input untouched. This is common in remote/headless sessions, since
image clipboard access needs a local display server or native platform APIs that a bare SSH session
does not provide.

**`--no-tui` (readline) mode.** Images are not supported there at all: no rendering and no
clipboard wiring. Single-line text paste works exactly like typing. Multi-line paste does **not**
paste atomically: Node's plain `readline` interface has no bracketed-paste support, so each
embedded newline is treated as its own Enter, submitting one message per line instead of one
combined message. Use the full TUI (the default on an interactive terminal) for multi-line or
image paste.

## Asking the user (ask_user_question) {#ask-user-question}

The model can ask one or more multiple-choice questions with the `ask_user_question` tool (see
[Tools & permissions](/tools#ask-user-question)) — for example when there is a real fork in the
approach and the user's preference changes what happens next. You can also start this yourself with
`/ask <question>`: the agent proposes 2-4 concrete options for your own question (marking one
`recommended` only when it has a clear opinion) and calls the tool immediately.

Questions are shown **one at a time** (stepped), not as a single panel holding every question's
options at once — a narrow terminal cannot fit several questions' options legibly in one screen, and
a step reflows independently on resize. The header line shows `Question i/N`; a `recommended` option
is tagged and colored, not only described, so it stands out even when descriptions are truncated.

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move the highlighted option (wraps at the ends) |
| → / Space | Toggle an option (multi-select questions only) |
| Enter | Confirm the current question and advance; submits on the last question |
| ← / Backspace | Back up to change an earlier answer (only offered once you have advanced) |
| Esc | Skip the **current question only** |

**Esc skips only the current question**, not the whole batch: it records that question as skipped
(shown as `_Skipped_` in the summary) and moves on to the next one exactly like Enter would, so an
earlier or later question in the same batch is never affected. This was a deliberate choice (Claude
Code's own exact behavior here was not independently verifiable at the time): whole-batch cancellation
would throw away answers already given, which is more surprising than skipping one question.

After the last question is confirmed or skipped, a compact summary is added to the conversation:
one line per question with its header and chosen option(s), or `_Skipped_` / `_None selected_`
(an explicit empty multi-select answer, distinct from a skip); long option labels are truncated
with a trailing `…` rather than wrapped, to keep the summary short.

### One prompt at a time

Write/process approvals, `/model`'s picker and `ask_user_question` all share **one interactive
queue**: at most one of them is ever on screen, in the order they were asked (plain first-in,
first-out — there is no root-over-subagent priority, since a subagent can also call
`ask_user_question` through the same tool). A [subagent](/subagents)'s question shows a breadcrumb
of who is asking (its agent path, e.g. `general › explore asks:`) and its answer is delivered back
only to that exact subagent, never broadcast. If a subagent is cancelled while its question is
queued or currently displayed, it is withdrawn cleanly — a notice says so, and the next queued
prompt (if any) takes its place — rather than leaving a stale prompt for a dead session. The [agent
panel](#agent-panel) shows that agent as **waiting** for as long as it is queued or displayed.

`/model` and `/resume`'s own pickers are not part of this shared queue: they are commands you type
yourself, never concurrent with a subagent's question.

## Truncated responses {#truncated-responses}

When a response is cut by `limits.maxOutputTokens` (finish reason `length`), the text produced so
far is kept and the run completes normally, but the TUI adds a visible notice:
`Response cut by max output tokens — the answer may be incomplete.` This is a hint, not an error:
raise `limits.maxOutputTokens` in your configuration for longer answers (see
[Configuration](/configuration#limits)). A truncated checkpoint from context compaction is shown
with a `partial` marker and points at `compaction.maxOutputTokens` (see
[Context compaction](/compaction)). Headless modes stay machine-readable: `alisio run --json`
never prints the notice text and carries the state only in event data — `run_completed` includes
`"truncated": true` when the final answer was cut, and `compaction_completed` includes
`"partial": true` for a cut summary.

## Turn limit {#turn-limit}

`limits.maxTurns` is a **safety rail, not a hard stop** (the real hard stops are the token budget
and the run timeout). When a run reaches the turn cap, Alisio keeps everything produced so far and
ends the run **softly**: the TUI adds a gentle notice —
`Turn limit reached — the answer may be incomplete. Continue with another prompt or raise
limits.maxTurns (/settings → Max turns).` — instead of an error block, and you can simply type
`continue` to keep going in the same session (the transcript is intact). Headless consumers see the
`run_turns_exceeded` event with the cap in its data, and the run result carries
`"status": "turns-exceeded"` with the partial text. Subagents that hit their cap return their
partial report as usable output with a `turnsExceeded` marker, never as a failure (see
[Subagents](/subagents#turn-limit)).

## Interactive approvals {#interactive-approvals}

In the TUI, when `write` or `process` are not allowed by flags, the corresponding tools are still
offered to the model, and Alisio asks before running them:

- **Allow once**
- **Always allow `<effect>` in this session** (lasts while the process lives)
- **Deny**

A tool path outside the workspace and every declared extra root asks the same way, scoped to the
containing directory (one session approval covers that directory's subtree). With `--read-only`
nothing is asked and those tools stay disabled. Headless modes never ask. The time
spent waiting for an approval counts toward `limits.timeoutMs`. Approvals share the same
[interactive queue](#ask-user-question) as `ask_user_question`, so a subagent's approval prompt and a
subagent's question never race each other for the screen. See [Tools & permissions](/tools) and
[Permission modes](#permission-modes), which switch these approvals on or off in one step.

## Artifacts {#artifacts}

Files published by [`python_run` or `artifact_create`](/analysis) are announced under the tool row
with their kind, name, size and real local path:

```text
  ▤ Dashboard  sales-dashboard.zip  48 KB
    ~/.local/state/alisio/artifacts/3f2a…/7c1d…/sales-dashboard--art_01JZ…/files/index.html
```

Without Unicode the icons are ASCII (`[D]`, `[M]`, `[T]`, `[I]`, `[J]`, `[C]`, `[Z]`, `[F]`) and
`NO_COLOR` removes the colors. At the end of a turn that published artifacts a dim line reminds you
of `/artifacts`. Nothing is opened automatically.

`/artifacts [filter]` lists the artifacts of the root session; choose one and pick an action (only
the ones that apply are offered):

| Action | When | What it does |
| --- | --- | --- |
| **Preview here** | Markdown, CSV/TSV, JSON, text and code | A bounded, scrollable preview (below) |
| **Open with default app** | Always | `xdg-open`, `open` or `explorer.exe`, never through a shell |
| **Copy path** | Always | Copies the local path (OSC 52 when needed) |
| **Reveal in folder** | Always | `explorer.exe /select,` on Windows, `open -R` on macOS, the folder on Linux |
| **Copy to workspace…** | Not with `--read-only` | Asks for a workspace folder and runs `artifact_export`; writing asks first unless `--allow-write` |
| **Reveal analysis sources** | `python_run` outputs | Opens the job folder (script, logs) of that execution |
| **Details** | Always | Date, model, provider, runtime, inputs with their hashes, the execution and, for a rerun, the execution it repeats |
| **Rerun** | `python_run` outputs, when `python_run` is available | Runs the same script on the same inputs as a new execution with new artifacts; it asks like the first run |
| **Delete** | Ready artifacts | With confirmation |

An artifact whose files were removed by [retention](/analysis#retention) still lists, marked
`Expired`, and offers only **Details** and **Rerun** (a rerun recreates it while its script is kept).

Esc goes back, a second Esc closes. Over SSH or without a display nothing is launched: Alisio shows
the path and offers to copy it.

The preview shows Markdown with the chat renderer (first 256 KiB), CSV/TSV as a table (200 rows ×
20 columns, with a `showing 200 of 12,480 rows · 20 of 31 columns` legend), JSON pretty-printed
(256 KiB) and text or code with highlighting (2 000 lines); the footer says `truncated` when it was
cut. ↑/↓, PgUp/PgDn and Home/End scroll, `o` opens with the default app, `c` copies the path and
Esc or `q` closes. Dashboards, PDFs, images and office files are never drawn in the terminal.

Running Python asks with its own title, `Run Python analysis (managed · not sandboxed)?`, shows the
first 40 lines of the script and offers **Allow once**, **Allow for this session** (saved for the
session, also after a restart) and **Deny**; Esc denies. `/permissions` lists saved permissions and
revokes them. With `analysis.runtime: "oci"` the title says `(container · no network)` instead.

Installing the optional Python packages asks with `Install Python packages (analysis; needs
network)?`, listing the packages, the download estimate and that nothing is compiled, and offers
only **Allow once** and **Deny**: this permission is never remembered. `/settings` has a **Data
analysis** group with the switch, the timeout and the three retention values.

### Data tools {#data}

`data_inspect` and `data_query` results show their tables in the transcript with the same table
renderer: the schema with type hints and statistics, a sample of rows, or the query result (at most
1 000 rows, with a `truncated` note). The terminal does not attach files: the model reads a workspace
file with `data_inspect { path }`, and a path outside the workspace follows the usual directory
approval. The CSV/TSV preview of `/artifacts` reads files the way ingestion does (`,` `;` TAB or `|`
delimiters; UTF-8, UTF-16 with a BOM or windows-1252); XLSX is never drawn in the terminal, so
**Open with default app** is its only action, and the model reads it with `data_inspect`. See
[Tabular data](/analysis#data).
