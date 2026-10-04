/**
 * Shared library of the manual benchmark harnesses (`scripts/bench-dashboard.ts` today; the routing
 * and model-tier benchmarks reuse it). It generates seeded datasets, runs `alisio run --json` in an
 * isolated config/state/database, derives the metrics from what Alisio PERSISTED (never from what
 * the model says), checks that one model answered the whole series and writes a results document
 * that never carries a secret.
 *
 * Secrets: the API key follows the provider's own mechanism (`apiKeyEnv`, default
 * `OPENAI_API_KEY`). This library never reads it by name; the child process simply inherits the
 * environment it is given. `readBenchParams` touches only the two `ALISIO_BENCH_*` variables.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chartWarnings } from "../../packages/core/src/artifacts/chart-lint.ts";

// ---------------------------------------------------------------------------------------------
// Errors and parameters
// ---------------------------------------------------------------------------------------------

/** A wrong invocation: missing parameters or an unsupported combination. Exit code 2. */
export class BenchUsageError extends Error {
  override name = "BenchUsageError";
}
/** More than one model answered the series: its numbers are not comparable and are discarded. */
export class SeriesDiscardedError extends Error {
  override name = "SeriesDiscardedError";
}

export interface BenchParams {
  /** `ALISIO_BENCH_MODEL`: passed as `--model` to every run of every variant. */
  model: string;
  /** `ALISIO_BENCH_BASE_URL`: passed as `--base-url`; never written to the results. */
  baseUrl: string;
  /** `URL.host` of the endpoint: no scheme, credentials, path or query. */
  endpointHost: string;
}

export const PARAMS_USAGE =
  "Set ALISIO_BENCH_MODEL (model id) and ALISIO_BENCH_BASE_URL (OpenAI-compatible endpoint, " +
  "including /v1 if needed). The API key is read by Alisio itself from the provider's apiKeyEnv " +
  "(default OPENAI_API_KEY); this harness never reads, prints or stores it.";

/** `URL.host` only (`host:port`, no credentials, scheme, path or query). */
export function endpointHost(baseUrl: string): string {
  return new URL(baseUrl).host;
}

type Env = Record<string, string | undefined>;

