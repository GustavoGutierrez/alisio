/**
 * Phase 0 baseline of the reliability lab (specs/010 §8). NOT part of `pnpm check`: live mode calls
 * a real model and costs tokens. It runs 3 hand-written smoke-coding tasks k times each through the
 * real Application (runner, tools, store) on throwaway copies under os.tmpdir(), then reports per
 * task: success rate, median and variance of tokens and wall time (measured), and infrastructure
 * failures (runner/provider errors), which are NOT task failures. Cost is never invented.
 *
 *   node --conditions=alisio-source --experimental-transform-types \
 *     --disable-warning=ExperimentalWarning scripts/eval-baseline.ts [--k 5] [--seed N] [--out file]
 *
 * `--experimental-transform-types` (not strip-only) is needed because it imports the core sources,
 * which use parameter properties. Bun works too where `node:sqlite` is available (Bun >= 1.4.2).
 *
 * Provider: the one the owner already configured (the `/connect` profile); or set
 * ALISIO_BENCH_MODEL and ALISIO_BENCH_BASE_URL (the API key is read by Alisio itself from the
 * provider's apiKeyEnv; this script never reads, prints or stores it). Exit code 2 on a usage error.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createApplication } from "../packages/core/src/index.ts";
import { BenchUsageError, mulberry32, PARAMS_USAGE, readBenchParams } from "./bench/lib.ts";

export const DEFAULT_K = 5;
export const DEFAULT_BASELINE_SEED = 0x5eed1234;

export interface BaselineTask {
  id: string;
  prompt: string;
  /** Fixture files (relative path -> content), written into the throwaway copy. */
  files: Record<string, string>;
}

const CHECK_PRELUDE = `import assert from "node:assert/strict";\n`;

