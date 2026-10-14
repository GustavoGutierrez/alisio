/**
 * `alisio eval list|run|compare|variants` (specs/010 Phase 3, 5.4). The command functions take an
 * injected environment, so these tests run real suites through the real engine with a scripted
 * provider: no network, no credentials, no subprocess of the CLI.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalReport, EvalRunRecord, EvalSuite } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EvalEnv,
  type EvalFlags,
  evalCompare,
  evalExport,
  evalList,
  evalRecord,
  evalRun,
  evalVariants,
} from "../packages/cli/src/eval.ts";
import { buildReport, configSchema, renderReportMarkdown } from "../packages/core/src/index.ts";
import { runsOf, scriptedProvider } from "./eval-helpers.ts";

let root: string;
let out: string;
let err: string;
let confirmations: string[];
let confirmAnswer: boolean;
let interactive: boolean;
let provider: ReturnType<typeof scriptedProvider>;
let runtimeOpened: number;
let configSeen: ReturnType<typeof configSchema.parse>[];
let runtimeSecrets: string[];
const ENV = ["ALISIO_CONFIG_HOME", "ALISIO_STATE_HOME", "ALISIO_TMPDIR"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cli-eval-test-")));
  out = "";
  err = "";
  confirmations = [];
  confirmAnswer = false;
  interactive = false;
  runtimeOpened = 0;
  configSeen = [];
  runtimeSecrets = [];
  provider = scriptedProvider([{ text: "done" }]);
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

function env(extra: Partial<EvalEnv> = {}): EvalEnv {
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stateDir: join(root, "state"),
    interactive,
    confirm: async (question) => {
      confirmations.push(question);
      return confirmAnswer;
    },
    newRunId: () => "run-1",
    tmpRoot: root,
    openRuntime: async () => {
      runtimeOpened++;
      const config = configSchema.parse({});
      configSeen.push(config);
      return { provider, config, builtins: [], secrets: runtimeSecrets, close: async () => {} };
    },
    ...extra,
  };
}

const ALLOW: EvalFlags = { allowWrite: true, allowProcess: true };

/** A suite on disk: `keeps` passes (file-contains), `breaks` fails (file-absent of an existing file). */
function writeSuite(
  dir: string,
  options: { suiteId?: string; suiteVersion?: string; mode?: "ask" | "auto" | "full" } = {},
): string {
  const suite: EvalSuite = {
    schemaVersion: 1,
    suiteId: options.suiteId ?? "demo",
    suiteVersion: options.suiteVersion ?? "1.0.0",
    description: "demo suite",
    tasks: [
      {
        id: "keeps",
        prompt: "Do nothing",
        fixture: "fixtures/keeps",
        budget: { maxTurns: 5, maxWallMs: 20_000 },
        policy: { mode: options.mode ?? "auto" },
        verifiers: [{ kind: "file-contains", id: "has", path: "a.txt", text: "hello" }],
      },
      {
        id: "breaks",
        prompt: "Do nothing",
        fixture: "fixtures/breaks",
        budget: { maxTurns: 5, maxWallMs: 20_000 },
        policy: { mode: "auto" },
        verifiers: [{ kind: "file-absent", id: "gone", path: "a.txt" }],
      },
    ],
  };
  for (const id of ["keeps", "breaks"]) {
    mkdirSync(join(dir, "fixtures", id), { recursive: true });
    writeFileSync(join(dir, "fixtures", id, "a.txt"), "hello\n");
  }
  writeFileSync(join(dir, "suite.json"), JSON.stringify(suite));
  return dir;
}

const lines = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

describe("eval list", () => {
  it("handles having no suites at all", async () => {
    expect(await evalList(env(), {})).toBe(0);
    expect(out).toMatch(/no suites/i);
    // Bundled suites exist only in a source checkout (specs/010 O4): the message must say so.
    expect(out).toMatch(/source checkout/i);
    expect(out).toMatch(/not .*npm package/i);
    out = "";
    expect(await evalList(env(), { json: true })).toBe(0);
    expect(JSON.parse(out)).toEqual({ suites: [] });
  });

  it("lists the bundled suites and a --suite-dir (a suite or a directory of suites)", async () => {
    const bundled = join(root, "bundled");
    writeSuite(join(bundled, "alpha"), { suiteId: "alpha" });
    const third = writeSuite(join(root, "third"), { suiteId: "third", suiteVersion: "2.1.0" });
    expect(await evalList(env({ bundledDir: bundled }), { suiteDir: third })).toBe(0);
    expect(out).toMatch(/alpha\s+1\.0\.0\s+2 tasks\s+\[bundled\]/);
    expect(out).toMatch(/third\s+2\.1\.0\s+2 tasks\s+\[suite-dir\]/);
    out = "";
    expect(await evalList(env(), { suiteDir: join(root, "none") })).toBe(1);
  });

  it("shows an invalid suite with its reason instead of failing", async () => {
    mkdirSync(join(root, "sd", "broken"), { recursive: true });
    writeFileSync(join(root, "sd", "broken", "suite.json"), "{nope");
    expect(await evalList(env(), { suiteDir: join(root, "sd") })).toBe(0);
    expect(out).toMatch(/broken.*invalid/);
  });
});

