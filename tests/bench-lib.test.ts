import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import {
  aggregateVariant,
  assertNoSecrets,
  assertSingleModel,
  BenchUsageError,
  DATASET_KINDS,
  DatasetChangedError,
  type DatasetKind,
  DEFAULT_SEED,
  datasetColumns,
  datasetCsv,
  endpointHost,
  materializeDataset,
  mergeResults,
  mulberry32,
  probeSmartDashboardSupport,
  REAL_DATASETS,
  readBenchParams,
  readRunData,
  runAlisio,
  runSeries,
  SeriesDiscardedError,
  type SeriesRun,
  serializeResults,
  summarizeRun,
  variantConfig,
} from "../scripts/bench/lib.ts";

const SECRET = "sk-test-SECRET-0123456789";
const PARAMS = {
  model: "bench-model",
  baseUrl: "https://user:pw@api.example.com:8443/v1?token=abc",
  endpointHost: "api.example.com:8443",
};

let dir: string;
let fake: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "alisio-bench-lib-"));
  fake = join(dir, "fake-alisio.mjs");
  // A stand-in for `alisio`: records how it was invoked and persists the events a real run would.
  writeFileSync(
    fake,
    `import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
if (args.includes("--version")) { console.log("9.9.9-fake"); process.exit(0); }
const configHome = process.env.ALISIO_CONFIG_HOME;
const configFile = join(configHome ?? "", "config.json");
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : null;
if (process.env.FAKE_UNSUPPORTED && config?.analysis && "smartDashboard" in config.analysis) {
  console.error("Invalid configuration: analysis: Unrecognized key: \\"smartDashboard\\"");
  process.exit(1);
}
const db = arg("--db");
mkdirSync(dirname(db), { recursive: true });
writeFileSync(join(dirname(db), "invocation.json"), JSON.stringify({
  args, config,
  env: { ALISIO_CONFIG_HOME: configHome, ALISIO_STATE_HOME: process.env.ALISIO_STATE_HOME },
}));
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
const d = new DatabaseSync(db);
d.exec("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,run_id TEXT,type TEXT,body TEXT,created_at INTEGER,correlation_id TEXT);" +
  "CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,kind TEXT,file_name TEXT,status TEXT,provenance TEXT,created_at INTEGER);");
const model = process.env.FAKE_MODEL ?? arg("--model");
const now = Date.now();
const ev = (type, body, at) => d.prepare("INSERT INTO events(session,run_id,type,body,created_at) VALUES('s','r',?,?,?)").run(type, JSON.stringify(body), at);
ev("run_started", { model }, now);
ev("turn_completed", { turn: 1, tokens: 150, calls: 1, model, usage: { input: 100, output: 50, cachedInput: 10 } }, now + 10);
ev("tool_started", { id: "a", name: "data_inspect", arguments: "{}", effect: "read" }, now + 11);
ev("tool_started", { id: "b", name: process.env.FAKE_TOOL ?? "python_run", arguments: "{}", effect: "process" }, now + 12);
ev("turn_completed", { turn: 2, tokens: 400, calls: 0, model, usage: { input: 200, output: 100 } }, now + 20);
if (!process.env.FAKE_NO_ARTIFACT) {
  const html = join(arg("--cwd"), "dashboard.html");
  writeFileSync(html, process.env.FAKE_HTML ?? "<!doctype html><title>ok</title><p>fine</p>");
  const spec = process.env.FAKE_SPEC ? JSON.parse(process.env.FAKE_SPEC) : null;
  d.prepare("INSERT INTO artifacts(id,kind,file_name,status,provenance,created_at) VALUES('art_1','dashboard','dashboard.html','ready',?,?)")
    .run(JSON.stringify(spec ? { generator: "dashboard_generate", spec } : { model }), now + 30);
  ev("artifact_published", { artifact: { id: "art_1", kind: "dashboard", fileName: "dashboard.html" }, path: html }, now + 30);
}
ev("run_completed", { tokens: 400, text: "done" }, now + 40);
console.log(JSON.stringify({ v: 1, type: "run_completed" }));
`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fakeCommand = () => [process.execPath, fake];
const baseEnv = () => ({ PATH: process.env.PATH, OPENAI_API_KEY: SECRET });

describe("seeded PRNG and dataset generators", () => {
  it("mulberry32 is deterministic and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seq = Array.from({ length: 1000 }, () => a());
    expect(seq).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(seq.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(seq).size).toBeGreaterThan(990);
    expect(mulberry32(43)()).not.toBe(mulberry32(42)());
  });

  it.each(DATASET_KINDS)(
    "%s: same seed gives byte-identical CSV, another seed does not",
    (kind) => {
      expect(datasetCsv(kind, 60, 7)).toBe(datasetCsv(kind, 60, 7));
      expect(datasetCsv(kind, 60, 7)).not.toBe(datasetCsv(kind, 60, 8));
    },
  );

  it.each(DATASET_KINDS)("%s: header, row count and consistent columns", (kind) => {
    const lines = datasetCsv(kind, 120, 1).trimEnd().split("\n");
    expect(lines).toHaveLength(121);
    expect(lines[0]?.split(",")).toEqual(datasetColumns(kind));
    for (const line of lines.slice(1))
      expect(line.split(",")).toHaveLength(datasetColumns(kind).length);
  });

  it("the opaque dataset has only col_a..col_m headers", () => {
    expect(datasetColumns("opaque")).toEqual("abcdefghijklm".split("").map((c) => `col_${c}`));
  });

  it("every dataset has ISO dates, an identifier, numeric measures and low-cardinality dimensions", () => {
    for (const kind of DATASET_KINDS as readonly DatasetKind[]) {
      const [header, ...rows] = datasetCsv(kind, 400, 3).trimEnd().split("\n");
      const cols = header?.split(",") ?? [];
      const column = (i: number) => rows.map((r) => r.split(",")[i] ?? "");
      const iso = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
      const dates = cols.map((_, i) => i).filter((i) => column(i).every((v) => iso.test(v)));
      expect(dates.length, `${kind} dates`).toBeGreaterThan(0);
      const numeric = cols
        .map((_, i) => i)
        .filter((i) => column(i).every((v) => v === "" || /^-?\d+(\.\d+)?$/.test(v)));
      expect(numeric.length, `${kind} numerics`).toBeGreaterThanOrEqual(3);
      const unique = cols.map((_, i) => i).filter((i) => new Set(column(i)).size === rows.length);
      expect(unique.length, `${kind} identifier`).toBeGreaterThan(0);
      const lowCard = cols
        .map((_, i) => i)
        .filter((i) => new Set(column(i)).size <= 12 && !numeric.includes(i));
      expect(lowCard.length, `${kind} dimensions`).toBeGreaterThan(0);
    }
  });
});

