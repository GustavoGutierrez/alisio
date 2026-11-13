# About Alisio

**Alisio is a desktop app with artificial intelligence that helps you with tasks from your work,
your studies and your daily life.** Describe what you need: Alisio organizes the steps, uses the
tools available and helps you reach a result you can review and use, such as a PDF, a spreadsheet, a
chart, a report or a dashboard. It is made for people who know their craft (teachers, students,
office staff, accountants and anyone at home) and want a simple way to put AI to work, without
learning engineering first. Programming is still possible, but it is an advanced, secondary use.

At the advanced level, Alisio has its own TypeScript core. It connects to any OpenAI-compatible
model service and drives its own tool loop. It runs in the desktop app, in your terminal (an
interactive TUI, or headless for scripts and CI) or in your browser with `alisio serve`.

## Pillars

1. **Easy to start.** A desktop app, no terminal needed. See [Desktop app](/desktop).
2. **Your files, your decisions.** You choose the folder, and Alisio asks before it changes files or
   runs programs. Working with local files does not mean nothing leaves your computer: what Alisio
   reads is sent to the model you configured. See [Tools & permissions](/tools#permission-flags).
3. **Apps for your work.** Install plugins from the catalog or build your own with the
   [plugin creator](/plugin-creator); connect tools and services from the
   [MCP catalog](/mcp-catalog). See [Writing plugins](/plugins).
4. **Results you can use.** Documents, spreadsheets, charts and dashboards you review and adjust.
   See [Forja](/forja) and [Data analysis](/analysis).
5. **The model you choose.** An online service (OpenAI-compatible, DeepSeek, OpenRouter and others)
   or a compatible model server on your own computer. See [Configuration](/configuration).

## Who it is for

This table lists only what exists today. The external plugins live in the public
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) repository. Install them in
one click from **Settings → Plugins → Plugin catalog** in the app, or with
`alisio install npm:<package>`; they are **not bundled in the desktop app yet** (see
[Desktop app](/desktop#limitations)).

| Who | What Alisio can do today | Backed by |
| --- | --- | --- |
| Students | Draft a thesis, research sources and study | `@alisio/plugin-thesis` (plans, researches, drafts and typesets university theses into PDF with Typst), `@alisio/plugin-literature-research` (scholarly metadata search) and the built-in [persistent memory](/memory) |
| Teachers | Create printable exams. Today the plugin covers school **math** exams only | `@alisio/plugin-evalua` |
| Accountants | Working papers and spreadsheet analysis | Forja Python analysis ([Forja](/forja), [Data analysis](/analysis)) |
| Office and secretaries | Analyze Excel and CSV data, charts, certificates and reports | Forja and analysis, plus `@alisio/plugin-cardsmith` (certificates, cards and charts) |
| Home | Budgets, charts and organizing information | Forja; there is no dedicated plugin |

Profession-specific plugins can also be private. For example, an ICA working paper plugin for
Colombian accountants exists, but it is not publicly available.

## Who made it

Alisio is **developed in Bogotá, Colombia** by **Ing. Gustavo Gutiérrez Mercado**.

- Developer profile: <https://github.com/GustavoGutierrez>
- LinkedIn: <https://www.linkedin.com/in/gustavo-gutierrez-mercado>
- Source repository: <https://github.com/GustavoGutierrez/alisio>

## Packages

All packages are published under the
[alisio npm organization](https://www.npmjs.com/settings/alisio/packages):

- CLI: [`@alisio/alisio-code`](https://www.npmjs.com/package/@alisio/alisio-code) — installs the
  `alisio` command
- Core: [`@alisio/core`](https://www.npmjs.com/package/@alisio/core)
- SDK: [`@alisio/sdk`](https://www.npmjs.com/package/@alisio/sdk)
- Plugins: `@alisio/plugin-memory`, `@alisio/plugin-subagents`,
  `@alisio/plugin-openai-compatible`

Dedicated model providers (`@alisio/plugin-deepseek`, `@alisio/plugin-opencode`,
`@alisio/plugin-opencode-go`) are published from the
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) monorepo and install with
`alisio install npm:@alisio/plugin-...`.

## Documentation

This documentation site (English and Spanish) is published at
<https://alisioair.com/>.

## Project documents

Some project documents are not part of this site; they live in the repository and are linked
here with their absolute GitHub URLs:

- [Product specification](https://github.com/GustavoGutierrez/alisio/blob/main/apps/website/specification.md):
  the product direction; it is not a claim that all of its release criteria are met.
- [Implementation status](https://github.com/GustavoGutierrez/alisio/blob/main/apps/website/implementation-status.md)
  (Spanish): the source of truth for the limitations and the verification scope.
- [Validation log](https://github.com/GustavoGutierrez/alisio/blob/main/apps/website/validation.txt): the
  record of the final validation run.
- [Benchmark data](https://github.com/GustavoGutierrez/alisio/blob/main/apps/website/benchmark.json): raw
  JSON; GitHub shows it as data, not as a rendered page.