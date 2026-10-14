---
"@alisio/sdk": minor
"@alisio/core": minor
---

Reliability lab, phase 1 (specs/010): additive SDK types for evaluation suites, verifiers, run
records and reports (`EvalSuite`, `EvalTask`, `EvalVerifier`, `EvalRunRecord`, `EvalReport`, ...),
and core building blocks: `loadSuite` (validated, path-confined suite loader), the six
deterministic verifiers (`runVerifier`, `snapshotTree`) and pure statistics (`wilsonInterval`,
`passAtK`, `passPowK`, `median`, `sampleVariance`). No behavior of the agent changes.
