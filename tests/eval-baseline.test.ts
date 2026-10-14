/**
 * Smoke test of the Phase 0 baseline script (specs/010 §8): scripted provider, no network, no
 * credentials. Covers the three recorded data points (success, variance, infrastructure failures),
 * the measured/estimated split, fixture isolation and the usage error without a provider.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../packages/core/src/index.ts";
import { BenchUsageError } from "../scripts/bench/lib.ts";
import {
  type AppFactory,
  createLiveAppFactory,
  median,
  planOrder,
  runBaseline,
  sampleVariance,
  TASKS,
} from "../scripts/eval-baseline.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Scripted solutions: the file each task must rewrite (path, new content). */
const SOLUTIONS: Record<string, { path: string; content: string }> = {
  "fix-add": {
    path: "src/math.ts",
    content: "export const add = (a: number, b: number) => a + b;\n",
  },
  "add-slugify": {
    path: "src/strings.ts",
    content:
      "export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);\n" +
      "export const slugify = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n",
  },
  "implement-chunk": {
    path: "src/list.ts",
    content:
      "export function chunk<T>(items: T[], size: number): T[][] {\n" +
      "  const out: T[][] = [];\n" +
      "  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n" +
      "  return out;\n}\n",
  },
};

interface Script {
  /** Tasks whose solution is wrong (the run completes, the verifier fails). */
  wrong?: Set<string>;
  /** Tasks whose provider call throws (infrastructure failure). */
  broken?: Set<string>;
  seenCwds: string[];
}

function scripted(script: Script): AppFactory {
  let tokens = 100;
  return async ({ cwd, db }) => {
    script.seenCwds.push(cwd);
    const provider: ModelProvider = {
      id: "scripted",
      model: "scripted-model",
      async *stream(request) {
        const first = request.messages.find((m) => m.role === "user");
        const prompt = first?.role === "user" ? first.text : "";
        const task = TASKS.find((t) => prompt.includes(t.prompt));
        if (!task) throw new Error("unknown task prompt");
        if (script.broken?.has(task.id)) throw new Error("provider exploded");
        const answered = request.messages.some((m) => m.role === "tool");
        tokens += 10;
        if (answered) {
          yield {
            type: "completed",
            message: { role: "assistant", text: "done", calls: [] },
            usage: { input: tokens, output: 5 },
          };
          return;
        }
        const solution = SOLUTIONS[task.id];
        if (!solution) throw new Error("no solution");
        const original = task.files[solution.path] ?? "";
        const content = script.wrong?.has(task.id) ? original : solution.content;
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: "",
            calls: [
              {
                id: "call-1",
                name: "write_file",
                arguments: JSON.stringify({
                  path: solution.path,
                  content,
                  expectedHash: sha(original),
                }),
              },
            ],
          },
          usage: { input: tokens, output: 20 },
        };
      },
    };
    const app = await createApplication({ cwd, db, noHerdr: true, allowWrite: true, provider });
    return app;
  };
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-eval-baseline-"));
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("pure helpers", () => {
  it("computes median and sample variance", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(sampleVariance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7);
    expect(sampleVariance([3])).toBeNull();
  });

  it("plans every (task, repetition) pair once, deterministically per seed", () => {
    const a = planOrder(["a", "b", "c"], 4, 42);
    expect(a).toHaveLength(12);
    expect(new Set(a.map((p) => `${p.task}#${p.repetition}`)).size).toBe(12);
    expect(planOrder(["a", "b", "c"], 4, 42)).toEqual(a);
    expect(planOrder(["a", "b", "c"], 4, 43)).not.toEqual(a);
  });
});

describe("runBaseline", () => {
  it("reports success, measured tokens/time spread and zero infrastructure failures", async () => {
    const script: Script = { seenCwds: [] };
    const report = await runBaseline({ k: 2, seed: 7, makeApp: scripted(script), tmpRoot: root });
    expect(report.k).toBe(2);
    expect(report.seed).toBe(7);
    expect(report.provider).toEqual({ id: "scripted", model: "scripted-model" });
    expect(report.tasks.map((t) => t.id).sort()).toEqual(TASKS.map((t) => t.id).sort());
    for (const task of report.tasks) {
      expect(task.runs).toBe(2);
      expect(task.successes).toBe(2);
      expect(task.successRate).toBe(1);
      expect(task.infraFailures).toBe(0);
      expect(task.measured.tokens.samples).toBe(2);
      expect(task.measured.tokens.median).toBeGreaterThan(0);
      expect(task.measured.tokens.variance).toBeGreaterThan(0);
      expect(task.measured.wallMs.median).toBeGreaterThanOrEqual(0);
    }
    expect(report.infraFailures).toBe(0);
    // Nothing is invented: cost is not measured, so it is reported as unavailable.
    expect(report.estimated.costUsd).toBeNull();
  });

  it("separates task failures from infrastructure failures", async () => {
    const script: Script = {
      seenCwds: [],
      wrong: new Set(["fix-add"]),
      broken: new Set(["implement-chunk"]),
    };
    const report = await runBaseline({ k: 2, seed: 1, makeApp: scripted(script), tmpRoot: root });
    const by = Object.fromEntries(report.tasks.map((t) => [t.id, t]));
    expect(by["fix-add"]).toMatchObject({ successRate: 0, taskFailures: 2, infraFailures: 0 });
    expect(by["implement-chunk"]).toMatchObject({
      successes: 0,
      taskFailures: 0,
      infraFailures: 2,
    });
    expect(by["implement-chunk"]?.measured.tokens.samples).toBe(0);
    expect(by["add-slugify"]).toMatchObject({ successRate: 1, infraFailures: 0 });
    expect(report.infraFailures).toBe(2);
  });

  it("runs every repetition on a throwaway copy under the temp root", async () => {
    const script: Script = { seenCwds: [] };
    await runBaseline({ k: 1, seed: 1, makeApp: scripted(script), tmpRoot: root });
    expect(script.seenCwds).toHaveLength(TASKS.length);
    for (const cwd of script.seenCwds) {
      expect(cwd.startsWith(root)).toBe(true);
      expect(existsSync(cwd)).toBe(false);
    }
  });
});

describe("live mode", () => {
  it("fails with a usage error when no provider is configured", async () => {
    const factory = createLiveAppFactory({});
    await expect(factory({ cwd: root, db: join(root, "db.sqlite") })).rejects.toBeInstanceOf(
      BenchUsageError,
    );
  });
});