/** Reads the two required variables (and only those); throws `BenchUsageError` otherwise. */
export function readBenchParams(env: Env): BenchParams {
  const model = env.ALISIO_BENCH_MODEL?.trim();
  const baseUrl = env.ALISIO_BENCH_BASE_URL?.trim();
  const missing = [
    ...(model ? [] : ["ALISIO_BENCH_MODEL"]),
    ...(baseUrl ? [] : ["ALISIO_BENCH_BASE_URL"]),
  ];
  if (missing.length || !model || !baseUrl)
    throw new BenchUsageError(`Missing ${missing.join(" and ")}. ${PARAMS_USAGE}`);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new BenchUsageError(`ALISIO_BENCH_BASE_URL is not a valid URL. ${PARAMS_USAGE}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new BenchUsageError(`ALISIO_BENCH_BASE_URL must be http(s). ${PARAMS_USAGE}`);
  return { model, baseUrl, endpointHost: url.host };
}

// ---------------------------------------------------------------------------------------------
// Seeded datasets
// ---------------------------------------------------------------------------------------------

/** Deterministic PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DATASET_KINDS = ["sales", "operations", "inventory", "tickets", "opaque"] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];
/** Row counts of the three sizes (small, medium, large). */
export const DATASET_SIZES = [1_000, 50_000, 500_000] as const;
export const DEFAULT_SEED = 0x5eed1234;

type Rand = () => number;
const pick = <T>(r: Rand, values: readonly T[]): T => values[Math.floor(r() * values.length)] as T;
/** Skewed pick: the first values are much more frequent (realistic category mixes). */
const skew = <T>(r: Rand, values: readonly T[]): T =>
  values[Math.floor(r() ** 1.7 * values.length)] as T;
const int = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const real = (r: Rand, lo: number, hi: number) => (lo + r() * (hi - lo)).toFixed(2);
const pad = (n: number, width: number) => String(n).padStart(width, "0");
const BASE_DAY = Date.UTC(2023, 0, 1);
const isoDate = (r: Rand, days = 730) =>
  new Date(BASE_DAY + int(r, 0, days - 1) * 86_400_000).toISOString().slice(0, 10);
const isoDateTime = (r: Rand, days = 730) =>
  new Date(BASE_DAY + int(r, 0, days - 1) * 86_400_000 + int(r, 0, 86_399) * 1000)
    .toISOString()
    .slice(0, 19);
const sparse = (r: Rand, ratio: number, value: string) => (r() < ratio ? "" : value);

interface DatasetSpec {
  columns: string[];
  row(i: number, r: Rand): Array<string | number>;
}
const REGIONS = ["West", "East", "North", "South"] as const;
const SPECS: Record<DatasetKind, DatasetSpec> = {
  sales: {
    columns: [
      "order_id",
      "order_date",
      "region",
      "channel",
      "category",
      "seller",
      "product_sku",
      "quantity",
      "unit_price",
      "revenue",
      "cost",
      "discount",
      "status",
    ],
    row(i, r) {
      const quantity = int(r, 1, 20);
      const price = Number(real(r, 5, 400));
      const revenue = quantity * price;
      return [
        `ORD-${pad(i + 1, 7)}`,
        isoDate(r),
        skew(r, REGIONS),
        skew(r, ["Online", "Retail", "Partners"]),
        skew(r, ["Electronics", "Home", "Toys", "Sports", "Beauty", "Books"]),
        pick(
          r,
          Array.from({ length: 12 }, (_, k) => `Seller ${k + 1}`),
        ),
        `SKU-${pad(int(r, 1, 3000), 5)}`,
        quantity,
        price.toFixed(2),
        revenue.toFixed(2),
        (revenue * (0.5 + r() * 0.3)).toFixed(2),
        sparse(r, 0.03, real(r, 0, 0.3)),
        skew(r, ["Delivered", "In transit", "Cancelled", "Returned"]),
      ];
    },
  },
  operations: {
    columns: [
      "job_id",
      "started_at",
      "site",
      "shift",
      "machine_id",
      "status",
      "operator",
      "duration_min",
      "units_produced",
      "defects",
      "energy_kwh",
    ],
    row(i, r) {
      const units = int(r, 20, 900);
      return [
        `JOB-${pad(i + 1, 7)}`,
        `${isoDateTime(r)}Z`,
        skew(r, [
          "Plant A",
          "Plant B",
          "Plant C",
          "Plant D",
          "Plant E",
          "Plant F",
          "Plant G",
          "Plant H",
        ]),
        pick(r, ["Morning", "Afternoon", "Night"]),
        `M-${pad(int(r, 1, 400), 4)}`,
        skew(r, ["Completed", "Running", "Stopped", "Failed"]),
        pick(
          r,
          Array.from({ length: 25 }, (_, k) => `Operator ${k + 1}`),
        ),
        real(r, 5, 480),
        units,
        Math.floor(units * r() * 0.05),
        real(r, 1, 250),
      ];
    },
  },
  inventory: {
    columns: [
      "sku",
      "warehouse",
      "category",
      "supplier",
      "last_restock",
      "stock_qty",
      "reorder_level",
      "unit_cost",
      "unit_price",
      "discontinued",
    ],
    row(i, r) {
      const cost = Number(real(r, 1, 250));
      return [
        `INV-${pad(i + 1, 7)}`,
        skew(r, ["Bogota", "Medellin", "Cali", "Barranquilla", "Bucaramanga", "Cartagena"]),
        skew(r, [
          "Tools",
          "Electrical",
          "Plumbing",
          "Paint",
          "Garden",
          "Safety",
          "Fasteners",
          "Lighting",
        ]),
        pick(
          r,
          Array.from({ length: 15 }, (_, k) => `Supplier ${k + 1}`),
        ),
        isoDate(r),
        int(r, 0, 5000),
        int(r, 10, 500),
        cost.toFixed(2),
        (cost * (1.1 + r() * 0.8)).toFixed(2),
        r() < 0.08 ? "true" : "false",
      ];
    },
  },
  tickets: {
    columns: [
      "ticket_id",
      "created_at",
      "priority",
      "status",
      "category",
      "assignee",
      "customer_id",
      "resolution_hours",
      "handle_minutes",
      "satisfaction",
      "reopened",
    ],
    row(i, r) {
      return [
        `TCK-${pad(i + 1, 7)}`,
        `${isoDateTime(r)}${pick(r, ["Z", "Z", "+05:30", "-05:00"])}`,
        skew(r, ["Low", "Medium", "High", "Urgent"]),
        skew(r, ["Closed", "Open", "Pending", "On hold", "Escalated"]),
        skew(r, ["Billing", "Access", "Bug", "Question", "Feature", "Outage", "Other"]),
        pick(
          r,
          Array.from({ length: 20 }, (_, k) => `Agent ${k + 1}`),
        ),
        `CUS-${pad(int(r, 1, 100_000), 6)}`,
        real(r, 0.2, 240),
        int(r, 1, 180),
        int(r, 1, 5),
        r() < 0.12 ? "true" : "false",
      ];
    },
  },
  opaque: {
    columns: "abcdefghijklm".split("").map((c) => `col_${c}`),
    row(i, r) {
      return [
        i + 1,
        isoDate(r),
        real(r, 0, 1000),
        real(r, -50, 50),
        real(r, 10, 99),
        int(r, 0, 500),
        skew(r, ["alpha", "beta", "gamma", "delta", "epsilon"]),
        pick(r, ["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
        pick(r, ["x", "y", "z"]),
        `k-${int(r, 1, 5000)}`,
        r() < 0.5 ? "true" : "false",
        int(r, 1, 5),
        `${isoDateTime(r)}Z`,
      ];
    },
  },
};

export const datasetColumns = (kind: DatasetKind): string[] => [...SPECS[kind].columns];

const kindSeed = (kind: DatasetKind, seed: number): number => {
  let h = 2166136261;
  for (const ch of kind) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h ^ seed) >>> 0;
};

/** The header and `rows` data lines of a dataset, one line at a time (no trailing newline). */
export function* datasetLines(
  kind: DatasetKind,
  rows: number,
  seed = DEFAULT_SEED,
): Generator<string> {
  const spec = SPECS[kind];
  const r = mulberry32(kindSeed(kind, seed));
  yield spec.columns.join(",");
  for (let i = 0; i < rows; i++) yield spec.row(i, r).join(",");
}

/** A whole dataset as CSV text (small sizes; large ones go through `writeDatasetFile`). */
export function datasetCsv(kind: DatasetKind, rows: number, seed = DEFAULT_SEED): string {
  return `${[...datasetLines(kind, rows, seed)].join("\n")}\n`;
}

/** Writes a dataset to `path` in batches (the 500 000-row ones are ~50 MB). */
export function writeDatasetFile(
  path: string,
  kind: DatasetKind,
  rows: number,
  seed = DEFAULT_SEED,
): void {
  const fd = openSync(path, "w");
  try {
    let batch: string[] = [];
    for (const line of datasetLines(kind, rows, seed)) {
      batch.push(line);
      if (batch.length >= 5000) {
        writeSync(fd, `${batch.join("\n")}\n`);
        batch = [];
      }
    }
    if (batch.length) writeSync(fd, `${batch.join("\n")}\n`);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------------
// Variants and prompts
// ---------------------------------------------------------------------------------------------

export type Variant = "A" | "B" | "C";
export const VARIANTS: readonly Variant[] = ["A", "B", "C"];
export type Lang = "en" | "es";

/**
 * The `config.json` of an isolated `ALISIO_CONFIG_HOME` for one variant.
 *
 * A is the current flow. The `analysis.smartDashboard` key arrives with the Smart Dashboard
 * feature and the config schema is strict, so a build without it would reject the file: A writes
 * `smartDashboard: false` ONLY when the installed Alisio supports the key (probe it with
 * `probeSmartDashboardSupport`); otherwise it writes nothing, which already IS variant A. B and C
 * need the key, so they are refused when it is unsupported.
 */
export function variantConfig(
  variant: Variant,
  support: { smartDashboard: boolean },
  extra: { plugins?: string[] } = {},
): Record<string, unknown> {
  if (variant === "A") return support.smartDashboard ? { analysis: { smartDashboard: false } } : {};
  if (!support.smartDashboard)
    throw new BenchUsageError(
      `Variant ${variant} needs analysis.smartDashboard, which the installed Alisio does not support yet.`,
    );
  return {
    analysis: { smartDashboard: true },
    decisions: { provider: variant === "C" ? "laya" : null },
    // The isolated config home sees no globally installed plugin: C gets the plugin by path.
    ...(variant === "C" && extra.plugins?.length ? { plugins: extra.plugins } : {}),
  };
}

/** The fixed dashboard prompt (same for every variant; it names the file, never a tool). */
export function dashboardPrompt(lang: Lang, fileName: string): string {
  return lang === "es"
    ? `Crea un dashboard profesional con los datos del archivo "${fileName}" del espacio de trabajo. Muestra las metricas clave, las tendencias y los desgloses importantes, y publicalo como un panel interactivo.`
    : `Build a professional dashboard from the data file "${fileName}" in the workspace. Show the key metrics, trends and breakdowns that matter, and publish it as an interactive dashboard.`;
}

// ---------------------------------------------------------------------------------------------
// Running alisio
// ---------------------------------------------------------------------------------------------

export interface RunSpec {
  /** The executable and its leading arguments, e.g. `["node", "packages/cli/dist/main.js"]`. */
  command: string[];
  params: BenchParams;
  variant: Variant;
  supportsSmartDashboard: boolean;
  /** Plugin paths loaded by variant C (e.g. the extracted `@alisio/plugin-laya`). */
  plugins?: string[];
  workspace: string;
  /** Holds `config/`, `state/` and `sessions.sqlite` of this run. */
  runDir: string;
  prompt: string;
  /** Environment of the child (inherited as given; carries the provider key untouched). */
  env: Env;
  timeoutMs?: number;
}
export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  dbPath: string;
}
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;

function childEnv(base: Env, configHome: string, stateHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  // The flags carry the model and endpoint; stale variables must not compete with them.
  delete env.ALISIO_MODEL;
  delete env.OPENAI_BASE_URL;
  env.ALISIO_CONFIG_HOME = configHome;
  env.ALISIO_STATE_HOME = stateHome;
  return env;
}

function execute(
  command: string[],
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ exitCode: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const [bin, ...lead] = command;
    if (!bin) throw new BenchUsageError("The alisio command is empty.");
    const child = spawn(bin, [...lead, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    // Only the tail is kept (error detection); stdout is JSONL we do not need: the DB is the truth.
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, timedOut, output });
    });
  });
}

/** Runs one `alisio run --json` in an isolated config home, state home and database. */
export async function runAlisio(spec: RunSpec): Promise<RunOutcome> {
  const configHome = join(spec.runDir, "config");
  const stateHome = join(spec.runDir, "state");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  const dbPath = join(spec.runDir, "sessions.sqlite");
  writeFileSync(
    join(configHome, "config.json"),
    JSON.stringify(
      variantConfig(
        spec.variant,
        { smartDashboard: spec.supportsSmartDashboard },
        { plugins: spec.plugins ?? [] },
      ),
      null,
      2,
    ),
  );
  const started = performance.now();
  const result = await execute(
    spec.command,
    [
      "run",
      "--json",
      "--db",
      dbPath,
      "--cwd",
      spec.workspace,
      "--allow-analysis",
      "--model",
      spec.params.model,
      "--base-url",
      spec.params.baseUrl,
      spec.prompt,
    ],
    {
      cwd: spec.workspace,
      env: childEnv(spec.env, configHome, stateHome),
      timeoutMs: spec.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    },
  );
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: Math.round(performance.now() - started),
    dbPath,
  };
}

/**
 * Whether the installed Alisio accepts `analysis.smartDashboard` in its (strict) config: runs it
 * once against an unreachable endpoint. Configuration is validated before any network use, so an
 * unsupported key fails fast naming `smartDashboard`; anything else counts as supported.
 */
export async function probeSmartDashboardSupport(options: {
  command: string[];
  env: Env;
  dir: string;
}): Promise<boolean> {
  const configHome = join(options.dir, "config");
  const workspace = join(options.dir, "workspace");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(configHome, "config.json"),
    JSON.stringify({ analysis: { smartDashboard: true } }),
  );
  const result = await execute(
    options.command,
    [
      "run",
      "--json",
      "--db",
      join(options.dir, "sessions.sqlite"),
      "--cwd",
      workspace,
      "--model",
      "probe",
      "--base-url",
      "http://127.0.0.1:9/v1",
      "probe",
    ],
    {
      cwd: workspace,
      env: childEnv(options.env, configHome, join(options.dir, "state")),
      timeoutMs: 30_000,
    },
  );
  return !(result.exitCode !== 0 && !result.timedOut && /smartDashboard/.test(result.output));
}

// ---------------------------------------------------------------------------------------------
// Persisted events and metrics
// ---------------------------------------------------------------------------------------------

export interface BenchEvent {
  seq: number;
  session: string;
  runId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}
export interface BenchArtifact {
  id: string;
  kind: string;
  fileName: string;
  status: string;
  provenance: unknown;
  createdAt: number;
}
export interface RunData {
  events: BenchEvent[];
  artifacts: BenchArtifact[];
}

const parseJson = (text: unknown): unknown => {
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
};
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Reads the durable events and artifact rows of one run's session database (read-only). */
export function readRunData(dbPath: string): RunData {
  if (!existsSync(dbPath)) return { events: [], artifacts: [] };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = (sql: string): Array<Record<string, unknown>> => {
      try {
        return db.prepare(sql).all() as Array<Record<string, unknown>>;
      } catch {
        return [];
      }
    };
    return {
      events: rows(
        "SELECT seq, session, run_id, type, body, created_at FROM events ORDER BY seq",
      ).map((r) => ({
        seq: Number(r.seq),
        session: String(r.session),
        runId: String(r.run_id),
        type: String(r.type),
        data: asRecord(parseJson(r.body)),
        createdAt: Number(r.created_at ?? 0),
      })),
      artifacts: rows(
        "SELECT id, kind, file_name, status, provenance, created_at FROM artifacts ORDER BY created_at, id",
      ).map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        fileName: String(r.file_name),
        status: String(r.status),
        provenance: parseJson(r.provenance),
        createdAt: Number(r.created_at ?? 0),
      })),
    };
  } finally {
    db.close();
  }
}

export interface RunMetrics {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCalls: number;
  toolsByName: Record<string, number>;
  pythonRunCalls: number;
  usedPythonRun: boolean;
  /** Milliseconds from the first persisted event to the first dashboard artifact. */
  timeToArtifactMs: number | null;
  dashboardPublished: boolean;
  runFailed: boolean;
  /** `run_failed` `data.error` as recorded; null when the run did not fail or gave no text. */
  failureReason: string | null;
  /** Heuristic class of `failureReason`; null when the run did not fail. */
  failureClass: FailureClass | null;
  /** `tokens` of the last `turn_completed`; null when none carried it. */
  lastTurnTokens: number | null;
  /** The process exited 0 yet no dashboard was published. */
  endedWithoutDashboard: boolean;
  /** A dashboard artifact was published and the run did not fail. */
  success: boolean;
  /** Total `chartWarnings` over the published dashboard HTML. */
  chartWarnings: number;
  /** SHA-256 of the canonical `DashboardSpec` in the artifact provenance (B/C); else null. */
  specHash: string | null;
  /** Widget types of that spec, sorted (duplicates kept); else null. */
  components: string[] | null;
  /** Every `turn_completed.model` seen, in order. */
  models: string[];
}

export type FailureClass = "token_budget" | "time" | "turns" | "other";

/** Heuristic only: the engine records free text, not a code. */
export function classifyFailure(reason: string | null): FailureClass {
  if (reason === null) return "other";
  if (/Token budget/.test(reason)) return "token_budget";
  if (/timed out|timeout/i.test(reason)) return "time";
  if (/max.*turns/i.test(reason)) return "turns";
  return "other";
}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** Derives the metrics of one run from its persisted data. */
export function summarizeRun(
  data: RunData,
  readHtml: (path: string) => string | undefined = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  exitCode?: number | null,
): RunMetrics {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let turns = 0;
  const models: string[] = [];
  const toolsByName: Record<string, number> = {};
  let toolCalls = 0;
  let runFailed = false;
  let failureReason: string | null = null;
  let lastTurnTokens: number | null = null;
  const dashboards: BenchEvent[] = [];
  for (const event of data.events) {
    if (event.type === "turn_completed") {
      turns++;
      const usage = asRecord(event.data.usage);
      inputTokens += Number(usage.input ?? 0);
      outputTokens += Number(usage.output ?? 0);
      cachedInputTokens += Number(usage.cachedInput ?? 0);
      if (typeof event.data.tokens === "number") lastTurnTokens = event.data.tokens;
      if (typeof event.data.model === "string") models.push(event.data.model);
    } else if (event.type === "tool_started") {
      toolCalls++;
      const name = String(event.data.name);
      toolsByName[name] = (toolsByName[name] ?? 0) + 1;
    } else if (event.type === "run_failed") {
      runFailed = true;
      if (typeof event.data.error === "string") failureReason = event.data.error;
    } else if (event.type === "artifact_published") {
      if (asRecord(event.data.artifact).kind === "dashboard") dashboards.push(event);
    }
  }
  let warnings = 0;
  for (const event of dashboards) {
    const html = typeof event.data.path === "string" ? readHtml(event.data.path) : undefined;
    if (html !== undefined) warnings += chartWarnings(html).length;
  }
  const first = dashboards[0];
  const start = data.events[0]?.createdAt;
  let specHash: string | null = null;
  let components: string[] | null = null;
  const id = first ? asRecord(first.data.artifact).id : undefined;
  const provenance = asRecord(data.artifacts.find((a) => a.id === id)?.provenance);
  if (provenance.generator === "dashboard_generate" && provenance.spec) {
    specHash = createHash("sha256").update(stable(provenance.spec)).digest("hex");
    const widgets = asRecord(provenance.spec).widgets;
    components = Array.isArray(widgets)
      ? widgets.map((w) => String(asRecord(w).type)).sort()
      : null;
  }
  const pythonRunCalls = toolsByName.python_run ?? 0;
  return {
    turns,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    toolCalls,
    toolsByName,
    pythonRunCalls,
    usedPythonRun: pythonRunCalls > 0,
    timeToArtifactMs: first && start !== undefined ? first.createdAt - start : null,
    dashboardPublished: dashboards.length > 0,
    runFailed,
    failureReason,
    failureClass: runFailed ? classifyFailure(failureReason) : null,
    lastTurnTokens,
    endedWithoutDashboard: exitCode === 0 && dashboards.length === 0,
    success: dashboards.length > 0 && !runFailed,
    chartWarnings: warnings,
    specHash,
    components,
    models,
  };
}

/** Throws `SeriesDiscardedError` when any turn of any run used a model other than `expected`. */
export function assertSingleModel(modelsPerRun: string[][], expected: string): void {
  const other = new Set(modelsPerRun.flat().filter((m) => m !== expected));
  if (other.size)
    throw new SeriesDiscardedError(
      `Series discarded: expected every turn_completed.model to be "${expected}" but saw ${[...other].map((m) => `"${m}"`).join(", ")}. Results of different models are not comparable.`,
    );
}

// ---------------------------------------------------------------------------------------------
// Real datasets
// ---------------------------------------------------------------------------------------------

export type DatasetSource = "generated" | "repo" | "download";
/** What the results record about where a dataset came from (never a full URL). */
export interface DatasetInfo {
  source: DatasetSource;
  /** `download` only: `URL.host` of the source (no scheme, path or query). */
  urlHost?: string;
  /** `download` only: the fixed maximum number of rows requested. */
  rowCap?: number;
  /** `download` only: SHA-256 the downloaded bytes were pinned to. */
  sha256?: string;
}
export type RealDataset =
  /** A file versioned in the repository, read in place (never copied into the repository). */
  | { id: string; source: "repo"; path: string }
  /** A public CSV fetched at run time into the temp folder; stops if its bytes change. */
  | { id: string; source: "download"; url: string; rowCap: number; sha256: string };

/** The data changed under us: benchmarking it would silently compare different inputs. */
export class DatasetChangedError extends Error {
  override name = "DatasetChangedError";
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
/**
 * Real datasets of the harness. The two Colombian sales files live in `examples/data` (Spanish
 * headers, UTF-8 BOM, ISO dates, COP amounts). `tickets-311` is the NYC 311 export of a closed
 * period (January 2019, first rows by `unique_key`, so it is deterministic), pinned by SHA-256.
 */
export const REAL_DATASETS: RealDataset[] = [
  {
    id: "sales-es-300",
    source: "repo",
    path: resolve(REPO_ROOT, "examples/data/dashboard_simple_300.csv"),
  },
  {
    id: "sales-es-4000",
    source: "repo",
    path: resolve(REPO_ROOT, "examples/data/dataset_dashboard_4000.csv"),
  },
  {
    id: "tickets-311",
    source: "download",
    // NYC 311 requests created in January 2019 (a closed period), first 50 000 rows by unique_key.
    url: "https://data.cityofnewyork.us/resource/76ig-c548.csv?$select=unique_key,created_date,closed_date,agency,complaint_type,descriptor,borough,status,open_data_channel_type&$where=created_date%20%3E=%20%272019-01-01T00:00:00%27%20AND%20created_date%20%3C%20%272019-02-01T00:00:00%27&$order=unique_key&$limit=50000",
    rowCap: 50_000,
    sha256: "a8d507178775de410981773119cae5ceae62866b2238a1e0519f4a365acaf80e",
  },
];

export interface MaterializedDataset {
  id: string;
  /** File to place in the run workspace. */
  file: string;
  rows: number;
  info: DatasetInfo;
}

const countRows = (bytes: Uint8Array): number => {
  let lines = 0;
  for (const byte of bytes) if (byte === 10) lines++;
  if (bytes.length && bytes[bytes.length - 1] !== 10) lines++;
  return Math.max(0, lines - 1);
};

/** Resolves a real dataset to a local file (downloading and pinning it when needed). */
export async function materializeDataset(
  def: RealDataset,
  dir: string,
  fetchFn: typeof fetch = fetch,
): Promise<MaterializedDataset> {
  if (def.source === "repo") {
    if (!existsSync(def.path) || !statSync(def.path).isFile())
      throw new BenchUsageError(`Dataset ${def.id}: ${def.path} not found.`);
    return {
      id: def.id,
      file: def.path,
      rows: countRows(readFileSync(def.path)),
      info: { source: "repo" },
    };
  }
  const response = await fetchFn(def.url);
  if (!response.ok)
    throw new BenchUsageError(
      `Dataset ${def.id}: download from ${new URL(def.url).host} failed (HTTP ${response.status}).`,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== def.sha256)
    throw new DatasetChangedError(
      `Dataset ${def.id} changed upstream: expected SHA-256 ${def.sha256} but downloaded ${hash}. Stopping instead of benchmarking different data; review it and update the pinned hash in scripts/bench/lib.ts.`,
    );
  const rows = countRows(bytes);
  if (rows > def.rowCap)
    throw new DatasetChangedError(
      `Dataset ${def.id} has ${rows} rows, above its cap of ${def.rowCap}.`,
    );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${def.id}.csv`);
  writeFileSync(file, bytes);
  return {
    id: def.id,
    file,
    rows,
    info: { source: "download", urlHost: new URL(def.url).host, rowCap: def.rowCap, sha256: hash },
  };
}

