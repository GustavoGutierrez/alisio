# Reliability Lab (`alisio eval`)

The Reliability Lab answers one question with data: does a change to the harness, a strategy or a
model make Alisio better or worse at a set of tasks? It runs a **suite** of tasks several times,
checks each result with deterministic verifiers, and reports pass rates with their uncertainty. It
is a development and CI tool: it runs headless (`alisio eval`), there is no interactive UI, and
nothing leaves your machine.

## Guiding principle {#principle}

A number without its measurement conditions is an anecdote. Every report carries the suite id and
version, the harness version, a hash of the effective configuration, the provider, the model, the
mode, `k` and the seed. The lab never claims determinism where there is only repetition: a `live`
run depends on a real model, and `--seed` only orders the runs (the provider never receives it).

Measured values (provider usage, wall time, event counts) and estimated values (cost in USD) live in
separate blocks and are never added together.

## Live and replay {#modes}

| Mode | Provider | What it measures | Use it for |
| --- | --- | --- | --- |
| `live` (default) | the configured provider | the harness and the model together, with variance | deciding on strategies and models |
| `replay` | a recording (cassette) | the harness only, deterministically | cheap CI, catching regressions in the runner, tools, compaction and permissions |

**Replay measures the harness, not the model.** The model answers come from a recording, so a green
replay says nothing about model quality. The report header says `replay` and repeats this.

## Quick start {#quick-start}

The bundled suites live in the source checkout (`tests/fixtures/eval`), not in the npm package or
the standalone binary. From a checkout:

```sh
alisio eval list
ALISIO_CONFIG_HOME="$(mktemp -d)" alisio eval run tool-sequences --mode replay --allow-write --allow-process
alisio eval run smoke-coding --k 5 --allow-write --allow-process
```

