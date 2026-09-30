# Web UI (`alisio serve`)

`alisio serve` starts a local HTTP server that gives a browser access to several workspaces and
sessions at once. It drives the same agent core as the terminal: sessions, runs, approvals and the
session database are shared with the TUI and `alisio run`.

::: warning Status
The server, its API and the browser interface are available. File explorer, image attachments,
rich renderers (diff, terminal, Mermaid, math), the trajectory view and plugin/model management
arrive in later versions. See [Known limitations](/limitations).
:::

## Start the server

```sh
alisio serve                      # http://127.0.0.1:4317, opens the browser
alisio serve --no-open --port 0   # any free port, print the URL only
alisio serve --allow-write        # web sessions may write files without asking
```

The command prints a launch URL with a one-time token, for example
`http://127.0.0.1:4317/?token=…`. Opening it exchanges the token for a session cookie and redirects
to `/`. Keep the URL private: whoever opens it first in a browser can drive the agent with your
permissions. Press `Ctrl+C` (or send `SIGTERM`) to stop the server; a second `Ctrl+C` forces exit.

`alisio`, `alisio run` and the TUI never load the server: it is imported only by `alisio serve`.

## Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port <port>` | `4317` | Port to listen on; `0` picks a free one |
| `--host <address>` | `127.0.0.1` | Address to bind; anything but loopback requires `--allow-remote` |
| `--allow-remote` | off | Allow a non-loopback `--host` (no TLS; prefer an SSH tunnel) |
| `--no-open` | opens | Do not open the browser |
| `--max-workspaces <n>` | `4` | Workspaces with an open application at once |
| `--max-runs <n>` | `4` | Runs executing at once across all sessions; more wait in a queue |

The global flags apply too. The permission flags (`--allow-write`, `--allow-process`,
`--allow-external`, `--allow-mcp`, `--read-only`) are the **ceiling** of every web session: the
browser can narrow them per session but never go beyond them. `--trust-project` and `--config`
apply to every workspace the server opens, like in the terminal. `--db` selects the shared session
database. Set `ALISIO_LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`) to control the JSON
log lines the server writes to stderr.

## Using the web UI

The page has a sidebar on the left and the open session on the right.

**Sidebar.** **New session** starts a session in the workspace you are looking at. Under
**Workspaces**, each folder lists its sessions, pinned first and then the most recently used, with a
relative time ("4 min"). A dot before a title shows a session that is running, waiting for you, in
use by another process or whose last run failed. The icons next to the heading search sessions
(also `Ctrl+K` / `Cmd+K`), show archived sessions and open another workspace by its absolute path.
Hover a session for **Pin** and **Archive**, or a folder for a new session inside it. **Settings**
sits at the bottom; the panel icon collapses the sidebar to a narrow rail. Below 900 px the sidebar
becomes a drawer opened from the header.

**Header.** Click the title to rename the session (untitled sessions show their first prompt). The
badge shows the agent and the permission preset. **Session log** downloads the session as JSON
Lines: every durable event in the `alisio run --json` format, then one `{"type":"message"}` line per
stored message.

**Conversation.** Your messages appear on the right with a copy button. The agent's work appears as
one-line rows: `Think · …` for reasoning, `Context injection · AGENTS.md`, and one row per tool call
such as `Read · README.md` or `Shell · npm test`. Click a row to see its input and output. The answer
streams as Markdown; code blocks have a language label, **Wrap lines** and **Copy**, and are
highlighted once they scroll into view. Reasoning is display-only: after a reload, earlier `Think`
rows are gone because reasoning is never stored. When you scroll up, a button jumps back to the
latest message; long sessions show the last 30 turns and load older messages on demand.

**Composer.** `Enter` sends, `Shift+Enter` inserts a new line, and `↑`/`↓` on the first line walk
through the prompts you sent. Typing `/` opens the command palette (arrows to move, `Enter` or `Tab`
to pick, `Esc` to close): commands run on the server and their output appears in the conversation;
prompt templates, skills and `/ask` become a prompt. `/` anywhere outside a text field focuses the
composer. Below the text box:

| Control | What it does |
| --- | --- |
| `+` | Attach images (disabled until a later version) |
| Permission preset | `Read only`, `Ask`, `Workspace write` or `Full access` for this session |
| Model and effort | Model of the workspace's provider and the reasoning effort the model supports |
| Context ring | Estimated context of the next request against the model window |
| Send / Stop | Stop replaces Send while a run is active and the box is empty |

While a run is active you can keep typing: text is queued for the session's next turn.

