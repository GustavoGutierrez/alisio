# About Alisio

**Alisio is a desktop AI harness for the everyday work of non-technical people:** teachers,
students, secretaries and office staff, accountants and the home. It installs with one click, works
on your own files and always asks permission. It specializes through plugins per profession and
delivers ready-to-use results: PDFs, spreadsheets, charts, reports and dashboards. Programming is
still possible, but it is an advanced, secondary use.

Under the hood it is a harness with its own TypeScript core. It connects to any OpenAI-compatible
endpoint and drives its own tool loop. It runs in the desktop app, in your terminal (an interactive
TUI, or headless for scripts and CI) or in your browser with `alisio serve`.

## Pillars

1. **Easy.** A desktop app, no terminal needed. See [Desktop app](/desktop).
2. **Your files, your control.** Local-first, with explicit permissions: reads by default, and
   writes ask first. See [Tools & permissions](/tools#permission-flags).
3. **Plugins per profession.** Thesis, exams, accounting, certificates, research. See
   [Writing plugins](/plugins).
4. **Deliverable results.** Documents, spreadsheets, charts and dashboards. See [Forja](/forja) and
   [Data analysis](/analysis).
5. **Any model.** OpenAI-compatible endpoints, DeepSeek, OpenRouter and others. See
   [Configuration](/configuration).

## Who it is for

This table lists only what exists today. The external plugins live in the public
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) repository and install with
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
<https://gustavogutierrez.github.io/alisio/>.

## Project documents

Some project documents are not part of this site; they live in the repository and are linked
here with their absolute GitHub URLs:

- [Product specification](https://github.com/GustavoGutierrez/alisio/blob/main/docs/specification.md):
  the product direction; it is not a claim that all of its release criteria are met.
- [Implementation status](https://github.com/GustavoGutierrez/alisio/blob/main/docs/implementation-status.md)
  (Spanish): the source of truth for the limitations and the verification scope.
- [Validation log](https://github.com/GustavoGutierrez/alisio/blob/main/docs/validation.txt): the
  record of the final validation run.
- [Benchmark data](https://github.com/GustavoGutierrez/alisio/blob/main/docs/benchmark.json): raw
  JSON; GitHub shows it as data, not as a rendered page.