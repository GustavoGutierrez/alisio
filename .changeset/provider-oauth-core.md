---
"@alisio/core": minor
---

Provider sign-in core. `credentials.json` gains an `oauth` section (bound to the provider that created
it, with a `generation` counter) and every write now takes `credentials.json.lock` (owner token,
rename-based takeover of locks older than 30 s). New `OAuthManager`: `get()` renews at expiry minus 5
minutes with one renewal per profile and a re-read across processes, persists the rotated refresh
token before returning it, marks `needs_sign_in` on a permanent failure without falling back to an
environment variable, and honors `invalidate()`. `ProviderRegistry.create(id, request, profile?)`
builds `request.oauth` at its single create point and `register` validates method ids. New
`redactCredentials` (JWT rule plus exact live and rotated values), applied to run-failure events and
their SQLite journal. A credentials file with `oauth` and no `providers` no longer breaks reads, and
changing a profile's provider type drops its sign-in session.
