---
"@alisio/core": minor
---

Proof, phase 3 (specs/011): evidence expires when `write_file`/`edit_file` succeeds on a path
inside the criterion scope (no scope means the whole workspace); the newest edit per path is kept
in the new `proof_edits` table (schema v12) and statuses are still derived on every read. Evidence
now carries a `treeFingerprint` (bounded `git diff` plus sha256 of the touched files) and its
`filesTouched`. `detectDivergence` finds closed EN/ES claims such as "tests pass" or "los tests
pasan" in the final answer and the runner announces the unbacked ones with `proof_divergence`
(display only). Sessions without criteria behave exactly as before.
