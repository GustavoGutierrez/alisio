---
"@alisio/alisio-code": minor
---

`alisio run --json` now redacts known token values and JWTs inside the values of every event line it
prints (the JSON stays valid: redaction walks the values, not the serialized text).
Redaction now also covers the `proof_ledger` line of `--json`.
