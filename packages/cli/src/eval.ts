/**
 * `alisio eval list|run|record|compare|variants|export` (specs/010 5.4, Phases 3-4). Every function
 * returns the exit code and talks only through the injected `EvalEnv`, so tests drive them without
 * a process:
 *
 *   0  completed (independent of which tasks passed)   1  usage or infrastructure error
 *   2  a replay diverged from its cassette             3  `compare` of incompatible suites
 *
 * `record` runs each task once live and writes `<suite>/cassettes/<taskId>.cassette.jsonl`;
 * `run --mode replay` serves those cassettes (no provider, no credentials, no network). `export`
 * writes one local, scrubbed JSON bundle of a stored run (nothing is uploaded). Reports go to `<stateHome>/eval/<runId>/` (or `--out DIR`): report.json, report.md, runs.jsonl.
 * A suite given with `--suite-dir` is third-party code: it needs `--yes` (or an interactive
 * confirmation) because a subprocess is not a sandbox.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BuiltinPlugin,
  Config,
  EvalApplication,
  EvalComparison,
  EvalReport,
  InvokerPermissions,
  LoadedSuite,
} from "@alisio/core";
import type { EvalRates, EvalRunRecord, ModelProvider } from "@alisio/sdk";

/** The part of the command line `eval` reads, global flags included. */
export interface EvalFlags {
  json?: boolean;
  allowWrite?: boolean;
  allowProcess?: boolean;
  allowExternal?: boolean;
  allowAnalysis?: boolean;
  readOnly?: boolean;
  disablePlugin?: string[];
  suiteDir?: string;
  tasks?: string;
  k?: string;
  seed?: string;
  mode?: string;
  keep?: boolean;
  out?: string;
  allowSuiteFull?: boolean;
  yes?: boolean;
  inputRate?: string;
  outputRate?: string;
  variants?: string;
  md?: boolean;
  cassetteDir?: string;
  force?: boolean;
}

/** What a live run needs, resolved BEFORE any task starts (the engine takes a provider). */
export interface EvalRuntime {
  provider: ModelProvider;
  /** The effective configuration (variant overrides are applied on top of it). */
  config: Config;
  builtins: BuiltinPlugin[];
  /** Exact credential values of the run's provider profile (a cassette holding one is refused). */
  secrets?: string[];
  resolveAgent?: (app: EvalApplication, agent: string) => ReturnType<NonNullable<ResolveAgent>>;
  close(): Promise<void>;
}
type ResolveAgent = NonNullable<import("@alisio/core").RunEvaluationOptions["resolveAgent"]>;

export interface EvalEnv {
  out(text: string): void;
  err(text: string): void;
  /** `<stateHome>`: reports default to `<stateDir>/eval/<runId>/`. */
  stateDir: string;
  /** Directory of the bundled suites: `tests/fixtures/eval` of a source checkout, absent elsewhere. */
  bundledDir?: string;
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
  /**
   * `requireProvider: false` (replay) must not fail when no provider is configured: the cassette
   * is the provider, and the returned `provider` is then ignored.
   */
  openRuntime(flags: EvalFlags, options?: { requireProvider?: boolean }): Promise<EvalRuntime>;
  newRunId(): string;
  /** Parent of the per-run temporary directories (tests); default `os.tmpdir()`. */
  tmpRoot?: string;
}

const DEFAULT_K = 5;
const DEFAULT_SEED = 0x5eed1234;

class UsageError extends Error {}

const failure = (env: EvalEnv, message: string, code = 1): number => {
  env.err(`${message}\n`);
  return code;
};

function positiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || !Number.isSafeInteger(Number(value)))
    throw new UsageError(`Invalid --${name} "${value}": expected an integer >= ${min}.`);
  return Number(value);
}

