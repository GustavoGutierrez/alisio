# Changelog

User-visible changes to Alisio, newest first. Each release is listed under the version of the
`@alisio/alisio-code` package (all packages share one version). Internal refactors, tests and documentation-only changes are left
out. `/changelog` (terminal and web) shows these entries offline.

## [0.1.1] - 2026-10-03

### Fixed

- The web UI no longer scrolls the page and leaves a blank gap under the interface while a reply is streaming: the app now always fills the window exactly and only its inner panels scroll.
- The Alisio version is shown in the web UI: **Settings → About** and, discreetly, the bottom of the sidebar.

## [0.1.0] - 2026-10-02

The first stable release. Until 1.0.0 the usual 0.x rules apply: fixes ship as 0.1.x and a new
minor (0.2.0) may include breaking changes.

### Added

- The terminal UI and `alisio serve`, a local web UI with several sessions and workspaces at once, streaming, approvals, themes and English/Spanish; both run the same agent core.
- Agents: define your own in `.agents/agents`, manage them with `/agents` (terminal and web) and switch with `/agent:<id>`; Shift+Tab cycles the main agents (build, plan and your own) in the terminal and the web composer.
- Plan mode with plan review: the agent proposes a plan with `exit_plan` and you approve or revise it before anything changes.
- `/permission` (also `/permissions`) switches between ask, auto and full-access modes, and saved permissions are reviewed and revoked from the same menu.
- Python analysis: the agent writes and runs a script and publishes its outputs as artifacts (dashboards, reports, charts, spreadsheets); `/artifacts` lists them and the web shows them in an artifact panel.
- Tabular datasets: attach CSV, TSV or XLSX files and the agent inspects and queries them; the web has a table viewer.
- Background tasks: long commands keep running while you work; `/tasks` lists, inspects and stops them.
- `/goal <objective>` keeps the agent working on one objective, turn after turn, with a token budget (`budget=50k`), turn and time limits, and breakers for repeated replies; it never runs in plan mode and waits for approvals, questions and background tasks.
- `/reload` reloads the configuration, agents, skills, prompt templates and MCP servers between turns; a broken configuration leaves your session untouched.
- `/changelog [version]` shows what changed in each release, and Alisio mentions the news once after an upgrade.
- A Memory tab in the web UI and plugin-provided data views.
- `/btw` asks a side question about the session without adding it to the conversation.
- Approved access to directories outside the workspace (`--add-dir`, or an approval per directory).

### Improved

- Live run progress in the terminal and the web: what the run is doing, how long it has been quiet and the last activity.
- A request that stays silent until the first-token limit is retried once and then ends with a readable error.
- The output limit of each request comes from the maximum the model declares in its catalog, when the provider reports it.
- Rich renderers for code, diffs, terminal output, JSON, test results, Mermaid diagrams and formulas.

### Fixed

- A model reply that is cut off at the output limit is continued automatically instead of failing the turn.
- Project plugins, skills and MCP servers are merged with your global configuration instead of replacing it.

## [0.1.0-alpha.28] - 2026-10-01

### Added

- A model reply that is cut off at the output limit is continued automatically instead of failing the turn.
- A model request that stays silent until the first-token limit is retried once before it fails.

### Changed

- The output limit of each request now comes from the maximum the model declares, when the provider reports it.

## [0.1.0-alpha.27] - 2026-10-01

### Added

- Live run progress in the terminal and the web: what the run is doing, how long it has been quiet and the last activity.

### Changed

- A silent model request now ends with a readable error, and the timeout defaults were adjusted.

## [0.1.0-alpha.26] - 2026-10-01

### Added

- Python analysis: the agent can write and run a script and publish its outputs as downloadable artifacts (dashboards, reports, charts, spreadsheets).
- `/artifacts` lists and opens a session's artifacts; the web shows them as cards with a side panel.
- `/permissions` reviews and revokes the permissions you saved for a session.
- Tabular data in the web: attach CSV, TSV or XLSX files and the agent inspects and queries them.

## [0.1.0-alpha.25] - 2026-09-30

### Changed

- The Agents window of the web UI can be maximized and keeps its scrollbar inside the corners.

## [0.1.0-alpha.24] - 2026-09-30

### Added

- Manage agents without leaving Alisio: `/agents` creates, edits and deletes agent files from templates, in the terminal and in the web Agents window.
- `/agent:<id>` activates an agent from the slash menu.

## [0.1.0-alpha.23] - 2026-09-30

### Changed

- Refreshed branding across the terminal and the web, with an About page in the web settings.

## [0.1.0-alpha.22] - 2026-09-30

### Added

- `/btw` asks a side question about the session without adding it to the conversation, in the terminal and in the web.
- Archive workspaces in the web sidebar and pick a folder with the native folder dialog.
- A redesigned stop control in the web composer and the official logo and favicon.

## [0.1.0-alpha.21] - 2026-09-30

### Added

- `alisio serve` starts a local web UI with several sessions and workspaces at once, streaming, approvals, themes and English/Spanish.
- Rich renderers for code, diffs, terminal output, JSON, test results, Mermaid diagrams and formulas, plus a files panel and a trajectory tab.
- Image attachments in the web composer.
- Manage plugins, skills, MCP servers, agent presets, providers and models from the web settings.

## [0.1.0-alpha.20] - 2026-09-30

### Added

- Approved access to directories outside the workspace (`--add-dir`, or an approval per directory).
- A configurable inset for the transcript in the terminal (`/settings`).

## [0.1.0-alpha.19] - 2026-09-29

### Changed

- External provider plugins moved to the separate alisio-plugins repository; `@alisio/plugin-openai-compatible` stays built in.

## [0.1.0-alpha.18] - 2026-09-28

### Fixed

- Project plugins, skills and MCP servers are merged with your global configuration instead of replacing it.

## [0.1.0-alpha.17] - 2026-09-28

### Added

- Plugins declare categories, and the plugin picker groups them under headers.

## [0.1.0-alpha.16] - 2026-09-27

### Added

- Rich MCP results, syntax highlighting in Markdown and clearer presentation of tool calls.

## [0.1.0-alpha.15] - 2026-09-27

### Added

- Active agents: `/agents` switches the main agent, and `/effort` sets the reasoning effort.
- The status line below the editor shows the agent, model, provider and effort.

## [0.1.0-alpha.14] - 2026-09-27

### Added

- A DuckDuckGo web search provider that needs no API key.

## [0.1.0-alpha.13] - 2026-09-26

### Added

- A soft turn limit that lets the agent finish gracefully, and richer package READMEs.

### Changed

- The header shows the model, provider and workspace identity.

## [0.1.0-alpha.12] - 2026-09-26

### Fixed

- Output-budget defaults, a cap on the context sent to the model and faster exit.

### Added

- The header shows the Git branch of the workspace.

## [0.1.0-alpha.1] - 2026-09-25

First alpha releases (alpha.1 to alpha.11, 2026-09-25 to 2026-09-26).

### Added

- Terminal UI for any OpenAI-compatible endpoint, with permissioned local tools, context compaction and persistent memory.
- Subagents, `ask_user_question`, web tools, per-directory project trust and pasting text or images into the editor.
- Providers, MCP servers and skills managers, `/settings`, slash completion for skills and an npm plugin installer.
- A context bar that follows the model's real window, with per-profile overrides for local servers.
