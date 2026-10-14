---
"@alisio/sdk": minor
"@alisio/core": minor
"@alisio/alisio-code": minor
---

Reliability lab, phase 3 (specs/010): per-task reliability metrics over k repetitions (Wilson
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