function parseRates(flags: EvalFlags): EvalRates | undefined {
  if (flags.inputRate === undefined && flags.outputRate === undefined) return undefined;
  if (flags.inputRate === undefined || flags.outputRate === undefined)
    throw new UsageError(
      "--input-rate and --output-rate go together (USD per million tokens); without both no cost is estimated.",
    );
  const parse = (text: string, name: string) => {
    const value = Number(text);
    if (text.trim() === "" || !Number.isFinite(value) || value < 0)
      throw new UsageError(`Invalid --${name} "${text}": expected a non-negative number.`);
    return value;
  };
  return {
    inputPerMTokUsd: parse(flags.inputRate, "input-rate"),
    outputPerMTokUsd: parse(flags.outputRate, "output-rate"),
  };
}

function invokerOf(flags: EvalFlags): InvokerPermissions {
  return {
    write: !!flags.allowWrite,
    process: !!flags.allowProcess,
    external: !!flags.allowExternal,
    analysis: !!flags.allowAnalysis,
    ...(flags.readOnly ? { readOnly: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------------------------

/**
 * The bundled suites (smoke-coding, tool-sequences, long-context) live in `tests/fixtures/eval` of
 * a source checkout and are NOT part of the npm package or the standalone binary (specs/010 O4).
 */
const NO_BUNDLED_HINT =
  "The bundled suites exist only in a source checkout (tests/fixtures/eval); they are not in the npm package or the binary. Pass --suite-dir DIR (a suite or a directory of suites) instead.";

interface FoundSuite {
  dir: string;
  origin: "bundled" | "suite-dir";
}

/** `root` itself when it holds a suite.json, otherwise its subdirectories that do. */
function suitesUnder(root: string, origin: FoundSuite["origin"]): FoundSuite[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  if (existsSync(join(root, "suite.json"))) return [{ dir: root, origin }];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "suite.json")))
    .map((e) => ({ dir: join(root, e.name), origin }))
    .sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

function discover(env: EvalEnv, flags: EvalFlags): FoundSuite[] {
  return [
    ...(env.bundledDir ? suitesUnder(resolve(env.bundledDir), "bundled") : []),
    ...(flags.suiteDir ? suitesUnder(resolve(flags.suiteDir), "suite-dir") : []),
  ];
}

export async function evalList(env: EvalEnv, flags: EvalFlags): Promise<number> {
  const { loadSuite } = await import("@alisio/core");
  if (flags.suiteDir && !existsSync(resolve(flags.suiteDir)))
    return failure(env, `--suite-dir ${flags.suiteDir} does not exist.`);
  const rows = discover(env, flags).map((found) => {
    try {
      const { suite } = loadSuite(found.dir);
      return {
        id: suite.suiteId,
        version: suite.suiteVersion,
        tasks: suite.tasks.length,
        description: suite.description,
        origin: found.origin,
        dir: found.dir,
      };
    } catch (error) {
      return {
        id: basename(found.dir),
        origin: found.origin,
        dir: found.dir,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  if (flags.json) env.out(`${JSON.stringify({ suites: rows })}\n`);
  else if (rows.length === 0) env.out(`No suites found. ${NO_BUNDLED_HINT}\n`);
  else
    for (const row of rows)
      env.out(
        "error" in row
          ? `${row.id}  [${row.origin}]  invalid: ${row.error}\n`
          : `${row.id}  ${row.version}  ${row.tasks} task${row.tasks === 1 ? "" : "s"}  [${row.origin}]  ${row.description}\n`,
      );
  return 0;
}

async function resolveSuite(
  env: EvalEnv,
  flags: EvalFlags,
  name: string,
): Promise<{ loaded: LoadedSuite; origin: FoundSuite["origin"] } | number> {
  const { loadSuite } = await import("@alisio/core");
  const found = discover(env, flags);
  const matches = found.flatMap((candidate) => {
    if (basename(candidate.dir) === name) return [candidate];
    try {
      return loadSuite(candidate.dir).suite.suiteId === name ? [candidate] : [];
    } catch {
      return [];
    }
  });
  const [match] = matches;
  if (!match)
    return failure(
      env,
      `Unknown suite "${name}". ${
        found.length > 0
          ? `Available: ${found.map((f) => basename(f.dir)).join(", ")}.`
          : NO_BUNDLED_HINT
      }`,
    );
  return { loaded: loadSuite(match.dir), origin: match.origin };
}

/** A third-party suite is code that runs with the user's privileges: warn and ask. */
async function confirmThirdParty(
  env: EvalEnv,
  flags: EvalFlags,
  suiteDir: string,
): Promise<boolean> {
  env.err(
    `Warning: the suite in ${suiteDir} comes from --suite-dir. Its verifier commands and the agent tools it enables run with YOUR privileges; a subprocess is not a sandbox. Only run suites you trust.\n`,
  );
  if (flags.yes) return true;
  if (!env.interactive) {
    env.err(
      "Refusing to run it without confirmation: pass --yes to accept this in a non-interactive run.\n",
    );
    return false;
  }
  return env.confirm("Run this suite? [y/N] ");
}

// ---------------------------------------------------------------------------------------------
// Report files
// ---------------------------------------------------------------------------------------------

function writeFiles(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

const jsonl = (values: unknown[]) => values.map((v) => `${JSON.stringify(v)}\n`).join("");

/** Adds the estimated cost of each run when rates were supplied (never otherwise). */
function withEstimate(
  core: typeof import("@alisio/core"),
  record: EvalRunRecord,
  rates: EvalRates | undefined,
): EvalRunRecord {
  const costUsd = rates ? core.estimateRunCost(record, rates) : undefined;
  return costUsd === undefined
    ? record
    : { ...record, estimated: { ...record.estimated, costUsd } };
}

/**
 * Shown only for runs that ended `error`, which are infrastructure failures by definition (fixture
 * copy, application creation, provider network/auth, a verifier that cannot start). Failures the
 * model causes are `fail` runs and never reach this message.
 */
function infrastructureMessage(errored: number, what: "report" | "reports", dir: string): string {
  return `${errored} run(s) ended in an infrastructure error and are excluded from the rates (a comparison with excluded runs claims no improvement or regression); the ${what} ${what === "report" ? "was" : "were"} written to ${dir}. Fix the cause and rerun.`;
}

// ---------------------------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------------------------

interface Prepared {
  loaded: LoadedSuite;
  k: number;
  seedBase: number;
  taskIds?: string[];
  rates?: EvalRates;
}

/** Shared validation of `run` and `variants`; a number is an exit code. */
async function prepare(
  env: EvalEnv,
  flags: EvalFlags,
  suiteName: string,
): Promise<Prepared | number> {
  // A replay is deterministic: repeating one cassette k times measures nothing new, so it runs once.
  const k = positiveInt(flags.k, "k", flags.mode === "replay" ? 1 : DEFAULT_K, 1);
  const seedBase = positiveInt(flags.seed, "seed", DEFAULT_SEED, 0);
  const rates = parseRates(flags);
  if (flags.mode !== undefined && flags.mode !== "live" && flags.mode !== "replay")
    return failure(env, `Invalid --mode "${flags.mode}": expected "live" or "replay".`);
  const taskIds = flags.tasks
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (flags.tasks !== undefined && (taskIds?.length ?? 0) === 0)
    return failure(env, "--tasks needs at least one task id (a comma-separated list).");
  const suite = await resolveSuite(env, flags, suiteName);
  if (typeof suite === "number") return suite;
  if (suite.origin === "suite-dir" && !(await confirmThirdParty(env, flags, suite.loaded.dir)))
    return 1;
  return {
    loaded: suite.loaded,
    k,
    seedBase,
    ...(taskIds ? { taskIds } : {}),
    ...(rates ? { rates } : {}),
  };
}

function reportDir(env: EvalEnv, flags: EvalFlags, runId: string): string {
  return flags.out ? resolve(flags.out) : join(env.stateDir, "eval", runId);
}

// ---------------------------------------------------------------------------------------------
// Cassettes
// ---------------------------------------------------------------------------------------------

const cassetteDirOf = (flags: EvalFlags, loaded: LoadedSuite): string =>
  flags.cassetteDir ? resolve(flags.cassetteDir) : join(loaded.dir, "cassettes");

const cassetteFile = (dir: string, taskId: string): string => join(dir, `${taskId}.cassette.jsonl`);

/** Ids of the tasks a command works on (all of the suite, or `--tasks`); unknown ids are refused. */
function selectedTaskIds(loaded: LoadedSuite, taskIds: string[] | undefined): string[] {
  const all = loaded.suite.tasks.map((t) => t.id);
  if (!taskIds) return all;
  const unknown = taskIds.find((id) => !all.includes(id));
  if (unknown)
    throw new UsageError(
      `Unknown task "${unknown}" in suite "${loaded.suite.suiteId}". Tasks: ${all.join(", ")}.`,
    );
  return [...new Set(taskIds)];
}

/** Values of environment variables that look like credentials (a cassette holding one is refused). */
function envSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && value)
    .map(([, value]) => value as string);
}

/** What `run --mode replay` prints for a run that diverged: the call, the field and the excerpts. */
function describeDivergence(record: EvalRunRecord): string {
  const divergence = record.divergence;
  if (!divergence) return "";
  const header = `[eval] DIVERGED ${record.taskId}#${record.repetition + 1}: ${divergence.message}\n`;
  const entries = divergence.diff
    .map(
      (d) =>
        `  call ${d.call}: ${d.field}\n    recorded: ${JSON.stringify(d.excerpt.before)}\n    now:      ${JSON.stringify(d.excerpt.after)}\n`,
    )
    .join("");
  return header + entries;
}

export async function evalRun(env: EvalEnv, flags: EvalFlags, suiteName: string): Promise<number> {
  try {
    const prepared = await prepare(env, flags, suiteName);
    if (typeof prepared === "number") return prepared;
    const core = await import("@alisio/core");
    const replaying = flags.mode === "replay";
    const cassettes = new Map<string, import("@alisio/core").Cassette>();
    if (replaying) {
      const dir = cassetteDirOf(flags, prepared.loaded);
      for (const id of selectedTaskIds(prepared.loaded, prepared.taskIds)) {
        const path = cassetteFile(dir, id);
        if (!existsSync(path))
          return failure(
            env,
            `No cassette for task "${id}" at ${path}. Record it with: alisio eval record ${suiteName} --tasks ${id}`,
          );
        cassettes.set(id, core.readCassette(path));
      }
    }
    const runtime = await env
      .openRuntime(flags, replaying ? { requireProvider: false } : undefined)
      .catch((error: unknown) => {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      });
    try {
      const rates = prepared.rates;
      const result = await core.runEvaluation({
        suite: prepared.loaded,
        ...(replaying
          ? {
              mode: "replay" as const,
              cassetteFor: (task: { id: string }) => cassettes.get(task.id),
            }
          : { provider: runtime.provider }),
        config: runtime.config,
        invoker: invokerOf(flags),
        k: prepared.k,
        seedBase: prepared.seedBase,
        builtins: runtime.builtins,
        ...(prepared.taskIds ? { taskIds: prepared.taskIds } : {}),
        ...(flags.allowSuiteFull ? { allowSuiteFull: true } : {}),
        ...(flags.keep ? { keep: true } : {}),
        ...(runtime.resolveAgent ? { resolveAgent: runtime.resolveAgent } : {}),
        ...(env.tmpRoot ? { tmpRoot: env.tmpRoot } : {}),
        onRecord: (record, progress) => {
          env.err(
            `[eval] ${progress.done}/${progress.total} ${record.taskId}#${record.repetition + 1}: ${record.status}${record.error ? ` (${record.error})` : ""}\n`,
          );
          if (flags.json) env.out(`${JSON.stringify(withEstimate(core, record, rates))}\n`);
        },
      });
      const records = result.records.map((r) => withEstimate(core, r, rates));
      const report = core.buildReport(records, {
        seedBase: prepared.seedBase,
        k: prepared.k,
        ...(rates ? { rates } : {}),
      });
      const markdown = core.renderReportMarkdown(report);
      const dir = reportDir(env, flags, env.newRunId());
      writeFiles(dir, {
        "report.json": `${JSON.stringify(report, null, 2)}\n`,
        "report.md": markdown,
        "runs.jsonl": jsonl(records),
      });
      if (flags.json) env.out(`${JSON.stringify(report)}\n`);
      else env.out(`${markdown}\nReport written to ${dir}\n`);
      for (const kept of result.keptDirs) env.err(`Kept run directory: ${kept}\n`);
      for (const record of records) {
        const cassette = cassettes.get(record.taskId);
        if (cassette && cassette.header.configHash !== record.configHash)
          env.err(
            `[eval] warning: task ${record.taskId} was recorded under configuration ${cassette.header.configHash} and replayed under ${record.configHash}; a difference may show up as a divergence.\n`,
          );
      }
      const diverged = records.filter((r) => r.divergence);
      if (diverged.length > 0) {
        env.err(diverged.map(describeDivergence).join(""));
        env.err(
          `${diverged.length} replay(s) diverged from their cassette; the report was written to ${dir}. Re-record the cassette if the change is intended: alisio eval record ${suiteName}\n`,
        );
        return 2;
      }
      if (report.summary.errored > 0)
        return failure(env, infrastructureMessage(report.summary.errored, "report", dir));
      return 0;
    } finally {
      await runtime.close();
    }
  } catch (error) {
    return failure(env, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------------------------

/**
 * Runs each selected task ONCE live and writes its cassette. A task whose run errored, whose
 * recording is unstable, or whose cassette holds a secret or is over the size limits writes
 * nothing and makes the command exit 1; the other tasks are still recorded.
 */
export async function evalRecord(
  env: EvalEnv,
  flags: EvalFlags,
  suiteName: string,
): Promise<number> {
  try {
    if (flags.mode !== undefined && flags.mode !== "live")
      return failure(env, "`alisio eval record` always runs live; --mode is not accepted.");
    if (flags.k !== undefined && flags.k !== "1")
      return failure(env, "`alisio eval record` runs each task once; drop --k.");
    const prepared = await prepare(env, { ...flags, k: "1" }, suiteName);
    if (typeof prepared === "number") return prepared;
    const core = await import("@alisio/core");
    const dir = cassetteDirOf(flags, prepared.loaded);
    const runtime = await env.openRuntime(flags).catch((error: unknown) => {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    });
    try {
      const recorders = new Map<string, import("@alisio/core").CassetteRecorder>();
      const result = await core.runEvaluation({
        suite: prepared.loaded,
        provider: runtime.provider,
        mode: "record",
        cassetteFor: (task) => {
          const recorder = new core.CassetteRecorder();
          recorders.set(task.id, recorder);
          return recorder;
        },
        config: runtime.config,
        invoker: invokerOf(flags),
        k: 1,
        seedBase: prepared.seedBase,
        builtins: runtime.builtins,
        ...(prepared.taskIds ? { taskIds: prepared.taskIds } : {}),
        ...(flags.allowSuiteFull ? { allowSuiteFull: true } : {}),
        ...(flags.keep ? { keep: true } : {}),
        ...(runtime.resolveAgent ? { resolveAgent: runtime.resolveAgent } : {}),
        ...(env.tmpRoot ? { tmpRoot: env.tmpRoot } : {}),
        onRecord: (record, progress) => {
          env.err(
            `[eval] ${progress.done}/${progress.total} ${record.taskId}: ${record.status}${record.error ? ` (${record.error})` : ""}\n`,
          );
          if (flags.json) env.out(`${JSON.stringify(record)}\n`);
        },
      });
      const secrets = [...(runtime.secrets ?? []), ...envSecrets()];
      const failures: string[] = [];
      const written: string[] = [];
      for (const record of result.records) {
        const recorder = recorders.get(record.taskId);
        if (!recorder) continue;
        if (record.status === "error") {
          failures.push(`${record.taskId}: not recorded (${record.error ?? "the run errored"}).`);
          continue;
        }
        try {
          const path = cassetteFile(dir, record.taskId);
          core.writeCassette(
            path,
            recorder.toCassette({
              suiteId: record.suiteId,
              taskId: record.taskId,
              harnessVersion: record.harnessVersion,
              configHash: record.configHash,
              recordedAt: record.startedAt,
              provider: record.provider,
              model: record.model,
            }),
            { secrets },
          );
          written.push(path);
          if (record.status !== "pass")
            env.err(
              `[eval] warning: ${record.taskId} ended "${record.status}"; its cassette records that run as it happened.\n`,
            );
        } catch (error) {
          failures.push(
            `${record.taskId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      for (const kept of result.keptDirs) env.err(`Kept run directory: ${kept}\n`);
      if (!flags.json) for (const path of written) env.out(`Recorded ${path}\n`);
      if (failures.length > 0) {
        env.err(`${failures.join("\n")}\n`);
        return 1;
      }
      return 0;
    } finally {
      await runtime.close();
    }
  } catch (error) {
    return failure(env, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------------------------

async function readReport(path: string): Promise<EvalReport> {
  const { parseReport } = await import("@alisio/core");
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "report.json") : path;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new UsageError(
      `Cannot read the report ${file}. Pass a report.json or the directory that holds it.`,
    );
  }
  try {
    return parseReport(JSON.parse(text));
  } catch (error) {
    throw new UsageError(
      error instanceof SyntaxError ? `${file} is not valid JSON.` : (error as Error).message,
    );
  }
}

export async function evalCompare(
  env: EvalEnv,
  flags: EvalFlags,
  pathA: string,
  pathB: string,
): Promise<number> {
  try {
    const core = await import("@alisio/core");
    const [a, b] = [await readReport(resolve(pathA)), await readReport(resolve(pathB))];
    let comparison: EvalComparison;
    try {
      comparison = core.compareReports(a, b);
    } catch (error) {
      if (error instanceof core.EvalCompareError) return failure(env, error.message, 3);
      throw error;
    }
    env.out(
      flags.json ? `${JSON.stringify(comparison)}\n` : core.renderComparisonMarkdown(comparison),
    );
    return 0;
  } catch (error) {
    return failure(env, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------
// variants
// ---------------------------------------------------------------------------------------------

export async function evalVariants(
  env: EvalEnv,
  flags: EvalFlags,
  suiteName: string,
): Promise<number> {
  try {
    if (flags.mode === "replay")
      return failure(
        env,
        "`alisio eval variants` compares strategies against a live model; replay serves a fixed recording and cannot tell variants apart.",
      );
    if (!flags.variants) return failure(env, "Pass --variants compare.json (the variants file).");
    const core = await import("@alisio/core");
    const file = core.loadVariantsFile(resolve(flags.variants));
    const prepared = await prepare(env, flags, suiteName);
    if (typeof prepared === "number") return prepared;
    const suiteId = prepared.loaded.suite.suiteId;
    if (file.suite !== suiteId && file.suite !== suiteName)
      return failure(
        env,
        `The variants file is for suite "${file.suite}" but the suite is "${suiteId}". Use a file written for this suite.`,
      );
    const runtime = await env.openRuntime(flags).catch((error: unknown) => {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    });
    try {
      // Every override is validated before the first run: one bad key rejects the file.
      const variants = core.resolveVariants(file, runtime.config);
      const rates = prepared.rates;
      const root = reportDir(env, flags, env.newRunId());
      const reports: Array<{
        id: string;
        report: EvalReport;
        overrides: Record<string, unknown>;
      }> = [];
      const kept: string[] = [];
      // Interleaved at each plan step (A,B then B,A ...) so provider drift is spread over the
      // variants instead of landing on whichever ran last. Same tasks, repetitions and seeds.
      const results = await core.runVariantEvaluations({
        suite: prepared.loaded,
        provider: runtime.provider,
        variants,
        invoker: invokerOf(flags),
        k: prepared.k,
        seedBase: prepared.seedBase,
        builtins: runtime.builtins,
        ...(prepared.taskIds ? { taskIds: prepared.taskIds } : {}),
        ...(flags.allowSuiteFull ? { allowSuiteFull: true } : {}),
        ...(flags.keep ? { keep: true } : {}),
        ...(runtime.resolveAgent ? { resolveAgent: runtime.resolveAgent } : {}),
        ...(env.tmpRoot ? { tmpRoot: env.tmpRoot } : {}),
        onRecord: (id, record, progress) =>
          env.err(
            `[eval] ${id} ${progress.done}/${progress.total} ${record.taskId}#${record.repetition + 1}: ${record.status}\n`,
          ),
      });
      for (const result of results) {
        const overrides = file.variants.find((v) => v.id === result.id)?.overrides ?? {};
        kept.push(...result.keptDirs);
        const records = result.records.map((r) => withEstimate(core, r, rates));
        const report = core.buildReport(records, {
          seedBase: prepared.seedBase,
          k: prepared.k,
          variant: { id: result.id, overrides },
          ...(rates ? { rates } : {}),
        });
        writeFiles(join(root, result.id), {
          "report.json": `${JSON.stringify(report, null, 2)}\n`,
          "report.md": core.renderReportMarkdown(report),
          "runs.jsonl": jsonl(records),
        });
        if (flags.json)
          env.out(`${JSON.stringify({ type: "variant_report", variant: result.id, report })}\n`);
        reports.push({ id: result.id, report, overrides });
      }
      let comparison: ReturnType<typeof core.compareVariants>;
      try {
        comparison = core.compareVariants(reports);
      } catch (error) {
        if (error instanceof core.EvalCompareError) return failure(env, error.message, 3);
        throw error;
      }
      const markdown = core.renderVariantComparisonMarkdown(comparison);
      writeFiles(root, {
        "comparison.json": `${JSON.stringify(comparison, null, 2)}\n`,
        "comparison.md": markdown,
      });
      if (flags.json) env.out(`${JSON.stringify({ type: "comparison", comparison })}\n`);
      else env.out(`${markdown}\nReports written to ${root}\n`);
      for (const dir of kept) env.err(`Kept run directory: ${dir}\n`);
      const errored = reports.reduce((n, r) => n + r.report.summary.errored, 0);
      if (errored > 0) return failure(env, infrastructureMessage(errored, "reports", root));
      return 0;
    } finally {
      await runtime.close();
    }
  } catch (error) {
    return failure(env, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Writes ONE shareable JSON bundle `{schemaVersion, report, runs, markdown}` of the stored run
 * `<stateDir>/eval/<runId>/`, scrubbed of absolute paths and secrets. A secret hit refuses it
 * (exit 1). The file is local: nothing is uploaded.
 */
export async function evalExport(env: EvalEnv, flags: EvalFlags, runId: string): Promise<number> {
  try {
    if (!flags.out) throw new UsageError("export needs --out FILE, the bundle to write.");
    if (!RUN_ID.test(runId) || runId.includes(".."))
      throw new UsageError(
        `Invalid run id "${runId}": use the directory name under <state>/eval/ (letters, digits, '.', '_', '-'; no path separators).`,
      );
    const dir = join(env.stateDir, "eval", runId);
    if (!existsSync(join(dir, "report.json")))
      throw new UsageError(
        `No run "${runId}" with a report.json under ${join(env.stateDir, "eval")}.`,
      );
    const target = resolve(flags.out);
    if (existsSync(target) && !flags.force)
      throw new UsageError(`${target} already exists. Pass --force to overwrite it.`);
    const core = await import("@alisio/core");
    const report = await readReport(dir);
    const runsText = existsSync(join(dir, "runs.jsonl"))
      ? readFileSync(join(dir, "runs.jsonl"), "utf8")
      : "";
    let runs: EvalRunRecord[];
    try {
      runs = runsText
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as EvalRunRecord);
    } catch {
      throw new UsageError(`${join(dir, "runs.jsonl")} is not valid JSONL.`);
    }
    const markdownFile = join(dir, "report.md");
    const markdown = existsSync(markdownFile)
      ? readFileSync(markdownFile, "utf8")
      : core.renderReportMarkdown(report);
    const roots = [
      { path: resolve(dir), placeholder: "<run-dir>" },
      { path: resolve(env.stateDir), placeholder: "<state>" },
      ...(env.tmpRoot ? [{ path: resolve(env.tmpRoot), placeholder: "<tmp>" }] : []),
      { path: tmpdir(), placeholder: "<tmp>" },
      { path: homedir(), placeholder: "<home>" },
    ];
    const bundle = core.buildExportBundle(
      { report, runs, markdown },
      { roots, secrets: envSecrets() },
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, {
      flag: flags.force ? "w" : "wx",
    });
    env.out(`Exported run ${runId} to ${target}\n`);
    return 0;
  } catch (error) {
    return failure(env, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------------------------
// Real environment
// ---------------------------------------------------------------------------------------------

type CliAppOptions = import("@alisio/core").AppOptions;

/** `tests/fixtures/eval` of a source checkout; undefined where the URL is not a file (a binary). */
function bundledSuitesDir(): string | undefined {
  try {
    return fileURLToPath(new URL("../../../tests/fixtures/eval", import.meta.url));
  } catch {
    return undefined;
  }
}

/**
 * The real environment of `alisio eval`: the provider is resolved from the same sources as
 * `alisio run` (flags, saved profile, trusted config) through a throwaway Application that only
 * lends its provider and configuration. It does not carry the invoker's `--read-only`, which
 * would stop the provider plugins from loading; the permissions the runs get come from
 * `InvokerPermissions` instead. Its in-memory database never touches the user's sessions.
 */
export async function realEvalEnv(
  appOptions: (flags: EvalFlags) => Promise<CliAppOptions>,
  defaults: () => Promise<{ builtins: BuiltinPlugin[] }>,
): Promise<EvalEnv> {
  const core = await import("@alisio/core");
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    stateDir: core.stateHome(),
    bundledDir: bundledSuitesDir(),
    interactive: !!process.stdin.isTTY && !!process.stderr.isTTY,
    newRunId: () => new Date().toISOString().replace(/[:.]/g, "-"),
    async confirm(question) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
    async openRuntime(flags, runtimeOptions) {
      const { builtins } = await defaults();
      const disabled = new Set(flags.disablePlugin ?? []);
      const kept = builtins.filter((b) => !disabled.has(b.id));
      const app = await core.createApplication({
        ...(await appOptions(flags)),
        builtins,
        readOnly: false,
        noHerdr: true,
        db: ":memory:",
      });
      if (app.provider.id === "unconfigured" && runtimeOptions?.requireProvider !== false) {
        await app.close();
        throw new Error(
          "No model provider is configured. Connect one first (/connect in the TUI), or pass --model and --base-url.",
        );
      }
      // Exact credential values of the active profile, so a cassette that holds one is refused.
      const profile = await new core.ProviderSettingsStore().active().catch(() => undefined);
      const { mcpSources: _sources, ...config } = app.config;
      const resolveAgent: ResolveAgent = (running, agent) => {
        const catalog = core.agentCatalogFromState(
          running.plugins.pluginState("subagents", "mainAgents"),
        );
        const found = catalog.find((a) => a.id === agent);
        if (!found)
          throw new Error(
            `Task names agent "${agent}", which is not available here (known: ${catalog.map((a) => a.id).join(", ") || "none"}).`,
          );
        return core.agentRunOptions(found, { plan: running.config.plan });
      };
      return {
        provider: app.provider,
        config: config as Config,
        builtins: kept,
        secrets: Object.values(profile?.credentials ?? {}),
        resolveAgent,
        close: () => app.close(),
      };
    },
  };
}
