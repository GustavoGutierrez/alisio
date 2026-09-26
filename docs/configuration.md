# Configuration

Alisio reads one JSON file, validated strictly (unknown keys are rejected). Which file is read is
described in the [configuration trust model](/quick-start#configuration-trust-model).

```json
{
  "schemaVersion": 1,
  "provider": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "YOUR_MODEL_ID",
    "apiMode": "chat",
    "auth": "bearer",
    "tokenParameter": "max_tokens",
    "streamUsage": false
  },
  "limits": { "maxTurns": 20, "timeoutMs": 300000 },
  "compaction": { "auto": true, "threshold": 0.85, "keepTurns": 2 },
  "builtinPlugins": { "memory": { "enabled": true } },
  "pluginHooks": { "timeoutMs": 15000, "sessionEndTimeoutMs": 10000 },
  "plugins": [],
  "skills": [],
  "mcp": { "servers": {} }
}
```

`schemaVersion` must be `1` (the default).

## `provider`

| Field | Default | Description |
| --- | --- | --- |
| `baseURL` | `https://api.openai.com/v1` | Base URL, including `/v1` when the server requires it. HTTP(S) only, without credentials in the URL |
| `apiKeyEnv` | `OPENAI_API_KEY` | Name of the environment variable holding the key |
| `model` | `""` | Exact model ID on your server (required to run) |
| `apiMode` | `chat` | `chat` (Chat Completions) or `responses` (Responses API) |
| `auth` | `bearer` | `bearer` or `none`; `none` omits the `Authorization` header |
| `tokenParameter` | `max_tokens` | Chat mode only: `max_tokens`, `max_completion_tokens` or `omit` |
| `streamUsage` | `false` | Request usage statistics while streaming, if the server supports it |
| `contextWindow` | none | Optional context window in tokens for the configured model; overrides `GET /models` |

Chat mode handles text messages and function tool calls. Responses mode keeps the provider's
opaque items, including encrypted reasoning for continuation with `store: false`. A compatible
provider may implement only part of the OpenAI API: validate your model and endpoint.

Provider precedence: selected file → environment variables → CLI flags.

## `limits`

| Field | Default | Description |
| --- | --- | --- |
| `maxTurns` | `20` | Model turns per run (1–100) |
| `timeoutMs` | `300000` | Run timeout in milliseconds (minimum 100); includes approval waits |
| `maxContextChars` | `160000` | Context length limit in characters; also triggers compaction |
| `maxOutputTokens` | `4096` | Output tokens per request |
| `maxTokens` | `100000` | Budget of reported tokens per run |

## `compaction`

| Field | Default | Description |
| --- | --- | --- |
| `auto` | `true` | Compact automatically before a model call |
| `threshold` | `0.85` | Fraction (0.1–0.99) of a known context window that triggers compaction |
| `keepTurns` | `2` | Recent turns kept verbatim (0–20) |

See [Context compaction](/compaction).

## `builtinPlugins`

Options for built-in plugins, keyed by plugin ID. Every entry accepts `enabled`; each plugin
validates the rest of its section. The only built-in plugin today is `memory`:

| Field | Default | Description |
| --- | --- | --- |
| `builtinPlugins.memory.enabled` | `true` | Enable the memory plugin |
| `builtinPlugins.memory.dbPath` | `<state home>/memory.sqlite` | Database path; relative paths resolve from the configuration file |
| `builtinPlugins.memory.injectBudgetTokens` | `1500` | Token budget (100–20000) for injected memory context |
| `builtinPlugins.memory.recallLimit` | `8` | Memories recalled after compaction (0–20) |
| `builtinPlugins.memory.autoSummary` | `true` | Write a session summary on `/clear`, `/exit` or quit (TUI) |
| `builtinPlugins.memory.defaultScope` | `project` | `project` or `personal` |

See [Persistent memory](/memory).

## `pluginHooks`

| Field | Default | Description |
| --- | --- | --- |
| `timeoutMs` | `15000` | Timeout (100–120000 ms) for compaction and session-start hooks |
| `sessionEndTimeoutMs` | `10000` | Timeout (100–120000 ms) for session-end hooks |

## `plugins`

A list of trusted plugins: paths (resolved relative to the configuration file) or npm package names.
See [Writing plugins](/plugins#loading-plugins).

```json
{ "plugins": ["alisio-plugin-foo", "./plugins/local.js"] }
```

## `skills`

Extra Agent Skills roots, resolved relative to the configuration file.

```json
{ "skills": ["./skills"] }
```

Skills are also discovered in `.agents/skills/<name>/SKILL.md` (from the working directory up to the
workspace root), `~/.agents/skills/` and plugin resources. Only the name and description are included
initially; the body is loaded with the `skill_load` tool or `/skill:name`, and supporting files with
`skill_resource`. YAML, name, description and the name/directory match are validated
(`alisio skills validate`). `.pi/skills` is not imported automatically.

## Prompt templates

There is no configuration key for templates. They are read from `<config home>/prompts/` and, for
trusted projects, from `.alisio/prompts/`. See [Prompt templates](/prompt-templates).

## `mcp.servers`

MCP servers, keyed by name. Never write literal secrets: pass environment variable names.

| Field | Default | Description |
| --- | --- | --- |
| `transport` | required | `stdio` or `http` (Streamable HTTP) |
| `command` | none | stdio: executable |
| `args` | `[]` | stdio: arguments; `./` and `../` are resolved relative to the configuration file |
| `url` | none | http: server URL |
| `envAllow` | `[]` | Environment variables passed to the stdio server |
| `bearerTokenEnv` | none | Environment variable holding an HTTP bearer token |

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "transport": "stdio",
        "command": "node",
        "args": ["./mcp/server.js"],
        "envAllow": ["MY_SERVER_TOKEN"]
      },
      "remote": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "bearerTokenEnv": "MY_MCP_TOKEN"
      }
    }
  }
}
```

MCP servers are only started or contacted with `--allow-mcp`. See [Tools & permissions](/tools#mcp).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` (or the name in `provider.apiKeyEnv`) | API key |
| `OPENAI_BASE_URL` | Overrides `provider.baseURL` |
| `ALISIO_MODEL` | Overrides `provider.model` |
| `ALISIO_API_MODE` | Overrides `provider.apiMode` |
| `ALISIO_CONFIG_HOME` | Global configuration directory (default `$XDG_CONFIG_HOME/alisio` or `~/.config/alisio`) |
| `ALISIO_STATE_HOME` | State directory for `sessions.sqlite` and `memory.sqlite` (default `$XDG_STATE_HOME/alisio` or `~/.local/state/alisio`) |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Standard XDG base directories used when the `ALISIO_*` variables are unset |
| `CI` | When set (and not `false` or `0`), the startup screen is not shown |
| `NO_COLOR` | Disables color in the startup screen |
| `TERM=dumb` | Startup screen in ASCII without color |
| `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH` | Set by Herdr; enable lifecycle reports |