/** Tiny hand-written `smoke-coding` fixtures. `check.ts` is the deterministic verifier. */
export const TASKS: BaselineTask[] = [
  {
    id: "fix-add",
    prompt:
      "The function add in src/math.ts returns the wrong result. Fix it so add(2, 3) returns 5. Change only src/math.ts.",
    files: {
      "src/math.ts": "export const add = (a: number, b: number) => a - b;\n",
      "check.ts": `${CHECK_PRELUDE}import { add } from "./src/math.ts";\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\n`,
    },
  },
  {
    id: "add-slugify",
    prompt:
      "In src/strings.ts add and export slugify(s): lowercase, trim, replace every run of non-alphanumeric characters with a single '-', and strip leading and trailing '-'. Keep capitalize unchanged.",
    files: {
      "src/strings.ts":
        "export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);\n",
      "check.ts": `${CHECK_PRELUDE}import { capitalize, slugify } from "./src/strings.ts";\nassert.equal(capitalize("alisio"), "Alisio");\nassert.equal(slugify("  Hello, World!  "), "hello-world");\nassert.equal(slugify("a--b"), "a-b");\n`,
    },
  },
  {
    id: "implement-chunk",
    prompt:
      "In src/list.ts implement chunk<T>(items: T[], size: number): T[][] that splits items into consecutive arrays of at most size elements. It currently throws.",
    files: {
      "src/list.ts":
        'export function chunk<T>(_items: T[], _size: number): T[][] {\n  throw new Error("not implemented");\n}\n',
      "check.ts": `${CHECK_PRELUDE}import { chunk } from "./src/list.ts";\nassert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);\nassert.deepEqual(chunk([], 3), []);\n`,
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Sample variance (n - 1); null below two samples. */
export function sampleVariance(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
}

/** Every (task, repetition) pair exactly once, in a seeded order so drift is not task-correlated. */
export function planOrder(
  taskIds: string[],
  k: number,
  seed: number,
): Array<{ task: string; repetition: number }> {
  const plan = taskIds.flatMap((task) =>
    Array.from({ length: k }, (_, repetition) => ({ task, repetition })),
  );
  const random = mulberry32(seed);
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [plan[i], plan[j]] = [plan[j] as (typeof plan)[number], plan[i] as (typeof plan)[number]];
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

type App = Awaited<ReturnType<typeof createApplication>>;
export type AppFactory = (input: { cwd: string; db: string }) => Promise<App>;

export interface Spread {
  samples: number;
  median: number | null;
  variance: number | null;
}
export interface TaskReport {
  id: string;
  runs: number;
  successes: number;
  successRate: number;
  /** Completed runs whose verifier failed (or that hit the turn limit). */
  taskFailures: number;
  /** Runner/provider errors: the run could not be judged. Not counted as task failures. */
  infraFailures: number;
  measured: { tokens: Spread; wallMs: Spread };
}
export interface BaselineReport {
  generatedAt: string;
  k: number;
  seed: number;
  provider: { id: string; model: string };
  tasks: TaskReport[];
  infraFailures: number;
  /** Provider-reported usage and wall time only. */
  measured: { note: string };
  /** Never filled from guesses: cost needs configured rates, which this baseline does not read. */
  estimated: { costUsd: number | null; note: string };
}

interface RunOutcome {
  infra: boolean;
  passed: boolean;
  tokens?: number;
  wallMs: number;
}

function verify(cwd: string): boolean {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "check.ts"], {
    cwd,
    timeout: 30_000,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
  });
  return result.status === 0;
}

async function runOnce(task: BaselineTask, makeApp: AppFactory, tmpRoot: string) {
  const dir = mkdtempSync(join(tmpRoot, "eval-baseline-"));
  const cwd = join(dir, "ws");
  const started = performance.now();
  let provider = { id: "unknown", model: "unknown" };
  let outcome: RunOutcome;
  try {
    for (const [path, content] of Object.entries(task.files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), content);
    }
    const app = await makeApp({ cwd, db: join(dir, "state.sqlite") });
    try {
      provider = { id: app.provider.id, model: app.provider.model };
      const session = app.store.create(app.workspace, app.provider.id, app.provider.model).id;
      const result = await app.runner.run(session, task.prompt);
      const record = app.store.runs?.(session, { limit: 1 })[0];
      const wallMs = performance.now() - started;
      const usage = record?.usage;
      const tokens = usage ? usage.input + usage.output : undefined;
      if (result.status === "failed" || record?.status === "failed")
        outcome = { infra: true, passed: false, wallMs };
      else
        outcome = {
          infra: false,
          passed: result.status === "completed" && verify(cwd),
          wallMs,
          ...(tokens === undefined ? {} : { tokens }),
        };
    } finally {
      await app.close();
    }
  } catch (error) {
    if (error instanceof BenchUsageError) throw error;
    outcome = { infra: true, passed: false, wallMs: performance.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { outcome, provider };
}

const spread = (values: number[]): Spread => ({
  samples: values.length,
  median: median(values),
  variance: sampleVariance(values),
});

export async function runBaseline(options: {
  k?: number;
  seed?: number;
  makeApp: AppFactory;
  tasks?: BaselineTask[];
  tmpRoot?: string;
  onProgress?: (message: string) => void;
}): Promise<BaselineReport> {
  const k = options.k ?? DEFAULT_K;
  if (!Number.isInteger(k) || k < 1) throw new BenchUsageError("k must be a positive integer.");
  const seed = options.seed ?? DEFAULT_BASELINE_SEED;
  const tasks = options.tasks ?? TASKS;
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const outcomes = new Map<string, RunOutcome[]>(tasks.map((t) => [t.id, []]));
  let provider = { id: "unknown", model: "unknown" };
  const plan = planOrder(
    tasks.map((t) => t.id),
    k,
    seed,
  );
  for (const [index, step] of plan.entries()) {
    const task = tasks.find((t) => t.id === step.task) as BaselineTask;
    const ran = await runOnce(task, options.makeApp, tmpRoot);
    if (ran.provider.id !== "unknown") provider = ran.provider;
    outcomes.get(task.id)?.push(ran.outcome);
    options.onProgress?.(
      `${index + 1}/${plan.length} ${task.id}#${step.repetition + 1}: ${
        ran.outcome.infra ? "infra failure" : ran.outcome.passed ? "pass" : "fail"
      }`,
    );
  }
  const reports: TaskReport[] = tasks.map((task) => {
    const runs = outcomes.get(task.id) ?? [];
    const judged = runs.filter((r) => !r.infra);
    const successes = judged.filter((r) => r.passed).length;
    return {
      id: task.id,
      runs: runs.length,
      successes,
      successRate: runs.length ? successes / runs.length : 0,
      taskFailures: judged.length - successes,
      infraFailures: runs.length - judged.length,
      measured: {
        tokens: spread(judged.flatMap((r) => (r.tokens === undefined ? [] : [r.tokens]))),
        wallMs: spread(judged.map((r) => r.wallMs)),
      },
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    k,
    seed,
    provider,
    tasks: reports,
    infraFailures: reports.reduce((n, t) => n + t.infraFailures, 0),
    measured: {
      note: "tokens = provider-reported input+output of RunRecord.usage; wallMs = run wall time; infrastructure failures are excluded from spreads and from taskFailures.",
    },
    estimated: {
      costUsd: null,
      note: "not computed: no configured rates are read, nothing is guessed.",
    },
  };
}

/**
 * Live mode: the owner's configured provider (or ALISIO_BENCH_MODEL + ALISIO_BENCH_BASE_URL over
 * the configured credentials). Throws `BenchUsageError` when no provider is configured.
 */
export function createLiveAppFactory(env: Record<string, string | undefined>): AppFactory {
  const override =
    env.ALISIO_BENCH_MODEL || env.ALISIO_BENCH_BASE_URL ? readBenchParams(env) : undefined;
  return async ({ cwd, db }) => {
    const app = await createApplication({
      cwd,
      db,
      noHerdr: true,
      allowWrite: true,
      ...(override ? { model: override.model, baseURL: override.baseUrl } : {}),
    });
    if (app.provider.id === "unconfigured") {
      await app.close();
      throw new BenchUsageError(
        `No model provider is configured. Connect one first (/connect in the TUI) or set ALISIO_BENCH_MODEL and ALISIO_BENCH_BASE_URL. ${PARAMS_USAGE}`,
      );
    }
    return app;
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: eval-baseline.ts [options]

Runs ${TASKS.length} smoke-coding tasks k times each against the configured provider (costs tokens).
  ${PARAMS_USAGE}

Options:
  --k <n>        Repetitions per task (default ${DEFAULT_K})
  --seed <n>     Seed of the run order (default ${DEFAULT_BASELINE_SEED})
  --out <file>   Also write the JSON report to this file
  -h, --help     This text
`;

function parsePositive(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new BenchUsageError(`Invalid --${name}.`);
  return n;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      k: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const k = parsePositive(values.k, "k", DEFAULT_K);
  const seed = parsePositive(values.seed, "seed", DEFAULT_BASELINE_SEED);
  const report = await runBaseline({
    k,
    seed,
    makeApp: createLiveAppFactory(process.env),
    onProgress: (message) => process.stderr.write(`[eval-baseline] ${message}\n`),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) writeFileSync(resolve(values.out), json);
  process.stdout.write(json);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof BenchUsageError) {
        process.stderr.write(`${message}\n\n${USAGE}`);
        process.exit(2);
      }
      process.stderr.write(`eval-baseline failed: ${message}\n`);
      process.exit(1);
    },
  );
}
