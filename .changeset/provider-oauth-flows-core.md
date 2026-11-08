---
"@alisio/core": minor
---

Provider sign-in flow runner and loopback helper. `runAuthFlow` and `AuthFlowRegistry` run a plugin's
sign-in method as a state machine (`running`, `awaiting_input`, `succeeded`, `failed`, `cancelled`,
`expired`) with a 15 minute limit, one flow per profile and four per process; step URLs must be
`https:` or local `http:`, the credential is written only while the flow is still live (checked under
`credentials.json.lock`), prompt answers and redirect parameters become exact redaction values, and
removing a provider registration (`ProviderRegistry.onRemoved`) cancels its pending flows.
`openLoopback` listens on `127.0.0.1` only, checks `state` in constant time with no failure cap, serves
one request and closes. New `redactDeep` redacts every string inside a JSON-shaped value.
