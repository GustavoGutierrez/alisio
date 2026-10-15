---
name: alisio-pkg-core
description: "Working in packages/core (@alisio/core): runner/tool loop, tools and permissions, sessions and the SQLite store with migrations, plugin host, providers, config, Forja (JS/Python execution), analysis, goal/plan/background. Entry points, conventions, gotchas and how to test. Use this skill whenever you edit, review or debug anything under packages/core, add a tool, config key, migration or slash command."
---

# `@alisio/core`

Public API = `packages/core/src/index.ts` (re-exports all of `@alisio/sdk`). Second export
`./forge-isolate` (`src/forge-isolate.ts`) is the process-isolate entry of the compiled binary.
Map and boundaries: `alisio-architecture`. Rules: `alisio-coding-standards`.

## Where things are (`packages/core/src/`)

| Area | Entry points |
|---|---|
| App wiring | `application.ts` (`createApplication`, `BuiltinPlugin`), `config.ts` (zod schema, layered config), `trust.ts` (per-directory project trust) |
| Loop | `core/runner.ts` (`AgentRunner`), `core/contracts.ts` (`SessionStore` etc.), `core/registry.ts` (`ToolRegistry`), `core/compaction.ts`, `core/timeout.ts`, `core/truncation.ts`, `core/human-wait.ts` (pausable clock) |
| Tools | `tools/standard.ts` (fs/shell/search), `tools/webfetch.ts`, `tools/search.ts`, `tools/js-run.ts`, `tools/goal.ts`, `tools/background.ts`, `tools/analysis.ts`, `tools/artifacts.ts` |
| Permissions | `permissions/decide.ts` (single effect gate), `permissions/modes.ts` |
| Persistence | `runtime/store.ts` (`SQLiteStore`), `runtime/sqlite.ts` (port adapter), `runtime/blobs.ts`, `runtime/paths.ts` |
| Plugins | `plugins/host.ts` (`PluginHost`), `plugins/install.ts`, `runtime/modules.ts` (resolution), `extensions/registry.ts` |
| Providers | `providers/registry.ts`, `providers/routing.ts`, `providers/settings.ts` |
| Sessions | `sessions/children.ts` (child sessions), `agents/` (definitions, active agent) |
| Forja | `forge/` (`kernel.ts` lifecycle, `broker.ts` capabilities, `ports.ts`, `javascript/`, `python/`, `journal.ts`, `limits.ts`) |
| Proof | `proof/` (`ledger.ts` pure status, `store.ts` `ProofStore`, `recorder.ts` `ProofRecorder` hooked in `executeCall` on the raw result, `command.ts` fingerprint v1, `scope.ts` glob scope, `tree.ts` tree fingerprint, `divergence.ts` pure claim detector; edits are tracked in `proof_edits`; `plan/criteria.ts` validates the criteria drafts of `exit_plan`, and `goal/machine.ts` gates `update_goal complete` on the ledger) |
| Other | `analysis/`, `artifacts/`, `background/`, `goal/`, `plan/`, `decisions/`, `mcp/`, `commands/catalog.ts`, `resources/` (skills, prompts, context), `startup/`, `changelog/` |

## Conventions and gotchas

- Core stays generic: no reference to a specific plugin; plugin features arrive via host APIs.
- Any new tool declares an honest `effect`; the runner, `availableTools`, legacy `execute` and the
  Forja nested dispatcher must all go through `permissions/decide.ts`. No second permission path.
- Runner invariants: every stored tool call has a result; cut/retried responses are never
  persisted half-way; `limits.timeoutMs` counts active time (human waits pause it); events are
  additive (`RunEventDataMap` in the SDK; update `tests/run-events-contract.test.ts`).
- Store: add migrations forward-only and additive (next version after `schema_migrations` 13); old
  binaries must ignore new tables/columns. Never rewrite rows destructively.
- New slash commands go through `commands/catalog.ts` so TUI, web and API share them (see
  `tests/command-catalog-tui-parity.test.ts`).
- New config keys: zod schema in `config.ts`, settings labels in EN and ES for the web
  (`tests/web-i18n.test.ts` fails otherwise), docs EN/ES.
