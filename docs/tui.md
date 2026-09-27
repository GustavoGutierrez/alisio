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
| Header | **Alisio Code** and the running package version (the same value `--version` prints), model, provider host (never the key or path), API mode, shortened working directory, short session ID, the git branch of the working directory when it is inside a git repository (`⎇ main`, or the commit SHA on a detached HEAD) and colored permissions (`write`/`process`: `on`, `ask` or `off`; `mcp:on` when the effective runtime permission is granted, `mcp:off` otherwise; `read-only`) |
| Conversation | Highlighted user messages; streamed assistant answers rendered as Markdown (headings, bold, lists, inline and block code, links). Visible reasoning sent by the provider (for example DeepSeek `reasoning_content`) is shown dimmed while it arrives, then collapsed to one line; it is never persisted or sent back |
| Tool blocks | One block per call: name, summarized argument (path, command, pattern), spinner while running, ✓/✗ status, duration and a truncated preview. `edit_file`/`write_file` show a `+`/`-` diff computed from the arguments |
| Status bar | Context used versus the **effective budget**, `used / total (pct%)`, with a green/yellow/red bar that turns red exactly where auto-compaction triggers; accumulated input/output tokens and cached tokens (`⚡`) when reported; turns; current turn duration; state; plugin status (for example `mem N`) |
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