// ---------------------------------------------------------------------------------------------
// A series of runs
// ---------------------------------------------------------------------------------------------

export interface SeriesRun {
  variant: Variant;
  /** A generated kind (`sales`, `opaque`, ...) or the id of a real dataset (`tickets-311`). */
  kind: string;
  /** Where the dataset came from; absent means `generated`. */
  dataset?: DatasetInfo;
  rows: number;
  repeat: number;
  lang: Lang;
  exitCode: number | null;
  timedOut: boolean;
  metrics: RunMetrics;
}
export interface SeriesOptions {
  command: string[];
  params: BenchParams;
  variants: Variant[];
  kinds: DatasetKind[];
  sizes: number[];
  /** Real datasets run in addition to the generated kind x size grid. */
  real?: RealDataset[];
  fetch?: typeof fetch;
  repeats: number;
  lang: Lang;
  supportsSmartDashboard: boolean;
  /** Plugin paths loaded by variant C. */
  plugins?: string[];
  env: Env;
  seed?: number;
  /** Scratch folder; created, and removed at the end unless `keep`. Defaults to a temp folder. */
  workDir?: string;
  keep?: boolean;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
}

function placeFile(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

/**
 * Runs every dataset x size x variant x repetition sequentially. After each run the model check
 * is applied: one different `turn_completed.model` throws `SeriesDiscardedError` and nothing is
 * returned (checking as it goes only saves the cost of a series that is already unusable).
 */
export async function runSeries(options: SeriesOptions): Promise<SeriesRun[]> {
  for (const variant of options.variants)
    variantConfig(variant, { smartDashboard: options.supportsSmartDashboard });
  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), "alisio-bench-"));
  const dataDir = join(workDir, "data");
  mkdirSync(dataDir, { recursive: true });
  const runs: SeriesRun[] = [];
  const modelsPerRun: string[][] = [];
  try {
    const jobs: Array<{ kind: string; rows: number; source: string; info?: DatasetInfo }> = [];
    for (const kind of options.kinds)
      for (const rows of options.sizes) {
        const source = join(dataDir, `${kind}-${rows}.csv`);
        writeDatasetFile(source, kind, rows, options.seed);
        jobs.push({ kind, rows, source });
      }
    for (const def of options.real ?? []) {
      const m = await materializeDataset(def, dataDir, options.fetch);
      jobs.push({ kind: m.id, rows: m.rows, source: m.file, info: m.info });
    }
    for (const job of jobs) {
      const { kind, rows, source } = job;
      const fileName = `${kind}-${rows}.csv`;
      for (const variant of options.variants)
        for (let repeat = 1; repeat <= options.repeats; repeat++) {
          const runDir = join(workDir, "runs", `${variant}-${kind}-${rows}-${repeat}`);
          const workspace = join(runDir, "workspace");
          mkdirSync(workspace, { recursive: true });
          placeFile(source, join(workspace, fileName));
          options.onProgress?.(`variant ${variant} ${fileName} #${repeat}`);
          const outcome = await runAlisio({
            command: options.command,
            params: options.params,
            variant,
            supportsSmartDashboard: options.supportsSmartDashboard,
            ...(options.plugins ? { plugins: options.plugins } : {}),
            workspace,
            runDir,
            prompt: dashboardPrompt(options.lang, fileName),
            env: options.env,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          });
          const metrics = summarizeRun(readRunData(outcome.dbPath), undefined, outcome.exitCode);
          modelsPerRun.push(metrics.models);
          assertSingleModel(modelsPerRun, options.params.model);
          runs.push({
            variant,
            kind,
            ...(job.info ? { dataset: job.info } : {}),
            rows,
            repeat,
            lang: options.lang,
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            metrics,
          });
          if (!options.keep) rmSync(runDir, { recursive: true, force: true });
        }
    }
    return runs;
  } finally {
    if (!options.keep) rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Results document
// ---------------------------------------------------------------------------------------------

export interface Spread {
  median: number;
  min: number;
  max: number;
}
export interface VariantSummary {
  runs: number;
  successRate: number;
  pythonRunRate: number;
  inputTokens: Spread;
  outputTokens: Spread;
  cachedInputTokens: Spread;
  turns: Spread;
  toolCalls: Spread;
  /** Over runs that published a dashboard; null when none did. */
  timeToArtifactMs: Spread | null;
  chartWarnings: number;
  /** Failed runs by `failureClass`; runs recorded without a class count as `other`. */
  failureReasons: Record<string, number>;
  /** Share of (dataset, size) groups whose repetitions produced the same spec; null for A. */
  specEqualityRate: number | null;
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return { median, min: sorted[0] as number, max: sorted.at(-1) as number };
}

export function aggregateVariant(runs: SeriesRun[]): VariantSummary {
  const n = runs.length;
  const of = (pick: (m: RunMetrics) => number) => spread(runs.map((r) => pick(r.metrics)));
  const times = runs.map((r) => r.metrics.timeToArtifactMs).filter((t): t is number => t !== null);
  const groups = new Map<string, Array<string | null>>();
  for (const run of runs) {
    const key = `${run.kind}-${run.rows}`;
    groups.set(key, [...(groups.get(key) ?? []), run.metrics.specHash]);
  }
  const comparable = [...groups.values()].filter((hashes) => hashes.every((h) => h !== null));
  const failureReasons: Record<string, number> = {};
  for (const { metrics } of runs) {
    if (!metrics.runFailed) continue;
    const cls = metrics.failureClass ?? "other";
    failureReasons[cls] = (failureReasons[cls] ?? 0) + 1;
  }
  return {
    runs: n,
    successRate: runs.filter((r) => r.metrics.success).length / n,
    pythonRunRate: runs.filter((r) => r.metrics.usedPythonRun).length / n,
    inputTokens: of((m) => m.inputTokens),
    outputTokens: of((m) => m.outputTokens),
    cachedInputTokens: of((m) => m.cachedInputTokens),
    turns: of((m) => m.turns),
    toolCalls: of((m) => m.toolCalls),
    timeToArtifactMs: times.length ? spread(times) : null,
    chartWarnings: runs.reduce((sum, r) => sum + r.metrics.chartWarnings, 0),
    failureReasons,
    specEqualityRate: comparable.length
      ? comparable.filter((hashes) => new Set(hashes).size === 1).length / comparable.length
      : null,
  };
}

export interface BenchResults {
  schema: 1;
  generatedAt: string;
  alisio: { version: string; platform: string; arch: string; node: string };
  /** Model that answered every run (O5). */
  model: string;
  /** `URL.host` of the endpoint (O5); never the URL, credentials or key. */
  endpointHost: string;
  seed: number;
  /** Per dataset id: where it came from (`generated` | `repo` | `download` + pin). */
  datasets: Record<string, DatasetInfo & { rows: number[] }>;
  variants: Record<string, VariantSummary>;
  runDetails: SeriesRun[];
}
export interface ResultsInput {
  params: BenchParams;
  alisioVersion: string;
  seed: number;
  runs: SeriesRun[];
  generatedAt: string;
}

function datasetsOf(runs: SeriesRun[]): BenchResults["datasets"] {
  const out: BenchResults["datasets"] = {};
  for (const run of runs) {
    const entry = (out[run.kind] ??= {
      ...(run.dataset ?? { source: "generated" as const }),
      rows: [],
    });
    if (!entry.rows.includes(run.rows)) entry.rows.push(run.rows);
  }
  for (const entry of Object.values(out)) entry.rows.sort((a, b) => a - b);
  return out;
}

export function buildResults(input: ResultsInput): BenchResults {
  const variants: Record<string, VariantSummary> = {};
  for (const variant of new Set(input.runs.map((r) => r.variant)))
    variants[variant] = aggregateVariant(input.runs.filter((r) => r.variant === variant));
  return {
    schema: 1,
    generatedAt: input.generatedAt,
    alisio: {
      version: input.alisioVersion,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
    },
    model: input.params.model,
    endpointHost: input.params.endpointHost,
    seed: input.seed,
    datasets: datasetsOf(input.runs),
    variants,
    runDetails: input.runs,
  };
}

/** Adds `incoming`'s variants to an existing document; a different model is refused (O5). */
export function mergeResults(
  existing: BenchResults | undefined,
  incoming: BenchResults,
): BenchResults {
  if (!existing) return incoming;
  if (existing.model !== incoming.model)
    throw new BenchUsageError(
      `The existing results were made with model "${existing.model}" and this series used "${incoming.model}": all variants of one benchmark must use the same model. Use another --out file.`,
    );
  const replaced = new Set(Object.keys(incoming.variants));
  return {
    ...incoming,
    datasets: { ...existing.datasets, ...incoming.datasets },
    variants: { ...existing.variants, ...incoming.variants },
    runDetails: [
      ...existing.runDetails.filter((r) => !replaced.has(r.variant)),
      ...incoming.runDetails,
    ],
  };
}

const SECRET_NAME = /(key|token|secret|password|credential)/i;
/** Throws when `text` contains the value of any secret-looking environment variable. */
export function assertNoSecrets(text: string, env: Env): void {
  for (const [name, value] of Object.entries(env))
    if (value && value.length >= 8 && SECRET_NAME.test(name) && text.includes(value))
      throw new Error(`Refusing to write results: they contain a secret from ${name}.`);
}

/** The results document as JSON text, refusing to produce one that leaks an environment secret. */
export function serializeBenchResults(results: BenchResults, env: Env): string {
  const text = `${JSON.stringify(results, null, 2)}\n`;
  assertNoSecrets(text, env);
  return text;
}
export function serializeResults(input: ResultsInput, env: Env): string {
  return serializeBenchResults(buildResults(input), env);
}