describe("eval run", () => {
  it("runs the suite k times, exits 0 whatever passed, and writes the three report files", async () => {
    const dir = writeSuite(join(root, "s"));
    const target = join(root, "report");
    const code = await evalRun(
      env(),
      { ...ALLOW, suiteDir: dir, yes: true, k: "2", out: target },
      "demo",
    );
    expect(code).toBe(0);
    expect(readdirSync(target).sort()).toEqual(["report.json", "report.md", "runs.jsonl"]);
    const report = JSON.parse(read(target, "report.json")) as EvalReport;
    expect(report.suiteId).toBe("demo");
    expect(report.conditions.mode).toBe("live");
    expect(report.conditions.k).toBe(2);
    expect(report.tasks.map((t) => [t.taskId, t.successRate.value])).toEqual([
      ["breaks", 0],
      ["keeps", 1],
    ]);
    expect(lines(read(target, "runs.jsonl"))).toHaveLength(4);
    expect(read(target, "report.md")).toMatch(/not deterministic/i);
    expect(read(target, "report.md")).toMatch(/low power/i);
    expect(out).toContain("Report written to");
    expect(err).toMatch(/\[eval\] 4\/4/);
  });

  it("writes to <stateDir>/eval/<runId>/ by default", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalRun(env(), { ...ALLOW, suiteDir: dir, yes: true, k: "1" }, "demo");
    expect(readdirSync(join(root, "state", "eval", "run-1")).sort()).toEqual([
      "report.json",
      "report.md",
      "runs.jsonl",
    ]);
  });

  it("--json prints the run records as JSONL and the report as the last line", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalRun(
      env(),
      { ...ALLOW, suiteDir: dir, yes: true, k: "2", json: true, out: join(root, "o") },
      "demo",
    );
    const all = lines(out);
    expect(all).toHaveLength(5);
    for (const record of all.slice(0, 4)) {
      expect(record.schemaVersion).toBe(1);
      expect(record).toHaveProperty("runId");
      expect(record).toHaveProperty("taskId");
    }
    const last = all[4] as unknown as EvalReport;
    expect(last.tasks).toHaveLength(2);
    expect(last.runs).toEqual(all.slice(0, 4).map((r) => r.runId));
  });

  it("restricts to --tasks and runs the same plan from --seed", async () => {
    const dir = writeSuite(join(root, "s"));
    const flags = { ...ALLOW, suiteDir: dir, yes: true, k: "2", seed: "9", json: true };
    await evalRun(env(), { ...flags, tasks: "keeps", out: join(root, "o1") }, "demo");
    const ran = lines(out).slice(0, 2) as unknown as EvalRunRecord[];
    expect(ran.map((r) => r.taskId)).toEqual(["keeps", "keeps"]);
    expect(ran.map((r) => r.seed).sort((a, b) => a - b)).toEqual([9, 10]);
    expect(await evalRun(env(), { ...flags, tasks: "nope", out: join(root, "o2") }, "demo")).toBe(
      1,
    );
    expect(err).toMatch(/nope/);
  });

  it("rejects an unknown --mode before resolving a provider", async () => {
    const dir = writeSuite(join(root, "s"));
    expect(
      await evalRun(env(), { ...ALLOW, suiteDir: dir, yes: true, mode: "turbo" }, "demo"),
    ).toBe(1);
    expect(err).toMatch(/Invalid --mode "turbo"/);
    expect(runtimeOpened).toBe(0);
  });

  it("warns about a --suite-dir suite and refuses without --yes when not interactive", async () => {
    const dir = writeSuite(join(root, "s"));
    expect(await evalRun(env(), { ...ALLOW, suiteDir: dir }, "demo")).toBe(1);
    expect(err).toMatch(/not a sandbox/i);
    expect(err).toMatch(/--yes/);
    expect(runtimeOpened).toBe(0);
    expect(confirmations).toEqual([]);
  });

  it("asks interactively and honors the answer", async () => {
    const dir = writeSuite(join(root, "s"));
    interactive = true;
    confirmAnswer = false;
    expect(await evalRun(env(), { ...ALLOW, suiteDir: dir }, "demo")).toBe(1);
    expect(confirmations).toHaveLength(1);
    expect(runtimeOpened).toBe(0);
    confirmAnswer = true;
    expect(
      await evalRun(env(), { ...ALLOW, suiteDir: dir, k: "1", out: join(root, "o") }, "demo"),
    ).toBe(0);
  });

  it("does not ask for a bundled suite", async () => {
    writeSuite(join(root, "bundled", "demo"));
    const code = await evalRun(
      env({ bundledDir: join(root, "bundled") }),
      { ...ALLOW, k: "1", out: join(root, "o") },
      "demo",
    );
    expect(code).toBe(0);
    expect(confirmations).toEqual([]);
    expect(err).not.toMatch(/sandbox/i);
  });

  it("tells where the bundled suites live when none is found (npm package or binary)", async () => {
    expect(await evalRun(env(), ALLOW, "smoke-coding")).toBe(1);
    expect(err).toMatch(/Unknown suite "smoke-coding"/);
    expect(err).toMatch(/source checkout/i);
    expect(err).toMatch(/--suite-dir/);
  });

  it("reports an unknown suite with what is available", async () => {
    writeSuite(join(root, "bundled", "demo"));
    expect(await evalRun(env({ bundledDir: join(root, "bundled") }), ALLOW, "other")).toBe(1);
    expect(err).toMatch(/Unknown suite "other"/);
    expect(err).toMatch(/demo/);
  });

  it("builds the invoker from the global flags: a task needing write is refused without --allow-write", async () => {
    const dir = writeSuite(join(root, "s"));
    const code = await evalRun(env(), { suiteDir: dir, yes: true, k: "1" }, "demo");
    expect(code).toBe(1);
    expect(err).toMatch(/write/);
    expect(provider.requests).toHaveLength(0);
  });

  it("refuses a suite asking for full without --allow-suite-full, and runs it with it", async () => {
    const dir = writeSuite(join(root, "s"), { mode: "full" });
    const flags = {
      ...ALLOW,
      allowExternal: true,
      suiteDir: dir,
      yes: true,
      k: "1",
      out: join(root, "o"),
    };
    expect(await evalRun(env(), flags, "demo")).toBe(1);
    expect(err).toMatch(/--allow-suite-full/);
    expect(await evalRun(env(), { ...flags, allowSuiteFull: true }, "demo")).toBe(0);
  });

  it("exits 1 when runs ended in an infrastructure error, but still writes the report", async () => {
    const dir = writeSuite(join(root, "s"));
    provider = scriptedProvider([{ text: "x" }], {
      onCall: () => {
        throw new Error("provider down");
      },
    });
    const target = join(root, "o");
    const code = await evalRun(
      env(),
      { ...ALLOW, suiteDir: dir, yes: true, k: "1", out: target },
      "demo",
    );
    expect(code).toBe(1);
    expect(err).toMatch(/infrastructure error/);
    const report = JSON.parse(read(target, "report.json")) as EvalReport;
    expect(report.summary.errored).toBe(2);
    expect(report.tasks.every((t) => t.k === 0)).toBe(true);
  });

  it("a failure the model causes is a fail: exit 0, no infrastructure message", async () => {
    const dir = writeSuite(join(root, "s"));
    const { OutputTruncatedError } = await import("@alisio/sdk");
    provider = scriptedProvider([{ text: "x" }], {
      onCall: () => {
        throw new OutputTruncatedError("cut");
      },
    });
    const target = join(root, "o");
    const code = await evalRun(
      env(),
      { ...ALLOW, suiteDir: dir, yes: true, k: "1", out: target },
      "demo",
    );
    expect(code).toBe(0);
    expect(err).not.toMatch(/infrastructure error|Fix the cause/);
    const report = JSON.parse(read(target, "report.json")) as EvalReport;
    expect(report.summary.errored).toBe(0);
    expect(report.summary.failed).toBe(2);
  });

  it("validates --k, --seed and the rates", async () => {
    const dir = writeSuite(join(root, "s"));
    const base = { ...ALLOW, suiteDir: dir, yes: true };
    for (const bad of [
      { k: "0" },
      { k: "x" },
      { seed: "-1" },
      { seed: "1.5" },
      { inputRate: "1" },
      { inputRate: "a", outputRate: "1" },
    ])
      expect(await evalRun(env(), { ...base, ...bad }, "demo")).toBe(1);
    expect(runtimeOpened).toBe(0);
  });

  it("adds estimated cost only when both rates are given", async () => {
    const dir = writeSuite(join(root, "s"));
    provider = scriptedProvider([{ text: "done", usage: { input: 1_000_000, output: 1_000_000 } }]);
    const withRates = join(root, "with");
    await evalRun(
      env(),
      {
        ...ALLOW,
        suiteDir: dir,
        yes: true,
        k: "1",
        out: withRates,
        inputRate: "2",
        outputRate: "10",
      },
      "demo",
    );
    const report = JSON.parse(read(withRates, "report.json")) as EvalReport;
    expect(report.rates).toEqual({ inputPerMTokUsd: 2, outputPerMTokUsd: 10 });
    expect(
      report.tasks.find((t) => t.taskId === "keeps")?.estimated?.costUsdPerSuccess,
    ).toBeCloseTo(12, 9);
    expect(lines(read(withRates, "runs.jsonl"))[0]).toMatchObject({ estimated: { costUsd: 12 } });
    const without = join(root, "without");
    await evalRun(env(), { ...ALLOW, suiteDir: dir, yes: true, k: "1", out: without }, "demo");
    expect(read(without, "report.json") + read(without, "runs.jsonl")).not.toContain("costUsd");
  });

  it("prints the kept run directories with --keep", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalRun(
      env(),
      { ...ALLOW, suiteDir: dir, yes: true, k: "1", keep: true, out: join(root, "o") },
      "demo",
    );
    expect(err.match(/Kept run directory: /g)).toHaveLength(2);
  });

  it("closes the runtime even when the run fails", async () => {
    const dir = writeSuite(join(root, "s"));
    let closed = false;
    const code = await evalRun(
      env({
        openRuntime: async () => ({
          provider,
          config: configSchema.parse({}),
          builtins: [],
          close: async () => {
            closed = true;
          },
        }),
      }),
      { suiteDir: dir, yes: true },
      "demo",
    );
    expect(code).toBe(1);
    expect(closed).toBe(true);
  });
});

