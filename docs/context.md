# Context: AGENTS.md and skills

Alisio builds the model's instructions from project instruction files (`AGENTS.md`, following the
[agents.md](https://agents.md/) convention) and exposes Agent Skills
through progressive disclosure.

## AGENTS.md

### Which files are read

| Scope | Files |
| --- | --- |
| Global | `<config home>/AGENTS.md`; `<config home>/AGENTS.override.md` replaces it when present |
| Project | One file per directory, walking from the workspace root down to the working directory |

In each directory the first existing file wins:

| Order | File | `context_explain` kind |
| --- | --- | --- |
| 1 | `AGENTS.override.md` | `override` |
| 2 | `AGENTS.md` | `agents` |
| 3 | `AGENT.md` (legacy alias, kept for compatibility) | `legacy` |
| 4 | `CLAUDE.md`, only with `context.claudeMdFallback: true` | `claude` |

`Agente.md` is no longer read. Files are concatenated root-first, under a header telling the model
that the closest file wins when instructions conflict and that explicit user prompts override them.

### Nested files

Instruction files in directories below the working directory are attached lazily, when a tool
touches a path below them:

- once per session per file, and again if the file changes;
- for read tools, the instructions are attached to the tool result;
- for write or process calls, the call is returned to the model with the new instructions so it can
  reconsider before retrying.

### Size limit

All instruction files together are capped at `context.maxBytes` (default 32 KiB). The closest files
are kept; farther ones are truncated or dropped with a truncation notice.

```json
{
  "context": { "claudeMdFallback": false, "maxBytes": 32768 }
}
```

| Field | Default | Description |
| --- | --- | --- |
| `claudeMdFallback` | `false` | Use `CLAUDE.md` in directories without an `AGENTS` file |
| `maxBytes` | `32768` | Total bytes of instruction files (1024–1048576) |

`alisio context explain <path>` (and the `context_explain` tool) shows which files apply to a path
and their kind. The built-in [`/init`](/prompt-templates#built-in-init) template creates or updates
the root `AGENTS.md`.

## Skills

Skills are directories containing a `SKILL.md` file with `name` and `description` frontmatter.

### Discovery

Roots are searched in this order; the first skill with a given name wins, and later ones are
reported as shadowed:

| Order | Roots | When |
| --- | --- | --- |
| 1 | `.agents/skills`, `.alisio/skills`, `.claude/skills` in each directory from the working directory up to the workspace root | Trusted projects only (`--trust-project` or an explicit `--config`) |
| 2 | Paths in the `skills` configuration key | Always |
| 3 | `~/.agents/skills`, `<config home>/skills` | Always |
| 4 | Directories registered by plugins (`api.resources.skills`) | When the plugin is loaded |

Scanning is bounded: at most 5 levels deep and 2000 directories.

### Validation

Names follow the Agent Skills specification: 1–64 lowercase letters and digits with single hyphens,
no leading or trailing hyphen. The description is required (up to 1024 characters). A directory name
that does not match the skill name only produces a warning. `alisio skills validate [path]` reports
all diagnostics.

### Progressive disclosure

Only each skill's name and description are included in the context at first. The body is loaded
with the `skill_load` tool or `/skill:name`, and supporting files with `skill_resource`.
`skill_search` searches the catalog.

In the TUI, `/skills` opens the effective catalog without loading skill bodies. It
shows scope/source, enabled and shadowed status, and an approximate token cost (`~`, estimated from
file bytes at four characters per token). Project, configured and user winners are enabled by
default and can be toggled immediately. The project-local override is saved atomically in
`.alisio/config.json`; an existing file must be trusted. Plugin skills use a namespaced display such
as `vercel:nextjs`, are locked to their owning plugin, and direct you to `/plugins`.

```sh
alisio skills list
alisio skills validate ./.agents/skills
```

The headless commands include source/status metadata and trusted diagnostic paths. The ordinary TUI
catalog never shows absolute paths or skill bodies.