The session database contains conversations and tool results: do not commit it.

## CLI flags

Global flags (valid for every command):

| Flag | Description |
| --- | --- |
| `--cwd <path>` | Working directory |
| `--config <path>` | Explicit trusted configuration file |
| `--trust-project` | Load project config and executable plugins (full process privileges) |
| `--plugin <path...>` | Load explicitly trusted plugins (paths or package names) |
| `--model <id>` | Provider model ID |
| `--base-url <url>` | OpenAI-compatible API base URL, including `/v1` if needed |
| `--api-mode <mode>` | `chat` or `responses` |
| `--allow-write` | Allow file writes |
| `--allow-process` | Allow arbitrary subprocesses; not sandboxed |
| `--allow-mcp` | Allow configured MCP servers and remote tool calls |
| `--allow-agents` | Allow messaging neighboring agents through Herdr |
| `--no-herdr` | Disable automatic Herdr lifecycle reports |
| `--read-only` | Disable writes, arbitrary processes, executable plugins and MCP |
| `--db <path>` | Session database |
| `--json` | Emit versioned JSONL events |
| `--no-tui` | Use the plain readline interactive mode instead of the TUI |
| `--disable-plugin <ids...>` | Disable built-in plugins (for example `memory`) |
| `--no-banner` | Do not show the startup screen |
| `--quiet` | Suppress non-essential output (startup screen, hints) |
| `-V`, `--version` | Print the version |
| `-h`, `--help` | Show help |

Commands:

| Command | Description |
| --- | --- |
| `alisio` | Interactive TUI (or readline with `--no-tui`) |
| `alisio run <prompt>` | Headless run; `/name args` runs a [prompt template](/prompt-templates) |
| `alisio resume <session> [prompt]` | Resume a session (TUI without prompt, headless with prompt) |
| `alisio init` | Write an example `.alisio/config.json` without secrets (for `AGENTS.md`, use `/init`) |
| `alisio doctor` | Environment and provider diagnostics |
| `alisio sessions list` | List sessions |
| `alisio sessions recover <session> --acknowledge` | Acknowledge uncertain tool effects after a crash |
| `alisio context explain <path>` | Show which `AGENTS.md` files apply to a path |
| `alisio skills list [path]` | List discovered skills |
| `alisio skills validate [path]` | Validate skills (non-zero exit on diagnostics) |
| `alisio plugins list` | List global, project and explicit plugins |
| `alisio plugins doctor` | Load plugins and show their tools and commands |
| `alisio mcp list` | List configured MCP servers |
| `alisio mcp doctor <server>` | Connect to a server (requires `--allow-mcp`) |

## `AGENTS.md`

In each directory the first available file is used, in this order: `AGENTS.md`, `AGENT.md`,
`Agente.md`. Alisio resolves them from the Git root (or the working directory without Git) down to the
path being operated on. New instructions are presented to the model before an operation that needs
reconsideration, and scopes are labeled by directory. `alisio context explain <path>` shows the result.