describe("parameters (O5)", () => {
  it("fails with a usage error naming both variables when they are missing", () => {
    expect(() => readBenchParams({})).toThrow(BenchUsageError);
    try {
      readBenchParams({ ALISIO_BENCH_MODEL: "m" });
    } catch (error) {
      expect((error as Error).message).toContain("ALISIO_BENCH_MODEL");
      expect((error as Error).message).toContain("ALISIO_BENCH_BASE_URL");
    }
    expect(() => readBenchParams({ ALISIO_BENCH_BASE_URL: "https://x.test/v1" })).toThrow(
      BenchUsageError,
    );
    expect(() =>
      readBenchParams({ ALISIO_BENCH_MODEL: "m", ALISIO_BENCH_BASE_URL: "not a url" }),
    ).toThrow(BenchUsageError);
    expect(() =>
      readBenchParams({ ALISIO_BENCH_MODEL: "m", ALISIO_BENCH_BASE_URL: "ftp://x.test" }),
    ).toThrow(BenchUsageError);
  });

  it("returns the model and only the host of the endpoint", () => {
    const params = readBenchParams({
      ALISIO_BENCH_MODEL: " gpt-x ",
      ALISIO_BENCH_BASE_URL: PARAMS.baseUrl,
    });
    expect(params.model).toBe("gpt-x");
    expect(params.endpointHost).toBe("api.example.com:8443");
    expect(endpointHost("http://localhost:11434/v1")).toBe("localhost:11434");
  });

  it("never reads the API key (or any variable but the two it needs)", () => {
    const touched: string[] = [];
    const env = new Proxy(
      {
        ALISIO_BENCH_MODEL: "m",
        ALISIO_BENCH_BASE_URL: "https://x.test/v1",
        OPENAI_API_KEY: SECRET,
      },
      {
        get(target, key) {
          touched.push(String(key));
          return Reflect.get(target, key);
        },
        has(target, key) {
          touched.push(String(key));
          return Reflect.has(target, key);
        },
        ownKeys(target) {
          touched.push("<ownKeys>");
          return Reflect.ownKeys(target);
        },
      },
    );
    readBenchParams(env);
    expect(
      touched.filter((k) => !["ALISIO_BENCH_MODEL", "ALISIO_BENCH_BASE_URL"].includes(k)),
    ).toEqual([]);
  });
});

