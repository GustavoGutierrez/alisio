# Configuration

## Global provider selection

In the TUI, `/connect` writes non-secret profiles and the active provider/model to
`<config home>/providers.json`. Secrets are stored separately in
`<config home>/credentials.json`, atomically written with mode `0600`; the directory is restricted to
`0700` where POSIX permissions are supported. This is filesystem protection, **not encryption**.
Keys are never shown by `doctor`, startup output, events or plugin state.

A profile's `values` may include an optional `contextWindow` (in **tokens**) for that profile's
model. It exists for local OpenAI-compatible servers (for example llama.cpp) whose `GET /models`
omits `context_window`: with it, the context bar and auto-compaction use the real window instead of
an honest `?`. `/connect` asks for it whenever the discovered catalog does not report the selected
model's window. The effective window for a model is, in priority: the legacy `provider.contextWindow`
(configured model only), then the active profile's `values.contextWindow` (user intent — it wins
over the catalog), then the catalog's own `context_window`.

Each connection also remembers its API key environment variable name: the profile's `values`
store `apiKeyEnv` (the name you chose for that connection). When a provider needs a key, the
precedence is: the stored credential in `credentials.json` first, then `process.env[apiKeyEnv]`
using the **profile's** remembered variable name, then the plugin's default variable name (for
example `DEEPSEEK_API_KEY` for the DeepSeek plugin, `OPENAI_API_KEY` for OpenAI-compatible) only
when the profile does not record one. Because the name is persisted with the profile, the
environment fallback keeps working even if the stored credential is later removed. No new secret
store is involved: the environment variable name is a non-secret configuration value, and keys
themselves are only ever read from the credentials file or that environment variable.

`/model` and `/models` open the same global selector. It groups every profile created through
`/connect` by provider title, marks the active provider/model pair, and keeps healthy profiles
selectable when another catalog is unavailable. Selecting a different pair persists it and starts a
fresh session; selecting the active pair does nothing. Legacy root `provider` configuration remains
available for startup and headless compatibility, but is intentionally absent from this selector.

Model selectors use `provider/model` as the canonical form, for example
`deepseek/deepseek-chat`. A bare model ID is accepted only when exactly one configured `/connect`
profile offers it. Zero matches fail with available choices; multiple matches fail as ambiguous.
The active global pair is the default for new sessions, not mutable state shared by every agent: a
child or programmatic override remains bound while the parent stays unchanged.

Embedders can use `app.listAvailableModels()`, `app.resolveModel(reference)`,
`app.createSession(reference?)`, and `app.switchModel(reference)`. Only global `/connect` profiles
participate in cross-provider resolution; legacy root `provider` configuration remains
startup/headless compatibility. Metadata and errors never expose credentials.

Legacy root `provider`, environment variables and CLI flags remain supported and are not rewritten.
Programmatic `AppOptions.provider` has highest priority. Next, explicit endpoint overrides
(`--base-url`, `--api-mode`, `OPENAI_BASE_URL`, `ALISIO_API_MODE`) or a trusted project/explicit
layer that defines a usable root `provider` — its parsed `provider.model` is non-empty and not the
`YOUR_MODEL_ID` placeholder `alisio setup` writes — select the legacy OpenAI-compatible provider for
that run; a placeholder or empty model never defeats a `/connect` selection. MCP, plugin, skill and
other settings alone do not. Otherwise the active `/connect` profile is restored; `--model` or
`ALISIO_MODEL` may replace only its model. Global legacy `provider` is the fallback when no saved
profile exists, so it does not permanently defeat a `/connect` selection.
Headless modes never prompt.

Four provider choices are built in and enabled by default:

| Provider | Scope |
| --- | --- |
| DeepSeek | Discovers models from `https://api.deepseek.com`; supports Chat Completions and Responses. `/connect` also exposes a clearly labelled base URL override for DeepSeek-compatible proxies. |
| OpenCode Console (Zen) | Discovers `opencode/<model-id>` entries from `https://opencode.ai/zen/v1/models`. Documented GPT/Grok/Muse models use Responses; DeepSeek/GLM/Kimi/MiMo/MiniMax and documented compatible models use Chat Completions; Claude and documented Qwen models use Anthropic Messages. Gemini-native and System One models are hidden. |
| OpenCode Go | Discovers `opencode-go/<model-id>` entries from `https://opencode.ai/zen/go/v1/models`. Its separate documented map routes GPT/Grok/Muse to Responses, open compatible families to Chat Completions, and MiniMax/Qwen to Anthropic Messages. |
| OpenAI compatible | Generic configurable Chat Completions or Responses endpoint. |