describe("eval compare", () => {
  const writeReport = (name: string, report: EvalReport) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.json"), JSON.stringify(report));
    return dir;
  };
  const make = (passes: number, total: number, change: Partial<EvalRunRecord> = {}) =>
    buildReport(
      runsOf(
        "t1",
        Array.from({ length: total }, (_, i) => (i < passes ? "pass" : "fail")),
        () => change,
      ),
    );

  it("prints the Markdown comparison from two report directories", async () => {
    const a = writeReport("a", make(4, 5));
    const b = writeReport("b", make(5, 5, { model: "other" }));
    expect(await evalCompare(env(), {}, a, b)).toBe(0);
    expect(out).toMatch(/# Comparison: demo 1\.0\.0/);
    expect(out).toMatch(/inconclusive/);
    expect(out).toContain("other");
  });

  it("prints JSON with --json, from report.json files directly", async () => {
    const a = join(writeReport("a", make(0, 10)), "report.json");
    const b = join(writeReport("b", make(10, 10)), "report.json");
    expect(await evalCompare(env(), { json: true }, a, b)).toBe(0);
    const comparison = JSON.parse(out) as { tasks: Array<{ successRate: { verdict: string } }> };
    expect(comparison.tasks[0]?.successRate.verdict).toBe("improved");
  });

  it("exits 3 for a different suiteVersion, and for a different suite", async () => {
    const a = writeReport("a", make(5, 5));
    const b = writeReport("b", make(5, 5, { suiteVersion: "2.0.0" }));
    expect(await evalCompare(env(), {}, a, b)).toBe(3);
    expect(err).toMatch(/1\.0\.0/);
    expect(err).toMatch(/2\.0\.0/);
    expect(out).toBe("");
    const c = writeReport("c", make(5, 5, { suiteId: "other" }));
    expect(await evalCompare(env(), {}, a, c)).toBe(3);
  });

  it("exits 1 for a missing or malformed report", async () => {
    const a = writeReport("a", make(5, 5));
    expect(await evalCompare(env(), {}, a, join(root, "missing"))).toBe(1);
    mkdirSync(join(root, "bad"));
    writeFileSync(join(root, "bad", "report.json"), "{}");
    expect(await evalCompare(env(), {}, a, join(root, "bad"))).toBe(1);
    expect(err).toMatch(/not a valid reliability report/i);
  });
});