- Forja engines are adapters behind ports; `ExecutionKernel` owns limits, journal, deadline. Never
  claim an engine is more isolated than `IsolationLevel` states. Embedded sources are generated
  (see `alisio-coding-standards`).
- Only portable Node APIs; Bun-specific paths are guarded by `process.versions.bun`.

## Proof in plan and goal (specs/011 phase 4)

- `exit_plan.acceptanceCriteria` are DRAFTS (`PlanState.criteria`, shown in `PlanReview`, part of
  the plan hash). Only the user's approval, applied once by `decidePlan`, calls
  `ProofStore.addCriterion`; no other path may create a criterion (O2, O3). Never add one from a tool
  result, a plan text or the model's `update_goal`.
- `GoalService.report` (the model) refuses `complete` while a required criterion of this goal (or the
  session) is `failed`/`not_checked`; `GoalService.overrideComplete` is the user-only override and has
  no model-reachable caller. A declared `GoalEvidence.evidenceId` survives only if it resolves to
  evidence of the session; it never changes a status.

## Proof surfaces (specs/011 phase 5)
- `proof/export.ts` is the one pure core every surface shares: `renderProofJson` (`proof/v1`, fixed key
  order), `renderProofMarkdown`, `renderProofText`, `proofExitCode` (0/10/11, `proof.exitCodes`),
  `parseCriteriaInput` (HTTP body, `--proof-file`, `--criterion/--verify`) and `publishProofExport`.
  Surfaces never re-derive statuses; `ProofStore.view()` = ledger + the divergences of the last
  completed run (read from the event journal). `app.proof` is the store for USER surfaces only.
- `ProofStore.updateCriterion` edits text and `required` only (verifier/scope are fixed so evidence keeps
  its meaning). `plan:criteria` (`PLAN_CRITERIA_KEY`) lets the user keep/edit/reject each plan draft;
  a malformed selection activates nothing. `GoalService` pauses a goal after completion refusals in 3
  different runs (`completion_refused`); `/goal override <reason>` is parsed in `goal/command.ts`.

## Proof verifiers (specs/011 phase 6)
- `file` and `data-check` evidence is CAPTURED by `ProofRecorder` from the raw result of `read_file` /
  `data_query` (`proof/verifiers.ts` holds the pure judges; `captureFailure` handles a thrown
  `File not found`). `data-check` counts only its canonical query (`canonicalSql`); `verifierCall(spec)`
  is the one call an on-demand check runs. Never judge from model text, and never add a path that lets
  a tool result or a plugin create a criterion.
- `proof/verify.ts` `verifyCriterion` (`app.verifyCriterion`) is USER-side only (no tool exposes it):
  `file`/`data-check` run the canonical call via `runner.runToolCall` (same gate); `plugin` runs the
  registered verifier (`ProofVerifierRegistry`, `PluginHost.setProofVerifiers` -> `api.proof`). No
  traceable evidence = an evidence of `verifierKind: "manual"` = `manual_review`; a throw or timeout
  records nothing.

## Proof coverage verifier (specs/011 phase 7)
- Opt-in: `proof.coverage.enabled` (default `false`). `ProofRecorder` takes `{coverage: () => boolean}`
  and skips coverage criteria when it is off; `verifyCriterion` takes the same getter and returns
  `coverage_disabled` without calling a tool. Never run a coverage command from Proof itself.
- `proof/coverage.ts` is pure (`parseCoverage`, `judgeCoverage`); evidence is captured like `command`
  evidence (same fingerprint, raw `shell`/`run_process` result). Unparseable output, exit != 0 or a
  low percentage are `failed`, never `verified`. Add new report formats to `PARSERS` with a fixed
  sample in `tests/proof-coverage.test.ts`.

## Testing

Tests in root `tests/` import from `../packages/core/src/index.ts`. Use a scripted
`ModelProvider` (async generator yielding `ProviderEvent`s), temp dirs, stubbed
`ALISIO_CONFIG_HOME`/`ALISIO_STATE_HOME`, real SQLite. Runner behavior: `tests/runner-*.test.ts`;
Forja: `tests/forge-*.test.ts` (helpers `forge-*-helpers.ts`; real Pyodide/Docker behind env flags).