OpenCode Console and Go model requests send `user-agent: alisio/<version>` and an opaque, stable
`x-opencode-session` conversation ID. Neither header includes a workspace path, prompt or credential.
Their model catalogs are unauthenticated. Both catalogs fail closed: entries absent from the
documented protocol map are hidden instead of guessed.

Alisio always reads `<ALISIO_CONFIG_HOME>/config.json` (default
`~/.config/alisio/config.json`). A trusted `<workspace>/.alisio/config.json` overlays it. An explicit
trusted `--config <file>` overlays global configuration and replaces the project layer, even when
project trust is enabled. An untrusted project file is never read. Unknown keys are rejected.

Top-level settings in the selected project/explicit layer replace their global counterpart; Alisio
does not concatenate executable plugin or skill lists. MCP servers are the defined exception: they
merge by name, with the selected layer winning. Relative paths are resolved against the file that
defined the value.

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
  "limits": { "maxTurns": 100, "timeoutMs": 300000 },
  "compaction": { "auto": true, "threshold": 0.85, "keepTurns": 2, "maxOutputTokens": 16000 },
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

Within legacy provider configuration, precedence is global file → trusted project or explicit file →
environment variables → CLI flags. The provider-selection precedence above determines when that
legacy configuration is used instead of an active `/connect` profile.

## `limits`

