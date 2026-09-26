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
screen; on exit it prints the conversation and the session ID.

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

## Layout

The screen reflows when the terminal is resized, and every line is truncated or wrapped to the width.

| Area | Content |
| --- | --- |
| Header | Version, model, provider host (never the key or path), API mode, shortened working directory, short session ID and colored permissions (`write`/`process`: `on`, `ask` or `off`; `mcp`; `read-only`) |
| Conversation | Highlighted user messages; streamed assistant answers rendered as Markdown (headings, bold, lists, inline and block code, links). Visible reasoning sent by the provider (for example DeepSeek `reasoning_content`) is shown dimmed while it arrives, then collapsed to one line; it is never persisted or sent back |
| Tool blocks | One block per call: name, summarized argument (path, command, pattern), spinner while running, ✓/✗ status, duration and a truncated preview. `edit_file`/`write_file` show a `+`/`-` diff computed from the arguments |
| Status bar | Context used versus the window, `used / total (pct%)`, with a green (< 60 %), yellow (< 85 %) or red bar; accumulated input/output tokens and cached tokens (`⚡`) when reported; turns; current turn duration; state; plugin status (for example `mem N`) |
| Pickers | Selectable lists for `/model`, `/resume` and approvals |

Errors appear in red inside the conversation without closing the TUI.

The context window comes from `provider.contextWindow`, then the `context_window` (or
`context_length`) field of `GET /models`, otherwise `unknown`. Used context is the last
`prompt + completion` reported by the provider; without `usage`, an estimate marked with `~`
(about 4 characters per token) is shown.

## Commands

Typing `/` opens autocompletion.

| Command | Purpose |
| --- | --- |
| `/help` | Commands and keys |
| `/model [id]` | Without an argument: selectable list from `GET /models` (or the configured model). With an argument: switch directly. Applies to the next turn and is saved in the session |
| `/compact [focus]` | Summarize older history with the current model, with optional focus instructions |
| `/stats` | Tokens (input, output, cached), turns, calls and errors per tool, duration, models, context and plugin details |
| `/clear` (`/new`) | Start a new session with the current model |
| `/sessions` | Recent sessions of the workspace |
| `/resume <id>` | Resume by ID or prefix; without an argument, shows a picker |
| `/tools` | Tools and their state according to permissions (`enabled`, `ask`, `disabled`) |
| `/copy` | Copy the last assistant response to the clipboard |
| `/exit` (`/quit`) | Exit |
| `/skill:name request` | Load a skill and send the request |
| `/command plugin.id:name args` | Run a plugin command |
| `/memory …` | Command of the built-in memory plugin; see [Persistent memory](/memory) |

Other plugin commands are routed the same way and listed in `/help` and autocompletion. While a turn
is running, prompts and the `/model`, `/compact`, `/clear` and `/resume` commands wait: press Esc to
interrupt first.

In `--no-tui` mode the supported commands are `/exit`, `/new`, `/skill:name request` and
`/command plugin.id:name args`. Lines are processed sequentially; Ctrl+C cancels and exits.

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

## Interactive approvals

In the TUI, when `write` or `process` are not allowed by flags, the corresponding tools are still
offered to the model, and Alisio asks before running them:

- **Allow once**
- **Always allow `<effect>` in this session** (lasts while the process lives)
- **Deny**

With `--read-only` nothing is asked and those tools stay disabled. Headless modes never ask. The time
spent waiting for an approval counts toward `limits.timeoutMs`. See [Tools & permissions](/tools).
