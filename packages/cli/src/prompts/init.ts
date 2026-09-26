/** Built-in `/init` prompt template (embedded so it ships in dist and in the binary). */
export const INIT_TEMPLATE = `---
description: Analyze this repository and create or update the root AGENTS.md
argument-hint: "[focus]"
requires: [write]
---
Analyze this repository and create or update the root \`AGENTS.md\`: concise, project-specific
instructions for coding agents working here.

## 1. Explore efficiently (read-only first)
- \`list_files\` on the root and key directories (use \`limit\`; skip vendored or generated folders).
- \`git_status\` to see the state of the tree.
- \`read_file\` the manifests that exist: package.json, pnpm-workspace.yaml, pyproject.toml,
  setup.cfg, requirements*.txt, go.mod, Cargo.toml, pom.xml, build.gradle*, Gemfile, composer.json,
  Makefile, justfile, Dockerfile. Nested workspace manifests matter in monorepos.
- Identify the package manager from lockfiles (pnpm-lock.yaml, package-lock.json, yarn.lock,
  bun.lock/bun.lockb, poetry.lock, uv.lock, Cargo.lock, go.sum).
- Read build/test/lint/format/typecheck configuration (tsconfig*.json, biome.json, .eslintrc*,
  .prettierrc*, vitest/jest/pytest config, ruff/flake8, rustfmt, golangci) and CI workflows.
  \`list_files\` hides dotfiles, so probe likely paths such as \`.github/workflows/ci.yml\` with
  \`read_file\` (a missing file just returns an error). Use \`search_text\` only on paths that exist.
- Read README and CONTRIBUTING, and existing agent instruction files if present: AGENTS.md
  (root and nested), CLAUDE.md, GEMINI.md, .cursorrules, .cursor/rules/*,
  .github/copilot-instructions.md. Probe them with \`read_file\`; a missing file is not an error.
- Sample a few representative source and test files to learn the layout and conventions. Use
  \`search_text\` instead of reading many files.

## 2. Write AGENTS.md (roughly 150 lines or fewer)
Cover, only where the repository gives evidence:
- Project overview: what it is, main languages and frameworks.
- Commands: exact setup, build, test, single-test, lint, format and typecheck commands as
  defined in manifests or CI (for example \`pnpm test\`, not "run the tests").
- Architecture: module or package layout with the important paths.
- Code style and conventions actually enforced by configuration (formatter, linter rules,
  compiler strictness, import style).
- Testing approach: framework, where tests live, how fixtures work.
- Gotchas and constraints: security rules, generated files, files or directories not to touch,
  required tool versions.

Rules:
- Only facts verified from files you read. No generic advice ("write clean code"), no invented
  commands or paths. If something important is unknown, say so briefly instead of guessing.
- Never include secrets, tokens or environment variable values; do not read .env files.
- Merge useful rules from other agent instruction files and cite the source file, e.g.
  "(from CLAUDE.md)".

## 3. Create or update safely
- If \`AGENTS.md\` does not exist, create it with \`write_file\` (\`expectedHash: null\`).
- If it exists, \`read_file\` it first and update it in place: preserve human-written content and
  intent, merge improvements, and keep edits minimal using \`edit_file\` with the sha256 from
  \`read_file\` as \`expectedHash\`. Never blindly overwrite an existing AGENTS.md.

## 4. Finish
Reply with a short summary of what you wrote or changed and anything you could not verify.

Additional focus from the user (may be empty): $ARGUMENTS
`;
