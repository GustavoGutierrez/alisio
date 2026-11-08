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
Hardening after the security review: the loopback no longer waits for stray connections to close,
`redactDeep` fails closed past its depth limit and redacts object keys, the JWT rule also catches a
token glued to a word, a pasted redirect URL registers its parameters as secrets, `cancel()` reports
whether it really cancelled, and the renewal single-flight is keyed by profile and registration.