describe("eval variants", () => {
  const writeVariants = (variants: unknown, suite = "demo") => {
    const path = join(root, "compare.json");
    writeFileSync(path, JSON.stringify({ suite, variants }));
    return path;
  };
  const good = [
    { id: "baseline", overrides: {} },
    { id: "early", overrides: { "compaction.threshold": 0.6 } },
  ];

  it("runs every variant over the same tasks and seeds and compares them with the first", async () => {
    const dir = writeSuite(join(root, "s"));
    const target = join(root, "o");
    const code = await evalVariants(
      env(),
      {
        ...ALLOW,
        suiteDir: dir,
        yes: true,
        k: "2",
        seed: "5",
        variants: writeVariants(good),
        out: target,
      },
      "demo",
    );
    expect(code).toBe(0);
    expect(readdirSync(target).sort()).toEqual([
      "baseline",
      "comparison.json",
      "comparison.md",
      "early",
    ]);
    const baseline = JSON.parse(read(target, "baseline", "report.json")) as EvalReport;
    const early = JSON.parse(read(target, "early", "report.json")) as EvalReport;
    expect(baseline.conditions.configHash).not.toBe(early.conditions.configHash);
    const comparison = JSON.parse(read(target, "comparison.json")) as {
      baselineId: string;
      variants: Array<{
        id: string;
        comparison: { tasks: Array<{ taskId: string; successRate: { delta: number } }> };
      }>;
    };
    expect(comparison.baselineId).toBe("baseline");
    expect(comparison.variants[0]?.comparison.tasks.map((t) => t.taskId)).toEqual([
      "breaks",
      "keeps",
    ]);
    expect(comparison.variants[0]?.comparison.tasks[0]?.successRate.delta).toBe(0);
    // Same plan and seeds in both variants.
    const plan = (name: string) =>
      lines(read(target, name, "runs.jsonl")).map((r) => `${r.taskId}#${r.repetition}:${r.seed}`);
    expect(plan("baseline")).toEqual(plan("early"));
    expect(out).toMatch(/# Variants: demo 1\.0\.0/);
    expect(err).toMatch(/\[eval\] early/);
  });

  it("interleaves the variants at each plan step (A,B then B,A), same tasks and seeds", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalVariants(
      env(),
      {
        ...ALLOW,
        suiteDir: dir,
        yes: true,
        k: "2",
        variants: writeVariants(good),
        out: join(root, "o"),
      },
      "demo",
    );
    const order = [...err.matchAll(/\[eval\] (\S+) \d+\/\d+ (\S+)#(\d+)/g)].map(
      (m) => `${m[1]}:${m[2]}#${m[3]}`,
    );
    expect(order).toHaveLength(8);
    const names = order.map((x) => x.split(":")[0]);
    expect(names).toEqual([
      "baseline",
      "early",
      "early",
      "baseline",
      "baseline",
      "early",
      "early",
      "baseline",
    ]);
    for (const i of [0, 2, 4, 6]) expect(order[i]?.split(":")[1]).toBe(order[i + 1]?.split(":")[1]);
  });

  it("persists each variant's overrides in comparison.json and in its report.json", async () => {
    const dir = writeSuite(join(root, "s"));
    const target = join(root, "o");
    await evalVariants(
      env(),
      { ...ALLOW, suiteDir: dir, yes: true, k: "1", variants: writeVariants(good), out: target },
      "demo",
    );
    const comparison = JSON.parse(read(target, "comparison.json")) as {
      baselineOverrides: unknown;
      variants: Array<{ id: string; overrides: unknown }>;
    };
    expect(comparison.baselineOverrides).toEqual({});
    expect(comparison.variants[0]?.overrides).toEqual({ "compaction.threshold": 0.6 });
    const early = JSON.parse(read(target, "early", "report.json")) as EvalReport;
    expect(early.variant).toEqual({ id: "early", overrides: { "compaction.threshold": 0.6 } });
    expect(read(target, "comparison.md")).toMatch(/compaction\.threshold/);
  });

  it("errored runs make the variants not comparable and say so", async () => {
    const dir = writeSuite(join(root, "s"));
    provider = scriptedProvider([{ text: "x" }], {
      onCall: () => {
        throw new Error("provider down");
      },
    });
    const target = join(root, "o");
    const code = await evalVariants(
      env(),
      { ...ALLOW, suiteDir: dir, yes: true, k: "1", variants: writeVariants(good), out: target },
      "demo",
    );
    expect(code).toBe(1);
    expect(err).toMatch(/infrastructure error/);
    expect(read(target, "comparison.md")).toContain("not comparable: errored runs");
  });

  it("applies the overrides before the config reaches the engine", async () => {
    const dir = writeSuite(join(root, "s"));
    const code = await evalVariants(
      env(),
      {
        ...ALLOW,
        suiteDir: dir,
        yes: true,
        k: "1",
        variants: writeVariants(good),
        out: join(root, "o"),
        keep: true,
      },
      "demo",
    );
    expect(code).toBe(0);
    const kept = [...err.matchAll(/Kept run directory: (.+)/g)].map((m) => m[1] as string);
    const thresholds = new Set(
      kept.map(
        (dir) =>
          (JSON.parse(read(dir, "config", "config.json")) as { compaction: { threshold: number } })
            .compaction.threshold,
      ),
    );
    expect([...thresholds].sort()).toEqual([0.6, 0.85]);
  });

  it("rejects an unknown override key naming the variant and the key, before any run", async () => {
    const dir = writeSuite(join(root, "s"));
    const bad = [
      { id: "baseline", overrides: {} },
      { id: "typo", overrides: { "compaction.treshold": 0.6 } },
    ];
    const code = await evalVariants(
      env(),
      { ...ALLOW, suiteDir: dir, yes: true, variants: writeVariants(bad) },
      "demo",
    );
    expect(code).toBe(1);
    expect(err).toMatch(/typo/);
    expect(err).toMatch(/compaction\.treshold/);
    expect(provider.requests).toHaveLength(0);
  });

  it("needs --variants, a matching suite and a valid file", async () => {
    const dir = writeSuite(join(root, "s"));
    const base = { ...ALLOW, suiteDir: dir, yes: true };
    expect(await evalVariants(env(), base, "demo")).toBe(1);
    expect(
      await evalVariants(env(), { ...base, variants: writeVariants(good, "other") }, "demo"),
    ).toBe(1);
    expect(err).toMatch(/other/);
    expect(
      await evalVariants(env(), { ...base, variants: join(root, "missing.json") }, "demo"),
    ).toBe(1);
    expect(provider.requests).toHaveLength(0);
  });

  it("emits typed JSONL with --json", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalVariants(
      env(),
      {
        ...ALLOW,
        suiteDir: dir,
        yes: true,
        k: "1",
        variants: writeVariants(good),
        out: join(root, "o"),
        json: true,
      },
      "demo",
    );
    const types = lines(out).map((l) => l.type);
    expect(types).toEqual(["variant_report", "variant_report", "comparison"]);
  });
});

