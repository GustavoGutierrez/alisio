# @alisio/core

## 0.12.0

### Minor Changes

- 7497a22: Context Governor, phase 2 (specs/012): deterministic elision by substitution, experimental and off
  by default. New `context.governor` (`off`, `shadow`, `on`), `context.elide.minAgeTurns`,
  `context.elide.epochMessages` and the optional `context.policyVersion` pin. In `on` mode, tool
  results that a later result made redundant (superseded reads, repeated identical `bg_output` polls
  and duplicate searches) are replaced by a one-line stub in the request; `shadow` only measures and
  sends exactly the same bytes as `off`. The stored transcript, compaction and limits always use the
  full history, and the `configHash` of the eval harness does not change while the governor is off.
- 0e21138: Context Governor, phase 3 (specs/012): invariants that survive compaction, experimental and only
  active with `context.governor: "on"`. The summarizer is asked for verbatim quotes of your
  instructions; Alisio keeps only quotes that are exact substrings of your own messages (kept in
  `sessions.options.contextInvariants`, at most 20 of 500 characters) and, after the first
  compaction, sends them with the live goal, approved plan, Proof criteria and session grants as one
  `<invariants>` block at the end of every request. The block is never saved or summarized. New
  `context.invariants.maxChars` (default 4000, 1000 to 20000). `off` and `shadow` send and store
  exactly what they did before; `shadow` only counts.
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
- 1fe27bb: Reliability Lab: runs now record the provider's cached input tokens. `EvalRunRecord.measured` gains
  the optional `cachedInputTokens` (and `cachedPartial` when only some turns reported it);
  `EvalReport.summary.cachedInput` and the per-task `cachedInputRatio` / `cachedInputRuns` aggregate
  them, `eval compare` shows the `cachedInputRatio` delta, and the report Markdown prints a "Cached
  input" line. The fields are additive and absent when the provider does not report cached tokens
  (never `0`); `schemaVersion` stays 1 and existing reports and cassettes read and replay unchanged.
- d930a4c: Plugin install and uninstall building blocks for the web and desktop apps. New `uninstallPlugin`
  (`npm uninstall --prefix`, atomic removal of the `plugins` entry, idempotent), `installLocalPluginTarball`
  (copies a private `.tgz` into `<config home>/plugins/local-packages/` and installs from that stable copy,
  with full rollback) and `inspectPluginTarball` (gzip and ustar reader in JS, no `tar` binary: only
  `package/package.json` is read, with size, entry and path-traversal limits). `installPlugin` gains
  `force` (reinstall or downgrade at a given version). npm is resolved through `runNpm`: with
  `ALISIO_NPM_CLI` set it runs that `npm-cli.js` through the current executable (Electron as Node), and a
  missing npm now says "npm was not found: install Node.js, or use the desktop app, which bundles it".
  Also `comparePluginVersions`, `satisfiesRange` and `catalogPluginState` (no dependency) and
  `pluginCodeImportedFrom`, which tells whether a plugin's code is already loaded in this process.
- 313b33f: Proof, phase 7 (specs/011): the opt-in `coverage` verifier. With `proof.coverage.enabled: true` the
  configured coverage command (run under the normal permission gate) is judged from its output:
  `lcov`, a vitest/istanbul table or summary, and `coverage.py` reports are parsed for the overall
  percentage and compared with `minPercent`; a low percentage, a failing command or unparseable
  output is `failed` with evidence. Disabled by default: a `coverage` criterion stays `not_checked`
  and Proof never records its command. Criteria are accepted by `--proof-file`, the HTTP `verifier`
  field and plan drafts. Without criteria nothing changes.
- 313b33f: Proof, phase 1 (specs/011): additive SDK types (`ProofStatus`, `ProofVerifierSpec`,
  `ProofCriterion`, `ProofEvidence`, `ProofLedger`, the `proof_updated` and `proof_divergence`
  events and `GoalEvidence.evidenceId`), a pure status derivation (`deriveStatus`, `buildLedger`),
  `ProofStore` and the additive schema v11 (`proof_criteria`, append-only `proof_evidence`).
  Nothing captures evidence yet and no agent behavior changes.
