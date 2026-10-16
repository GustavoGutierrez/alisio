---
"@alisio/core": minor
---

Context Governor, phase 2 (specs/012): deterministic elision by substitution, experimental and off
by default. New `context.governor` (`off`, `shadow`, `on`), `context.elide.minAgeTurns`,
`context.elide.epochMessages` and the optional `context.policyVersion` pin. In `on` mode, tool
results that a later result made redundant (superseded reads, repeated identical `bg_output` polls
and duplicate searches) are replaced by a one-line stub in the request; `shadow` only measures and
sends exactly the same bytes as `off`. The stored transcript, compaction and limits always use the
full history, and the `configHash` of the eval harness does not change while the governor is off.
