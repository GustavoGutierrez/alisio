---
"@alisio/sdk": minor
"@alisio/core": minor
"@alisio/alisio-code": minor
---

Proof, phase 6 (specs/011): the `file` verifier (existence, sha256, regex over a `read_file`
result) and the `data-check` verifier (`row_count`, `sum`, `equals` over the canonical `data_query`
of a dataset) capture evidence from the raw tool result; a differing total is `failed` with
evidence. `PluginAPI.proof?.registerVerifier` (additive, optional) lets plugins contribute
verifiers; a result without referenceable evidence degrades to `manual_review` and verifiers gain
no permissions. `runToolCall` also returns the `callId`, `app.verifyCriterion` runs a verifier on
demand and the `--proof` brief names the exact read or query. Without criteria nothing changes.