- 313b33f: Proof, phase 4 (specs/011): `exit_plan` accepts optional `acceptanceCriteria` as drafts that become
  real criteria only when the user approves the plan, and `update_goal complete` is refused while a
  required criterion is failed or not checked unless the user overrides it
  (`GoalService.overrideComplete`, reason `user_override`). `GoalEvidence.evidenceId` links a
  declaration to captured evidence; without a valid id it stays free text. Completed goals keep a
  Proof snapshot in the new `session_goals.proof_json` column (schema v13). Goals and plans without
  criteria behave exactly as before.
- 313b33f: Proof, phase 2 (specs/011): `ProofRecorder` captures evidence for `command` criteria from the raw
  result of `run_process`, `shell` and `bg_run`/`bg_output` calls (command fingerprint v1, exit code
  and optional output pattern, redacted excerpt of at most 4 KB) and the runner announces it with
  `proof_updated`. Evidence needs a call present in the session journal. Sessions without criteria
  behave exactly as before.
- 313b33f: Proof, phase 3 (specs/011): evidence expires when `write_file`/`edit_file` succeeds on a path
  inside the criterion scope (no scope means the whole workspace); the newest edit per path is kept
  in the new `proof_edits` table (schema v12) and statuses are still derived on every read. Evidence
  now carries a `treeFingerprint` (bounded `git diff` plus sha256 of the touched files) and its
  `filesTouched`. `detectDivergence` finds closed EN/ES claims such as "tests pass" or "los tests
  pasan" in the final answer and the runner announces the unbacked ones with `proof_divergence`
  (display only). Sessions without criteria behave exactly as before.
- 313b33f: Proof, phase 5 (specs/011): the ledger reaches every surface. New routes `GET
  /api/sessions/:sid/proof`, `POST …/proof/criteria`, `POST …/criteria/:id/not-applicable`, `GET
  …/proof/export?format=md|json` and the user-only `POST …/goal/override`; the web UI gets a Proof
  card and tab (and per-criterion decisions in the plan review), the terminal gets `/proof` and
  `/goal override <reason>`, and `alisio run` gets `--proof`, `--criterion`, `--verify`,
  `--proof-file`, the final `proof_ledger` JSONL event and exit codes 0/10/11 (`proof.exitCodes`,
  `proof.ci`). Exports are versioned `proof/v1`. A goal whose completion is refused over the ledger in
  three different runs pauses as `no_progress`. Nothing changes without criteria.
- 313b33f: Proof, phase 6 (specs/011): the `file` verifier (existence, sha256, regex over a `read_file`
  result) and the `data-check` verifier (`row_count`, `sum`, `equals` over the canonical `data_query`
  of a dataset) capture evidence from the raw tool result; a differing total is `failed` with
  evidence. `PluginAPI.proof?.registerVerifier` (additive, optional) lets plugins contribute
  verifiers; a result without referenceable evidence degrades to `manual_review` and verifiers gain
  no permissions. `runToolCall` also returns the `callId`, `app.verifyCriterion` runs a verifier on
  demand and the `--proof` brief names the exact read or query. Without criteria nothing changes.
- 28a7c57: Provider sign-in core. `credentials.json` gains an `oauth` section (bound to the provider that created
  it, with a `generation` counter) and every write now takes `credentials.json.lock` (owner token,
  rename-based takeover of locks older than 30 s). New `OAuthManager`: `get()` renews at expiry minus 5
  minutes with one renewal per profile and a re-read across processes, persists the rotated refresh
  token before returning it, marks `needs_sign_in` on a permanent failure without falling back to an
  environment variable, and honors `invalidate()`. `ProviderRegistry.create(id, request, profile?)`
  builds `request.oauth` at its single create point and `register` validates method ids. New
  `redactCredentials` (JWT rule plus exact live and rotated values), applied to run-failure events and
  their SQLite journal. A credentials file with `oauth` and no `providers` no longer breaks reads, and
  changing a profile's provider type drops its sign-in session.