describe("eval record and --mode replay (Phase 4)", () => {
  const flagsFor = (dir: string, extra: EvalFlags = {}): EvalFlags => ({
    ...ALLOW,
    suiteDir: dir,
    yes: true,
    ...extra,
  });
  const cassettePath = (dir: string, id: string) => join(dir, "cassettes", `${id}.cassette.jsonl`);

  it("record runs each task once live and writes <suite>/cassettes/<task>.cassette.jsonl", async () => {
    const dir = writeSuite(join(root, "s"));
    expect(await evalRecord(env(), flagsFor(dir), "demo")).toBe(0);
    expect(readdirSync(join(dir, "cassettes")).sort()).toEqual([
      "breaks.cassette.jsonl",
      "keeps.cassette.jsonl",
    ]);
    expect(provider.requests).toHaveLength(2);
    const header = JSON.parse(read(dir, "cassettes", "keeps.cassette.jsonl").split("\n")[0] ?? "");
    expect(header).toMatchObject({
      v: 1,
      suiteId: "demo",
      taskId: "keeps",
      provider: "fake",
      model: "fake-model",
    });
    expect(out).toContain("keeps.cassette.jsonl");
  });

  it("honors --tasks and --cassette-dir, and refuses --k above 1", async () => {
    const dir = writeSuite(join(root, "s"));
    const target = join(root, "elsewhere");
    expect(
      await evalRecord(env(), flagsFor(dir, { tasks: "keeps", cassetteDir: target }), "demo"),
    ).toBe(0);
    expect(readdirSync(target)).toEqual(["keeps.cassette.jsonl"]);
    expect(existsSync(join(dir, "cassettes"))).toBe(false);
    expect(await evalRecord(env(), flagsFor(dir, { k: "3" }), "demo")).toBe(1);
    expect(err).toMatch(/once/);
  });

  it("record --json prints the run records as JSONL", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalRecord(env(), flagsFor(dir, { json: true }), "demo");
    const records = lines(out) as unknown as EvalRunRecord[];
    expect(records.map((r) => [r.taskId, r.mode]).sort()).toEqual([
      ["breaks", "live"],
      ["keeps", "live"],
    ]);
  });

  it("record refuses a cassette that holds a secret and names the field", async () => {
    const dir = writeSuite(join(root, "s"));
    writeFileSync(
      join(dir, "fixtures", "keeps", "a.txt"),
      "hello\nOPENAI_API_KEY=sk-live-0123456789abcdefghijkl\n",
    );
    provider = scriptedProvider([
      { calls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { text: "done" },
    ]);
    expect(await evalRecord(env(), flagsFor(dir, { tasks: "keeps" }), "demo")).toBe(1);
    expect(err).toMatch(/Refusing to write the cassette: calls\[1\]\.messages\./);
    expect(err).not.toContain("sk-live-0123456789abcdefghijkl");
    expect(existsSync(cassettePath(dir, "keeps"))).toBe(false);
  });

  it("record refuses the exact credential values of the provider profile", async () => {
    const dir = writeSuite(join(root, "s"));
    runtimeSecrets = ["profile-secret-value-1"];
    provider = scriptedProvider([{ text: "echo profile-secret-value-1" }]);
    expect(await evalRecord(env(), flagsFor(dir, { tasks: "keeps" }), "demo")).toBe(1);
    expect(err).toMatch(/looks like a secret/);
    expect(existsSync(cassettePath(dir, "keeps"))).toBe(false);
  });

  it("record fails, writes nothing and says why when the run errored", async () => {
    const dir = writeSuite(join(root, "s"));
    provider = scriptedProvider([{ text: "x" }], {
      onCall: () => {
        throw new Error("provider down");
      },
    });
    expect(await evalRecord(env(), flagsFor(dir, { tasks: "keeps" }), "demo")).toBe(1);
    expect(err).toMatch(/provider down/);
    expect(existsSync(cassettePath(dir, "keeps"))).toBe(false);
  });

  it("replays the cassettes without calling the provider and labels the report as replay", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalRecord(env(), flagsFor(dir), "demo");
    const called = provider.requests.length;
    const target = join(root, "report");
    expect(await evalRun(env(), flagsFor(dir, { mode: "replay", out: target }), "demo")).toBe(0);
    expect(provider.requests).toHaveLength(called);
    const report = JSON.parse(read(target, "report.json")) as EvalReport;
    expect(report.conditions.mode).toBe("replay");
    expect(report.conditions.k).toBe(1);
    expect(report.tasks.map((t) => [t.taskId, t.successRate.value])).toEqual([
      ["breaks", 0],
      ["keeps", 1],
    ]);
    expect(read(target, "report.md")).toMatch(/replay.*harness|harness.*replay/is);
    const runs = lines(read(target, "runs.jsonl")) as unknown as EvalRunRecord[];
    expect(runs.every((r) => r.mode === "replay")).toBe(true);
  });

  it("replay needs no configured provider (credentials are not required)", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalRecord(env(), flagsFor(dir), "demo");
    const seen: Array<{ requireProvider?: boolean } | undefined> = [];
    const base = env();
    await evalRun(
      {
        ...base,
        openRuntime: (flags, options) => {
          seen.push(options);
          return base.openRuntime(flags, options);
        },
      },
      flagsFor(dir, { mode: "replay", out: join(root, "o") }),
      "demo",
    );
    expect(seen).toEqual([{ requireProvider: false }]);
  });

  it("exits 2 with the structured diff when the harness request changed", async () => {
    const dir = writeSuite(join(root, "s"));
    await evalRecord(env(), flagsFor(dir), "demo");
    const suiteFile = join(dir, "suite.json");
    writeFileSync(suiteFile, read(dir, "suite.json").replaceAll("Do nothing", "Do something else"));
    const target = join(root, "report");
    const code = await evalRun(env(), flagsFor(dir, { mode: "replay", out: target }), "demo");
    expect(code).toBe(2);
    expect(err).toMatch(/diverged/i);
    expect(err).toMatch(/messages\[0\]\.user\.text/);
    expect(err).toContain("Do nothing");
    const runs = lines(read(target, "runs.jsonl")) as unknown as EvalRunRecord[];
    expect(runs.every((r) => r.status === "error" && r.error === "replay_divergence")).toBe(true);
    expect(runs[0]?.divergence?.diff[0]?.field).toBe("messages[0].user.text");
  });

  it("names the missing cassette and the command that records it", async () => {
    const dir = writeSuite(join(root, "s"));
    expect(await evalRun(env(), flagsFor(dir, { mode: "replay" }), "demo")).toBe(1);
    expect(err).toContain(cassettePath(dir, "keeps"));
    expect(err).toMatch(/alisio eval record/);
    expect(runtimeOpened).toBe(0);
  });

  it("reads the cassettes from --cassette-dir", async () => {
    const dir = writeSuite(join(root, "s"));
    const target = join(root, "elsewhere");
    await evalRecord(env(), flagsFor(dir, { cassetteDir: target }), "demo");
    expect(
      await evalRun(
        env(),
        flagsFor(dir, { mode: "replay", cassetteDir: target, out: join(root, "o") }),
        "demo",
      ),
    ).toBe(0);
  });

  it("variants refuses --mode replay", async () => {
    const dir = writeSuite(join(root, "s"));
    const file = join(root, "v.json");
    writeFileSync(
      file,
      JSON.stringify({
        suite: "demo",
        variants: [
          { id: "a", overrides: {} },
          { id: "b", overrides: {} },
        ],
      }),
    );
    expect(
      await evalVariants(env(), flagsFor(dir, { mode: "replay", variants: file }), "demo"),
    ).toBe(1);
    expect(err).toMatch(/replay/i);
  });
});

