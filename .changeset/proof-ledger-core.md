---
"@alisio/sdk": minor
"@alisio/core": minor
---

Proof, phase 1 (specs/011): additive SDK types (`ProofStatus`, `ProofVerifierSpec`,
`ProofCriterion`, `ProofEvidence`, `ProofLedger`, the `proof_updated` and `proof_divergence`
events and `GoalEvidence.evidenceId`), a pure status derivation (`deriveStatus`, `buildLedger`),
`ProofStore` and the additive schema v11 (`proof_criteria`, append-only `proof_evidence`).
Nothing captures evidence yet and no agent behavior changes.
