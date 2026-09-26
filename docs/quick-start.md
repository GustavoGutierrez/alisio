# Quick start

Alisio ships with no default model and no credentials. Configure an endpoint and a model before
running tasks. The model must support streaming and tool calling in the selected protocol.

## 1. Create a configuration file

`alisio init` writes an example `.alisio/config.json` in the current directory, without secrets.
You can also write the file anywhere yourself.

```sh
alisio init
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
settings, including whether the key variable is set. It never prints the key.

## 4. Run

```sh
# Interactive terminal UI
alisio --config ./my-api.json

# Headless, read-only
alisio run "Explain this repository" --config ./my-api.json --read-only

# Headless with versioned JSONL events on stdout (diagnostics go to stderr)
alisio run "Review the code" --config ./my-api.json --json

# Allow edits (and processes, if needed)
alisio run "Implement the task in docs/task.md" --config ./my-api.json --allow-write
```

`--allow-process` gives access to arbitrary processes with your user privileges; it is not a
sandbox. See [Tools & permissions](/tools).

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

## Configuration trust model

Opening a repository must not redirect your API key to an endpoint chosen by that repository. For
that reason Alisio reads:

| Source | When |
| --- | --- |
| `--config <path>` | Always, when given: an explicitly trusted file |
| `<workspace>/.alisio/config.json` | Only with `--trust-project` |
| `~/.config/alisio/config.json` (`ALISIO_CONFIG_HOME` or `XDG_CONFIG_HOME`) | Otherwise |

`--trust-project` also loads the project's executable plugins from `.alisio/plugins`, which run with
full process privileges. Only use it for repositories you trust.

Next: [Terminal UI](/tui) · [Configuration](/configuration).
