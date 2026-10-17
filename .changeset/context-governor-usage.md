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

Context Governor, phase 5 (specs/012): one `ContextReport` explains what the next request of a session
carries and what the governor elides, and every surface renders it. New `/context` command (terminal
and API catalog), a **Context** tab in the web right panel and `GET /api/sessions/:sid/context/report`
(the older `GET /api/sessions/:sid/context`, the context-bar estimate, is unchanged). The report holds
ids, counts, token estimates and metadata, never message, file or invariant text (invariants appear only as counts); with the governor `off` it is
empty. New additive SDK types: `ContextCriticality`, `ContextSegment` and `ContextReport`.
