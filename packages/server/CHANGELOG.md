# @alisio/server

## 0.12.0

### Minor Changes

- 16eb4a3: Context Governor, phase 4 (specs/012): with `context.governor` set to `shadow` or `on`, every model
  request emits one durable `context_governed` event (counts, token estimates, the call ids newly
  elided and a heuristic summary of which tool results the agent acted on later; never paths, patterns
  or file content). `context_reduced` gains the optional `reason: "budget"` and `tokensSaved`; elision
  is never reported through it. `/stats` shows a Context Governor section, and the web trajectory
  shows a short row for the new event. New additive SDK types: `ContextSegmentKind`,
  `ContextElisionReason`, `ContextUsageCounts` and `ContextGovernedData`. `off` sends and stores
  exactly what it did before, and `shadow` still sends byte-identical requests.
  
  Context Governor, phase 5 (specs/012): one `ContextReport` explains what the next request of a session
  carries and what the governor elides, and every surface renders it. New `/context` command (terminal
  and API catalog), a **Context** tab in the web right panel and `GET /api/sessions/:sid/context/report`
  (the older `GET /api/sessions/:sid/context`, the context-bar estimate, is unchanged). The report holds
  ids, counts, token estimates and metadata, never message, file or invariant text (invariants appear only as counts); with the governor `off` it is
  empty. New additive SDK types: `ContextCriticality`, `ContextSegment` and `ContextReport`.
- d930a4c: Plugin catalog, install, update and uninstall from the web. `GET /api/plugin-catalog` (remote catalog
  validated and cached 24 hours under the state directory, conditional requests, offline copy),
  `GET /api/plugin-catalog/covers/:slug` (covers through the server), `GET /api/plugins/packages`,
  `POST /api/plugins/install` (catalog packages only, `confirmed: true`), `DELETE /api/plugins/package/:name`,
  `POST /api/plugins/local/inspect` and `POST /api/plugins/local/install` (private `.tgz` with a background
  job and phases), `GET /api/plugins/jobs/:jobId`, and `GET|POST /api/server/restart` (only when a
  supervisor such as the desktop app sets `ALISIO_SUPERVISED=1`; exit code 75). Installing a package that
  is already installed updates it in place. All of it is refused under `--read-only`, serialized, and
  needs the usual Origin check. New `ALISIO_PLUGIN_CATALOG_URL` override. The SDK is unchanged.
- 313b33f: Proof, phase 5 (specs/011): the ledger reaches every surface. New routes `GET
  /api/sessions/:sid/proof`, `POST …/proof/criteria`, `POST …/criteria/:id/not-applicable`, `GET
  …/proof/export?format=md|json` and the user-only `POST …/goal/override`; the web UI gets a Proof
  card and tab (and per-criterion decisions in the plan review), the terminal gets `/proof` and
  `/goal override <reason>`, and `alisio run` gets `--proof`, `--criterion`, `--verify`,
  `--proof-file`, the final `proof_ledger` JSONL event and exit codes 0/10/11 (`proof.exitCodes`,
  `proof.ci`). Exports are versioned `proof/v1`. A goal whose completion is refused over the ledger in
  three different runs pauses as `no_progress`. Nothing changes without criteria.
- 527b3be: Provider sign-in flows over HTTP. `POST /api/providers/:profile/auth/:method/start` (202 with a
  `flowId`), `GET .../auth/flows/:flowId?after=n` (steps, the one pending prompt and the outcome, never a
  token, authorization code or prompt answer), `POST .../input` and `DELETE .../flows/:flowId`, behind the
  existing Host, Origin, cookie and JSON checks; the three that change state are refused under
  `--read-only`. `GET /api/providers` adds `types[].auth` (no functions) and a synthetic `oauth`
  credential with `state` and `expires` and no tail. `DELETE .../credentials` also cancels the active
  flow and removes the session, and a `PUT` that changes a profile's provider type cancels its flow. New
  `localBrowser` server option (declarative: the browser runs on this machine, set by the desktop app).
  SSE frames, `ApiError` messages and log lines are now redacted for known token values and JWTs.

### Patch Changes

- 376b1ce: Identity and documentation only, no behavior change. Alisio is now described as a desktop AI harness
  for the everyday work of non-technical people, with programming as an advanced use. The npm package
  description and the `alisio --help` summary are rewritten in English, and the About text of the Web
  UI (English and Spanish) follows the new positioning.
- Updated dependencies [7497a22]
- Updated dependencies [0e21138]
- Updated dependencies [16eb4a3]
- Updated dependencies [f1f4d55]
- Updated dependencies [313b33f]
- Updated dependencies [1fe27bb]
- Updated dependencies [d930a4c]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [28a7c57]
- Updated dependencies [527b3be]
- Updated dependencies [527b3be]
- Updated dependencies [28a7c57]
- Updated dependencies [4619bae]
- Updated dependencies [4619bae]
- Updated dependencies [4619bae]
  - @alisio/core@0.12.0
  - @alisio/sdk@0.12.0