describe("variant configuration", () => {
  it("A is today's behavior: no smartDashboard key unless the installed Alisio supports it", () => {
    expect(variantConfig("A", { smartDashboard: false })).toEqual({});
    expect(variantConfig("A", { smartDashboard: true })).toEqual({
      analysis: { smartDashboard: false },
    });
  });

  it("B and C need the smartDashboard setting; B has no decision provider, C uses laya", () => {
    expect(() => variantConfig("B", { smartDashboard: false })).toThrow(BenchUsageError);
    expect(() => variantConfig("C", { smartDashboard: false })).toThrow(BenchUsageError);
    expect(variantConfig("B", { smartDashboard: true })).toEqual({
      analysis: { smartDashboard: true },
      decisions: { provider: null },
    });
    expect(variantConfig("C", { smartDashboard: true })).toEqual({
      analysis: { smartDashboard: true },
      decisions: { provider: "laya" },
    });
  });

  it("loads the given plugin paths into variant C only (the isolated config home sees no global plugins)", () => {
    const plugins = ["/opt/laya/node_modules/@alisio/plugin-laya"];
    expect(variantConfig("C", { smartDashboard: true }, { plugins })).toEqual({
      analysis: { smartDashboard: true },
      decisions: { provider: "laya" },
      plugins,
    });
    expect(variantConfig("B", { smartDashboard: true }, { plugins })).toEqual({
      analysis: { smartDashboard: true },
      decisions: { provider: null },
    });
    expect(variantConfig("A", { smartDashboard: true }, { plugins })).toEqual({
      analysis: { smartDashboard: false },
    });
  });

  it("writes the plugin paths of a C run into its isolated config.json", async () => {
    const runDir = join(dir, "run-c-plugins");
    const workspace = join(dir, "ws-c-plugins");
    mkdirSync(workspace, { recursive: true });
    await runAlisio({
      command: fakeCommand(),
      params: PARAMS,
      variant: "C",
      supportsSmartDashboard: true,
      plugins: ["/opt/laya/plugin"],
      workspace,
      runDir,
      prompt: "p",
      env: { PATH: process.env.PATH },
    });
    const config = JSON.parse(readFileSync(join(runDir, "config", "config.json"), "utf8"));
    expect(config.plugins).toEqual(["/opt/laya/plugin"]);
    expect(config.decisions).toEqual({ provider: "laya" });
  });
});

