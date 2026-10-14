/**
 * `scripts/eval-ci.ts` (specs/010 O7): the opt-in CI gate that replays the bundled cassettes and
 * exits non-zero when a replay diverges, a task does not pass or nothing was replayed. It reuses
 * `alisio eval run --mode replay`; these tests drive it with the real engine and the real cassettes
 * (no network, no credentials) and with the same "reworded tool description" harness change as
 * tests/eval-bundled-suites.test.ts.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuiltinPlugin } from "../packages/core/src/index.ts";
import { runEvalCi } from "../scripts/eval-ci.ts";
import { bundledRunOptions } from "../scripts/eval-record-bundled.ts";

const BUNDLED = resolve(import.meta.dirname, "fixtures/eval");
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "eval-ci-test-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function capture() {
  const lines = { out: "", err: "" };
  return {
    lines,
    out: (text: string) => void (lines.out += text),
    err: (text: string) => void (lines.err += text),
  };
}

describe("all green", () => {
  it("replays every bundled cassette, exits 0, writes the reports and says what replay measures", async () => {
    const io = capture();
    const out = join(root, "green");
    const started = performance.now();
    const result = await runEvalCi({ outDir: out, tmpRoot: root, ...io });
    const elapsed = performance.now() - started;
    expect(io.lines.err).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.replayed).toBe(10);
    expect(result.passed).toBe(10);
    expect(result.diverged).toEqual([]);
    expect(result.suites.map((s) => s.suiteId).sort()).toEqual(["smoke-coding", "tool-sequences"]);
    expect(result.skipped).toEqual(["long-context"]);
    for (const suite of ["smoke-coding", "tool-sequences"]) {
      expect(existsSync(join(out, suite, "report.json"))).toBe(true);
      expect(existsSync(join(out, suite, "report.md"))).toBe(true);
    }
    expect(io.lines.out).toMatch(/replay measures the harness, not the model/i);
    expect(io.lines.out).toMatch(/10\/10/);
    // Spec section 11: the whole replay stays inside 10 s.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe("harness change", () => {
  it("exits non-zero and names the field that diverged", async () => {
    const { builtins } = bundledRunOptions();
    const tweaked: BuiltinPlugin[] = builtins.map((builtin) => ({
      ...builtin,
      create(options, context) {
        const plugin = builtin.create(options, context);
        return {
          ...plugin,
          setup(api) {
            return plugin.setup({
              ...api,
              tools: {
                register: (tool) =>
                  api.tools.register({ ...tool, description: `${tool.description} (reworded)` }),
              },
            });
          },
        };
      },
    }));
    const io = capture();
    const result = await runEvalCi({
      outDir: join(root, "diverged"),
      tmpRoot: root,
      builtins: tweaked,
      ...io,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(2);
    expect(result.diverged.length).toBeGreaterThan(0);
    expect(io.lines.err).toMatch(/tools\[[^\]]+\]\.description/);
    expect(io.lines.out).toMatch(/DIVERGED/);
  });
});

describe("misconfiguration", () => {
  it("exits non-zero when the suite directory holds no suite", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const io = capture();
    const result = await runEvalCi({
      suiteDir: empty,
      outDir: join(root, "empty-out"),
      tmpRoot: root,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(result.replayed).toBe(0);
    expect(io.lines.err).toMatch(/nothing to replay/i);
  });

  it("exits non-zero when the suites have no cassettes", async () => {
    const copy = join(root, "no-cassettes");
    cpSync(join(BUNDLED, "long-context"), join(copy, "long-context"), { recursive: true });
    const io = capture();
    const result = await runEvalCi({
      suiteDir: copy,
      outDir: join(root, "nc-out"),
      tmpRoot: root,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.lines.err).toMatch(/nothing to replay/i);
  });

  it("exits non-zero when a replayed task does not pass", async () => {
    // A cassette whose task verifier cannot pass: replay a cassette against a suite whose verifier
    // was changed to something the recorded run never satisfies.
    const copy = join(root, "failing");
    cpSync(join(BUNDLED, "tool-sequences"), join(copy, "tool-sequences"), { recursive: true });
    const suitePath = join(copy, "tool-sequences", "suite.json");
    const suite = JSON.parse(readFileSync(suitePath, "utf8")) as {
      tasks: Array<{ id: string; verifiers: Array<Record<string, unknown>> }>;
    };
    const task = suite.tasks.find((t) => t.id === "read-before-edit");
    if (!task) throw new Error("task missing");
    task.verifiers.push({
      id: "impossible",
      kind: "file-contains",
      path: "never-created.txt",
      text: "x",
    });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(suitePath, JSON.stringify(suite));
    const io = capture();
    const result = await runEvalCi({
      suiteDir: copy,
      outDir: join(root, "failing-out"),
      tmpRoot: root,
      ...io,
    });
    expect(result.exitCode).toBe(1);
    expect(result.passed).toBeLessThan(result.replayed);
    expect(io.lines.out).toMatch(/NOT PASSING tool-sequences\/read-before-edit/);
  });
});

describe("the script entry point", () => {
  it("exits 1 for an empty suite dir and 0 for --help, from a source checkout", () => {
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--conditions=alisio-source",
          "--experimental-transform-types",
          "--disable-warning=ExperimentalWarning",
          resolve(import.meta.dirname, "../scripts/eval-ci.ts"),
          ...args,
        ],
        { encoding: "utf8" },
      );
    const empty = join(root, "entry-empty");
    mkdirSync(empty);
    const bad = run("--suite-dir", empty, "--out", join(root, "entry-out"));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/nothing to replay/i);
    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/eval-ci/);
  });
});
