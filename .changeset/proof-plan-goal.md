---
"@alisio/sdk": minor
"@alisio/core": minor
---

Proof, phase 4 (specs/011): `exit_plan` accepts optional `acceptanceCriteria` as drafts that become
real criteria only when the user approves the plan, and `update_goal complete` is refused while a
required criterion is failed or not checked unless the user overrides it
(`GoalService.overrideComplete`, reason `user_override`). `GoalEvidence.evidenceId` links a
declaration to captured evidence; without a valid id it stays free text. Completed goals keep a
Proof snapshot in the new `session_goals.proof_json` column (schema v13). Goals and plans without
criteria behave exactly as before.