- 527b3be: Provider sign-in flow runner and loopback helper. `runAuthFlow` and `AuthFlowRegistry` run a plugin's
  sign-in method as a state machine (`running`, `awaiting_input`, `succeeded`, `failed`, `cancelled`,
  `expired`) with a 15 minute limit, one flow per profile and four per process; step URLs must be
  `https:` or local `http:`, the credential is written only while the flow is still live (checked under
  `credentials.json.lock`), prompt answers and redirect parameters become exact redaction values, and
  removing a provider registration (`ProviderRegistry.onRemoved`) cancels its pending flows.
  `openLoopback` listens on `127.0.0.1` only, checks `state` in constant time with no failure cap, serves
  one request and closes. New `redactDeep` redacts every string inside a JSON-shaped value.
  Hardening after the security review: the loopback no longer waits for stray connections to close,
  `redactDeep` fails closed past its depth limit and redacts object keys, the JWT rule also catches a
  token glued to a word, a pasted redirect URL registers its parameters as secrets, `cancel()` reports
  whether it really cancelled, and the renewal single-flight is keyed by profile and registration.
- 4619bae: Reliability lab, phase 1 (specs/010): additive SDK types for evaluation suites, verifiers, run
  records and reports (`EvalSuite`, `EvalTask`, `EvalVerifier`, `EvalRunRecord`, `EvalReport`, ...),
  and core building blocks: `loadSuite` (validated, path-confined suite loader), the six
  deterministic verifiers (`runVerifier`, `snapshotTree`) and pure statistics (`wilsonInterval`,
  `passAtK`, `passPowK`, `median`, `sampleVariance`). No behavior of the agent changes.
- 4619bae: Reliability lab, phase 2 (specs/010): the live engine `runTask` runs one task repetition through the
  real application on an isolated copy of its fixture (scoped config/state/tmp homes, per-task policy
  that can only equal or restrict the invoker's, hard budgets, tool events and incidents read from run
  events, `configHash` over an allowlist) and returns an `EvalRunRecord`. Additive SDK fields:
  `EvalRunRecord.budgetExceeded`, `EvalRunRecord.error` and `EvalTask.fixtureGit`. The `command`
  verifier now sets HOME/TMPDIR to the run tmp dir and kills its whole process group on timeout, and the
  suite loader restricts `policy.allow` to write/process/external/analysis and caps verifier timeouts at
  600000 ms. No default behavior of the agent changes.
