# Web UI (`alisio serve`)

`alisio serve` starts a local HTTP server that gives a browser access to several workspaces and
sessions at once. It drives the same agent core as the terminal: sessions, runs, approvals and the
session database are shared with the TUI and `alisio run`.

::: warning Status
The server and its API are available now. The browser interface (`@alisio/web`) is still being
built: until it ships, `alisio serve` serves a placeholder page next to the API. See
[Known limitations](/limitations).
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
