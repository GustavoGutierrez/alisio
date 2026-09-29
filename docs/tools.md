# Tools & permissions

Every tool declares an **effect**. The effect decides whether the tool is available, asks for
approval or is disabled.

| Effect | Meaning | Default |
| --- | --- | --- |
| `read` | No side effects | Enabled |
| `write` | Modifies workspace files | Needs `--allow-write` (or TUI approval) |
| `process` | Runs arbitrary processes | Needs `--allow-process` (or TUI approval) |
| `external` | Network tools (`webfetch`, `websearch`), MCP, Herdr, external plugin tools | Needs `--allow-external` (or TUI approval), `--allow-mcp`, `--allow-agents` or an active external plugin; never with `--read-only` |
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
| `ask_user_question` | `read` | Ask the user 1-4 multiple-choice questions (see [below](#ask-user-question)) |
| `write_file` | `write` | Write a file |
| `edit_file` | `write` | Replace an exact, unique match in a file |
| `run_process` | `process` | Run a command with an argument array |
| `shell` | `process` | Run a shell command |
| `webfetch` | `external` | Read a URL as text/markdown/html (see [below](#webfetch)) |
| `websearch` | `external` | Search the web (see [below](#websearch)) |
| `execute` | `process` | Run a JS snippet that calls other tools ("Code Mode", see [below](#execute)) |
| `plugin_install` | `process` | Install an npm plugin package into the global plugins directory (see [below](#plugin-install)) |

Edits require a SHA-256 fingerprint of the file and an exact, unique match. Writes use a temporary
file plus an atomic replace on the same filesystem. Mediated operations reject paths outside the
workspace and symlinks; this does not protect against hostile processes changing paths concurrently,
and it does not confine a free shell.

Editable files and the initial read scan are limited to 1 MiB; tool outputs are bounded and a
truncated result is marked explicitly. Independent reads run in batches of up to four; operations
with effects are serialized.

`list_files` and `search_text` need the `rg` executable on `PATH`. When it is missing, the tools
and `alisio doctor` report how to install it: `sudo apt install ripgrep` (Debian/Ubuntu),
`brew install ripgrep` (macOS), `winget install BurntSushi.ripgrep.MSVC` or
`scoop install ripgrep` (Windows).

Built-in plugins add more tools: `memory_*` from [Persistent memory](/memory) and `task`,
`task_status`, `task_wait` and `send_message` from [Subagents](/subagents), all with the `internal`
effect.

## Asking the user {#ask-user-question}

`ask_user_question` lets the model ask 1-4 multiple-choice questions (2-4 options each, at most one
`recommended` per question — a suggestion, never forced) when there is a real fork in the approach.
It is `effect: read` but gated on an interactive UI being bound **at all** (`ui.interactive()`),
regardless of which session is asking — a [subagent](/subagents) under an interactive root TUI can
use it too. In a headless run (`run`, `resume <id> "prompt"`, `--json`, or any session without a
bound interactive UI) the call fails fast with a structured error telling the model to ask in plain
text instead; it never hangs waiting for a UI that cannot answer. See [Terminal
UI](/tui#ask-user-question) for the panel, its keys, the Esc-skips-current-question-only behavior,
and how root and subagent questions are queued and routed back to the exact session that asked.

## Reading a URL: webfetch {#webfetch}

`webfetch(url, format?, timeout?)` fetches an `http(s)` URL and returns it as `markdown` (default),
`text` or `html`. It follows redirects (bounded by the runtime's own default, roughly 20 hops), and
refuses non-textual responses (images, other binaries) with a clear error instead of returning
garbage — check the response's `content-type` first if you are unsure a URL is fetchable at all.
Responses over 5 MiB are rejected. `timeout` is in seconds, default 30, capped at 120.

HTML is converted with [`turndown`](https://www.npmjs.com/package/turndown) (markdown) or a
minimal script/style-stripped text extraction; both use
[`@mixmark-io/domino`](https://www.npmjs.com/package/@mixmark-io/domino), a small pure-JS DOM
implementation (turndown's only dependency) — never a headless browser or jsdom. The converted text
embedded in the result is capped at 20,000 characters; a longer page is truncated there, but the
full text is written to a workspace-scoped cache file (`.alisio/cache/webfetch/<hash>.<ext>`) and
the result's `fullTextPath` names it, so a follow-up `read_file` is never lossy.

## Searching the web: websearch {#websearch}

`websearch(query)` returns `{ title, url, snippet }[]`. No provider is bundled as a hard
dependency; the tool resolves one, in order:

1. **A plugin-registered `websearch` extension** (`api.extensions.register("websearch", ...)`) —
   see [Writing plugins](/plugins#extension-points). Fully replaces everything below while loaded;
   a throwing provider falls back to the built-in chain with a diagnostic.
2. **`websearch.provider`** from [configuration](/configuration), when set:

   | `provider` | Needs | Notes |
   | --- | --- | --- |
   | `"searxng"` | `websearch.searxngUrl` (optional; see below) | Self-hosted or another public instance |
   | `"duckduckgo-instant"` | Nothing | Keyless; **only answers direct factual/infobox queries** (Wikipedia-style) — an empty result does not mean nothing exists on the web |
   | `"duckduckgo-html"` | Nothing | Keyless DuckDuckGo **lite** HTML search — a real general web search (unlike `duckduckgo-instant`). Parses HTML DuckDuckGo may change at any time; heavy automation can be bot-checked. A solid keyless fallback when the default SearXNG instance is bot-blocked |
   | `"tavily"` | `TAVILY_API_KEY` (or `websearch.apiKeyEnv`) | Card-free free tier (1000 credits/month at the time of writing) |
   | `"brave"` | `BRAVE_SEARCH_API_KEY` | Needs a card; ~$5/month recurring credit ≈ 1000 queries at the time of writing — not card-free |
   | `"serpapi"` | `SERPAPI_API_KEY` | Check current SerpApi pricing |
   | `"native"` | `provider.apiMode: "responses"` | The model provider searches server-side; see below — the `websearch` tool is not even registered in this mode |

3. **Nothing configured**: a public [SearXNG](https://docs.searxng.org/) instance
   (`websearch.searxngUrl`'s default), queried with `GET <url>/search?q=...&format=json` — genuinely
   free and keyless. **In practice this is unreliable**: while building this tool, nearly every
   public instance tried (from [searx.space](https://searx.space)) rate-limited or bot-blocked a
   single fresh automated request. Treat it as a starting point, not something to depend on. If you
   hit that, switch to `"duckduckgo-html"` in `/settings` → Web search provider (or set
   `websearch.provider`), or self-host — either way it is one config line away:

   ```sh
   docker run -d -p 8080:8080 searxng/searxng
   ```
   ```json
   { "websearch": { "searxngUrl": "http://localhost:8080" } }
   ```

   A non-loopback `searxngUrl` must use `https://` (a heuristic SSRF guard, since — unlike the
   other providers' hardcoded hosts — this one is user-configurable and could point anywhere).

Every result includes a `source`; when relevant, a `limitation` (e.g. DuckDuckGo Instant Answer's
narrow scope) and, only when a plugin provider failed over to the built-in chain, a `diagnostic`.

**`"native"` passthrough** is opt-in and provider-specific: with `provider.apiMode: "responses"`,
Alisio appends a raw provider-native tool definition (`{ type: websearch.nativeToolType }`,
default `"web_search"`) to the Responses API request instead of implementing its own HTTP call; the
provider answers the search server-side, so the `websearch` tool is not registered in this mode.
Most OpenAI-compatible providers — including the DeepSeek plugin configuration — do
**not** support this; check your provider's own documentation for the exact tool type it expects
before opting in. An unsupported/rejected tool surfaces as a normal provider error, the same as any
other request failure.

## Running a snippet against other tools: execute {#execute}

`execute(code)` ("Code Mode") runs a short JavaScript snippet that calls other already-registered
tools through `await callTool(name, input)` and returns one final value — so intermediate tool
results (e.g. several files' contents) never re-enter the model's own context, only the snippet's
return value does. It is a much lighter-weight feature than it might sound: it does **not**
replicate a full JS engine or interpreter, and it does not give the snippet any capability a plain
sequential tool call would not already have.

- Sandboxing uses Node's built-in `vm` module: the snippet gets its own global object and V8
  intrinsics, with no `require`, `process`, `fetch`, filesystem access or timers — the only thing
  exposed is `callTool`. `codeGeneration` is restricted, so the snippet cannot `eval()` or
  `new Function()` its way to more.
- Every nested `callTool` goes through the exact same effect/permission gate as a direct call: an
  effect the current policy does not already allow is denied outright. `execute` never triggers a
  new interactive approval from inside the snippet (that could mean a confusing, potentially
  deadlocking nested prompt) — it can only use what this session already has.
- Bounded to 10 seconds wall-clock and 20 nested tool calls; a snippet cannot call `execute` itself.

::: danger Not a security sandbox
Node's own documentation is explicit: "the vm module is not a security mechanism; do not use it to
run untrusted code." `execute` isolates a snippet's scope and bounds its running time for
correctness and ergonomics, not as an OS-level boundary — the same trust model as every other
in-process Alisio tool. See [Not a sandbox](#not-a-sandbox).
:::

`execute` uses the `process` effect (reusing the existing gate rather than adding a new
classification): running a JS snippet is arbitrary code execution in the same spirit as
`run_process`/`shell`, and `--allow-process` is what a user already expects to gate "run stuff".

## Installing plugins: plugin_install {#plugin-install}

`plugin_install(spec)` installs an npm plugin package into Alisio's global plugins directory
(`<config home>/plugins`) and adds its npm name to the global configuration's `plugins` array — the
identical routine behind the `alisio install` command. `spec` accepts `npm:<package>[@<version>]` or
a bare package name, validated before any network operation. It lets the model install a plugin on
your request instead of you typing the command: the agent forms the correct spec and invokes the
tool, and you keep the final say through the normal permission flow.

It is a host-owned tool with the `process` effect: installing runs `npm install`, an unsandboxed
subprocess that may execute the package's lifecycle scripts, so it goes through the same gate as
`run_process`/`shell` — allowed outright with `--allow-process`, asked interactively in the TUI
otherwise, and hard-denied (not even registered) under `--read-only`. The result is sanitized and
returns the package name, installed version, config entry, install path and the project-trust
remark. See [Writing plugins](/plugins#installing-plugins-from-npm) for the full story, including
the headless `--yes` confirmation rules.

## Permission flags {#permission-flags}

| Flag | Effect |
| --- | --- |
| (none) | Read and search tools only in headless modes; in the TUI, `write`/`process`/`external` are also offered and **ask every time** (see the truth table below) |
| `--allow-write` | Enables `write_file` and `edit_file` outright, no asking |
| `--allow-process` | Enables `run_process`, `shell` and `execute` outright, no asking |
| `--allow-external` | Enables `webfetch` and `websearch` outright, no asking |
| `--allow-mcp` | Starts/connects configured MCP servers and exposes their capabilities |
| `--allow-agents` | Enables Herdr messaging tools |
| `--read-only` | Disables writes, arbitrary processes, network tools, MCP, agent messaging and executable (external) plugins — never even offered, in the TUI or headless |

`--read-only` wins over every `--allow-*` flag. Built-in plugins (for example `memory`) remain
active under `--read-only` because their tools only use the `internal` effect; use
`--disable-plugin memory` for a strictly write-free mode.

### The write/process/external truth table

| State | TUI | Headless (`run`, `resume <id> "prompt"`, `--json`) |
| --- | --- | --- |
| No flag, not `--read-only` | **Asks every time** the model calls the tool (allow once / allow for the session / deny) | Tool is simply **unavailable** — there is no one to ask |
| `--allow-write` / `--allow-process` / `--allow-external` | **Allowed**, never asks | **Allowed**, never asks |
| `--read-only` | **Never offered**, hard denied | **Never offered**, hard denied |

The TUI's "ask every time" default needs no extra flag: it is the TUI's own always-on approval
flow (the same one write/process already used) now also covering `external`. Headless modes are
non-interactive by design, so an unset flag there means the effect is unavailable, full stop —
never asked, never silently allowed.

### Tool execution flow

The diagram below (source asset
`docs/assets/Flujo de Ejecución de Herramientas y Modelo de Permisos.webp`) shows how tool
execution flows through the permission model: every call is resolved against the effect
declared by its tool definition, and only then runs — allowed, asked (interactive approval), or
denied. It is an illustration of the flow in this section, not a security boundary.

![Flujo de Ejecución de Herramientas y Modelo de Permisos — tool execution flow and the permission model](<./assets/Flujo de Ejecución de Herramientas y Modelo de Permisos.webp>)

## Interactive approval

In the TUI, `write`, `process` and `external` tools that were not allowed by flags are offered to
the model and Alisio asks before running each call: allow once, allow that effect for the session,
or deny. Headless modes (`run`, `resume <id> "prompt"`, `--json`) never ask. See
[Terminal UI](/tui#interactive-approvals).

## Project trust {#project-trust}

Separately from tool-call approvals, opening a repository must not silently load *its* Alisio
configuration (which can point your API key at a different endpoint) or run its plugins. The TUI
asks once per directory before doing that; the decision persists and a changed `.alisio/config.json`
asks again. `alisio trust list`/`alisio trust revoke <path>` inspect or undo it. See [Quick
start](/quick-start#configuration-trust-model) for the full flow and [Configuration](/configuration)
for the `alisio trust` command.

## Not a sandbox

::: danger
Alisio does **not** provide an OS sandbox. `--allow-process` gives the model arbitrary processes with
your user privileges. Plugins run in-process with full privileges; a plugin manifest or a
subprocess is not an isolation boundary, and the `effect` field does not isolate anything.
:::

## MCP

MCP servers use canonical `mcp.servers` or compatible `mcpServers` configuration. They remain
disconnected until requested. Headless, JSON, readline, doctor and embedded uses require
`--allow-mcp`/`allowMcp`; in the interactive TUI, choosing **Connect** or **Enable** first presents a
session-only process/network consent. `--read-only` always blocks MCP.

The `mcp.allow` user preference grants the same process/network consent **persistently across
sessions**: every start (TUI and headless) begins granted, shows `mcp:on`, and auto-connects
enabled servers. It is read only from the global/user configuration layer (`<config home>/config.json`)
and elevates startup permission exactly like `--allow-mcp`; `--read-only` still wins over both. A
project `.alisio/config.json` value is ignored for this decision. Granting persists across sessions,
so only enable it when you trust every configured server — MCP servers run unsandboxed with your
user privileges.
Stdio servers are unsandboxed subprocesses; direct `env` values are scoped to that child and are not
shown in diagnostics.

- `mcp_connect` connects on demand and registers the server's tools; `mcp_resource` and `mcp_prompt`
  list and read resources and prompts.
- `/mcp` shows disabled, disconnected, connecting, connected, failed, needs authentication and
  restart-required states where applicable. Configured/enabled, runtime permission, connection and
  loaded-tool counts are separate states. It displays declared read-only, destructive and open-world
  tool annotations; missing annotations are not treated as destructive.
- Connected tools use semantic provider-safe names such as `mcp_devforge_time_diff`; deterministic
  short hashes are added only for collisions or truncation. They are available to the next model
  turn. The model still chooses whether to call them: say “use `devforge/time_diff`” when that call is
  required rather than relying on automatic selection.
- Exposed tools must use schemas supported by the registry. Schema changes require a reconnect; a
  call is never executed with a stale schema.
- There is no interactive OAuth and no automatic retry of operations with effects.

```sh
alisio mcp list --config ./my-api.json
alisio mcp doctor my-server --config ./my-api.json --allow-mcp
```

### Rich results

MCP tool and resource results are no longer flattened to raw JSON text. The connector maps them
heuristically into Alisio's own content parts:

- `text` parts stay text; `image` parts become images.
- `structuredContent` (or a JSON-parseable text part) matching a **verified shape** becomes a
  native TUI block: `{columns, rows}` / `{headers, rows}` tables (rows can also be objects keyed
  by the column names), flat scalar objects as key-value, and `{nodes: [{label, children?, meta?}]}`
  trees. Anything else — including nested JSON without a recognized shape — stays plain text, as
  before.
- A **canonical text projection** of every block/image is always appended as text, so the model,
  compaction and every headless path (`run`, `resume <id> "prompt"`, `--json`, `--no-tui`,
  `TERM=dumb`, `NO_COLOR`) see exactly what they saw before: text only, never image bytes. The
  TUI renders the block natively on top of that same projection.

In the TUI, tables render as aligned columns with wrapped cells, key-value as two columns, trees
with branch glyphs, code blocks with the same syntax highlighting as responses, and markdown blocks
through the regular Markdown renderer. Images render inline when the terminal supports the kitty or
iTerm2 graphics protocol (dim placeholder `[image: mime WxH]` otherwise). `mcp_resource` uses the
same mapping for text contents and image blobs; non-image blobs become a short marker instead of
raw base64.

Limitations: the shape detection is intentionally conservative (heuristic, not protocol-driven);
servers that return only unstructured JSON keep the previous behavior verbatim; and if the terminal
cannot render images, the TUI shows a placeholder while the model still reads the `[image: …]`
marker in the text projection.

### Example: Brave Search

The official package runs over stdio through `npx` (resolved from your `PATH`, which the
connector forwards to the child):

```json
{
  "mcp": {
    "servers": {
      "brave-search": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@brave/brave-search-mcp-server"],
        "envAllow": ["BRAVE_API_KEY"]
      }
    }
  }
}
```

`envAllow` forwards the listed environment variables **by name** from your shell; the key never
sits in the config file. Export it before starting Alisio:

```sh
export BRAVE_API_KEY=your-key
```

MCP stays disconnected until requested: passing `--allow-mcp` (or setting the global `mcp.allow`
preference) grants process/network consent and auto-connects enabled servers; in the TUI you can
also just choose **Connect** in `/mcp`.

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
