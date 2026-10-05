# About Alisio

**Alisio is a coding-agent harness with its own TypeScript core.** It connects to any
OpenAI-compatible endpoint, drives its own tool loop and runs in your terminal (an interactive TUI,
or headless for scripts and CI) or in your browser with `alisio serve`.

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