describe("runAlisio", () => {
  it("runs `alisio run --json` in an isolated config, state and database, with the shared model flags", async () => {
    const runDir = join(dir, "run-a");
    const workspace = join(dir, "ws-a");
    mkdirSync(workspace, { recursive: true });
    const outcome = await runAlisio({
      command: fakeCommand(),
      params: PARAMS,
      variant: "B",
      supportsSmartDashboard: true,
      workspace,
      runDir,
      prompt: "make a dashboard",
      env: { ...baseEnv(), ALISIO_MODEL: "other", OPENAI_BASE_URL: "https://elsewhere.test" },
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.timedOut).toBe(false);
    const seen = JSON.parse(readFileSync(join(runDir, "invocation.json"), "utf8"));
    expect(seen.args.slice(0, 2)).toEqual(["run", "--json"]);
    expect(seen.args[seen.args.indexOf("--db") + 1]).toBe(join(runDir, "sessions.sqlite"));
    expect(seen.args[seen.args.indexOf("--cwd") + 1]).toBe(workspace);
    expect(seen.args).toContain("--allow-analysis");
    expect(seen.args[seen.args.indexOf("--model") + 1]).toBe("bench-model");
    expect(seen.args[seen.args.indexOf("--base-url") + 1]).toBe(PARAMS.baseUrl);
    expect(seen.args.at(-1)).toBe("make a dashboard");
    expect(seen.env.ALISIO_CONFIG_HOME).toBe(join(runDir, "config"));
    expect(seen.env.ALISIO_STATE_HOME).toBe(join(runDir, "state"));
    expect(seen.config).toEqual({
      analysis: { smartDashboard: true },
      decisions: { provider: null },
    });
  });

  it("reports a failing exit code and a timeout without throwing", async () => {
    const workspace = join(dir, "ws-b");
    mkdirSync(workspace, { recursive: true });
    const failed = await runAlisio({
      command: fakeCommand(),
      params: PARAMS,
      variant: "A",
      supportsSmartDashboard: false,
      workspace,
      runDir: join(dir, "run-b"),
      prompt: "p",
      env: { ...baseEnv(), FAKE_EXIT: "3" },
    });
    expect(failed.exitCode).toBe(3);
    const slow = await runAlisio({
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      params: PARAMS,
      variant: "A",
      supportsSmartDashboard: false,
      workspace,
      runDir: join(dir, "run-c"),
      prompt: "p",
      env: baseEnv(),
      timeoutMs: 300,
    });
    expect(slow.timedOut).toBe(true);
  });
});

describe("probeSmartDashboardSupport", () => {
  it("is true when the installed Alisio accepts the key and false when its config schema rejects it", async () => {
    expect(
      await probeSmartDashboardSupport({
        command: fakeCommand(),
        env: baseEnv(),
        dir: join(dir, "probe-1"),
      }),
    ).toBe(true);
    expect(
      await probeSmartDashboardSupport({
        command: fakeCommand(),
        env: { ...baseEnv(), FAKE_UNSUPPORTED: "1" },
        dir: join(dir, "probe-2"),
      }),
    ).toBe(false);
  });
});

describe("persisted events", () => {
  it("reads events written by the real SessionStore", () => {
    const path = join(dir, "real.sqlite");
    const store = new SQLiteStore(path);
    store.event("s1", "r1", "run_started", { model: "m" });
    store.event("s1", "r1", "turn_completed", {
      turn: 1,
      tokens: 3,
      calls: 0,
      model: "m",
      usage: { input: 2, output: 1 },
    });
    store.close();
    const data = readRunData(path);
    expect(data.events.map((e) => e.type)).toEqual(["run_started", "turn_completed"]);
    expect(data.events[1]?.data).toMatchObject({ model: "m", usage: { input: 2, output: 1 } });
    expect(data.artifacts).toEqual([]);
  });

  it("an empty or missing database yields no data instead of throwing", () => {
    expect(readRunData(join(dir, "missing.sqlite"))).toEqual({ events: [], artifacts: [] });
  });
});

describe("metrics from persisted events", () => {
  async function recorded(env: Record<string, string> = {}, name = "metrics") {
    const workspace = join(dir, `ws-${name}`);
    mkdirSync(workspace, { recursive: true });
    const runDir = join(dir, `run-${name}`);
    await runAlisio({
      command: fakeCommand(),
      params: PARAMS,
      variant: "A",
      supportsSmartDashboard: false,
      workspace,
      runDir,
      prompt: "p",
      env: { ...baseEnv(), ...env },
    });
    return readRunData(join(runDir, "sessions.sqlite"));
  }

  it("sums usage, counts turns and tool starts, and detects python_run", async () => {
    const metrics = summarizeRun(await recorded());
    expect(metrics).toMatchObject({
      turns: 2,
      inputTokens: 300,
      outputTokens: 150,
      cachedInputTokens: 10,
      toolCalls: 2,
      pythonRunCalls: 1,
      usedPythonRun: true,
      dashboardPublished: true,
      runFailed: false,
      success: true,
      models: ["bench-model", "bench-model"],
    });
    expect(metrics.toolsByName).toEqual({ data_inspect: 1, python_run: 1 });
    expect(metrics.timeToArtifactMs).toBe(30);
    expect(metrics.chartWarnings).toBe(0);
    expect(metrics.specHash).toBeNull();
  });

  it("counts chart-lint warnings of the published HTML", async () => {
    const html = `<html><link href="https://cdn.example.com/x.css"><script src="https://cdn.example.com/chart.js"></script></html>`;
    const metrics = summarizeRun(await recorded({ FAKE_HTML: html }, "lint"));
    expect(metrics.chartWarnings).toBeGreaterThan(0);
  });

  it("is not a success without a dashboard artifact", async () => {
    const metrics = summarizeRun(await recorded({ FAKE_NO_ARTIFACT: "1" }, "noart"));
    expect(metrics.dashboardPublished).toBe(false);
    expect(metrics.success).toBe(false);
    expect(metrics.timeToArtifactMs).toBeNull();
  });

  describe("failure reasons", () => {
    const ev = (seq: number, type: string, data: Record<string, unknown>) => ({
      seq,
      session: "s",
      runId: "r",
      type,
      data,
      createdAt: seq,
    });
    const failed = (error: unknown, extra: ReturnType<typeof ev>[] = []) => ({
      events: [ev(1, "run_started", {}), ...extra, ev(9, "run_failed", { error })],
      artifacts: [],
    });

    it.each([
      ["Token budget exhausted", "token_budget"],
      ["Request timed out", "time"],
      ["Run timeout after 600s", "time"],
      ["Reached the maximum number of turns", "turns"],
      ["max turns exceeded", "turns"],
      ["Provider returned 500", "other"],
    ])("classifies %j as %s", (error, failureClass) => {
      const metrics = summarizeRun(failed(error));
      expect(metrics.runFailed).toBe(true);
      expect(metrics.failureReason).toBe(error);
      expect(metrics.failureClass).toBe(failureClass);
    });

    it("records the tokens of the last completed turn", () => {
      const metrics = summarizeRun(
        failed("Token budget exhausted", [
          ev(2, "turn_completed", { tokens: 150, usage: {} }),
          ev(3, "turn_completed", { tokens: 4200, usage: {} }),
        ]),
      );
      expect(metrics.lastTurnTokens).toBe(4200);
    });

    it("leaves failure fields null for a run that did not fail", async () => {
      const metrics = summarizeRun(await recorded({}, "nofail"), undefined, 0);
      expect(metrics.failureReason).toBeNull();
      expect(metrics.failureClass).toBeNull();
      expect(metrics.lastTurnTokens).toBe(400);
      expect(metrics.endedWithoutDashboard).toBe(false);
    });

    it("tolerates a run_failed without a string error", () => {
      const metrics = summarizeRun(failed(undefined));
      expect(metrics.failureReason).toBeNull();
      expect(metrics.failureClass).toBe("other");
      expect(metrics.lastTurnTokens).toBeNull();
    });

    it("flags a clean exit that published no dashboard", async () => {
      const none = summarizeRun(await recorded({ FAKE_NO_ARTIFACT: "1" }, "nodash"), undefined, 0);
      expect(none.endedWithoutDashboard).toBe(true);
      const crashed = summarizeRun(
        await recorded({ FAKE_NO_ARTIFACT: "1" }, "nodash2"),
        undefined,
        1,
      );
      expect(crashed.endedWithoutDashboard).toBe(false);
      const unknown = summarizeRun(await recorded({ FAKE_NO_ARTIFACT: "1" }, "nodash3"));
      expect(unknown.endedWithoutDashboard).toBe(false);
    });
  });

  it("hashes the DashboardSpec of the provenance and lists its components", async () => {
    const spec = {
      version: 1,
      title: "T",
      widgets: [{ type: "kpi" }, { type: "line" }, { type: "kpi" }],
    };
    const a = summarizeRun(
      await recorded({ FAKE_SPEC: JSON.stringify(spec), FAKE_TOOL: "dashboard_generate" }, "spec1"),
    );
    const reordered = { widgets: spec.widgets, title: "T", version: 1 };
    const b = summarizeRun(await recorded({ FAKE_SPEC: JSON.stringify(reordered) }, "spec2"));
    expect(a.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.specHash).toBe(b.specHash);
    expect(a.components).toEqual(["kpi", "kpi", "line"]);
    expect(a.usedPythonRun).toBe(false);
  });
});

describe("single-model check", () => {
  it("accepts a series where every turn used the requested model", () => {
    expect(() => assertSingleModel([["m"], ["m", "m"], []], "m")).not.toThrow();
  });
  it("discards the series when any turn used another model", () => {
    expect(() => assertSingleModel([["m"], ["m", "other"]], "m")).toThrow(SeriesDiscardedError);
  });
});

describe("runSeries", () => {
  const series = (overrides: Partial<Parameters<typeof runSeries>[0]> = {}) =>
    runSeries({
      command: fakeCommand(),
      params: PARAMS,
      variants: ["A"],
      kinds: ["sales", "opaque"],
      sizes: [30],
      repeats: 2,
      lang: "en",
      supportsSmartDashboard: false,
      env: baseEnv(),
      workDir: join(dir, `series-${Math.random().toString(36).slice(2)}`),
      ...overrides,
    });

  it("runs every dataset, size and repetition with its own workspace holding the generated CSV", async () => {
    const workDir = join(dir, "series-main");
    const runs = await series({ workDir });
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => `${r.kind}-${r.rows}-${r.repeat}`)).toEqual([
      "sales-30-1",
      "sales-30-2",
      "opaque-30-1",
      "opaque-30-2",
    ]);
    expect(runs.every((r) => r.metrics.success)).toBe(true);
    expect(existsSync(workDir)).toBe(false); // temp files are removed
  });

  it("puts the file and its name in the prompt, in the requested language", async () => {
    const keep = join(dir, "series-prompt");
    await series({ workDir: keep, kinds: ["sales"], repeats: 1, lang: "es", keep: true });
    const runDir = join(keep, "runs", "A-sales-30-1");
    const seen = JSON.parse(readFileSync(join(runDir, "invocation.json"), "utf8"));
    expect(seen.args.at(-1)).toContain("sales-30.csv");
    expect(seen.args.at(-1)).toMatch(/dashboard/i);
    expect(seen.args.at(-1)).toMatch(/panel|datos|archivo/i);
    const csv = readFileSync(
      join(keep, "runs", "A-sales-30-1", "workspace", "sales-30.csv"),
      "utf8",
    );
    expect(csv).toBe(datasetCsv("sales", 30, DEFAULT_SEED));
  });

  it("aborts and returns nothing when a turn used a different model", async () => {
    await expect(series({ env: { ...baseEnv(), FAKE_MODEL: "something-else" } })).rejects.toThrow(
      SeriesDiscardedError,
    );
  });

  it("refuses variants B/C when the installed Alisio does not support the setting", async () => {
    await expect(series({ variants: ["B"] })).rejects.toThrow(BenchUsageError);
  });
});

