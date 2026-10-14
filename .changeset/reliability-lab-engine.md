---
"@alisio/sdk": minor
"@alisio/core": minor
---

Reliability lab, phase 2 (specs/010): the live engine `runTask` runs one task repetition through the
real application on an isolated copy of its fixture (scoped config/state/tmp homes, per-task policy
that can only equal or restrict the invoker's, hard budgets, tool events and incidents read from run
events, `configHash` over an allowlist) and returns an `EvalRunRecord`. Additive SDK fields:
`EvalRunRecord.budgetExceeded`, `EvalRunRecord.error` and `EvalTask.fixtureGit`. The `command`
verifier now sets HOME/TMPDIR to the run tmp dir and kills its whole process group on timeout, and the
suite loader restricts `policy.allow` to write/process/external/analysis and caps verifier timeouts at
600000 ms. No default behavior of the agent changes.
