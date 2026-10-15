---
"@alisio/core": minor
"@alisio/alisio-code": minor
---

Proof, phase 7 (specs/011): the opt-in `coverage` verifier. With `proof.coverage.enabled: true` the
configured coverage command (run under the normal permission gate) is judged from its output:
`lcov`, a vitest/istanbul table or summary, and `coverage.py` reports are parsed for the overall
percentage and compared with `minPercent`; a low percentage, a failing command or unparseable
output is `failed` with evidence. Disabled by default: a `coverage` criterion stays `not_checked`
and Proof never records its command. Criteria are accepted by `--proof-file`, the HTTP `verifier`
field and plan drafts. Without criteria nothing changes.
