/**
 * Opt-in CI gate for the reliability lab (specs/010 O7).
 *
 *   pnpm eval:ci [--suite-dir DIR] [--cassette-dir DIR] [--out DIR]
 *
 * Replays the recorded cassettes of the bundled suites (`tests/fixtures/eval`) through the same
 * path as `alisio eval run --mode replay` and exits NON-ZERO when:
 *   - a replay diverged from its cassette (exit 2, like the CLI), or
 *   - a replayed task did not end `pass` (exit 1), or
 *   - the run could not replay anything or failed for an infrastructure reason (exit 1).
 * It exits 0 only when every cassette replays cleanly and passes.
 *
 * Replay measures the HARNESS, not the model: the model answers come from a recording. The lab
 * informs; this script is not part of the default CI and promoting it to a required check is the
 * owner's decision (see "Using replay in CI" in docs/eval.md). It runs from a source checkout only:
 * the suites, the cassettes and this script are not shipped in any npm package.
 *
 * Runs with `node --conditions=alisio-source --experimental-transform-types` (see the package.json
 * script). The permissions (`--allow-write --allow-process`) and an empty configuration are fixed
 * here: the cassettes were recorded under them and a user configuration would change what the
 * provider receives.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { EvalRunRecord } from "@alisio/sdk";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";
import { type EvalEnv, evalRun } from "../packages/cli/src/eval.ts";
import { CASSETTE_SUFFIX } from "../packages/core/src/eval/cassette.ts";
import { type BuiltinPlugin, configSchema, loadSuite } from "../packages/core/src/index.ts";

const DEFAULT_SUITE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/eval",
);

export const REPLAY_NOTE =
  "Replay measures the harness, not the model: the model answers come from recordings.";

export interface EvalCiOptions {
  /** A suite or a directory of suites (default: `tests/fixtures/eval`). */
  suiteDir?: string;
  /** Cassettes of ONE suite when not under `<suite>/cassettes` (needs a single suite). */
  cassetteDir?: string;
  /** Reports go to `<outDir>/<suiteId>/` (default: a fresh directory under `os.tmpdir()`). */
  outDir?: string;
  /** Replaces the built-in plugins (tests simulate a harness change with it). */
  builtins?: BuiltinPlugin[];
  tmpRoot?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export interface EvalCiSuiteResult {
  suiteId: string;
  replayed: number;
  passed: number;
  reportDir: string;
}

export interface EvalCiResult {
  exitCode: number;
  replayed: number;
  passed: number;
  /** `suite/task: field` of every divergence. */
  diverged: string[];
  /** `suite/task` of every replayed task that did not pass. */
  failed: string[];
  /** Suites with no cassettes (live only). */
  skipped: string[];
  suites: EvalCiSuiteResult[];
  outDir: string;
}

interface Found {
  dir: string;
  suiteId: string;
  /** Task ids that have a cassette. */
  tasks: string[];
  cassetteDir: string;
}

function suiteDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  if (existsSync(join(root, "suite.json"))) return [root];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "suite.json")))
    .map((e) => join(root, e.name))
    .sort();
}

const cassetteIds = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(CASSETTE_SUFFIX))
        .map((f) => f.slice(0, -CASSETTE_SUFFIX.length))
        .sort()
    : [];

