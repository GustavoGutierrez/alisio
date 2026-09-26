## Summary

<!-- What does this change do, and why? Keep it outcome-focused. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (run locally; rg-dependent tests skip when ripgrep is absent)
- [ ] `pnpm build` passes
- [ ] `pnpm test:cli` and `pnpm test:compiled` pass
- [ ] `pnpm pack:check` passes
- [ ] `pnpm docs:build` passes
- [ ] English and Spanish documentation are in parity where the change is user-visible
- [ ] Commit messages are Conventional Commits and describe the outcome, not the file list
- [ ] Only `pnpm-lock.yaml` is kept for dependencies (no npm/yarn lockfiles)
- [ ] No real API keys, credentials, session databases, or memory databases are committed:
      tests, fixtures, docs, and examples use placeholders (e.g. `sk-test-…`)
- [ ] A changeset was added when a published package changed (`pnpm changeset`)

## Tests

<!-- Focused test command and exact result:

```sh
pnpm vitest run tests/<area>.test.ts
# N passed
```
-->

## Notes for reviewers

- What to review first:
- Intentionally out of scope: