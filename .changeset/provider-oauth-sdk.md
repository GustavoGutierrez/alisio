---
"@alisio/sdk": minor
---

Provider sign-in contract (additive, all optional). `ProviderRegistration.auth` declares sign-in
methods (`ProviderAuthMethod` with `start` and an optional `refresh`; a rejection with
`retryable: true` is transient). The provider's `create()` receives `request.oauth` with `get(signal?)`
and `invalidate(reason?: "sign_in_required")` when the registration declares `auth`. New types
`ProviderAuthContext`, `ProviderAuthStep` (including `device_code` with `verificationUriComplete` and
`intervalSeconds`), `ProviderAuthPrompt`, `ProviderAuthLoopback*`, `ProviderOAuthCredential`,
`ProviderOAuthHandle`, `ProviderAuthMethodInfo`, `ProviderTypeInfo.auth` and the `kind`, `expires` and
`state` fields of `CredentialStatus`. Method ids must match `^[a-z0-9_-]{1,40}$` and be unique per
registration. Consumers must ignore unknown fields.