function readRecords(dir: string): EvalRunRecord[] {
  const file = join(dir, "runs.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalRunRecord);
}

export async function runEvalCi(options: EvalCiOptions = {}): Promise<EvalCiResult> {
  const write = options.out ?? ((text: string) => void process.stdout.write(text));
  const writeErr = options.err ?? ((text: string) => void process.stderr.write(text));
  const outDir = resolve(options.outDir ?? mkdtempSync(join(tmpdir(), "alisio-eval-ci-")));
  const result: EvalCiResult = {
    exitCode: 0,
    replayed: 0,
    passed: 0,
    diverged: [],
    failed: [],
    skipped: [],
    suites: [],
    outDir,
  };
  const fail = (code: number, message: string): EvalCiResult => {
    writeErr(`eval-ci: ${message}\n`);
    result.exitCode = Math.max(result.exitCode, code);
    return result;
  };

  const suitesRoot = resolve(options.suiteDir ?? DEFAULT_SUITE_DIR);
  if (options.suiteDir && !existsSync(suitesRoot))
    return fail(1, `--suite-dir ${options.suiteDir} does not exist.`);
  const dirs = suiteDirs(suitesRoot);
  if (options.cassetteDir && dirs.length > 1)
    return fail(1, "--cassette-dir needs exactly one suite; pass --suite-dir with a single suite.");

  const found: Found[] = [];
  for (const dir of dirs) {
    let loaded: ReturnType<typeof loadSuite>;
    try {
      loaded = loadSuite(dir);
    } catch (error) {
      return fail(1, `suite ${dir} is invalid: ${error instanceof Error ? error.message : error}`);
    }
    const cassetteDir = resolve(options.cassetteDir ?? join(dir, "cassettes"));
    const ids = cassetteIds(cassetteDir);
    const taskIds = loaded.suite.tasks.map((t) => t.id);
    const orphan = ids.find((id) => !taskIds.includes(id));
    if (orphan)
      return fail(
        1,
        `cassette "${orphan}" in ${cassetteDir} matches no task of ${loaded.suite.suiteId}.`,
      );
    if (ids.length === 0) result.skipped.push(loaded.suite.suiteId);
    else found.push({ dir, suiteId: loaded.suite.suiteId, tasks: ids, cassetteDir });
  }
  if (found.length === 0)
    return fail(
      1,
      `nothing to replay: no suite with cassettes under ${suitesRoot}. An empty set is a misconfiguration, not a pass.`,
    );

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  write(
    `eval-ci: replaying the recorded cassettes (no network, no credentials).\n${REPLAY_NOTE}\n`,
  );

  const config = configSchema.parse({});
  const builtins = options.builtins ?? (BUILTIN_PLUGINS as BuiltinPlugin[]);
  for (const suite of found) {
    const diagnostics: string[] = [];
    const reportDir = join(outDir, suite.suiteId);
    const env: EvalEnv = {
      out: () => undefined,
      err: (text) => void diagnostics.push(text),
      stateDir: outDir,
      interactive: false,
      confirm: async () => false,
      newRunId: () => suite.suiteId,
      openRuntime: async () => ({
        provider: {
          id: "replay",
          model: "replay",
          async *stream() {
            throw new Error("eval-ci: replay must not call a provider.");
          },
        },
        config,
        builtins,
        close: async () => undefined,
      }),
      ...(options.tmpRoot ? { tmpRoot: options.tmpRoot } : {}),
    };
    const code = await evalRun(
      env,
      {
        mode: "replay",
        allowWrite: true,
        allowProcess: true,
        suiteDir: suite.dir,
        cassetteDir: suite.cassetteDir,
        tasks: suite.tasks.join(","),
        out: reportDir,
        yes: true,
      },
      suite.suiteId,
    );
    const records = readRecords(reportDir);
    const passed = records.filter((r) => r.status === "pass").length;
    result.replayed += records.length;
    result.passed += passed;
    result.suites.push({ suiteId: suite.suiteId, replayed: records.length, passed, reportDir });
    for (const record of records) {
      const key = `${suite.suiteId}/${record.taskId}`;
      if (record.divergence) {
        const fields = [...new Set(record.divergence.diff.map((d) => d.field))].join(", ");
        result.diverged.push(`${key}: ${fields || record.divergence.message}`);
      } else if (record.status !== "pass")
        result.failed.push(`${key}: ${record.status}${record.error ? ` (${record.error})` : ""}`);
    }
    if (code !== 0 || records.length !== suite.tasks.length) {
      // The diagnostics hold the diverging calls, fields and excerpts, or the usage/infra error.
      writeErr(
        diagnostics
          .filter((line) => !/^(\[eval\] \d+\/\d+ |Warning: the suite in )/.test(line))
          .join(""),
      );
      result.exitCode = Math.max(result.exitCode, code === 0 ? 1 : code);
    }
  }
  if (result.failed.length > 0) result.exitCode = Math.max(result.exitCode, 1);
  if (result.diverged.length > 0) result.exitCode = 2;

  for (const suite of result.suites)
    write(`  ${suite.suiteId}: ${suite.passed}/${suite.replayed} passed\n`);
  for (const line of result.diverged) write(`  DIVERGED ${line}\n`);
  for (const line of result.failed) write(`  NOT PASSING ${line}\n`);
  if (result.skipped.length > 0)
    write(`  skipped (no cassettes, live only): ${result.skipped.join(", ")}\n`);
  write(
    `eval-ci: ${result.exitCode === 0 ? "OK" : "FAILED"} ${result.passed}/${result.replayed} cassettes replayed and passed. Reports: ${outDir}\n${REPLAY_NOTE}\n`,
  );
  return result;
}

const USAGE = `Usage: eval-ci.ts [options]

Replays the recorded cassettes of the bundled eval suites and exits non-zero when a replay diverges,
a replayed task does not pass or nothing could be replayed. ${REPLAY_NOTE}
Opt-in: it is not part of the default CI. Source checkout only.

Options:
  --suite-dir <dir>     A suite or a directory of suites (default: tests/fixtures/eval)
  --cassette-dir <dir>  Cassettes of a single suite (default: <suite>/cassettes)
  --out <dir>           Reports go to <dir>/<suite>/report.{json,md} (default: a new tmp directory)
  -h, --help            This text

Exit codes: 0 all replays clean and passing; 2 a replay diverged; 1 a task did not pass, nothing
to replay, or a usage or infrastructure error.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "suite-dir": { type: "string" },
      "cassette-dir": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  // An empty configuration home, so a developer's own configuration never reaches the provider.
  const configHome = mkdtempSync(join(tmpdir(), "alisio-eval-ci-config-"));
  process.env.ALISIO_CONFIG_HOME = configHome;
  try {
    const result = await runEvalCi({
      ...(values["suite-dir"] ? { suiteDir: values["suite-dir"] } : {}),
      ...(values["cassette-dir"] ? { cassetteDir: values["cassette-dir"] } : {}),
      ...(values.out ? { outDir: values.out } : {}),
    });
    return result.exitCode;
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `eval-ci failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
