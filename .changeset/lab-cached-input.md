---
"@alisio/sdk": minor
"@alisio/core": minor
"@alisio/alisio-code": minor
---

Reliability Lab: runs now record the provider's cached input tokens. `EvalRunRecord.measured` gains
the optional `cachedInputTokens` (and `cachedPartial` when only some turns reported it);
`EvalReport.summary.cachedInput` and the per-task `cachedInputRatio` / `cachedInputRuns` aggregate
them, `eval compare` shows the `cachedInputRatio` delta, and the report Markdown prints a "Cached
input" line. The fields are additive and absent when the provider does not report cached tokens
(never `0`); `schemaVersion` stays 1 and existing reports and cassettes read and replay unchanged.