Typing `/` opens autocompletion: `/skills` (`/skill`) suggests the effective skills by name or
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
| `/plugins` (`/plugin`) | Filter active, inactive and failed plugins; inspect metadata/source and persist a project enable/disable override. Changes are marked `restart required`; external actions require project trust and confirmation, and the active model provider cannot be disabled |
| `/skills` (`/skill`) | Browse the bounded effective skills catalog; search with `/`, cycle name/source/token sorting with `t`, inspect safe details, and enable/disable manageable skills immediately. Plugin skills are locked and managed through `/plugins` |
| `/mcp` | Browse servers by source; separately inspect configured/enabled, session permission, connection and loaded-tool states; view annotations; connect/reconnect; and persist enable/disable in the defining file. Without startup `--allow-mcp` (or global `mcp.allow`), Connect/Enable shows process/network consequences and can grant access for this TUI session only, or remember it globally (`mcp.allow`) for every session. A "Revoke global MCP consent" row clears that preference and disconnects servers. `--read-only` blocks it |
| `/settings` (`/prefs`) | Settings menu: an OpenCode-style list of real, wired preferences (compaction, context, MCP consent, limits, editor padding) plus navigation rows for the managers below. Two-column rows (name + current value), type-to-search filter, `(n/total)` counter, footer with the highlighted row's description; Enter/Space changes a value, Esc leaves. Persisted to your user configuration and applied to the running session |
| `/copy` | Copy the last assistant response to the clipboard |
| `/ask <question>` | Turn your own question into a multiple-choice `ask_user_question` call; see [Asking the user](#ask-user-question) |
| `/init [focus]` | Built-in [prompt template](/prompt-templates#built-in-init): analyze the repository and create or update the root `AGENTS.md` |
| `/exit` (`/quit`) | Exit |
| `/skill:name request` | Load a skill and send the request |
| `/command plugin.id:name args` | Run a plugin command |
| `/memory …` | Command of the built-in memory plugin; see [Persistent memory](/memory) |
| `/agents …` | Command of the built-in subagents plugin: list, `open`, `cancel`, `kill`, `resume`, `merge`, `discard`, `defs`; see [Subagents](/subagents#in-the-tui) |

`/init` is a prompt template that generates or updates `AGENTS.md` from the repository; it is
unrelated to the `alisio setup` command, which only scaffolds an example `.alisio/config.json`.
Other [prompt templates](/prompt-templates) appear in their own section of
`/help` and in autocompletion.

Other plugin commands are routed the same way and listed in `/help` and autocompletion. While a turn
is running, prompts and the `/model`, `/plugins`, `/skills`, `/mcp`, `/settings`, `/compact`, `/clear` and `/resume` commands wait: press Esc to
interrupt first.

### Skills catalog and autocompletion

The skills catalog uses `↑`/`↓`, PgUp/PgDn, Home/End and the mouse wheel. It keeps the selection
visible after filtering, sorting and resizing, renders only the rows that fit, and reports clipped
rows as `↑ N more above` / `↓ N more below`. Enter or Space toggles the selected manageable skill;
Esc closes it. Skills also appear directly in the editor's slash autocomplete: starting to type
`/ski…` (or the skill's own name, like `/branch-pr…`) shows every effective skill as a
`skill:<name>` command with a scope marker (`[u]` user, `[p]` project, `[c]` config, `[l]` plugin)
and its description, OpenCode-style; selecting one inserts `skill:<name>` and submits it. In
addition, `/skills <prefix>` (or `/skill <prefix>`) autocompletes catalog
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
| Web search provider (`websearch.provider`) | `searxng` / `duckduckgo-instant` / `tavily` / `brave` / `serpapi` / `native` | unset (fallback chain) | next search call |
| Remember MCP consent (`mcp.allow`) | `true` / `false` | `false` | immediately |
| Max turns (`limits.maxTurns`) | 5 / 10 / 15 / 20 / 30 / 50 / 100 | `100` | next run |
| Agent max output tokens (`limits.maxOutputTokens`) | 1k / 2k / 4k / 8k / 16k | `16384` | next run |
| Context char budget (`limits.maxContextChars`) | 80k / 120k / 160k / 240k / 320k / 800k | `800000` | next run |
| Run timeout (`limits.timeoutMs`) | 30 s – 600 s in 30 s steps (persisted as ms) | `300000 ms` (5 min) | next run |
| Plugin hook timeout (`pluginHooks.timeoutMs`) | 1 s – 120 s in 1 s steps (persisted as ms) | `15000 ms` | next hook call |
| Editor padding (`tui.paddingX`) | 0 – 4 | `1` | immediately |
| Skill slash commands (`tui.skillSlashCommands`) | `true` / `false` | `true` | immediately |

"Remember MCP consent" toggles the same persisted consent as the `/mcp` grant flow: turning it on
writes `mcp.allow` and grants runtime permission (enabled servers auto-connect from the next
start; use `/mcp` to connect now), turning it off revokes the consent and disconnects servers.

The bottom rows navigate: Provider & model, Connect provider, Compact context now, Plugins,
Skills, MCP servers and Session statistics. Rows that open a manager leave Esc/back to that
manager; one-shot actions (compact, statistics) return to the settings list.

**Not included (honest list):** several settings commonly seen in other coding agents do not exist
in Alisio yet, so they are NOT offered here — telemetry (Alisio collects none), Mermaid diagram
rendering, steering/follow-up mode, double-Esc to exit, automatic transport selection (stdio/http
handshake), HTTP idle timeout for MCP, install telemetry, collapsed changelog entries, hardware
cursor, clearing on terminal shrink, terminal progress reporting, theme switching, warning
levels, a tree filter, thinking/effort level, a persisted trust default, and a global
model-provider context window (that one is per-profile in `/connect`). If a setting is missing it
means Alisio does not implement the feature; no row is a stub.

In `--no-tui` mode the supported commands are `/exit`, `/new`, `/skill:name request` and
`/command plugin.id:name args`. Lines are processed sequentially; Ctrl+C cancels and exits.

## MCP manager {#mcp}

`/mcp` in the TUI lists servers by source and, for the selected one, separates configured/enabled,
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
| PgUp / PgDn, mouse wheel | Scroll the conversation |
| Ctrl+X | Focus the [agent panel](#agent-panel) |
| Ctrl+B | Move running foreground agents to the background (during a turn) |
| Ctrl+K | Cancel the selected or viewed agent |
| Ctrl+V | Attach a clipboard image (see [Paste](#paste-text-and-images)) |
| Ctrl+R | Remove the most recently attached image |

`/exit`, double Ctrl+C on an empty input and Ctrl+D all go through the same bounded shutdown:
whatever is still running is aborted, waited for at most ~3 seconds, session-end hooks get ~1.5
seconds, and the app teardown itself is capped — exit feels instant even with many MCP servers.

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

While mouse capture is active, native terminal selection usually requires **Shift+drag**.

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

With `--read-only` nothing is asked and those tools stay disabled. Headless modes never ask. The time
spent waiting for an approval counts toward `limits.timeoutMs`. Approvals share the same
[interactive queue](#ask-user-question) as `ask_user_question`, so a subagent's approval prompt and a
subagent's question never race each other for the screen. See [Tools & permissions](/tools).
