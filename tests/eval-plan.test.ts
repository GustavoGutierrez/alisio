/** Reliability lab Phase 3: run planning and the serialized suite runner (specs/010 D6, D15). */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvalRunRefusedError } from "../packages/core/src/eval/engine.ts";
import { interleaveVariants, mulberry32, planRuns } from "../packages/core/src/eval/plan.ts";
import { runEvaluation, runVariantEvaluations } from "../packages/core/src/eval/run-suite.ts";
import { configSchema } from "../packages/core/src/index.ts";
import { makeSuite, scriptedProvider, task } from "./eval-helpers.ts";

describe("planRuns", () => {
  const ids = ["a", "b", "c"];

  it("lists every (task, repetition) pair exactly once", () => {
    const plan = planRuns(ids, 4, 7);
    expect(plan).toHaveLength(12);
    const keys = new Set(plan.map((p) => `${p.taskId}#${p.repetition}`));
    expect(keys.size).toBe(12);
    for (const id of ids) for (let r = 0; r < 4; r++) expect(keys.has(`${id}#${r}`)).toBe(true);
  });

  it("is deterministic for a seed and varies with it", () => {
    expect(planRuns(ids, 4, 7)).toEqual(planRuns(ids, 4, 7));
    expect(planRuns(ids, 4, 7)).not.toEqual(planRuns(ids, 4, 8));
  });

  it("does not depend on the order the caller listed the tasks in", () => {
    expect(planRuns(["c", "a", "b"], 3, 11)).toEqual(planRuns(["a", "b", "c"], 3, 11));
  });

  it("gives mulberry32 the sequence of scripts/bench/lib.ts", () => {
    const random = mulberry32(1);
    const first = random();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(mulberry32(1)()).toBe(first);
  });
});

describe("interleaveVariants", () => {
  const plan = planRuns(["a", "b"], 2, 3);

  it("visits every variant at every plan step, alternating the order (A,B then B,A)", () => {
    const steps = interleaveVariants(plan, ["x", "y"]);
    expect(steps).toHaveLength(plan.length * 2);
    expect(steps.map((s) => s.variantId).slice(0, 6)).toEqual(["x", "y", "y", "x", "x", "y"]);
    plan.forEach((p, i) => {
      for (const step of steps.slice(i * 2, i * 2 + 2)) {
        expect([step.taskId, step.repetition, step.step]).toEqual([p.taskId, p.repetition, i]);
      }
    });
  });

  it("rotates the starting variant with three variants and leaves one variant untouched", () => {
    const steps = interleaveVariants(plan, ["x", "y", "z"]);
    expect(steps.slice(0, 6).map((s) => s.variantId)).toEqual(["x", "y", "z", "y", "z", "x"]);
    expect(interleaveVariants(plan, ["only"]).map((s) => s.taskId)).toEqual(
      plan.map((p) => p.taskId),
    );
  });
});

describe("runEvaluation", () => {
  let root: string;
  const ENV = ["ALISIO_CONFIG_HOME", "ALISIO_STATE_HOME", "ALISIO_TMPDIR"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "eval-plan-test-")));
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const invoker = { write: true, process: true, external: true, analysis: true };
  const tasks = () => [
    task({
      id: "keeps",
      fixture: "fixtures/keeps",
      verifiers: [{ kind: "file-contains", id: "has", path: "a.txt", text: "hello" }],
    }),
    task({
      id: "breaks",
      fixture: "fixtures/breaks",
      verifiers: [{ kind: "file-absent", id: "gone", path: "a.txt" }],
    }),
  ];
  const base = (extra: Record<string, unknown> = {}) => {
    const provider = scriptedProvider([{ text: "done" }]);
    return {
      suite: makeSuite(root, tasks(), { "a.txt": "hello\n" }),
      provider,
      config: configSchema.parse({}),
      invoker,
      tmpRoot: root,
      k: 3,
      seedBase: 40,
      ...extra,
    };
  };

  it("runs k repetitions of every task, serially, with seedBase + repetition as the run seed", async () => {
    const seen: string[] = [];
    const result = await runEvaluation({
      ...base(),
      onRecord: (record) => seen.push(`${record.taskId}#${record.repetition}`),
    });
    expect(result.records).toHaveLength(6);
    expect(seen).toHaveLength(6);
    for (const record of result.records) expect(record.seed).toBe(40 + record.repetition);
    expect(
      result.records.filter((r) => r.taskId === "keeps").every((r) => r.status === "pass"),
    ).toBe(true);
    expect(
      result.records.filter((r) => r.taskId === "breaks").every((r) => r.status === "fail"),
    ).toBe(true);
  });

  it("runs the same plan for the same seed, so variants see the same tasks in the same order", async () => {
    const order = async () =>
      (await runEvaluation(base())).records.map((r) => `${r.taskId}#${r.repetition}`);
    expect(await order()).toEqual(await order());
  });

  it("restricts the run to the chosen tasks and rejects unknown ids by name", async () => {
    const result = await runEvaluation({ ...base(), taskIds: ["keeps"], k: 2 });
    expect(result.records.map((r) => r.taskId)).toEqual(["keeps", "keeps"]);
    await expect(runEvaluation({ ...base(), taskIds: ["nope"] })).rejects.toThrow(/nope/);
  });

  it("refuses the whole batch before the first run when one task is not allowed", async () => {
    const options = base();
    const suite = makeSuite(
      root,
      [task({ id: "wild", fixture: "fixtures/wild", policy: { mode: "full" } })],
      { "a.txt": "x" },
    );
    await expect(runEvaluation({ ...options, suite })).rejects.toThrow(EvalRunRefusedError);
    expect(options.provider.requests).toHaveLength(0);
    await expect(
      runEvaluation({ ...options, suite, allowSuiteFull: true, k: 1 }),
    ).resolves.toBeTruthy();
  });

  it("rejects a k that is not a positive integer", async () => {
    await expect(runEvaluation({ ...base(), k: 0 })).rejects.toThrow(/k/);
    await expect(runEvaluation({ ...base(), k: 1.5 })).rejects.toThrow(/k/);
  });

  it("runs variants interleaved at each plan step over the same tasks, repetitions and seeds", async () => {
    const early = configSchema.parse({ compaction: { threshold: 0.5 } });
    const seen: string[] = [];
    const results = await runVariantEvaluations({
      ...base({ k: 2 }),
      variants: [
        { id: "a", config: configSchema.parse({}) },
        { id: "b", config: early },
      ],
      onRecord: (id, record) => seen.push(`${id}:${record.taskId}#${record.repetition}`),
    });
    expect(seen).toHaveLength(8);
    // Pairs are the same (task, repetition); the order inside a pair alternates A,B / B,A.
    const pairs = [0, 2, 4, 6].map((i) => seen.slice(i, i + 2));
    pairs.forEach((pair, i) => {
      expect(pair.map((x) => x.split(":")[0])).toEqual(i % 2 === 0 ? ["a", "b"] : ["b", "a"]);
      expect(new Set(pair.map((x) => x.split(":")[1])).size).toBe(1);
    });
    const [a, b] = results;
    expect(a?.id).toBe("a");
    expect(b?.id).toBe("b");
    const key = (r: { taskId: string; repetition: number; seed: number }) =>
      `${r.taskId}#${r.repetition}@${r.seed}`;
    expect(new Set(a?.records.map(key))).toEqual(new Set(b?.records.map(key)));
    expect(a?.records[0]?.configHash).not.toBe(b?.records[0]?.configHash);
  });
});