| Field | Default | Description |
| --- | --- | --- |
| `maxTurns` | `100` | Model turns per run (1–100). Each turn is one model response; a run that only calls tools many times can exhaust this. The limit is a **safety rail, not a hard stop**: when it is reached the run ends *softly* — everything produced so far stays in the transcript, the run is reported as `turns-exceeded` (partial result, no failure) and you can simply prompt again to continue in the same session. The real hard stops are the token budget (`maxTokens`) and the run timeout. Raise it for long read-heavy audits |
| `timeoutMs` | `300000` | Run timeout in milliseconds (minimum 100); includes approval waits |
| `maxContextChars` | `800000` | Context length limit in characters. The default (800k chars ≈ 200k tokens) is an **assumption for unknown model windows** — the same ~200k-token budget OpenCode assumes for custom providers — so local servers that do not report a window (e.g. llama.cpp) get ~200k tokens instead of ~40k. Acts as the **fallback auto-compaction trigger** when the model window is unknown (or absurdly large, see [compaction](/configuration#compaction)) — estimated tokens (`~chars/4`) reaching `maxContextChars / 4` — and as the **hard limit** that must fit after a compaction. A **known** window overrides the fallback, and `/settings` → Context char budget can lower it at any time |
| `maxOutputTokens` | `16384` | Output tokens per request. When a model hits this budget mid-answer, Alisio keeps the text produced so far, warns that the response was cut (`response cut by max output tokens`), completes the run normally and flags the completion as `truncated` in `run_completed`. Tool calls that were fully written still execute. Raise this budget for longer answers; reasoning models can spend most of it on reasoning before any text, so don't set it too low. Editable from `/settings` → Agent max output tokens |
| `maxTokens` | proportional | Optional cumulative budget of reported tokens per run. Default: 8 × the model's context window, clamped to 400000–8000000; 1000000 when the window is unknown |

## `compaction`

| Field | Default | Description |
| --- | --- | --- |
| `auto` | `true` | Compact automatically before a model call |
| `threshold` | `0.85` | Fraction (0.1–0.99) of a known context window that triggers compaction |
| `keepTurns` | `2` | Recent turns kept verbatim (0–20) |
| `maxOutputTokens` | `16000` | Output token budget for the summarizer call. Independent of `limits.maxOutputTokens` and never falls back to it. If the summary is cut by this budget, the checkpoint is kept as **partial** (the UI says so); when nothing usable was produced, compaction fails and asks you to raise this value |

Auto-compaction uses **one effective budget**. When the model's context window is known, it
triggers when the used context reaches `threshold` (default `0.85`) of that window; the fixed
`limits.maxContextChars` budget is then only a post-compaction hard limit. When the window is
unknown — or absurdly large (declared windows beyond `2_000_000` tokens are treated as unknown so
a gigantic `window × threshold` never hides real pressure) — the char budget falls back: the raw
character estimate (`~chars / 4`, about 4 characters per token) reaching `maxContextChars / 4`
also compacts (a provider's token report never triggers the fallback on its own). The TUI context
bar shows the same known window, or an honest `?` when it is unknown (see [Terminal UI](/tui#layout));
the char fallback above is an engine guardrail, never a displayed total. The default
`800000` characters (≈ `200000` tokens) is an assumption for unknown windows — the same ~200k-token
budget OpenCode assumes for custom providers — so local servers that do not report a window get
~200k tokens instead of ~40k; a known window always wins, and `/settings` → Context char budget can
lower the fallback at any time.

See [Context compaction](/compaction).

## `websearch`

| Field | Default | Description |
| --- | --- | --- |
| `provider` | none (public SearXNG) | `"searxng"`, `"duckduckgo-instant"`, `"duckduckgo-html"`, `"tavily"`, `"brave"`, `"serpapi"` or `"native"` — see [Tools & permissions](/tools#websearch) |
| `searxngUrl` | a public instance | Self-hosted or another public SearXNG instance; non-loopback values must use `https://` |
| `apiKeyEnv` | `<PROVIDER>_API_KEY` | Environment variable holding the key for `tavily`/`brave`/`serpapi` |
| `nativeToolType` | `web_search` | Only for `provider: "native"`: the provider-native tool type sent to the model |

The default public SearXNG instance is occasionally bot-blocked for automated requests.
`"duckduckgo-html"` is a keyless fallback you can pick in `/settings` → Web search provider (or set
`websearch.provider` directly); self-hosting SearXNG (`websearch.searxngUrl`) is the most reliable
option.

## `context`

```json
{ "context": { "claudeMdFallback": false, "maxBytes": 32768 } }
```

| Field | Default | Description |
| --- | --- | --- |
| `claudeMdFallback` | `false` | Use `CLAUDE.md` in directories without an `AGENTS` file |
| `maxBytes` | `32768` | Total bytes of `AGENTS.md` content injected (1024–1048576); the closest files are kept |

See [Context: AGENTS.md and skills](/context).

## `builtinPlugins`

Options for built-in plugins, keyed by plugin ID. Every entry accepts `enabled`; each plugin
 validates the rest of its section. The built-in plugins are `deepseek`, `opencode`, `opencode-go`,
 `openai-compatible`, `memory` and `subagents`; the
`subagents` options are listed in [Subagents](/subagents#limits). `memory` options:

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

Packages installed with `alisio install` land in the global plugins directory
(`<config home>/plugins`, via `npm install --prefix`) and their npm names are appended to the
GLOBAL configuration's `plugins` array automatically — see
[Installing plugins from npm](/plugins#installing-plugins-from-npm). Path entries that point at the
installed package are never written; npm names stay portable. `pluginOverrides` below can disable a
project-installed package per project just like any other external plugin.

`/plugins` stores project-local external overrides separately, keyed by the plugin's stable ID:

```json
{ "pluginOverrides": { "acme.hello": { "enabled": false } } }
```

Built-in toggles use the existing `builtinPlugins.<id>.enabled` field. Both forms apply on restart.
They do not alter global provider profiles or the separate credentials store.

## `skills`

Extra Agent Skills roots, resolved relative to the configuration file.

```json
{ "skills": ["./skills"] }
```

Project roots (`.agents/skills`, `.alisio/skills`, `.claude/skills`, trusted projects only), user
roots and plugin skills are also searched. See [Context: AGENTS.md and skills](/context#skills).

`/skills` writes project-local activation choices without changing the discovery roots:

```json
{ "skillOverrides": { "review": { "enabled": false } } }
```

Overrides apply to the effective skill in the current project. Plugin-owned skills are locked and
follow their plugin lifecycle instead.

## Prompt templates

There is no configuration key for templates. They are read from `<config home>/prompts/` and, for
trusted projects, from `.alisio/prompts/`. See [Prompt templates](/prompt-templates).

## MCP servers

Alisio first reads global `<config home>/config.json`, then a trusted project
`<workspace>/.alisio/config.json`. An explicit `--config` replaces the project layer, so the order is
**global → project** or **global → explicit**. MCP servers merge by name; the higher layer replaces a
same-name server. An untrusted project file is not read. Relative commands and arguments resolve
against the file that defined that server.

The canonical form is `mcp.servers`, keyed by name. `transport` may be explicit or inferred from
`command`/`url`.

| Field | Default | Description |
| --- | --- | --- |
| `transport` | inferred | `stdio` or `http` (Streamable HTTP) |
| `enabled` | `true` | Persisted configured state managed by `/mcp`; it does not grant runtime access or mean connected |
| `command` | none | stdio: executable |
| `args` | `[]` | stdio: arguments; `./` and `../` are resolved relative to the configuration file |
| `url` | none | http: server URL |
| `envAllow` | `[]` | Environment variables passed to the stdio server |
| `env` | `{}` | Literal values passed only to this stdio child; overrides the same name from `envAllow` |
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
      "nonsecret-local": {
        "command": "./bin/local-mcp",
        "env": { "LOG_LEVEL": "info" }
      },
      "public-remote": {
        "url": "https://example.com/public-mcp"
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

The common top-level `mcpServers` shape is also accepted:

```json
{
  "mcpServers": {
    "devforge": {
      "command": "/path/to/devforge-mcp",
      "args": [],
      "env": { "DEV_FORGE_CONFIG": "/path/to/devforge/config.json" }
    }
  }
}
```

Do not define the same name in `mcp.servers` and `mcpServers` in one file. Server names, transports,
URLs, commands, arguments and environment values are strictly validated. Environment values are
never shown by diagnostics. Direct `env` values are passed only to that child and override a
same-name value forwarded through `envAllow`; use them for non-secret settings or protected local
paths. HTTP secrets cannot be literal: `bearerTokenEnv` names the environment variable that holds the
token. A configured server stays disconnected until requested. The interactive TUI may grant MCP
process/network access for the current application session after clear confirmation; this grant is
not written to configuration. Non-TUI and programmatic callers still require `--allow-mcp` or
`allowMcp`; `--read-only` always prohibits MCP. A stdio server is a subprocess with
your user privileges, **not a sandbox**. Only trust the configuration and executable you run. See
[Tools & permissions](/tools#mcp).

### Global consent (`mcp.allow`)

Set `"mcp": { "allow": true }` in **your user configuration**
(`<config home>/config.json`, default `~/.config/alisio/config.json`) to grant MCP process/network
consent **across sessions for this user**: every Alisio start (interactive TUI and headless) begins
with MCP runtime permission already granted, the header shows `mcp:on`, and every server marked
`enabled` auto-connects, exactly like pressing **Connect** for each. This avoids the per-session
prompt on every restart.

```json
{
  "mcp": {
    "allow": true,
    "servers": {
      "devforge": { "command": "/path/to/devforge-mcp" }
    }
  }
}
```

- `mcp.allow` is **read from the global/user layer only**; a value in a project `.alisio/config.json`
  is deliberately ignored, so a project cannot grant itself network consent.
- Absent or `false` keeps today's behavior: permission is not granted at startup, the TUI may still
  grant it for the session, and headless/programmatic runs still require `--allow-mcp` (which keeps
  working as an explicit per-run grant, equivalent to `mcp.allow: true` for that run).
- `--read-only` always hard-blocks MCP regardless of `mcp.allow`; it is never even offered.
- Granting it persists across sessions and auto-connects enabled servers. MCP servers run
  unsandboxed with your user privileges, so only enable global consent when you trust every server
  you configure.
- The TUI `/mcp` manager can set this (Grant and remember) and revoke it; see
  [Terminal UI](/tui#mcp).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` (or the name in `provider.apiKeyEnv`) | API key |
| `OPENAI_BASE_URL` | Overrides `provider.baseURL` |
| `ALISIO_MODEL` | Overrides `provider.model` |
| `ALISIO_API_MODE` | Overrides `provider.apiMode` |
| `ALISIO_CONFIG_HOME` | Global configuration directory (default `$XDG_CONFIG_HOME/alisio` or `~/.config/alisio`) |
| `ALISIO_STATE_HOME` | State directory for `sessions.sqlite`, `memory.sqlite` and `trust.json` (default `$XDG_STATE_HOME/alisio` or `~/.local/state/alisio`) |
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
| `--allow-external` | Allow network tools: `webfetch`, `websearch` and provider-native search |
| `--allow-mcp` | Allow configured MCP servers and remote tool calls |
| `--allow-agents` | Allow messaging neighboring agents through Herdr |
| `--no-herdr` | Disable automatic Herdr lifecycle reports |
| `--read-only` | Disable writes, arbitrary processes, network tools, executable plugins and MCP |
| `--db <path>` | Session database |
| `--json` | Emit versioned JSONL events |
| `--no-tui` | Use the plain readline interactive mode instead of the TUI |
| `--disable-plugin <ids...>` | Disable built-in plugins (`memory`, `subagents`) |
| `--agents <json>` | Extra subagent definitions as JSON: `{"name":{"description":"...","prompt":"..."}}` |
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
| `alisio setup` | Write an example `.alisio/config.json` without secrets (for `AGENTS.md`, use `/init`) |
| `alisio doctor` | Environment and provider diagnostics; warns when no model is configured |
| `alisio trust list` | List directories with a stored project-trust decision |
| `alisio trust revoke <path>` | Forget a directory's trust decision (re-prompts next time) |
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

Instruction files (`AGENTS.override.md`, `AGENTS.md`, legacy `AGENT.md` and optionally
`CLAUDE.md`) are described in [Context: AGENTS.md and skills](/context#agents-md).