- 4619bae: Reliability lab, phase 3 (specs/010): per-task reliability metrics over k repetitions (Wilson
  interval, pass@k, pass^k, spreads, per-success figures) in a report whose `measured` and `estimated`
  blocks never mix (`buildReport`, `renderReportMarkdown`), report and config-variant comparison with
  "inconclusive" and "low power" verdicts (`compareReports`, `compareVariants`, `applyConfigOverrides`),
  a seeded suite runner (`runEvaluation`), and the new `alisio eval list|run|compare|variants` command
  (live mode only; reports in `<state>/eval/<runId>/`; exit 3 for incompatible suites). Additive SDK
  changes: `EvalRates`, `EvalReport.rates`, optional `errored`/`configHash` on `EvalTaskMetrics`,
  optional `runs`/`failed` in `EvalReport.summary`, and `medianWallMs`/`varianceWallMs` become optional
  (omitted when they cannot be computed). The isolated eval config layer no longer carries user skill
  roots. No default behavior of the agent changes.
  
  Review fixes: a failure the model causes (output truncation, more than 64 tool calls in a turn,
  duplicate tool call IDs, a hung `command` verifier) is now a `fail` with a `run_aborted` incident,
  not an excluded `error`; comparisons claim no improvement or regression with errored runs, different
  modes or (token and cost deltas) different compaction settings, replay reports compare as
  `changed`/`unchanged`, variants run interleaved, and every comparison carries a limits footnote.
  Additive SDK fields: `EvalRunRecord.compactionHash`, `EvalRunRecord.measured.usagePartial`,
  `EvalReport.conditions.compactionHash`, `EvalReport.variant` and `EvalReport.notes`.
  
  Reliability lab, phase 4 (specs/010): cassettes and replay. `alisio eval record <suite>` runs each
  task once live and writes `<suite>/cassettes/<taskId>.cassette.jsonl` (`cassette/v1`: header with
  suite, task, harness version, configuration hash and model catalog; one line per provider call with
  the request fingerprint, the events and any provider error; tool-call ids and provider continuation
  data stored verbatim). `alisio eval run --mode replay` serves those cassettes with no provider, no
  credentials and no network, and exits 2 with a structured diff (`tools[name].description`,
  `messages[i].tool.result`, `instructions`...) when the harness asks for something different.
  Replay measures the harness, not the model. The writer refuses a cassette that holds a secret
  (well-known key shapes plus the exact credentials of the provider profile and environment) or that
  exceeds 256 KB (2 MB per directory). Core additions: `CassetteRecorder`, `RecordingProvider`,
  `ReplayProvider`, `ReplayDivergenceError`, `ReplayExhausted`, `ReplayUnconsumedError`,
  `readCassette`/`writeCassette`, `computeFingerprint`, `canonicalJson`/`hashCanonical` (moved into
  `eval/canonical.ts`) and `runTask` options `mode`, `cassette` and `onEvent`. The fingerprint covers
  instructions, messages, tools (name, description, schema), `maxOutputTokens`, `model`,
  `nativeTools` and `reasoningEffort`, after normalizing per-run paths and ids. Additive SDK changes:
  `EvalTask.replayNormalize`, `EvalRunRecord.divergence`, `EvalReplayDivergence` and
  `EvalDivergenceEntry`. Additive runtime change with no effect unless installed: `setIdSource`,
  `newUuid` and `seededIdSource` in `runtime/ids.ts`; sessions, plan ids, forge execution ids and
  `ulid`-based ids consult the installed source (the lab installs a seeded one while recording and
  replaying). No default behavior of the agent changes.
  
  Reliability lab, phase 5 (specs/010): bundled suites for a source checkout (`smoke-coding`,
  `tool-sequences`, `long-context` under `tests/fixtures/eval`, not shipped in the npm package or the
  binary) with cassettes recorded from a scripted provider that pin harness behavior, not model
  quality (`pnpm eval:record-bundled` re-records them). `alisio eval list` lists them in a checkout and
  its "no suites" messages now say where the bundled suites live. No default behavior of the agent
  changes.
  
  Reliability lab, phase 6 (specs/010): user guide `docs/eval.md` (EN) and `docs/es/eval.md` (ES),
  README entry and consolidated limitations in `docs/implementation-status.md`. Documentation only; no
  behavior changes.
  
  Reliability lab, export (specs/010 5.4, D9): `alisio eval export <runId> --out FILE [--force]` writes
  one local JSON bundle `{ schemaVersion: 1, report, runs[], markdown }` of a stored run, with absolute
  paths replaced by placeholders, provider ids that may embed an endpoint host reduced to
  `custom-endpoint`, and the cassette secret scanner run over the whole bundle (a hit refuses the export
  with exit 1 and names the field, never the value). Nothing is uploaded; scrubbing is pattern-based, not
  a guarantee. Core additions: `buildExportBundle`, `EvalExportRefusedError`. No default behavior of the
  agent changes.
  
  Reliability lab, CI gate (specs/010 O7): the optional `scripts/eval-ci.ts` (`pnpm eval:ci`, source
  checkout only, not published) replays the bundled cassettes and exits non-zero on a divergence (2), a
  non-passing task or an empty set (1). It is opt-in and not part of the default CI; documented in
  `docs/eval.md` and `docs/es/eval.md`. No package code or default behavior changes.

### Patch Changes

- f1f4d55: Support for the new Electron desktop app (`apps/desktop`, private, not published). The CLI exposes
  `cliDefaults()` (built-in plugins, prompt templates and reserved command names) through the new
  `@alisio/alisio-code/defaults` subpath, without the commander side effects of the package entry.
  Core worker processes (data engine, Forja isolate, Pyodide) now start with `ELECTRON_RUN_AS_NODE=1`
  when the host runs on the Electron binary; nothing changes under plain Node or Bun.
- 313b33f: The Reliability Lab no longer depends on the host: `createApplication` accepts a `home` option
  (default `os.homedir()`) and the eval engine points it at the run's scratch home, so skills and
  agents installed in the developer's real home never reach the prompt, the tool descriptions or the
  cassette fingerprints. The bundled cassettes were re-recorded hermetically.
- Updated dependencies [16eb4a3]
- Updated dependencies [1fe27bb]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [313b33f]
- Updated dependencies [527b3be]
- Updated dependencies [28a7c57]
- Updated dependencies [4619bae]
- Updated dependencies [4619bae]
- Updated dependencies [4619bae]
  - @alisio/sdk@0.12.0
