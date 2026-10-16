---
"@alisio/core": minor
---

Context Governor, phase 3 (specs/012): invariants that survive compaction, experimental and only
active with `context.governor: "on"`. The summarizer is asked for verbatim quotes of your
instructions; Alisio keeps only quotes that are exact substrings of your own messages (kept in
`sessions.options.contextInvariants`, at most 20 of 500 characters) and, after the first
compaction, sends them with the live goal, approved plan, Proof criteria and session grants as one
`<invariants>` block at the end of every request. The block is never saved or summarized. New
`context.invariants.maxChars` (default 4000, 1000 to 20000). `off` and `shadow` send and store
exactly what they did before; `shadow` only counts.
