---
"@alisio/sdk": patch
"@alisio/core": patch
"@alisio/web": patch
---

Plugin creator: requests for a screen in the Apps menu build a plugin app (`api.apps.register`). The
plan declares `needsApp`, and the delivery gate checks every app's page and calls each app action
once (new codes `app_missing`, `app_html_failed`, `app_html_too_large`, `app_script_nonce_missing`,
`app_external_resource`, `app_inline_handler`, `app_action_failed`, `app_action_untested`,
`app_dispose_failed`). The web Apps menu refreshes as soon as plugins change.
