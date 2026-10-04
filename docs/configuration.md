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
example `OPENAI_API_KEY` for OpenAI-compatible; dedicated provider plugins such as DeepSeek record
their own default) only when the profile does not record one. Because the name is persisted with the profile, the
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

One model provider is built in and enabled by default — **OpenAI compatible**. The dedicated
providers below are separate plugins published from the
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) monorepo: install them with
`alisio install npm:@alisio/plugin-deepseek`, `alisio install npm:@alisio/plugin-opencode` and
`alisio install npm:@alisio/plugin-opencode-go`, and they appear in `/connect` like the built-in:

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

Top-level settings in the selected project/explicit layer replace their global counterpart, with
additive exceptions: MCP servers merge by name, and `plugins`, `skills`, `additionalDirectories`,
`pluginOverrides`, `skillOverrides` and `builtinPlugins` ADD to the global layer instead of replacing
it. Additive lists keep the global entries first (exact duplicates dropped) and append the selected
layer's new entries, so an empty array in a lower layer never clears the global collection. Additive
records merge by key, with the selected layer winning per key. Relative paths are resolved against
the file that defined the value.

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
  "limits": { "maxTurns": 100, "timeoutMs": 600000, "firstTokenTimeoutMs": 90000, "firstTokenRetries": 1 },
  "compaction": { "auto": true, "threshold": 0.85, "keepTurns": 2, "maxOutputTokens": 16000 },
  "builtinPlugins": { "memory": { "enabled": true } },
  "pluginHooks": { "timeoutMs": 15000, "sessionEndTimeoutMs": 10000, "disposeTimeoutMs": 2000 },
  "decisions": { "enabled": true, "provider": null, "timeoutMs": 1500, "minConfidence": 0.6, "telemetry": true },
  "plugins": [],
  "skills": [],
  "additionalDirectories": [],
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
| `timeoutMs` | `600000` | Limit of the **active time of the whole run** in milliseconds (minimum 100; the default was 300000 before 0.1.0-alpha.27). It spans every model turn and every tool call (Python included), so a long dashboard task that works fine can still hit it. **Time spent waiting for you is not counted**: while a tool approval, an external-directory approval, `ask_user_question` or the plan review is open the clock is paused, and it resumes with the time that was left when you answer (several waits at once keep it paused until the last one ends). It is not a per-request or idle timeout. When it fires the run is recorded as `failed` (not `cancelled`) with a readable message that names the model and provider and says the run reached its limit of N s of active time, and `run_failed` carries `code: "timeout"` plus the details. Raise it for long analysis runs |
| `firstTokenTimeoutMs` | `90000` (`0` = off) | Stops a model request that stays completely silent (no text, reasoning or tool-call delta) for this many milliseconds, so a queued or stuck provider connection fails early instead of after `timeoutMs`. `0` disables it. The default of 90 s covers DeepSeek, which once answered after 56 s of queueing; a model that does not stream its reasoning can stay silent for longer than 90 s, so raise `firstTokenTimeoutMs` or set it to `0` for those. When it fires and retries are left (see `firstTokenRetries`) the same request is sent again; otherwise the failure is a `run_failed` with `code: "timeout"`, `kind: "first_token"` and `attempts`. Set it in the configuration file; it applies from the next run |
| `firstTokenRetries` | `1` (`0` = off, max `3`) | How many times the same request is sent again after it stayed silent for `firstTokenTimeoutMs`. A stalled connection usually answers on the next try (a DeepSeek request replayed 6 times stalled once and answered in about 2 s the other five). The retry only happens when nothing at all was received for the request (no text, reasoning or tool-call delta), it is not a turn (it does not consume `maxTurns`), nothing is appended to the session and the run emits a `request_retry` event (`attempt`, `of`, `reason: "first_token_timeout"`, `afterMs`). After a short fixed pause (250 ms, cut off by a stop) the request is resent with a fresh timer; a retry that cannot finish inside the whole-run `timeoutMs` is not started. With the defaults the worst case before the run fails is about 2 × 90 s plus the pause. The retry lives in the runner, so it applies to every provider. Set it in the configuration file; it applies from the next run |
| `truncationRecoveries` | `2` (`0` = off, max `5`) | How many times a turn is requested again after the model's response was cut off by `maxOutputTokens` before it was usable: no visible text and no tool call (typically reasoning that used the whole budget), or a tool call whose `arguments` are incomplete JSON (a long `python_run` script cut mid-string). A cut-off tool call is **never executed and never stored** (it would have no result, and provider APIs reject that); visible text of the cut response is kept as a normal assistant message. The next request carries a short transient notice (not persisted) telling the model that its reply was cut off, not to repeat what it produced, to work in smaller steps and to keep reasoning short. On the first recovery of a response that produced nothing at all, the reasoning effort is lowered one step for that request only when the model advertises its effort levels. A recovery is not a turn (it does not consume `maxTurns`) and emits a `truncation_recovery` event; `maxOutputTokens` is never raised for you. When the recoveries run out the run fails with `code: "output_truncated"` and a message that names the model and the limit. A response with usable text and no tool calls is not recovered: it completes with the `response_truncated` warning, and complete tool calls of a cut response still execute. Set it in the configuration file or with `/settings`; it applies from the next run |
| `maxContextChars` | `800000` | Context length limit in characters. The default (800k chars ≈ 200k tokens) is an **assumption for unknown model windows** — the same ~200k-token budget OpenCode assumes for custom providers — so local servers that do not report a window (e.g. llama.cpp) get ~200k tokens instead of ~40k. Acts as the **fallback auto-compaction trigger** when the model window is unknown (or absurdly large, see [compaction](/configuration#compaction)) — estimated tokens (`~chars/4`) reaching `maxContextChars / 4` — and as the **hard limit** that must fit after a compaction. A **known** window overrides the fallback, and `/settings` → Context char budget can lower it at any time |
| `maxOutputTokens` | unset: the model's declared limit (max `65536`), else `16384` | Output tokens per request. **A value you set always wins**, even above what the model declares (a provider that rejects it says so; Alisio does not clamp or retry). While it is unset, each request uses the maximum output the active model's catalog declares (`ModelInfo.maxOutputTokens`, read from the provider's model listing when it reports one; DeepSeek's `/models` does), capped at 65536, and 16384 when the catalog declares nothing. The value is resolved for the model of every request, so `/model`, an agent switch or the web model picker change it. Alisio shows the effective value and where it came from (*set by you*, *from the model catalog*, *default*) in the cut-response notice, in the truncation failure and in `alisio doctor`. Subagents keep their own budget (`maxOutputTokensPerChild`, 16384, forwarded as a per-run value), compaction keeps `compaction.maxOutputTokens`, and side questions follow this setting. When a model hits this budget mid-answer, Alisio keeps the text produced so far, warns that the response was cut (`response cut by max output tokens`), completes the run normally and flags the completion as `truncated` in `run_completed`. Tool calls that were fully written still execute. Raise this budget for longer answers; reasoning models can spend most of it on reasoning before any text, so don't set it too low (for reasoning-heavy models such as DeepSeek, and for runs that write whole dashboards inside one `python_run` call, 32768 or more is recommended; the recoveries of `truncationRecoveries` only mitigate a cut, they do not remove it). Editable from `/settings` → Agent max output tokens |
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
 validates the rest of its section. Entries merge across configuration layers by plugin ID — the
 project/explicit entry wins per ID, so `{ "memory": { "enabled": false } }` in a project disables
 the memory built-in there while every other global entry stays. The built-in plugins are `deepseek`, `opencode`, `opencode-go`,
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
| `disposeTimeoutMs` | `2000` | Per-plugin limit (100–10000 ms) for `dispose()` and for the active decision provider's `deactivate()` when Alisio closes. Plugins are disposed in parallel, so one slow plugin does not delay the others. Settable live from **Settings → General** in the web UI; not listed in the terminal `/settings` menu |

## `decisions` {#decisions}

[Decision Intelligence](/decision-intelligence): an optional provider resolves closed choices
without a full model generation. `provider` and `telemetry` are **global only**: they are read from
`<config home>/config.json`, and a project or `--config` layer that sets them is ignored with a
notice (`alisio doctor` lists what was ignored).

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | `false` turns decisions off: calls resolve to nothing and features use their defaults |
| `provider` | `null` | ID of the plugin provider to use (`^[a-z0-9][a-z0-9.-]{0,63}$`); `null` means none. Installing a plugin never activates it. Global only |
| `timeoutMs` | `1500` | Limit of one decision call (50–10000 ms) |
| `minConfidence` | `0.6` | Answers below this confidence are rejected (0–1). A heuristic filter: confidence is not assumed to be calibrated |
| `telemetry` | `true` | `false` stops persisting decision events, so `/stats` shows no decisions section. Global only |

```json
{ "decisions": { "provider": "my-provider", "timeoutMs": 1500 } }
```

All five keys are settable from **Settings → General** in [`alisio serve`](/web) (labels in English
and Spanish) and are read live: the next decision uses the new value. They are not listed in the
terminal `/settings` menu; edit the file there.
## `plugins`

A list of trusted plugins: paths (resolved relative to the configuration file) or npm package names.
Project/explicit `plugins` entries ADD to the global list: global entries stay first, exact
duplicates are dropped, then the selected layer's new entries follow. An empty `plugins` array in a
project never clears the global plugins.
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

An entry may also carry `options`, a JSON object the plugin reads as `api.options` (see
[Writing plugins](/plugins#decision-intelligence)). `options` is **global only**: a project layer
cannot set it (it is ignored with a notice), because a plugin runs with the full privileges of the
process. Option names start with a letter and use letters, digits, dot, underscore or dash; the
serialized object is at most 8 KB; do not put secrets in it. Changing it takes effect on restart.
Toggling a plugin from `/plugins` keeps its `options`.

```json
{ "pluginOverrides": { "acme.hello": { "options": { "device": "cpu" } } } }
```

Built-in toggles use the existing `builtinPlugins.<id>.enabled` field. Both forms apply on restart.
They do not alter global provider profiles or the separate credentials store.

## `skills`

Extra Agent Skills roots, resolved relative to the configuration file.
Project/explicit `skills` entries ADD to the global list with the same global-first, deduplicated
merge; an empty `skills` array in a project never clears the global roots.

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

## `additionalDirectories`

Extra directories the mediated path policy may touch outside the workspace, for reads and for writes
(writes still need `--allow-write` or their own approval). Project/explicit entries ADD to the global
list with the same global-first, deduplicated merge; an empty `additionalDirectories` array in a
project never clears the global roots. Each entry is resolved relative to the configuration file that
defined it and canonicalized on load.

```json
{ "additionalDirectories": ["/data/videos", "./shared"] }
```

In an interactive session an undeclared external path asks for approval scoped to its containing
directory instead of failing; in headless runs it is denied with the resolved path and the exact
remedies (`--add-dir` or this key). `--read-only` ignores both this key and `--add-dir`, so a locked
session never gains external access. See [Paths outside the workspace](/tools#external-directories).

## `agents`

The active agent and the reasoning effort of the main session. Written by `/agents` and `/effort`
(also settable through the same atomic `setConfigValue` writer as the other user settings).

| Field | Default | Description |
| --- | --- | --- |
| `active` | `"build"` | Id of the active (main-session) agent: the built-in `build` or `plan`, or a main-capable definition id from the [subagents](/subagents) system (`mode: primary`/`all`). The agent's system prompt is appended to every prompt; a read-only agent narrows the run to reads. An id that does not resolve falls back to `build` |
| `effort` | unset | Reasoning effort level (`string`) for a model that advertises `effort.supportedLevels`; validated against the ACTIVE model on use. When the stored level is unsupported by the current model, the model's `defaultLevel` is used silently with a one-time notice. Providers that advertise effort receive it as `reasoning_effort` (chat) / `reasoning.effort` (responses); providers without the concept ignore it |

```json
{ "agents": { "active": "plan", "effort": "high" } }
```

`/agents` and `/effort` are TUI commands; `alisio run`/`resume` and `--no-tui` mode apply the
persisted active agent's system prompt and read-only narrowing to each run (the effort level is a
TUI feature: it is sent only by the interactive TUI, after validation against the active model's
catalog).

## `analysis`

[Python analysis and artifacts](/analysis). The interpreter has no configuration key: it is
discovered automatically or pinned with `--python <path>`. `runtime`, `oci.*` and `retention.*` are
**global only**: they are read from `<config home>/config.json`, and a project or `--config` layer
that sets them is ignored with a notice (`alisio doctor` lists what was ignored), so a repository can
neither pick the binary that runs scripts nor shorten the retention of every workspace.

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | `false` registers none of `python_run`, `artifact_create`, `artifact_list`, `data_inspect`, `data_query` and `dashboard_generate` |
| `smartDashboard` | `true` | Registers `dashboard_generate` and steers the model to it for dashboards; `false` removes the tool and restores the Python-only guidance. A global `false` cannot be undone by a project layer. Applies at the next start. See [Smart Dashboard](/smart-dashboard#switch) |
| `runtime` | `"managed"` | `managed` (your Python, not a sandbox) or `oci` (a Docker or Podman container; see [Container runtime](/analysis#oci)). Global only |
| `oci.engine` | `"docker"` | `docker` or `podman`. Global only |
| `oci.image` | unset | The image, pinned by digest (`name@sha256:<64 hex>`); a value without a digest is rejected when the configuration loads. Global only |
| `oci.memoryMb` | `2048` | Container memory limit (256–65 536) |
| `oci.cpus` | `2` | Container CPU limit (0.5–64) |
| `retention.jobsDays` | `30` | Logs and staging of a job, its script once no artifact is ready, and datasets unused for this long (0–3 650; `0` never deletes). Global only |
| `retention.intermediateDays` | `7` | The scratch folder (`work/`) of a job (0–3 650; `0` never deletes). Global only |
| `retention.artifactsDays` | `0` | Artifacts older than this become expired (files deleted, card kept); `0` keeps them forever (0–3 650). Global only |
| `limits.timeoutMs` | `120000` | Default and maximum run time of one `python_run` call (1 000–900 000) |
| `limits.maxFiles` | `200` | Files one execution may publish |
| `limits.maxFileBytes` | `104857600` | Largest published file (100 MiB) |
| `limits.maxOutputBytes` | `524288000` | Total bytes one execution may publish (500 MiB) |
| `limits.maxLogBytes` | `10485760` | Size cap of each job log (`stdout.log`, `stderr.log`) |
| `data.maxUploadBytes` | `209715200` | Largest data file ingested, an upload or a workspace file (200 MiB) |
| `data.maxRows` | `5000000` | Rows per sheet; a larger file stops the ingestion and leaves no dataset |
| `data.queryTimeoutMs` | `5000` | Time limit of one `data_query` statement (100–60 000); past it the engine process is killed |
| `data.maxInteractiveRows` | `1000000` | Above it the web table viewer disables sorting and filtering |

```json
{ "analysis": { "limits": { "timeoutMs": 300000 }, "retention": { "artifactsDays": 90 } } }
```

`analysis.enabled`, `analysis.smartDashboard`, `analysis.limits.timeoutMs` and the three `analysis.retention.*` keys can also be
edited from **Settings → Data analysis** in [`alisio serve`](/web) and from `/settings` in the
[TUI](/tui); they are written to the global file with the same validated writer as the other
settings (a key with three levels, such as `analysis.retention.jobsDays`, keeps its siblings).
The timeout and the retention apply from the next call or sweep; `analysis.enabled` and `analysis.smartDashboard` apply when
Alisio restarts (the web reloads the workspace's tools once its runs finish). `runtime` and
`oci.*` are not editable from the UI: edit the file.

## `tasks` {#tasks}

[Background tasks](/tools#background-tasks): the `bg_run`, `bg_list`, `bg_output` and `bg_stop` tools.
`retentionDays` is **global only**: it is read from `<config home>/config.json` and a project or
`--config` layer that sets it is ignored with a notice (`alisio doctor` lists what was ignored), because
one sweep deletes the data of every workspace.

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | `false` registers none of the four tools. Applies the next time Alisio starts |
| `maxPerSession` | `4` | Live (queued, running or stopping) tasks per root session (1–32). There is also a fixed limit of 16 per Alisio process |
| `maxRunMs` | `3600000` | Watchdog: a task still running after this long (and the cap of `bg_run`'s `timeoutMs`) is stopped and ends `failed` with the code `timeout` (1 000–86 400 000) |
| `maxOutputBytes` | `2097152` | Size of one task log: the first bytes are kept, one marker line, and the last 32 KiB are appended when the task ends (65 536–104 857 600) |
| `retentionDays` | `7` | Finished tasks and their logs are deleted after this many days; `0` keeps them. Swept at most once a day in the background (0–3 650). Global only |

```json
{ "tasks": { "maxPerSession": 2, "maxRunMs": 600000 } }
```

All five keys are settable from **Settings → General** in [`alisio serve`](/web) (labels in English and
Spanish) and the main ones from `/settings` in the [TUI](/tui), with the same validated writer as the
other settings. `maxPerSession`, `maxRunMs` and `maxOutputBytes` apply to the next task and
`retentionDays` to the next sweep; `enabled` applies when Alisio restarts (the web reloads the
workspace's tools once it has no runs or tasks). Tasks are not sandboxed and end when Alisio exits.

## `goal` {#goal}

[Session goals](/tui#goals) (`/goal`): the agent keeps working on one objective with hard limits.
There is **no** token budget setting on purpose: a goal has none unless you give it one with
`/goal <objective> budget=50k`. **Without a token budget only the turn and time limits below stop a
goal**, so set one when the objective could run long or expensive.

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | `false` refuses new goals and stops continuing the current one (the tools stay registered; they are only offered to a session with an active goal) |
| `maxTurns` | `50` | A goal pauses (`max_turns`) after this many turns; a turn is one run: the kickoff, a continuation or a prompt of yours while the goal is active (1–1 000) |
| `maxMinutes` | `120` | A goal pauses (`max_wall`) after this much **active** time inside runs; time spent waiting for you (an approval, a question, the plan review) or for background tasks does not count (1–1 440) |
| `repeatedReplyLimit` | `3` | Pause (`no_progress`) after this many consecutive repeats of the same final reply; the first is logged and the second adds a nudge to the next continuation (2–20) |
| `noToolTurnsLimit` | `3` | Pause (`no_progress`) after this many consecutive turns in which the agent called no tool, with the same log-then-nudge steps (2–20) |
| `blockedRepeats` | `2` | Consecutive turns in which the agent must report the same blocker, with evidence, before the goal stops as blocked (1–10); a permission denial blocks at once |

```json
{ "goal": { "maxTurns": 30, "maxMinutes": 60 } }
```

All six keys are settable from **Settings → General** in [`alisio serve`](/web) (labels in English and
Spanish) and from `/settings` in the [TUI](/tui), with the same validated writer as the other settings.
They are read live: the next continuation (or the next `/goal`) uses the new value, but the turn and
time caps of a goal that already exists were fixed when it was created.

## `plan` {#plan}

[Plan diagrams](/tools#exit-plan): the plan agent may add small Mermaid diagrams to a plan, which the
[web plan viewer](/plan#plan-viewer) draws and the [terminal](/plan#terminal) shows as source.
See [Plan settings](/plan#settings) for where to change them.

| Field | Default | Description |
| --- | --- | --- |
| `diagrams` | `true` | `false` removes the `diagrams` argument from `exit_plan` and the diagram style guide from the plan agent's instructions; a call that still sends diagrams is answered with a note and they are not published |
| `maxDiagrams` | `5` | Most diagrams one plan keeps (0–8); the rest are dropped and the tool result says so. `0` behaves like `diagrams: false` |

The size of one diagram (8 KB) and its estimated node count (40) are fixed limits, not settings.

```json
{ "plan": { "maxDiagrams": 3 } }
```

Both keys are settable from **Settings → General** in [`alisio serve`](/web) (labels in English and
Spanish) and from `/settings` in the [TUI](/tui), and are read live: the next plan request offers (or
hides) the diagrams and uses the new cap.

## Changes made from the web UI

The **Settings** pages of [`alisio serve`](/web) write to the same files as the terminal:

| Change | Where it is written |
| --- | --- |
| Agent settings (General page) | `<config home>/config.json`, through the same validated writer as `/settings`; only the settable keys are accepted |
| Provider profiles (Models page) | `<config home>/providers.json` (non-secret values only, `0600`) |
| Credentials (Models page) | `<config home>/credentials.json` (`0600`, atomic writes); the web can set or delete them but never reads them back |
| Plugin and skill switches | The project's `.alisio/config.json` (trusted workspaces only) |
| MCP server switches | The configuration layer that defines the server |
| MCP consent with **Remember for this user** | `mcp.allow` in `<config home>/config.json` |

**Open configuration file** in Settings shows these paths with copy buttons; the server does not
open editors. Activating a profile from the web also makes it the default profile (`active` in
`providers.json`), as `/connect` does in the terminal.

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
| `enabled` | `true` | Persisted configured state managed by `/mcps`; it does not grant runtime access or mean connected |
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
- The TUI `/mcps` manager can set this (Grant and remember) and revoke it; see
  [Terminal UI](/tui#mcp). In the web UI, **Settings → MCP servers → Grant MCP access** asks for
  an explicit confirmation and can remember the grant the same way; see [Web UI](/web).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` (or the name in `provider.apiKeyEnv`) | API key |
| `OPENAI_BASE_URL` | Overrides `provider.baseURL` |
| `ALISIO_MODEL` | Overrides `provider.model` |
| `ALISIO_API_MODE` | Overrides `provider.apiMode` |
| `ALISIO_CONFIG_HOME` | Global configuration directory (default `$XDG_CONFIG_HOME/alisio` or `~/.config/alisio`) |
| `ALISIO_STATE_HOME` | State directory for `sessions.sqlite`, `memory.sqlite` and `trust.json` (default `$XDG_STATE_HOME/alisio` or `~/.local/state/alisio`) |
| `ALISIO_LOG_LEVEL` | Log level of `alisio serve` JSON log lines on stderr: `debug`, `info` (default), `warn`, `error`, `silent` |
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
| `--allow-analysis` | Allow Python analysis (`python_run`) without asking; not sandboxed, never allows `shell` |
| `--python <path>` | Python 3.10+ interpreter for `python_run` (default: discovered) |
| `--allow-external` | Allow network tools: `webfetch`, `websearch` and provider-native search |
| `--allow-mcp` | Allow configured MCP servers and remote tool calls |
| `--allow-agents` | Allow messaging neighboring agents through Herdr |
| `--add-dir <paths...>` | Additional directories tools may touch outside the workspace (repeatable, this run only) |
| `--no-herdr` | Disable automatic Herdr lifecycle reports |
| `--read-only` | Disable writes, arbitrary processes, network tools, executable plugins, MCP and every external path |
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
| `alisio doctor` | Environment and provider diagnostics; warns when no model is configured; shows the Python of `python_run` (or how to install it) |
| `alisio analysis status` | Mode, the discovered Python interpreter, installed extras, the container engine and image, limits and retention, and install guidance when Python is missing |
| `alisio analysis setup --extras analysis\|science` | Optional: install hash-locked extras (pandas…) into a private virtualenv; needs network and fails cleanly without it |
| `alisio analysis setup --oci [--image <name>]` | Optional: pull the container image once and verify its digest (Docker or Podman) |
| `alisio analysis sweep [--force]` | Run the retention sweep now (it also runs by itself at most once a day) |
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
| `alisio serve` | Start the local [web UI server](/web) |

`alisio serve` flags (the global permission flags are the ceiling of every web session):

| Flag | Description |
| --- | --- |
| `--port <port>` | Port to listen on (default `4317`; `0` picks a free one) |
| `--host <address>` | Address to bind (default `127.0.0.1`); non-loopback requires `--allow-remote` |
| `--allow-remote` | Allow a non-loopback `--host` (no TLS; prefer an SSH tunnel) |
| `--no-open` | Do not open the browser |
| `--max-workspaces <n>` | Workspaces with an open application at once (default `4`) |
| `--max-runs <n>` | Concurrent runs across all sessions (default `4`) |

## `AGENTS.md`

Instruction files (`AGENTS.override.md`, `AGENTS.md`, legacy `AGENT.md` and optionally
`CLAUDE.md`) are described in [Context: AGENTS.md and skills](/context#agents-md).