The second command replays the recorded cassettes with an empty configuration directory (see
[Replay and cassettes](#cassettes)); the third needs a configured provider and spends real tokens.
From the npm package or the binary, pass your own suite with `--suite-dir`.

## Writing a suite {#writing-a-suite}

A suite is a directory with a `suite.json` and one fixture directory per task. A task runs in a
temporary copy of its fixture, never in your working tree.

```text
my-suite/
  suite.json
  fixtures/fix-add/        # copied for each run
    src/math.ts
    check.ts
```

```json
{
  "schemaVersion": 1,
  "suiteId": "my-suite",
  "suiteVersion": "1.0.0",
  "description": "Small coding tasks.",
  "tasks": [
    {
      "id": "fix-add",
      "prompt": "The function add in src/math.ts is wrong. Fix it. Change only src/math.ts.",
      "fixture": "fixtures/fix-add",
      "budget": { "maxTurns": 30, "maxTokens": 200000, "maxWallMs": 120000, "maxToolCalls": 40 },
      "policy": { "mode": "auto", "allow": ["process"] },
      "verifiers": [
        {
          "kind": "command",
          "id": "check",
          "command": ["node", "--experimental-strip-types", "check.ts"],
          "timeoutMs": 30000
        },
        { "kind": "tree-diff-within", "id": "scope", "allowed": ["src/math.ts"] }
      ],
      "tags": ["coding"]
    }
  ]
}
```

- `suiteVersion` is semver. Change a fixture or a verifier and you must bump it: `compare` refuses to
  mix versions.
- Paths (`fixture` and verifier paths) must be relative and stay inside the suite or the task
  directory; `..`, absolute paths and escaping symlinks are rejected, and task and verifier ids must be
  unique. The loader reports the task and the field that is wrong.
- `agent` optionally runs the task with one of your main agents.
- `fixtureGit: true` initializes a git repository inside the copy, for tasks that need one.

### Budgets {#budgets}

`maxTurns` and `maxWallMs` are required; `maxTokens` and `maxToolCalls` are optional. A run that
exceeds one stops with status `budget_exceeded`, which counts as not passing, and records the reason.
`maxTokens` is only enforced when the provider reports usage; without usage the run records the
`usage_unreported` incident and may overshoot by one response.

### Policy {#policy}

`policy.mode` is `ask`, `auto` or `full`; `policy.allow` can add `write`, `process`, `external` or
`analysis`; `readOnly` restricts further. A suite can only equal or restrict the permissions of whoever
runs it: the `--allow-write`, `--allow-process`, `--allow-external` and `--allow-analysis` flags map
to the effects `write`, `process`, `external` and `analysis`. A task that asks for an effect you did not
grant is rejected before the first run, not silently trimmed. A task with `mode: "full"` also needs
`--allow-suite-full`.

In `ask` mode the lab is headless and **denies every approval** (each one counts as an
`approval_denied` incident); `alisio run` asks instead. In `auto` and `full` an ungranted effect is
refused without an approval event.

### Verifiers {#verifiers}

Verifiers are deterministic and local; there is no model judge. Each returns `pass`, `fail` or
`error`. A task passes when all its verifiers pass and no budget was exceeded.

| Kind | Checks |
| --- | --- |
| `command` | runs `command` (an argument array, no shell) within `timeoutMs` (at most 600000) and checks `expectExit` and `expectStdoutIncludes` |
| `file-equals` | the file's sha256 equals `sha256` |
| `file-contains` | the file contains `text` |
| `file-absent` | the file does not exist |
| `tree-diff-within` | every changed, added or deleted file is in `allowed` (`dir/` allows a whole directory; `.git` and `node_modules` are ignored) |
| `tool-sequence` | a rule over the tool calls of the run, below |

`tool-sequence` rules:

| Rule | Passes when |
| --- | --- |
| `{"type": "before", "first": "read_file", "then": "edit_file"}` | `first` happened before every `then` call (it compares tool names, not files) |
| `{"type": "never", "tool": "bash"}` | the tool was never called |
| `{"type": "max-calls", "tool": "read_file", "max": 3}` | the tool was called at most `max` times |
| `{"type": "no-repeat-failure", "tool": "edit_file"}` | an identical failed call was not repeated |

`error` means the verifier could not run (a path outside the directory, a command that does not
start, missing events). It is reported apart and is neither a pass nor a fail. A `command` that
exceeds its timeout is a `fail`: it is the task's own check running code the agent wrote.

### `replayNormalize` {#replay-normalize}

Replay compares what the harness sends to the provider. If a task prints noise that changes between
runs (dates, PIDs), declare it so it does not look like a regression:

```json
"replayNormalize": [
  { "pattern": "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z", "replace": "<TIMESTAMP>" }
]
```

`pattern` is a global regular expression. An over-broad rule can hide a real regression.

## Commands {#commands}

Global flags (`--json`, `--allow-*`, `--read-only`, `--model`, `--base-url`...) work as in
`alisio run`.

| Command | Does |
| --- | --- |
| `alisio eval list [--suite-dir DIR]` | lists the bundled suites (checkout only) and those in `DIR` |
| `alisio eval run <suite>` | runs a suite `k` times and writes the report |
| `alisio eval record <suite>` | runs each task once, live, and writes its cassette |
| `alisio eval compare <baseline> <candidate>` | compares two reports (`report.json` or its directory) |
| `alisio eval variants <suite> --variants compare.json` | runs configuration variants over the same tasks and compares them |
| `alisio eval export <runId> --out FILE [--force]` | writes one shareable bundle of a stored run, without absolute paths or secrets |

`<suite>` is a suite id or the name of its directory. Options of `run` and `variants`:

| Flag | Meaning |
| --- | --- |
| `--tasks id,id` | only these tasks |
| `--k N` | repetitions per task (default 5; default 1 in replay) |
| `--seed N` | seed of the run order; each run gets `seed + repetition` |
| `--mode live\|replay` | `run` only; `variants` refuses replay |
| `--cassette-dir DIR` | cassettes to read or write (default `<suite>/cassettes`) |
| `--keep` | keep each run's temporary directory and print its path |
| `--out DIR` | write the three report files directly in `DIR` |
| `--suite-dir DIR` | a suite, or a directory of suites, outside the bundled ones |
| `--yes` | accept a `--suite-dir` suite without asking |
| `--allow-suite-full` | let tasks with `mode: "full"` run |
| `--input-rate USD`, `--output-rate USD` | USD per million tokens; both or neither |
| `--variants FILE` | `variants` only: the `compare.json` file |

`record` accepts `--tasks`, `--seed`, `--keep`, `--cassette-dir`, `--suite-dir`, `--yes` and
`--allow-suite-full`. With `--json`, `run` prints one JSON record per run and the report last;
`variants` prints lines with a `type` (`variant_report`, `comparison`); `compare --json` prints the
comparison.

### Exit codes {#exit-codes}

| Code | Meaning |
| --- | --- |
| `0` | it completed, whichever tasks passed |
| `1` | usage or infrastructure error (also when some run ended `error`; the report is still written) |
| `2` | a replay diverged from its cassette |
| `3` | `compare` of incompatible suites (different `suiteId` or `suiteVersion`) |

A failing task is data, not an error: gate CI on the report, not on code `0`.

### Third-party suites {#third-party}

A suite from `--suite-dir` is code that runs with your privileges: its verifier commands and the tools
it enables are not sandboxed. The command prints a warning and asks for confirmation; without a
terminal it refuses unless you pass `--yes`. Only run suites you trust.

### Variants {#variants}

`compare.json` names a suite and two or more variants, each a set of configuration overrides:

```json
{
  "suite": "smoke-coding",
  "variants": [
    { "id": "baseline", "overrides": {} },
    { "id": "early-compaction", "overrides": { "compaction.threshold": 0.6 } }
  ]
}
```

Only keys of the measured configuration are accepted; an unknown key, or one that does not enter the
configuration hash (provider, plugins, MCP, paths), rejects the file before the first run. To compare
models use `--model`. Variants run interleaved (A, B, then B, A...) over the same tasks, repetitions
and seeds, which spreads provider drift instead of eliminating it. Each variant gets its own report
directory, plus `comparison.json` and `comparison.md` at the root.

## Reading the results {#reading-results}

### Success rate and the Wilson interval {#success-rate}

`successRate` is passes over judged runs, with a 95% Wilson interval. With few runs the interval is
wide: 3/5 is about 23% to 88%. A task counts the runs judged `pass`, `fail` or `budget_exceeded`.
Runs that ended `error` are infrastructure failures (fixture copy, provider network or auth, a verifier
that cannot start): they are excluded from every rate and counted apart. A failure the model causes
(truncated output, too many tool calls in a turn, a hung `command` verifier) is a `fail`, not an
`error`.

### pass@k and pass^k {#pass-k}

- `pass@k`: at least one of the `k` runs passed. It answers "can it do this at all?".
- `pass^k`: all `k` runs passed. It answers "can I rely on it?". It drops fast as `k` grows.

Both are shown per task. A task with `pass@5` yes and `pass^5` no is flaky, not solved.

### Why `k` is at least 5 {#why-k}

Below 5 judged runs the report prints a **low power** warning and `compare` makes no claim. With
`k = 5` only 0/5 against 5/5 can produce a verdict, because the intervals must be disjoint. Use a
larger `k` to detect smaller differences; each repetition costs real tokens.

### `inconclusive` and `low power` {#verdicts}

`compare` reads the intervals, not the point estimates:

| Verdict | Meaning |
| --- | --- |
| `improved` / `regressed` | both sides have at least 5 judged runs and the Wilson intervals are disjoint |
| `inconclusive` | the intervals overlap (touching counts). It is not "no difference": there is not enough evidence |
| `low power` | fewer than 5 judged runs on a side; no direction is claimed |
| `not comparable` | errored runs on a side, different modes, or (for token and cost deltas) different compaction settings |

In replay the report has no intervals: each task is `changed` or `unchanged`. Every comparison ends
with a footnote stating its limits: a conservative screen, not a significance test; independent
repetitions assumed; no correction across the number of tasks; excluded errored runs.

### Measured and estimated {#measured-estimated}

The `measured` block holds provider-reported tokens, wall time (median and sample variance), tokens
and time per success. Per-success figures are the total spend of the judged runs, failures included,
divided by the successes. Tokens are main-loop tokens and **exclude compaction calls**. If a provider
does not report usage in every turn, the token figures are omitted, not guessed.

`estimated` holds `costUsd`, and it exists only when you pass **both** `--input-rate` and
`--output-rate`. Alisio does not guess prices, and the cost ignores cached and reasoning token prices.
Comparisons only compare estimated costs when both reports used the same rates.

### Report files {#report-files}

`run` writes three files to `<dataDir>/eval/<runId>/` (the state directory), or directly to `--out`:

| File | Content |
| --- | --- |
| `report.json` | conditions, per-task metrics, summary |
| `report.md` | the same, readable, with the Measured and Estimated tables apart |
| `runs.jsonl` | one record per run: verifiers, usage, incidents, errors, divergence |

Pass a `report.json` or its directory to `compare`.

### Exporting a run {#export}

```sh
alisio eval export 2026-10-13T12-00-00-000Z --out share/run.json
```

`export` reads `<dataDir>/eval/<runId>/` and writes **one** JSON file,
`{ "schemaVersion": 1, "report": ..., "runs": [...], "markdown": "..." }`, that you can share
yourself. Nothing is uploaded and there is no network access. The run id is the directory name
(letters, digits, `.`, `_`, `-`; no path separators). It refuses to overwrite an existing `FILE`
unless you pass `--force`.

What it does to the content:

- Absolute paths (your home directory, the data directory, the run directory, temporary
  directories and any other absolute path) become placeholders such as `<home>`, `<run-dir>`,
  `<tmp>` or `<path>`. Kept temporary directories are not part of the bundle.
- A provider id that is not a plain identifier, because it may embed the endpoint host, is replaced by
  `custom-endpoint` everywhere.
- The same secret scanner that protects cassettes (well-known key shapes plus the credentials found in
  your environment) runs over the whole bundle. If it finds one, `export` **refuses** (exit `1`) and
  names the field, for example `runs[1].verifiers[0].detail`, never the value. Nothing is stripped
  and nothing is written.

The scrubbing is pattern-based. It is not a guarantee: a task prompt, a verifier detail or a tool
output can hold a sensitive string no pattern recognizes. Read the bundle before you share it.

## Replay and cassettes {#cassettes}

A cassette (`cassette/v1`, JSONL) records every provider call of one task: a fingerprint of the
request (instructions, messages, tools with schemas, output limit, model, native tools and reasoning
effort) and the events the provider emitted. Tool call ids and provider continuation data are stored
verbatim. Per-run paths and generated ids are normalized before hashing. The writer refuses a
cassette that holds a secret (known key shapes and the exact credentials of your profile) or that
exceeds 256 KB (2 MB per directory); the scan is a safety net, so review a cassette before committing
it.

```sh
alisio eval record my-suite --suite-dir ./suites --tasks fix-add   # live; writes the cassette
alisio eval run my-suite --suite-dir ./suites --mode replay        # no provider, no network
```

Replay needs no provider or credentials, but it does need the same permissions the recording had
(`--allow-write --allow-process` for the bundled cassettes) and a clean configuration. Your own
configuration changes what the provider receives, so for the bundled cassettes point
`ALISIO_CONFIG_HOME` to an empty directory. The run warns when the configuration hash differs from the
recorded one.

### Divergence {#divergence}

If the harness asks the provider for something different from the recording, the run ends `error`
with `replay_divergence`, the command prints the task, the call, the field (for example
`tools[edit_file].description` or `messages[3].tool.result`) with excerpts around the first
difference, writes the report anyway and exits `2`. Recorded calls that are never made, or extra
calls, also diverge.

A divergence after you changed the harness is the point: replay is a regression detector. If the
change is intended, review the diff and re-record. Anything that changes what the provider receives
invalidates the cassettes, including your reasoning effort or enabling native search.

### Bundled suites {#bundled-suites}

| Suite | Tasks | Mode |
| --- | --- | --- |
| `smoke-coding` 1.2.0 | 7 small TypeScript tasks (three easy, four harder; three of them hardened after they saturated) | live; 4 cassettes |
| `tool-sequences` | 6 stateful tool-use tasks, one with a deliberate invalid transition | replay; 6 cassettes |
| `long-context` | 3 tasks with facts buried in long files and truncated command output | live; no cassettes |

They exist **only in the repository checkout** (`tests/fixtures/eval`), not in the npm package or the
binary; there `list` is empty and says so. The bundled cassettes were recorded with a scripted
provider (a fixed list of tool calls), not a real model: they pin harness behavior. `pnpm test` replays
them in about two seconds.

To re-record them, for example after an intended harness change, run from the checkout:

```sh
pnpm eval:record-bundled
```

(`--tasks suite/task,...` and `--out DIR` are accepted.) Two consecutive recordings are
byte-identical. To record a real model use `alisio eval record <suite>` with your provider. Review the
cassette diff before committing it.

## Using replay in CI {#ci}

`pnpm eval:ci` replays every bundled cassette and exits non-zero when a replay diverges (exit `2`),
a replayed task does not pass, or nothing could be replayed (an empty set is a misconfiguration, not
a pass; both exit `1`). It exits `0` only when every cassette replays cleanly and passes. It runs
from a source checkout (the script, suites and cassettes are not in the npm package), needs no
provider, credentials or network, sets `--allow-write --allow-process` and an empty configuration
itself, and takes about two seconds.

```sh
pnpm eval:ci                       # reports in a new temporary directory
pnpm eval:ci --out ./eval-report   # <dir>/<suite>/report.json and report.md
```

`--suite-dir DIR` and `--cassette-dir DIR` replace the bundled locations (`--cassette-dir` needs a
single suite). A suite without cassettes (`long-context`) is listed as skipped. A divergence names the
task, the call and the field, for example `tools[edit_file].description`.

**It informs; the owner decides.** Replay measures the harness, not the model, and the lab never
promotes or blocks a change on its own. Nothing runs it by default: it is not in `.github/workflows/ci.yml`
or in the delivery checklist. To opt in, add a job such as this one (a snippet, not an active job):

```yaml
eval-replay:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version: "24"
        cache: pnpm
    - run: pnpm install --frozen-lockfile
    - run: pnpm eval:ci --out eval-report
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: eval-report
        path: eval-report
```

Leave the job out of the required checks to keep it informational; making it required is the owner's
call. After an intended harness change, re-record with `pnpm eval:record-bundled`.

## Measured results {#measured}

`smoke-coding` 1.2.0, `k = 5`, live, harness 0.6.0, 2026-10-14, tasks `rename-symbol`,
`edit-respects-hash` and `off-by-one-among-passing`:

| Model | pass | fail | `budget_exceeded` | error | Success rate per task (Wilson 95 %) |
| --- | --- | --- | --- | --- | --- |
| `opencode-go/deepseek-v4.1-flash` | 15 | 0 | 0 | 0 | 100 % [56.6 %, 100 %] on all three |
| `opencode-go/mimo-v2.6-flash` | 9 | 0 | 6 (5 by `maxWallMs`, 1 by `maxTokens`) | 0 | 80 % [37.6 %, 96.4 %], 80 % [37.6 %, 96.4 %], 20 % [3.6 %, 62.4 %] |

- DeepSeek saturated the tasks: the 30-80 % target was a hypothesis and was not met. Median wall time
  was 43-106 s per run and 117k-256k tokens per success.
- MiMo had no model-caused `fail` runs, so the verifiers never rejected a wrong solution. Its lower rate
  is mostly wall time (provider latency, about 30 s per turn), so it mixes capability and speed. The
  intervals overlap with DeepSeek's: `eval compare` would say `inconclusive`. Budgets were not raised
  to favor it; the budget is part of the task.
- `smoke-coding` is a smoke and regression suite. It saturates on a strong, cheap model and only
  discriminates (partly through latency) on a weaker one. Discriminating power between models is not
  established.

## Limits {#limits}

- **No LLM judge.** Verifiers are deterministic; subjective quality is not measured.
- **No third-party benchmarks** (SWE-bench and similar). The suite format could host them; none is
  included.
- **No determinism in `live`.** Repetitions and intervals describe variance; the seed only orders runs.
- **Replay is not model evidence** (see [Live and replay](#modes)).
- **A subprocess or a policy is not a sandbox.** File tools are mediated, but when a task is granted
  `process`, or a `command` verifier runs, the code runs with your privileges and can write outside the
  temporary copy. Do not rely on "nothing outside the copy changes" in that case.
- **Repetitions are assumed independent**, nothing is paired, and there is no multiple-comparison
  correction across tasks.
- **No upload.** Reports are local files you share yourself; `export` only writes a scrubbed local bundle,
  and its scrubbing is pattern-based, not a guarantee. The suites never run against your real working
  tree.
- **Bundled cassettes pin the harness only**, and a legitimate harness change invalidates them.
- **Unverified with a real model**: `long-context` has not been measured with a real model yet; do not
  use it to decide until you have run it live with `k = 5`. See [Measured results](#measured).
- **Only the OpenAI-compatible provider from a config file is verified**; the provider is resolved once
  per command, so a provider plugin that reads credentials lazily on every request may not work.

See [Known limitations](/limitations) for the verification scope.
