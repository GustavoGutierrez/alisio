---
"@alisio/sdk": minor
"@alisio/core": minor
"@alisio/server": minor
"@alisio/alisio-code": minor
---

Context Governor, phase 4 (specs/012): with `context.governor` set to `shadow` or `on`, every model
request emits one durable `context_governed` event (counts, token estimates, the call ids newly
elided and a heuristic summary of which tool results the agent acted on later; never paths, patterns
or file content). `context_reduced` gains the optional `reason: "budget"` and `tokensSaved`; elision
is never reported through it. `/stats` shows a Context Governor section, and the web trajectory
shows a short row for the new event. New additive SDK types: `ContextSegmentKind`,
`ContextElisionReason`, `ContextUsageCounts` and `ContextGovernedData`. `off` sends and stores
exactly what it did before, and `shadow` still sends byte-identical requests.
