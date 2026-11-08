---
"@alisio/sdk": minor
---

Added `ProviderAuthFlowView` (the polled state of a sign-in flow: `status`, `steps`, the pending
`prompt`, `error` with the codes `auth_failed`, `loopback_unavailable`, `expired`, `cancelled`,
`unsupported` and `unsafe_url`, the stored `credential` status and the `loopback` hint) and
`ProviderAuthFlowStarted`. Additive; consumers must ignore unknown fields.
