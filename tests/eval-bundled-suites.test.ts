/**
 * Bundled suites of the reliability lab (specs/010 Phase 5): the suites under tests/fixtures/eval
 * load, their recorded cassettes replay green inside the time budget, a deliberate invalid tool
 * transition is detected, a changed request surfaces as a named diff, re-recording is byte
 * identical and the cassettes hold no secrets, session ids or absolute paths.
 *
 * The cassettes are recorded with a scripted provider (scripts/eval-record-bundled.ts): they pin
 * what the HARNESS asks for and does, not how any model behaves. No network, no credentials.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { EvalRunRecord } from "@alisio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evalList } from "../packages/cli/src/eval.ts";
import {
  CASSETTE_SUFFIX,
  MAX_CASSETTE_BYTES,
  MAX_CASSETTE_DIR_BYTES,
  readCassette,
} from "../packages/core/src/eval/cassette.ts";
import { findSecrets } from "../packages/core/src/eval/secrets.ts";
import { loadSuite } from "../packages/core/src/eval/suite.ts";
import { runVerifiers, snapshotTree } from "../packages/core/src/eval/verifiers.ts";
import type { BuiltinPlugin } from "../packages/core/src/index.ts";
import {
  BUNDLED_DIR,
  bundledRunOptions,
  INVALID_SCRIPTS,
  RECORDED_TASKS,
  REFERENCE_SCRIPTS,
  recordBundled,
  runScripted,
  WRONG_SOLUTIONS,
} from "../scripts/eval-record-bundled.ts";

const SUITES = ["smoke-coding", "tool-sequences", "long-context"] as const;
const APPROVED_BUDGET = { maxTurns: 30, maxTokens: 200_000, maxWallMs: 120_000, maxToolCalls: 40 };
// smoke-coding 1.1.0: the live run showed bug-across-modules passing at up to 189k tokens and 82 s,
// so the phase 0 budget made it measure speed instead of capability. Owner-approved override.
// smoke-coding 1.2.0: the hardened tasks need more turns than the phase 0 tasks they replace (live
// 1.0.0 runs of rename-symbol on 3 files already used up to 145k tokens in 10 turns at about 13k
// tokens per turn; the hardened one has 7 files and a second pass to verify), so a budget sized for
// the old tasks would again measure speed. Tool calls and turns keep the approved values.
const BUDGET_OVERRIDES: Record<string, typeof APPROVED_BUDGET> = {
  "smoke-coding/bug-across-modules": { ...APPROVED_BUDGET, maxTokens: 400_000, maxWallMs: 240_000 },
  "smoke-coding/rename-symbol": { ...APPROVED_BUDGET, maxTokens: 400_000, maxWallMs: 240_000 },
  "smoke-coding/edit-respects-hash": { ...APPROVED_BUDGET, maxTokens: 300_000, maxWallMs: 180_000 },
  "smoke-coding/off-by-one-among-passing": {
    ...APPROVED_BUDGET,
    maxTokens: 300_000,
    maxWallMs: 180_000,
  },
};

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "eval-bundled-test-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const cassettePath = (suite: string, task: string) =>
  join(BUNDLED_DIR, suite, "cassettes", `${task}${CASSETTE_SUFFIX}`);
const recordedKeys = () => RECORDED_TASKS.map((key) => key.split("/") as [string, string]);

describe("the bundled suites load (criterion a)", () => {
  it.each(SUITES)("%s loads with loadSuite at its pinned version", (suiteId) => {
    const loaded = loadSuite(join(BUNDLED_DIR, suiteId));
    expect(loaded.suite.suiteId).toBe(suiteId);
    expect(loaded.suite.suiteVersion).toBe(suiteId === "smoke-coding" ? "1.2.0" : "1.0.0");
    expect(loaded.suite.tasks.length).toBeGreaterThan(0);
  });

  it("has the task counts of the spec and the three phase 0 smoke tasks", () => {
    const ids = (suite: string) => loadSuite(join(BUNDLED_DIR, suite)).suite.tasks.map((t) => t.id);
    const smoke = ids("smoke-coding");
    expect(smoke.length).toBeGreaterThanOrEqual(6);
    expect(smoke.length).toBeLessThanOrEqual(8);
    expect(smoke).toEqual(expect.arrayContaining(["fix-add", "add-slugify", "implement-chunk"]));
    const harder = loadSuite(join(BUNDLED_DIR, "smoke-coding")).suite.tasks.filter((t) =>
      t.tags?.includes("harder"),
    );
    expect(harder.length).toBeGreaterThanOrEqual(3);
    expect(ids("tool-sequences").length).toBeGreaterThanOrEqual(4);
    expect(ids("tool-sequences").length).toBeLessThanOrEqual(6);
    expect(ids("long-context")).toHaveLength(3);
  });

  it("reserves injection for spec 014: no such suite is bundled", () => {
    expect(readdirSync(BUNDLED_DIR).sort()).toEqual([...SUITES].sort());
  });

  it("gives every task the owner-approved phase 0 budget and at least one verifier", () => {
    for (const suiteId of SUITES)
      for (const task of loadSuite(join(BUNDLED_DIR, suiteId)).suite.tasks) {
        const key = `${suiteId}/${task.id}`;
        expect(task.budget, key).toEqual(BUDGET_OVERRIDES[key] ?? APPROVED_BUDGET);
        expect(task.verifiers.length, `${suiteId}/${task.id}`).toBeGreaterThan(0);
      }
  });

  it("gives every tool-sequences task a tool-sequence verifier and a cassette", () => {
    const loaded = loadSuite(join(BUNDLED_DIR, "tool-sequences"));
    for (const task of loaded.suite.tasks) {
      expect(
        task.verifiers.some((v) => v.kind === "tool-sequence"),
        task.id,
      ).toBe(true);
      expect(existsSync(cassettePath("tool-sequences", task.id)), `${task.id} cassette`).toBe(true);
    }
  });

  it("keeps recorded and reference scripts in step with the suites (no orphan scripts)", () => {
    for (const suiteId of SUITES) {
      const ids = loadSuite(join(BUNDLED_DIR, suiteId)).suite.tasks.map((t) => t.id);
      for (const id of ids)
        expect(REFERENCE_SCRIPTS[`${suiteId}/${id}`], `${suiteId}/${id}`).toBeDefined();
    }
    expect(Object.keys(REFERENCE_SCRIPTS).length).toBe(
      SUITES.reduce((n, s) => n + loadSuite(join(BUNDLED_DIR, s)).suite.tasks.length, 0),
    );
    for (const [suite, task] of recordedKeys())
      expect(existsSync(cassettePath(suite, task)), `${suite}/${task}`).toBe(true);
    const onDisk = SUITES.flatMap((suite) => {
      const dir = join(BUNDLED_DIR, suite, "cassettes");
      return existsSync(dir)
        ? readdirSync(dir).map((f) => `${suite}/${f.slice(0, -CASSETTE_SUFFIX.length)}`)
        : [];
    });
    expect(onDisk.sort()).toEqual([...RECORDED_TASKS].sort());
  });

  it("lists the bundled suites through `alisio eval list`", async () => {
    let out = "";
    const env = {
      out: (text: string) => void (out += text),
      err: () => undefined,
      stateDir: root,
      bundledDir: BUNDLED_DIR,
      interactive: false,
      newRunId: () => "run",
      confirm: async () => false,
      openRuntime: async () => {
        throw new Error("not needed");
      },
    };
    expect(await evalList(env as never, { json: true } as never)).toBe(0);
    const rows = (JSON.parse(out) as { suites: Array<{ id: string; origin: string }> }).suites;
    expect(rows.map((r) => r.id).sort()).toEqual([...SUITES].sort());
    expect(new Set(rows.map((r) => r.origin))).toEqual(new Set(["bundled"]));
  });
});

describe("the tasks are solvable and not already solved", () => {
  it.each(
    SUITES.flatMap((suite) =>
      loadSuite(join(BUNDLED_DIR, suite)).suite.tasks.map((t) => [suite, t.id] as const),
    ),
  )("%s/%s: the pristine fixture fails a verifier without erroring", async (suite, id) => {
    const loaded = loadSuite(join(BUNDLED_DIR, suite));
    const task = loaded.suite.tasks.find((t) => t.id === id);
    const fixture = loaded.fixtureDirs[id];
    if (!task || !fixture) throw new Error("task not found");
    const copy = join(root, `pristine-${suite}-${id}`);
    cpSync(fixture, copy, { recursive: true });
    const results = await runVerifiers(task.verifiers, {
      cwd: copy,
      baseline: snapshotTree(copy),
      toolEvents: [],
      tmpDir: root,
    });
    expect(results.filter((r) => r.status === "error")).toEqual([]);
    expect(results.some((r) => r.status === "fail")).toBe(true);
  });

  // Recorded tasks are proven solvable by their cassette replay (below); the others run live here.
  const unrecorded = Object.keys(REFERENCE_SCRIPTS).filter((key) => !RECORDED_TASKS.includes(key));
  it.each(unrecorded)("%s: its reference script passes every verifier", async (key) => {
    const [suiteId, taskId] = key.split("/") as [string, string];
    const record = await runScripted({
      suiteId,
      taskId,
      turns: REFERENCE_SCRIPTS[key] ?? [],
      tmpRoot: root,
    });
    expect(record.error).toBeUndefined();
    expect(record.verifiers.filter((v) => v.status !== "pass")).toEqual([]);
    expect(record.status).toBe("pass");
  });
});

describe("the hardened smoke-coding tasks reject plausible wrong solutions", () => {
  // The failing verifier ids each wrong solution must trip (a subset: other verifiers may fail too).
  const EXPECTED_FAILURES: Record<string, Record<string, string[]>> = {
    "smoke-coding/rename-symbol": {
      "replace-all-text": ["check"],
      "misses-dynamic-import": ["check"],
      "renames-metric-key": ["check"],
    },
    "smoke-coding/edit-respects-hash": {
      "rewrites-normalized": ["defaults-exact"],
      "forgets-second-file": ["limits-exact"],
      "edits-the-legacy-twin": ["defaults-exact"],
    },
    "smoke-coding/off-by-one-among-passing": {
      "patches-total-pages-only": ["contract"],
      "fixes-only-the-visible-failure": ["contract"],
      "misses-the-page-clamp": ["contract"],
    },
  };
  const cases = Object.entries(EXPECTED_FAILURES).flatMap(([key, wrong]) =>
    Object.entries(wrong).map(([name, failing]) => [key, name, failing] as const),
  );

  it("scripts at least three wrong solutions for each hardened task, and no orphan", () => {
    expect(Object.keys(WRONG_SOLUTIONS).sort()).toEqual(Object.keys(EXPECTED_FAILURES).sort());
    for (const [key, wrong] of Object.entries(WRONG_SOLUTIONS))
      expect(Object.keys(wrong).sort(), key).toEqual(
        Object.keys(EXPECTED_FAILURES[key] ?? {}).sort(),
      );
    for (const wrong of Object.values(WRONG_SOLUTIONS))
      expect(Object.keys(wrong).length).toBeGreaterThanOrEqual(3);
  });

  it.each(cases)(
    "%s: the wrong solution %s is rejected, not errored",
    async (key, name, failing) => {
      const [suiteId, taskId] = key.split("/") as [string, string];
      const record = await runScripted({
        suiteId,
        taskId,
        turns: WRONG_SOLUTIONS[key]?.[name] ?? [],
        tmpRoot: root,
      });
      expect(record.error).toBeUndefined();
      expect(record.verifiers.filter((v) => v.status === "error")).toEqual([]);
      expect(record.status).toBe("fail");
      const failed = record.verifiers.filter((v) => v.status === "fail").map((v) => v.id);
      for (const id of failing) expect(failed, `${key} ${name}`).toContain(id);
    },
  );

  it("only the correct solution passes every verifier of each hardened task", async () => {
    for (const key of Object.keys(WRONG_SOLUTIONS)) {
      const [suiteId, taskId] = key.split("/") as [string, string];
      const record = await runScripted({
        suiteId,
        taskId,
        turns: REFERENCE_SCRIPTS[key] ?? [],
        tmpRoot: root,
      });
      expect(
        record.verifiers.filter((v) => v.status !== "pass"),
        key,
      ).toEqual([]);
      expect(record.status, key).toBe("pass");
    }
  });
});

describe("the hardened smoke-coding tasks protect their checks from tampering", () => {
  const smoke = join(BUNDLED_DIR, "smoke-coding");
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const tasks = () => loadSuite(smoke).suite.tasks;
  const taskById = (id: string) => {
    const task = tasks().find((t) => t.id === id);
    if (!task) throw new Error(`no task ${id}`);
    return task;
  };

  it("pins rename-symbol's check.ts and off-by-one-among-passing's visible suite by sha256", () => {
    const pinned = [
      ["rename-symbol", "check.ts"],
      ["off-by-one-among-passing", "checks/paginate.check.mjs"],
    ] as const;
    for (const [id, path] of pinned) {
      const verifier = taskById(id).verifiers.find(
        (v) => v.kind === "file-equals" && v.path === path,
      );
      expect(verifier, `${id} pins ${path}`).toBeDefined();
      if (verifier?.kind === "file-equals")
        expect(verifier.sha256, `${id}: ${path} changed, update suite.json`).toBe(
          sha256(join(smoke, "fixtures", id, path)),
        );
    }
  });

  it("keeps the bug-across-modules scope verifier covering check.ts (unchanged task)", () => {
    const scope = taskById("bug-across-modules").verifiers.find(
      (v) => v.kind === "tree-diff-within",
    );
    expect(scope?.kind === "tree-diff-within" ? scope.allowed : []).toEqual(["src/"]);
  });

  it("limits edit-respects-hash to its two files and pins both results exactly", () => {
    const task = taskById("edit-respects-hash");
    const scope = task.verifiers.find((v) => v.kind === "tree-diff-within");
    expect(scope?.kind === "tree-diff-within" ? scope.allowed.sort() : []).toEqual([
      "src/defaults.ts",
      "src/limits.ts",
    ]);
    expect(task.verifiers.filter((v) => v.kind === "file-equals").map((v) => v.id)).toEqual([
      "defaults-exact",
      "limits-exact",
    ]);
  });

  it("keeps the edit-respects-hash fixture byte-exact: CRLF, trailing spaces, no final newline", () => {
    const text = readFileSync(
      join(smoke, "fixtures", "edit-respects-hash", "src", "defaults.ts"),
      "latin1",
    );
    expect(text).toContain("\r\n");
    expect(text).toContain('backoff: "linear",  \r\n');
    expect(text.endsWith("};")).toBe(true);
  });

  it("hides the strict pagination check: it lives in suite.json, not in the workspace", () => {
    const task = taskById("off-by-one-among-passing");
    const contract = task.verifiers.find((v) => v.id === "contract");
    if (contract?.kind !== "command") throw new Error("contract verifier missing");
    const script = readFileSync(join(smoke, "verifiers", "pagination-contract.mjs"), "utf8");
    expect(contract.command.at(-1), "suite.json embeds verifiers/pagination-contract.mjs").toBe(
      script,
    );
    const fixtureDir = join(smoke, "fixtures", "off-by-one-among-passing");
    const files = readdirSync(fixtureDir, { recursive: true }).map(String);
    expect(files.some((f) => f.includes("contract"))).toBe(false);
  });
});

describe("replay of the bundled cassettes (criteria b and U2)", () => {
  async function replayAll(options: { builtins?: BuiltinPlugin[] } = {}) {
    const records = new Map<string, EvalRunRecord>();
    for (const [suiteId, taskId] of recordedKeys()) {
      const record = await runScripted({
        suiteId,
        taskId,
        mode: "replay",
        cassette: readCassette(cassettePath(suiteId, taskId)),
        tmpRoot: root,
        ...(options.builtins ? { builtins: options.builtins } : {}),
      });
      records.set(`${suiteId}/${taskId}`, record);
    }
    return records;
  }

  it("replays every cassette green, without divergence, in under 10 seconds in total", async () => {
    const started = performance.now();
    const records = await replayAll();
    const elapsedMs = performance.now() - started;
    for (const [key, record] of records) {
      expect(record.divergence, key).toBeUndefined();
      expect(record.error, key).toBeUndefined();
      expect(record.mode, key).toBe("replay");
      expect(
        record.verifiers.filter((v) => v.status !== "pass"),
        key,
      ).toEqual([]);
      expect(record.status, key).toBe("pass");
    }
    expect(records.size).toBe(RECORDED_TASKS.length);
    // The spec budget (section 11) is 10 s for all the bundled cassettes. The assertion keeps that
    // number: a slower machine can flake it, which is a signal worth seeing, not a bound to widen.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it("fails with a diff naming the field when a tool the harness sends changes (criterion U2)", async () => {
    const [suiteId, taskId] = ["tool-sequences", "read-before-edit"];
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
    const record = await runScripted({
      suiteId,
      taskId,
      mode: "replay",
      cassette: readCassette(cassettePath(suiteId, taskId)),
      tmpRoot: root,
      builtins: tweaked,
    });
    expect(record.status).toBe("error");
    expect(record.error).toBe("replay_divergence");
    expect(record.divergence?.kind).toBe("fingerprint");
    const fields = record.divergence?.diff.map((d) => d.field) ?? [];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(field).toMatch(/^tools\[[^\]]+\]\.description$/);
    const entry = record.divergence?.diff[0];
    expect(entry?.excerpt.after).toContain("(reworded)");
    expect(entry?.excerpt.before).not.toContain("(reworded)");
  });
});

describe("the deliberate invalid transition (criterion 1, key criterion 4)", () => {
  it("is detected by the tool-sequence verifier when a scripted model deletes before stopping", async () => {
    const record = await runScripted({
      suiteId: "tool-sequences",
      taskId: "stop-bg-before-delete",
      turns: INVALID_SCRIPTS["tool-sequences/stop-bg-before-delete"] ?? [],
      tmpRoot: root,
    });
    expect(record.error).toBeUndefined();
    expect(record.status).toBe("fail");
    const verdicts = Object.fromEntries(record.verifiers.map((v) => [v.id, v]));
    expect(verdicts["stop-before-delete-shell"]?.status).toBe("fail");
    expect(verdicts["stop-before-delete-shell"]?.detail).toMatch(/"shell".*"bg_stop"/);
    // The rest of the run was fine: the failure is exactly the invalid transition.
    expect(verdicts["started-before-stopped"]?.status).toBe("pass");
    expect(verdicts["directory-removed"]?.status).toBe("pass");
  });

  it("passes the same verifiers when the scripted model stops the process first", async () => {
    const record = await runScripted({
      suiteId: "tool-sequences",
      taskId: "stop-bg-before-delete",
      turns: REFERENCE_SCRIPTS["tool-sequences/stop-bg-before-delete"] ?? [],
      tmpRoot: root,
    });
    expect(record.status).toBe("pass");
  });
});

describe("re-recording (criterion 3 and determinism)", () => {
  it("writes byte-identical cassettes on two recordings, and ones the committed cassettes still match", async () => {
    const first = await recordBundled({ outDir: join(root, "record-a"), tmpRoot: root });
    const second = await recordBundled({ outDir: join(root, "record-b"), tmpRoot: root });
    expect(first.map((f) => `${f.suiteId}/${f.taskId}`).sort()).toEqual([...RECORDED_TASKS].sort());
    expect(second).toHaveLength(first.length);
    for (const file of first) {
      const key = `${file.suiteId}/${file.taskId}`;
      const twin = second.find((f) => f.suiteId === file.suiteId && f.taskId === file.taskId);
      expect(twin, key).toBeDefined();
      expect(
        readFileSync(file.path, "utf8") === readFileSync(twin?.path ?? "", "utf8"),
        `${key} differs between two recordings`,
      ).toBe(true);
      // The committed cassette must still ask the provider for the same things: if it does not,
      // it is stale (replaying it fails too) and `pnpm eval:record-bundled` regenerates it.
      const committed = readCassette(cassettePath(file.suiteId, file.taskId));
      expect(
        readCassette(file.path).calls.map((c) => c.fingerprint),
        `${key}: the committed cassette is stale; run pnpm eval:record-bundled`,
      ).toEqual(committed.calls.map((c) => c.fingerprint));
    }
  });
});

describe("what the bundled cassettes hold (criterion f)", () => {
  const files = () => recordedKeys().map(([suite, task]) => cassettePath(suite, task));

  it("keeps each cassette under 256 KB and all of them under 2 MB", () => {
    let total = 0;
    for (const file of files()) {
      const size = statSync(file).size;
      expect(size, file).toBeLessThanOrEqual(MAX_CASSETTE_BYTES);
      total += size;
    }
    expect(total).toBeLessThanOrEqual(MAX_CASSETTE_DIR_BYTES);
  });

  it("holds no secret, session id, generated uuid or absolute path of this machine", () => {
    const forbidden = [homedir(), tmpdir(), resolve(BUNDLED_DIR, "../../..")].filter(
      (path) => path.length > 3,
    );
    for (const file of files()) {
      const text = readFileSync(file, "utf8");
      expect(findSecrets(text), file).toEqual([]);
      expect(text, file).not.toMatch(/sessionId/);
      expect(text, file).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
      );
      for (const path of forbidden)
        expect(text.includes(path), `${file} contains ${path}`).toBe(false);
    }
  });

  it("states in the header that the model is the scripted one", () => {
    for (const file of files()) {
      const { header } = readCassette(file);
      expect(header.provider, file).toBe("scripted");
      expect(header.recordedAt, file).toBe(0);
    }
  });
});
