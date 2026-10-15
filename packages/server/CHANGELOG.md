# @alisio/server

## 0.9.0

### Minor Changes

- 313b33f: Proof, phase 5 (specs/011): the ledger reaches every surface. New routes `GET
  /api/sessions/:sid/proof`, `POST …/proof/criteria`, `POST …/criteria/:id/not-applicable`, `GET
  …/proof/export?format=md|json` and the user-only `POST …/goal/override`; the web UI gets a Proof
  card and tab (and per-criterion decisions in the plan review), the terminal gets `/proof` and
  `/goal override <reason>`, and `alisio run` gets `--proof`, `--criterion`, `--verify`,
  `--proof-file`, the final `proof_ledger` JSONL event and exit codes 0/10/11 (`proof.exitCodes`,
  `proof.ci`). Exports are versioned `proof/v1`. A goal whose completion is refused over the ledger in
  three different runs pauses as `no_progress`. Nothing changes without criteria.

### Patch Changes

- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [4619bae]
- Updated dependencies [4619bae]
- Updated dependencies [4619bae]
  - @alisio/core@0.9.0
  - @alisio/sdk@0.9.0
