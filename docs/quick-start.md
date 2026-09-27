# Quick start

Alisio ships with the OpenAI-compatible provider plugin enabled, but no default model or credentials.
Start the TUI and run `/connect` for the quickest setup: choose the provider, enter its settings and
key, then choose a discovered model. The selection applies globally on later launches.

## Quick path (60 seconds)

1. `alisio setup` — write an example `.alisio/config.json` without secrets.
2. Export the key variable that file names (step 2 below).
3. `alisio doctor --config ./my-api.json` — confirm runtime, tools and provider.
4. `alisio --config ./my-api.json` — open the TUI and run `/connect` to pick a provider and model.

Each step follows in detail below; [Terminal UI](/tui) covers the TUI itself.

## 1. Create a configuration file

`alisio setup` writes an example `.alisio/config.json` in the current directory, without secrets.
You can also write the file anywhere yourself.

```sh
alisio setup
```

OpenAI-compatible endpoint (`my-api.json`):

```json
{
  "schemaVersion": 1,
  "provider": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "YOUR_MODEL_ID",
    "apiMode": "chat",
    "auth": "bearer",
    "tokenParameter": "max_completion_tokens",
    "streamUsage": true
  }
}
```

DeepSeek (`deepseek.json`):

```json
{
  "schemaVersion": 1,
  "provider": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "model": "deepseek-chat",
    "apiMode": "chat",
    "tokenParameter": "max_tokens",
    "streamUsage": true
  }
}
```

A local server without authentication uses `"auth": "none"` and its own `baseURL`, for example
`http://127.0.0.1:1234/v1`. All fields are described in [Configuration](/configuration).

## 2. Provide the API key through the environment

Keys are **only** read from the environment variable named by `provider.apiKeyEnv`
(default `OPENAI_API_KEY`). Never put keys in configuration files.

```sh
export OPENAI_API_KEY='YOUR_KEY'
```

PowerShell:

```powershell
$env:OPENAI_API_KEY = 'YOUR_KEY'
```

## 3. Check the setup

```sh
alisio doctor --config ./my-api.json
```

`doctor` prints the version, runtime, platform, workspace, Git and ripgrep paths, and the provider
settings, including whether the key variable is set. When ripgrep is missing, it also prints the
per-platform install commands (it powers `search_text`/`list_files`). It never prints the key.

## 4. Run

```sh
# Interactive terminal UI: write/process/external tools are offered and ask before each call
alisio --config ./my-api.json

# Headless, read-only: writes/processes/network tools are never even offered
alisio run "Explain this repository" --config ./my-api.json --read-only

# Headless with versioned JSONL events on stdout (diagnostics go to stderr)
alisio run "Review the code" --config ./my-api.json --json

# Skip asking and allow edits (and processes, if needed) outright
alisio run "Implement the task in docs/task.md" --config ./my-api.json --allow-write
```

The TUI's write/process/external tools **ask by default** — allow once, allow for the session, or
deny — every time, with no flag needed. `--allow-write`/`--allow-process`/`--allow-external` skip
that question and allow outright; `--read-only` disables them completely, never even offering them
to the model. Headless `run`/`resume <id> "prompt"`/`--json` have no one to ask, so there the exact
same flags mean the tool is simply unavailable without them. `--allow-process` (or an "allow"
answer to the prompt) gives access to arbitrary processes with your user privileges; it is not a
sandbox. See [Tools & permissions](/tools#permission-flags) for the full truth table.

## 5. Sessions

Sessions are stored in SQLite and can be resumed.

```sh
alisio sessions list
alisio resume <id>                 # opens the TUI with that session
alisio resume <id> "Continue"      # headless turn in that session
alisio sessions recover <id> --acknowledge
```

Passing `--model` when resuming switches the session to that model for the following turns.
`sessions recover` is only needed after a crash left a tool with an uncertain result; see
[Context compaction](/compaction#uncertain-tool-results).

## 6. Generate AGENTS.md

Run the built-in `/init` template in the TUI, or headless, to create or update the root `AGENTS.md`
with project-specific instructions for coding agents:

```sh
alisio run "/init" --config ./my-api.json --allow-write
```

See [Prompt templates](/prompt-templates#built-in-init).

## Configuration trust model

Opening a repository must not redirect your API key to an endpoint chosen by that repository. For
that reason Alisio reads:

| Source | When |
| --- | --- |
| `--config <path>` | Always, when given: an explicitly trusted file |
| `<workspace>/.alisio/config.json` | With `--trust-project`, or after trusting it interactively (below) |
| `~/.config/alisio/config.json` (`ALISIO_CONFIG_HOME` or `XDG_CONFIG_HOME`) | Otherwise |

Trusting a project also loads its executable plugins from `.alisio/plugins` (full process
privileges), and its agents/skills/prompts from `.alisio/agents`, `.agents/agents`,
`.alisio/skills` and `.alisio/prompts`.

**Interactive one-time trust.** Starting the TUI (not headless `run`/`--json`, which always keep
requiring `--trust-project`/`--config` explicitly — there is no one there to ask) in a directory
that has any of those project resources, without `--trust-project`/`--config`, asks once:

```
This directory has Alisio project configuration: /path/to/repo
Trusting it lets Alisio load that configuration for this and future runs — including a possibly
different provider endpoint or API key — plus its plugins, agents, skills and prompt templates.
Declining uses Alisio's own defaults instead; nothing here is read.
Trust this project's Alisio configuration? [y/N]
```

The decision is remembered per directory (`alisio trust list`/`alisio trust revoke <path>` inspect
or undo it) together with a hash of `.alisio/config.json`'s content, so editing that file — even
after trusting it once — asks again rather than silently keeping the old trust. A directory with no
project resources at all is never prompted. `--trust-project`/`--config` remain explicit, one-run
trust exactly as before and are never written to this store.

Next: [Terminal UI](/tui) · [Prompt templates](/prompt-templates) · [Configuration](/configuration).
