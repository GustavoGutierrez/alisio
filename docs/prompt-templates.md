# Prompt templates

A prompt template is a Markdown file that expands into a normal user turn when you type
`/name args`. Alisio ships one built-in template, [`/init`](#built-in-init), and loads more from
plugins, your user directory and trusted projects.

## Format

A template is a Markdown file with YAML frontmatter. The template name is the file name without
`.md`.

```md
---
description: Review the staged changes
argument-hint: "[area]"
requires: [process]
---
Review the staged changes in this repository. Run `git diff --staged` and report correctness bugs
first, then style issues. Focus on: $ARGUMENTS
```

| Field | Required | Description |
| --- | --- | --- |
| `description` | Yes | Shown in `/help` and autocompletion (1–300 characters) |
| `argument-hint` | No | Hint shown next to the name, for example `"[focus]"` (up to 120 characters) |
| `requires` | No | Capabilities the template needs: `write`, `process` or both |

Rules:

- Unknown frontmatter keys are rejected.
- The name must use lowercase letters, digits and dashes (`^[a-z0-9][a-z0-9-]{0,40}$`).
- The file is limited to 64 KB and the body must not be empty.

## Argument syntax

| Placeholder | Replaced with |
| --- | --- |
| `$ARGUMENTS` | The whole argument string, trimmed |
| `$1` … `$9` | Shell-like positional arguments: whitespace separates them, single or double quotes group words. A missing argument becomes empty |

- Positional placeholders are a single digit: `$10` is `$1` followed by `0`.
- If the body references neither `$ARGUMENTS` nor `$1`…`$9`, non-empty arguments are appended after
  a blank line.

```text
/review "error handling" src/core
  $ARGUMENTS → "error handling" src/core
  $1         → error handling
  $2         → src/core
```

## Sources and precedence

Templates are loaded from four levels. A later level overrides an earlier one with the same name.

| Level | Location | When |
| --- | --- | --- |
| builtin | Shipped with the CLI (`/init`) | Always |
| plugin | Directories registered with `api.resources.prompts(dir)` | When the plugin is loaded |
| user | `<config home>/prompts/` (`~/.config/alisio/prompts` or `$ALISIO_CONFIG_HOME/prompts`) | Always |
| project | `<workspace>/.alisio/prompts/` | Only when the project is trusted |

Only `*.md` files directly inside each directory are read. Several plugins defining the same name
resolve by plugin ID, then registration order.

## Trust

Project templates follow the [configuration trust model](/quick-start#configuration-trust-model):
`.alisio/prompts/` is only read with `--trust-project` or an explicit `--config`. Opening an
untrusted repository never adds its templates.

## Diagnostics

Problems never stop Alisio; they are listed in `/stats` in the TUI.

| Diagnostic | Meaning |
| --- | --- |
| `prompt_invalid` | A file failed validation (frontmatter, name, size or empty body) and was skipped |
| `prompt_override` | A higher level overrode a template from a lower level |
| `prompt_conflict` | Several plugins defined the same name; the winner is chosen by plugin ID, then registration order |
| `prompt_shadowed` | A template tried to take a TUI command name or alias (for example `/help`, `/new`) or a plugin command name, and was ignored |

## Requirements

`requires` makes Alisio check capabilities before the turn starts:

| Mode | `requires: [write]` without `--allow-write` |
| --- | --- |
| `--read-only` | Refused, with a hint to run without `--read-only` |
| Headless (`run`, `resume <id> "prompt"`) | Refused: `rerun with --allow-write` |
| TUI | Runs; each write asks for the usual per-call [approval](/tui#interactive-approvals) |

`requires: [process]` behaves the same way with `--allow-process`.

## In the TUI

Templates appear as slash commands in their own section of `/help` and in autocompletion, with
their description and argument hint. Running one streams a normal user turn with tools and
approvals. The conversation shows what you typed (for example `/init focus on tests`) instead of the
full rendered prompt; that text is persisted as the message display and reused by `/resume`.

## Headless usage

Headless runs use the same `/name args` syntax; there is no extra flag.

```sh
alisio run "/init focus on the plugin SDK" --allow-write
alisio run "/review error-handling" --allow-process
```

A `/name` that is not a template (and not `/skill:name`) is sent to the model verbatim.

## Writing a template

Save this as `~/.config/alisio/prompts/explain.md`:

```md
---
description: Explain a file or module for a newcomer
argument-hint: "<path> [audience]"
---
Read $1 and explain what it does, how it fits in this repository and the non-obvious parts.
Write for this audience: $2
```

Then run `/explain src/index.ts "a new contributor"` in the TUI, or
`alisio run '/explain src/index.ts "a new contributor"'`.

## Templates from plugins {#templates-from-plugins}

A plugin registers a directory of templates with `resources.prompts`; the path is relative to the
plugin file.

```ts
import { definePlugin } from "@alisio/sdk";

export default definePlugin({
  id: "acme.prompts",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.resources.prompts("./prompts"); // ./prompts/*.md
  },
});
```

User and project templates with the same name override plugin templates. See
[Writing plugins](/plugins).

## Built-in `/init` {#built-in-init}

`/init` analyzes the repository and creates or updates the root `AGENTS.md`: concise,
project-specific instructions for coding agents. Its frontmatter:

```yaml
description: Analyze this repository and create or update the root AGENTS.md
argument-hint: "[focus]"
requires: [write]
```

The template instructs the model to:

1. **Explore read-only first**: list the root and key directories, check `git_status`, read the
   manifests and lockfiles, build/test/lint configuration, CI workflows, README, CONTRIBUTING and
   existing agent instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`,
   `.cursor/rules/*`, `.github/copilot-instructions.md`), and sample representative source and test
   files, preferring `search_text` over reading many files.
2. **Write `AGENTS.md`** (roughly 150 lines or fewer) covering, only where the repository gives
   evidence: project overview, exact commands, architecture, enforced code style, testing approach,
   and gotchas and constraints. Only verified facts, no generic advice or invented commands, no
   secrets or environment values, no reading `.env`; useful rules from other instruction files are
   merged with their source cited.
3. **Create or update safely**: if `AGENTS.md` does not exist, create it with `write_file`
   (`expectedHash: null`). If it exists, read it first and update it in place with `edit_file`,
   using the SHA-256 from `read_file` as `expectedHash`, preserving human-written content. It never
   blindly overwrites an existing file.
4. **Finish** with a short summary of what changed and what could not be verified.

The optional argument is an extra focus appended at the end (`$ARGUMENTS`):

```sh
alisio run "/init focus on the plugin SDK" --allow-write
```

`/init` is not `alisio init`: the `alisio init` command writes an example `.alisio/config.json`
and now prints a hint pointing to `/init`.

::: tip Larger repositories
Exploration re-sends the growing context on every turn, and `limits.maxTokens` (default `100000`) is
a cumulative budget per run. On larger repositories, raise it in your configuration. In a real run
against DeepSeek, the edits landed but the final summary hit the budget.
:::

## Limits

No includes or partials between templates, no shell execution or file injection inside templates,
no `$10` or higher, and positional arguments are plain text only.
