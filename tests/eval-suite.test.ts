/** Suite loader of the reliability lab (specs/010 D1, Phase 1): validation and safe paths. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalSuite, EvalTask } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvalSuiteError, loadSuite } from "../packages/core/src/eval/suite.ts";

let root: string;
let suiteDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eval-suite-"));
  suiteDir = join(root, "suite");
  mkdirSync(join(suiteDir, "fixtures", "a"), { recursive: true });
  mkdirSync(join(suiteDir, "fixtures", "b"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const task = (id: string, overrides: Partial<EvalTask> = {}): EvalTask => ({
  id,
  prompt: `Do ${id}`,
  fixture: `fixtures/${id}`,
  budget: { maxTurns: 30, maxWallMs: 120_000 },
  policy: { mode: "auto" },
  verifiers: [{ kind: "file-absent", id: "no-tmp", path: "tmp.txt" }],
  ...overrides,
});

const suite = (tasks: EvalTask[], overrides: Record<string, unknown> = {}): EvalSuite =>
  ({
    schemaVersion: 1,
    suiteId: "demo",
    suiteVersion: "1.0.0",
    description: "demo suite",
    tasks,
    ...overrides,
  }) as EvalSuite;

const write = (value: unknown) =>
  writeFileSync(
    join(suiteDir, "suite.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );

describe("loadSuite", () => {
  it("loads a valid suite and resolves each fixture to an absolute directory", () => {
    write(suite([task("a"), task("b")]));
    const loaded = loadSuite(suiteDir);
    expect(loaded.suite.suiteId).toBe("demo");
    expect(loaded.suite.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(loaded.fixtureDirs.a).toBe(join(suiteDir, "fixtures", "a"));
    expect(loaded.dir).toBe(suiteDir);
  });

  it("rejects a duplicate task id and names it", () => {
    write(suite([task("a"), task("b", { id: "a" })]));
    expect(() => loadSuite(suiteDir)).toThrow(EvalSuiteError);
    expect(() => loadSuite(suiteDir)).toThrow(/duplicate task id "a"/i);
  });

  it("rejects a missing fixture and says which task and which path", () => {
    write(suite([task("a"), task("ghost")]));
    expect(() => loadSuite(suiteDir)).toThrow(/task "ghost".*fixtures\/ghost.*does not exist/is);
  });

  it("rejects a fixture that is a file, not a directory", () => {
    writeFileSync(join(suiteDir, "fixtures", "file"), "x");
    write(suite([task("file")]));
    expect(() => loadSuite(suiteDir)).toThrow(/task "file".*not a directory/is);
  });

  it("rejects a fixture path that climbs out of the suite directory", () => {
    mkdirSync(join(root, "outside"));
    write(suite([task("a", { fixture: "../outside" })]));
    expect(() => loadSuite(suiteDir)).toThrow(/task "a".*fixture.*inside the suite directory/is);
  });

  it("rejects an absolute fixture path", () => {
    write(suite([task("a", { fixture: join(root, "outside") })]));
    expect(() => loadSuite(suiteDir)).toThrow(/task "a".*fixture.*relative/is);
  });

  it("rejects a symlinked fixture that resolves outside the suite directory", () => {
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(suiteDir, "fixtures", "link"));
    write(suite([task("link")]));
    expect(() => loadSuite(suiteDir)).toThrow(/task "link".*inside the suite directory/is);
  });

  it("rejects verifier paths that escape the working directory", () => {
    write(
      suite([
        task("a", {
          verifiers: [{ kind: "file-equals", id: "v", path: "../x", sha256: "0".repeat(64) }],
        }),
      ]),
    );
    expect(() => loadSuite(suiteDir)).toThrow(/task "a".*verifier "v".*path/is);
    write(
      suite([task("a", { verifiers: [{ kind: "tree-diff-within", id: "t", allowed: ["/etc"] }] })]),
    );
    expect(() => loadSuite(suiteDir)).toThrow(/task "a".*verifier "t".*allowed/is);
  });

  it("rejects duplicate verifier ids inside one task", () => {
    const dup = { kind: "file-absent", id: "same", path: "x" } as const;
    write(suite([task("a", { verifiers: [dup, dup] })]));
    expect(() => loadSuite(suiteDir)).toThrow(/task "a".*duplicate verifier id "same"/is);
  });

  it("rejects an unsupported schemaVersion with the value found", () => {
    write(suite([task("a")], { schemaVersion: 2 }));
    expect(() => loadSuite(suiteDir)).toThrow(/schemaVersion.*1.*2/is);
  });

  it("rejects a suiteVersion that is not semver", () => {
    write(suite([task("a")], { suiteVersion: "latest" }));
    expect(() => loadSuite(suiteDir)).toThrow(/suiteVersion.*semver/is);
  });

  it("rejects a suite without tasks", () => {
    write(suite([]));
    expect(() => loadSuite(suiteDir)).toThrow(/at least one task/i);
  });

  it("points at the field of a malformed task", () => {
    write(suite([task("a", { budget: { maxTurns: 0, maxWallMs: 1000 } })]));
    expect(() => loadSuite(suiteDir)).toThrow(/tasks\.0\.budget\.maxTurns/);
  });

  it("reports a missing suite.json and invalid JSON distinctly", () => {
    expect(() => loadSuite(suiteDir)).toThrow(/suite\.json.*not found/is);
    write("{ not json");
    expect(() => loadSuite(suiteDir)).toThrow(/suite\.json.*not valid JSON/is);
  });
  it("accepts only write, process, external and analysis in policy.allow", () => {
    for (const allow of [["write"], ["process", "external", "analysis"]]) {
      write(suite([task("a", { policy: { mode: "auto", allow } })]));
      expect(() => loadSuite(suiteDir)).not.toThrow();
    }
    for (const bad of ["mcp", "agents", "bogus"]) {
      write(suite([task("a", { policy: { mode: "auto", allow: ["write", bad] } })]));
      expect(() => loadSuite(suiteDir)).toThrow(EvalSuiteError);
      expect(() => loadSuite(suiteDir)).toThrow(
        /policy\.allow\.1: must be one of write, process, external, analysis/,
      );
    }
  });

  it("caps a command verifier timeout at 600000 ms with an actionable error", () => {
    const command = (timeoutMs: number) =>
      task("a", {
        verifiers: [{ kind: "command", id: "c", command: ["node", "-v"], timeoutMs }],
      });
    write(suite([command(600_000)]));
    expect(() => loadSuite(suiteDir)).not.toThrow();
    write(suite([command(600_001)]));
    expect(() => loadSuite(suiteDir)).toThrow(/600000/);
  });

  it("accepts replayNormalize rules and rejects a malformed or invalid-regex one", () => {
    const rules = [{ pattern: "\\d{4}-\\d{2}-\\d{2}", replace: "<DATE>" }];
    write(suite([task("a", { replayNormalize: rules })]));
    expect(loadSuite(suiteDir).suite.tasks[0]?.replayNormalize).toEqual(rules);
    write(suite([task("a", { replayNormalize: [{ pattern: "(", replace: "" }] })]));
    expect(() => loadSuite(suiteDir)).toThrow(/replayNormalize.*pattern/s);
    write(suite([task("a", { replayNormalize: [{ pattern: "x" } as never] })]));
    expect(() => loadSuite(suiteDir)).toThrow(/replayNormalize/);
  });

  it("accepts the optional fixtureGit flag and rejects a non-boolean one", () => {
    write(suite([task("a", { fixtureGit: true })]));
    expect(loadSuite(suiteDir).suite.tasks[0]?.fixtureGit).toBe(true);
    write(suite([task("a", { fixtureGit: "yes" as unknown as boolean })]));
    expect(() => loadSuite(suiteDir)).toThrow(/fixtureGit/);
  });
});