describe("results JSON", () => {
  const run = (over: Partial<SeriesRun> = {}): SeriesRun => ({
    variant: "A",
    kind: "sales",
    rows: 1000,
    repeat: 1,
    lang: "en",
    exitCode: 0,
    timedOut: false,
    metrics: {
      turns: 4,
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 0,
      toolCalls: 3,
      toolsByName: { python_run: 2 },
      pythonRunCalls: 2,
      usedPythonRun: true,
      timeToArtifactMs: 9000,
      dashboardPublished: true,
      runFailed: false,
      failureReason: null,
      failureClass: null,
      lastTurnTokens: 4000,
      endedWithoutDashboard: false,
      success: true,
      chartWarnings: 0,
      specHash: null,
      components: null,
      models: ["bench-model"],
    },
    ...over,
  });
  const build = (runs: SeriesRun[], model = "bench-model") => ({
    params: { ...PARAMS, model },
    alisioVersion: "0.3.0",
    seed: 1,
    runs,
    generatedAt: "2026-10-03T00:00:00.000Z",
  });

  it("contains model and endpointHost but neither the key, the full URL nor its credentials", () => {
    const json = serializeResults(build([run()]), {
      OPENAI_API_KEY: SECRET,
      ALISIO_BENCH_MODEL: "bench-model",
    });
    const parsed = JSON.parse(json);
    expect(parsed.model).toBe("bench-model");
    expect(parsed.endpointHost).toBe("api.example.com:8443");
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("user:pw");
    expect(json).not.toContain("token=abc");
    expect(json).not.toContain("/v1");
    expect(parsed.variants.A.runs).toBe(1);
    expect(parsed.variants.A.successRate).toBe(1);
  });

  it("refuses to write a document that contains a secret from the environment", () => {
    expect(() => assertNoSecrets(`{"x":"${SECRET}"}`, { OPENAI_API_KEY: SECRET })).toThrow(
      /secret/i,
    );
    expect(() =>
      assertNoSecrets('{"x":"fine"}', { OPENAI_API_KEY: SECRET, SHORT_TOKEN: "abc" }),
    ).not.toThrow();
    expect(() =>
      serializeResults(build([run({ variant: SECRET as never })]), { OPENAI_API_KEY: SECRET }),
    ).toThrow(/secret/i);
  });

  it("aggregates medians, success rate, python usage and spec equality per variant", () => {
    const metrics = (over: Partial<SeriesRun["metrics"]>): SeriesRun["metrics"] => ({
      ...run().metrics,
      ...over,
    });
    const summary = aggregateVariant([
      run({ repeat: 1, metrics: metrics({ outputTokens: 100, turns: 2, specHash: "h" }) }),
      run({ repeat: 2, metrics: metrics({ outputTokens: 300, turns: 4, specHash: "h" }) }),
      run({
        repeat: 3,
        metrics: metrics({ outputTokens: 200, turns: 6, specHash: "h", success: false }),
      }),
      run({ kind: "opaque", repeat: 1, metrics: metrics({ specHash: "x" }) }),
      run({ kind: "opaque", repeat: 2, metrics: metrics({ specHash: "y" }) }),
    ]);
    expect(summary.runs).toBe(5);
    expect(summary.successRate).toBeCloseTo(0.8);
    expect(summary.pythonRunRate).toBe(1);
    expect(summary.outputTokens.median).toBe(300);
    expect(summary.turns.median).toBe(4);
    expect(summary.specEqualityRate).toBeCloseTo(0.5);
  });

  it("counts failure reasons by class and tolerates runs recorded before the field existed", () => {
    const metrics = (over: Partial<SeriesRun["metrics"]>): SeriesRun["metrics"] => ({
      ...run().metrics,
      ...over,
    });
    const legacy = metrics({ runFailed: true, success: false });
    delete (legacy as Partial<SeriesRun["metrics"]>).failureClass;
    const summary = aggregateVariant([
      run({ metrics: metrics({}) }),
      run({
        metrics: metrics({ runFailed: true, success: false, failureClass: "token_budget" }),
      }),
      run({
        metrics: metrics({ runFailed: true, success: false, failureClass: "token_budget" }),
      }),
      run({ metrics: metrics({ runFailed: true, success: false, failureClass: "time" }) }),
      run({ metrics: legacy }),
    ]);
    expect(summary.failureReasons).toEqual({ token_budget: 2, time: 1, other: 1 });
    expect(aggregateVariant([run()]).failureReasons).toEqual({});
  });

  it("merges a new variant into an existing file and refuses a different model", () => {
    const a = JSON.parse(serializeResults(build([run()]), {}));
    const b = JSON.parse(serializeResults(build([run({ variant: "B" })]), {}));
    const merged = mergeResults(a, b);
    expect(Object.keys(merged.variants).sort()).toEqual(["A", "B"]);
    const other = JSON.parse(serializeResults(build([run({ variant: "B" })], "different"), {}));
    expect(() => mergeResults(a, other)).toThrow(/model/);
    expect(mergeResults(undefined, b).variants.B?.runs).toBe(1);
  });
});

