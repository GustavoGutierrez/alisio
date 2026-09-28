---
"@alisio/sdk": minor
"@alisio/core": minor
---

Allow plugins to declare the `methodology-harness` catalog category. `PluginCategory` now accepts
`"model-provider" | "methodology-harness"`, plugin validation accepts both values and still rejects
unknown ones, and the host keeps deriving `model-provider` from provider registrations.