**Approvals and questions.** When a tool needs approval, a panel takes the composer's place and
receives focus: it names the tool, the effect and its input. Answer with **Deny** (`D`), **Allow
once** (`O`) or **Allow for session** (`S`); keys pressed in the first 300 ms are ignored so a stray
`Enter` cannot approve. Plugin questions (for example `ask_user_question`) appear the same way.

**Settings.** Choose the language (English or Spanish; the browser language by default), the theme
(dark, light or system) and whether tool rows start collapsed or expanded. These preferences stay in
this browser only.

## Security model

The server is designed for one user on one machine:

- It binds `127.0.0.1` by default. Exposing it on a network requires `--host <address>
  --allow-remote` and prints a warning; there is no TLS, so use an SSH tunnel instead.
- A 256-bit launch token is generated per process and never written to disk. The browser exchanges
  it once for an `HttpOnly; SameSite=Strict` cookie that holds a separate secret.
- Every request must name this server in `Host` (DNS-rebinding defense), and requests with side
  effects need a matching `Origin` and `Content-Type: application/json` (CSRF defense).
- Responses carry a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer` and same-origin opener/resource policies; API responses are not
  cached.
- Approvals are fail-closed: when no browser tab watches the session for 30 seconds, when the run is
  cancelled or after 10 minutes, the answer is **deny**.
- Plugins are not sandboxed: a trusted project's plugins run inside the server process with its
  operating-system permissions, exactly as in the terminal.

## Workspaces and trust

A workspace is a directory (its git root when inside a repository). The server lists the
workspaces of existing sessions plus the directory where `alisio serve` started, and opens an
application for a workspace only when it is used. At most `--max-workspaces` are open at once: the
least recently used idle one is closed to make room, and when all of them are busy the request
fails with `workspace_limit`. Idle workspaces close after 10 minutes.

The web never grants project trust. A directory whose `.alisio` configuration you have not trusted
from the terminal opens without its project resources (plugins, skills, prompts, configuration) and
is marked untrusted. Run `alisio` in that directory to answer the trust prompt.

## Sessions, runs and permissions

Several sessions can run at the same time, in one or more workspaces. A session runs one prompt at
a time: text sent while it is running is queued for its next turn, while attachments must wait
until it is idle. Runs beyond `--max-runs` wait in a first-in, first-out queue. Retrying a prompt
with the same request id never starts a second run.

A session that another Alisio process is using (for example the TUI) is reported as locked and is
read-only in the web until that process releases it.

Each session has a permission preset. Effects the launch flags do not allow keep asking, whatever
the preset:

| Preset | Allowed without asking | Other effects |
| --- | --- | --- |
| `read-only` | reads | denied |
| `ask` | reads | ask for approval |
| `workspace-write` (default) | reads, writes | ask for approval |
| `full-access` | reads, writes, processes, network | ask for approval |

"Allow for session" in an approval widens only that session, never the other sessions of the same
workspace.

## API and events

The browser talks to JSON routes under `/api` and to one Server-Sent Events stream per tab:

```text
GET  /api/health                       unauthenticated: name, version, protocolVersion, capabilities
GET  /api/workspaces                   POST /api/workspaces {path}   PATCH /api/workspaces/:wid
GET  /api/sessions                     POST /api/sessions            GET|PATCH /api/sessions/:sid
GET  /api/sessions/:sid/messages       GET /api/sessions/:sid/events GET /api/sessions/:sid/runs
POST /api/sessions/:sid/prompts        POST /api/sessions/:sid/cancel  POST /api/sessions/:sid/compact
GET  /api/sessions/:sid/models         GET /api/sessions/:sid/context GET /api/sessions/:sid/export
GET  /api/commands?session=<sid>       POST /api/sessions/:sid/commands {requestId, name, args?}
GET  /api/approvals                    POST /api/approvals/:aid      POST /api/interactions/:iid
GET  /api/events?session=<sid>         the event stream (snapshot, then live frames)
```

On every (re)connection the stream sends a snapshot of each subscribed session (recent messages,
text still streaming, pending approvals) followed by live frames; durable events carry their
`eventId` as the SSE `id`, and streamed text arrives coalesced about 30 times per second. The
protocol version is reported by `/api/health` and in the stream's first frame.

## Limitations

- Single host: session locks rely on process ids, and the web does not see live changes a TUI makes
  to a session until the session is reopened.
- No TLS; remote access is opt-in and meant for SSH tunnels.
- The provider is per workspace: every session of a workspace uses the workspace's active provider
  profile; the web changes the model within it.
- The standalone binary serves the API only; the web UI assets ship with the npm package.
- The web UI keeps command output, notices and reasoning only while the page is open; a reload
  rebuilds the conversation from stored messages.