describe("real datasets", () => {
  const csv = "a,b\n1,x\n2,y\n3,z\n";
  const sha = createHash("sha256").update(csv).digest("hex");
  const download = {
    id: "tickets-311",
    source: "download" as const,
    url: "https://data.example.org/path/file.csv?$limit=3&token=abc",
    rowCap: 3,
    sha256: sha,
  };
  const serve = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("lists the two repository sales files and the pinned download", () => {
    expect(REAL_DATASETS.map((d) => `${d.id}:${d.source}`)).toEqual([
      "sales-es-300:repo",
      "sales-es-4000:repo",
      "tickets-311:download",
    ]);
  });

  it("reads the repository files in place and counts their rows", async () => {
    const [small, big] = REAL_DATASETS;
    if (small?.source !== "repo" || big?.source !== "repo") throw new Error("unexpected");
    const a = await materializeDataset(small, join(dir, "real-a"));
    const b = await materializeDataset(big, join(dir, "real-a"));
    expect([a.rows, b.rows]).toEqual([300, 4000]);
    expect(a.file).toBe(small.path);
    expect(a.info).toEqual({ source: "repo" });
  });

  it("downloads into the temp folder, verifies the pin and records only host, cap and hash", async () => {
    const got = await materializeDataset(download, join(dir, "real-b"), serve(csv));
    expect(readFileSync(got.file, "utf8")).toBe(csv);
    expect(got.file.startsWith(join(dir, "real-b"))).toBe(true);
    expect(got.rows).toBe(3);
    expect(got.info).toEqual({
      source: "download",
      urlHost: "data.example.org",
      rowCap: 3,
      sha256: sha,
    });
  });

  it("stops with a clear message when the download changed", async () => {
    await expect(
      materializeDataset(download, join(dir, "real-c"), serve(`${csv}4,w\n`)),
    ).rejects.toThrow(DatasetChangedError);
    await expect(
      materializeDataset(download, join(dir, "real-c"), serve(`${csv}4,w\n`)),
    ).rejects.toThrow(/changed upstream/);
    expect(existsSync(join(dir, "real-c", "tickets-311.csv"))).toBe(false);
  });

  it("runs real datasets in a series and records their source per dataset in the results", async () => {
    const [small] = REAL_DATASETS;
    if (small?.source !== "repo") throw new Error("unexpected");
    const runs = await runSeries({
      command: fakeCommand(),
      params: PARAMS,
      variants: ["A"],
      kinds: ["inventory"],
      sizes: [20],
      real: [small, download],
      fetch: serve(csv),
      repeats: 1,
      lang: "en",
      supportsSmartDashboard: false,
      env: baseEnv(),
      workDir: join(dir, "series-real"),
    });
    expect(runs.map((r) => `${r.kind}:${r.rows}`)).toEqual([
      "inventory:20",
      "sales-es-300:300",
      "tickets-311:3",
    ]);
    const parsed = JSON.parse(
      serializeResults(
        {
          params: PARAMS,
          alisioVersion: "0.3.0",
          seed: 1,
          runs,
          generatedAt: "2026-10-03T00:00:00.000Z",
        },
        { OPENAI_API_KEY: SECRET },
      ),
    );
    expect(parsed.datasets.inventory).toEqual({ source: "generated", rows: [20] });
    expect(parsed.datasets["sales-es-300"]).toEqual({ source: "repo", rows: [300] });
    expect(parsed.datasets["tickets-311"]).toEqual({
      source: "download",
      urlHost: "data.example.org",
      rowCap: 3,
      sha256: sha,
      rows: [3],
    });
    expect(JSON.stringify(parsed)).not.toContain("token=abc");
  });
});
