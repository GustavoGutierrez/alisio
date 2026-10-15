---
"@alisio/core": minor
---

Proof, phase 2 (specs/011): `ProofRecorder` captures evidence for `command` criteria from the raw
result of `run_process`, `shell` and `bg_run`/`bg_output` calls (command fingerprint v1, exit code
and optional output pattern, redacted excerpt of at most 4 KB) and the runner announces it with
`proof_updated`. Evidence needs a call present in the session journal. Sessions without criteria
behave exactly as before.