describe("eval export", () => {
  const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOP1234567890";

  /** A recorded run on disk, as `eval run` writes it, with absolute paths in a detail string. */
  function plantRun(runId: string, detail: string): string {
    const dir = join(root, "state", "eval", runId);
    mkdirSync(dir, { recursive: true });
    const runs = runsOf("t1", ["pass", "fail", "pass"], (i) => ({
      provider: "openai-compatible@llm.corp.example.com:8443",
      ...(i === 1 ? { verifiers: [{ id: "v", status: "fail" as const, detail }] } : {}),
    }));
    const report = buildReport(runs);
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(dir, "report.md"), renderReportMarkdown(report));
    writeFileSync(join(dir, "runs.jsonl"), `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return dir;
  }
  const target = () => join(root, "share", "bundle.json");

  it("writes one bundle without absolute paths, home dir or the endpoint host", async () => {
    plantRun(
      "r1",
      `cannot open ${homedir()}/proj/a.ts and ${join(root, "state")}/x and ${dir0()}/w`,
    );
    expect(await evalExport(env(), { out: target() }, "r1")).toBe(0);
    const raw = readFileSync(target(), "utf8");
    expect(raw).not.toContain(homedir());
    expect(raw).not.toContain(root);
    expect(raw).not.toContain("corp.example.com");
    const bundle = JSON.parse(raw);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.runs).toHaveLength(3);
    expect(typeof bundle.markdown).toBe("string");
    expect(out).toContain("bundle.json");
  });

  it("keeps the report numbers of the source", async () => {
    const dir = plantRun("r1", "plain detail");
    expect(await evalExport(env(), { out: target() }, "r1")).toBe(0);
    const source = JSON.parse(read(dir, "report.json")) as EvalReport;
    const exported = JSON.parse(readFileSync(target(), "utf8")).report as EvalReport;
    expect(exported.tasks).toEqual(source.tasks);
    expect(exported.summary).toEqual(source.summary);
  });

  it("refuses (exit 1, writes nothing) when a secret is present, naming the field not the value", async () => {
    plantRun("r1", `key ${KEY}`);
    expect(await evalExport(env(), { out: target() }, "r1")).toBe(1);
    expect(err).toContain("runs[1].verifiers[0].detail");
    expect(err).not.toContain(KEY);
    expect(existsSync(target())).toBe(false);
  });

  it("refuses the credential values of the environment too", async () => {
    plantRun("r1", "token hunter2hunter2 used");
    process.env.ALISIO_EVAL_EXPORT_TEST_TOKEN = "hunter2hunter2";
    try {
      expect(await evalExport(env(), { out: target() }, "r1")).toBe(1);
    } finally {
      delete process.env.ALISIO_EVAL_EXPORT_TEST_TOKEN;
    }
    expect(err).not.toContain("hunter2hunter2");
  });

  it.each(["../escape", "a/b", "..", ".hidden", "", "x\\y"])(
    "rejects the run id %j",
    async (id) => {
      plantRun("r1", "d");
      expect(await evalExport(env(), { out: target() }, id)).toBe(1);
      expect(err).toMatch(/run id/i);
      expect(existsSync(target())).toBe(false);
    },
  );

  it("fails clearly for a run that does not exist or has no report", async () => {
    expect(await evalExport(env(), { out: target() }, "nope")).toBe(1);
    expect(err).toMatch(/no run "nope"/i);
  });

  it("requires --out and refuses to overwrite without --force", async () => {
    plantRun("r1", "d");
    expect(await evalExport(env(), {}, "r1")).toBe(1);
    expect(err).toMatch(/--out/);
    err = "";
    mkdirSync(join(root, "share"), { recursive: true });
    writeFileSync(target(), "precious");
    expect(await evalExport(env(), { out: target() }, "r1")).toBe(1);
    expect(err).toMatch(/--force/);
    expect(readFileSync(target(), "utf8")).toBe("precious");
    expect(await evalExport(env(), { out: target(), force: true }, "r1")).toBe(0);
    expect(JSON.parse(readFileSync(target(), "utf8")).schemaVersion).toBe(1);
  });
});

function dir0(): string {
  return join(tmpdir(), "alisio-eval-abc123");
}
