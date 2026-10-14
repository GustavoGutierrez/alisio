/** Live engine of the reliability lab (specs/010 Phase 2): isolation, policy, budgets, records. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_HASH_COVERAGE,
  computeConfigHash,
  EvalRunRefusedError,
  type InvokerPermissions,
  type RunTaskOptions,
  runTask,
} from "../packages/core/src/eval/engine.ts";
import { snapshotTree } from "../packages/core/src/eval/verifiers.ts";
import { type BuiltinPlugin, configSchema } from "../packages/core/src/index.ts";
import { makeSuite, type ScriptedTurn, scriptedProvider, task } from "./eval-helpers.ts";

let root: string;
let tmpRoot: string;
const ENV_KEYS = ["ALISIO_CONFIG_HOME", "ALISIO_STATE_HOME", "ALISIO_TMPDIR"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "eval-engine-test-")));
  tmpRoot = join(root, "runs");
  mkdirSync(tmpRoot);
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const ALL: InvokerPermissions = { write: true, process: true, external: true, analysis: true };
const NONE: InvokerPermissions = { write: false, process: false, external: false, analysis: false };
const config = () => configSchema.parse({});
const read = (path: string) => ({ name: "read_file", args: { path } });
const write = (path: string, content = "x") => ({
  name: "write_file",
  args: { path, content, expectedHash: null },
});
const done: ScriptedTurn = { text: "done" };

function options(
  t: EvalTask,
  turns: ScriptedTurn[],
  extra: Partial<RunTaskOptions> = {},
  files: Record<string, string> = { "a.txt": "hello\n" },
): RunTaskOptions & { provider: ReturnType<typeof scriptedProvider> } {
  const provider = scriptedProvider(turns);
  return {
    suite: makeSuite(root, [t], files),
    provider,
    config: config(),
    seed: 7,
    repetition: 2,
    invoker: ALL,
    tmpRoot,
    ...extra,
  } as RunTaskOptions & { provider: ReturnType<typeof scriptedProvider> };
}

describe("run record (D2)", () => {
  it("carries every D2 field and measured usage from the provider", async () => {
    const t = task({
      verifiers: [{ kind: "file-contains", id: "has-hello", path: "a.txt", text: "hello" }],
    });
    const turns = [
      { calls: [read("a.txt")], usage: { input: 10, output: 5 } },
      { text: "done", usage: { input: 20, output: 7 } },
    ];
    const before = Date.now();
    const { record } = await runTask(t, options(t, turns));
    expect(record).toMatchObject({
      schemaVersion: 1,
      suiteId: "demo",
      suiteVersion: "1.0.0",
      taskId: "t1",
      repetition: 2,
      seed: 7,
      provider: "fake",
      model: "fake-model",
      mode: "live",
      status: "pass",
      verifiers: [{ id: "has-hello", status: "pass" }],
      incidents: [],
    });
    expect(record.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(record.harnessVersion.length).toBeGreaterThan(0);
    expect(record.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(record.startedAt).toBeGreaterThanOrEqual(before);
    expect(record.endedAt).toBeGreaterThanOrEqual(record.startedAt);
    expect(record.measured).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
      turns: 2,
      toolCalls: 1,
    });
    expect(record.measured.wallMs).toBeGreaterThanOrEqual(0);
    expect(record.budgetExceeded).toBeUndefined();
    expect(record.estimated).toBeUndefined();
  });

  it("omits token fields and records usage_unreported when the provider reports no usage", async () => {
    const t = task();
    const { record } = await runTask(t, options(t, [done]));
    expect(record.measured.inputTokens).toBeUndefined();
    expect(record.measured.outputTokens).toBeUndefined();
    expect(record.incidents).toContainEqual({ kind: "usage_unreported", count: 1 });
  });

  it("gives every run its own runId", async () => {
    const t = task();
    const a = await runTask(t, options(t, [done]));
    const b = await runTask(t, options(t, [done]));
    expect(a.record.runId).not.toBe(b.record.runId);
  });

  it("marks a provider failure as error with a detail, never as a task failure", async () => {
    const t = task();
    const o = options(t, [done]);
    o.provider = scriptedProvider([done], {
      onCall: () => {
        throw new Error("upstream exploded");
      },
    });
    const { record } = await runTask(t, o);
    expect(record.status).toBe("error");
    expect(record.error).toMatch(/upstream exploded/);
  });

  it("a verifier that errors (and none fails) makes the run error; a failing one wins", async () => {
    const errored = task({
      verifiers: [{ kind: "tree-diff-within", id: "bad", allowed: ["../x"] }],
    });
    expect((await runTask(errored, options(errored, [done]))).record.status).toBe("error");
    const mixed = task({
      verifiers: [
        { kind: "tree-diff-within", id: "bad", allowed: ["../x"] },
        { kind: "file-absent", id: "fails", path: "a.txt" },
      ],
    });
    expect((await runTask(mixed, options(mixed, [done]))).record.status).toBe("fail");
  });
});

describe("model-caused failures are fail, not error (survivorship)", () => {
  const hasIncident = (record: { incidents: Array<{ kind: string }> }, kind: string) =>
    record.incidents.some((i) => i.kind === kind);

  it("output truncation that exhausts the recoveries is a fail with an incident", async () => {
    const { OutputTruncatedError } = await import("@alisio/sdk");
    const t = task();
    const o = options(t, [done]);
    o.provider = scriptedProvider([done], {
      onCall: () => {
        throw new OutputTruncatedError("cut");
      },
    });
    const { record } = await runTask(t, o);
    expect(record.status).toBe("fail");
    expect(record.error).toMatch(/cut off/);
    expect(hasIncident(record, "output_truncated")).toBe(true);
  });

  it("more than 64 tool calls in one turn is a fail", async () => {
    const t = task();
    const calls = Array.from({ length: 65 }, () => read("a.txt"));
    const { record } = await runTask(t, options(t, [{ calls }]));
    expect(record.status).toBe("fail");
    expect(record.error).toMatch(/Too many tool calls/);
    expect(hasIncident(record, "run_aborted")).toBe(true);
  });

  it("duplicate tool call ids in one turn are a fail", async () => {
    const t = task();
    const o = options(t, [done]);
    o.provider = {
      requests: [],
      id: "fake",
      model: "fake-model",
      async *stream() {
        const call = { id: "same", name: "read_file", arguments: '{"path":"a.txt"}' };
        yield {
          type: "completed",
          message: { role: "assistant", text: "", calls: [call, { ...call }] },
        };
      },
    };
    const { record } = await runTask(t, o);
    expect(record.status).toBe("fail");
    expect(record.error).toMatch(/duplicate tool call IDs/);
  });

  it("a provider failure still ends error (infrastructure)", async () => {
    const t = task();
    const o = options(t, [done]);
    o.provider = scriptedProvider([done], {
      onCall: () => {
        throw new Error("401 unauthorized");
      },
    });
    expect((await runTask(t, o)).record.status).toBe("error");
  });

  it("a command verifier that times out on agent-written code is a fail", async () => {
    const t = task({
      verifiers: [
        {
          kind: "command",
          id: "check",
          command: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
          timeoutMs: 200,
        },
      ],
    });
    const { record } = await runTask(t, options(t, [done]));
    expect(record.status).toBe("fail");
    expect(record.verifiers[0]?.status).toBe("fail");
  });

  it("a command verifier that cannot start stays error", async () => {
    const t = task({
      verifiers: [
        { kind: "command", id: "check", command: ["definitely-not-a-binary-xyz"], timeoutMs: 1000 },
      ],
    });
    expect((await runTask(t, options(t, [done]))).record.status).toBe("error");
  });
});

describe("usage coverage and compaction identity", () => {
  it("marks totals partial and records usage_unreported when only SOME turns reported usage", async () => {
    const t = task();
    const turns = [{ calls: [read("a.txt")], usage: { input: 10, output: 5 } }, { text: "done" }];
    const { record } = await runTask(t, options(t, turns));
    expect(record.incidents).toContainEqual({ kind: "usage_unreported", count: 1 });
    expect(record.measured.usagePartial).toBe(true);
  });

  it("does not mark totals partial when every turn reported usage", async () => {
    const t = task();
    const turns = [
      { calls: [read("a.txt")], usage: { input: 10, output: 5 } },
      { text: "done", usage: { input: 1, output: 1 } },
    ];
    const { record } = await runTask(t, options(t, turns));
    expect(record.measured.usagePartial).toBeUndefined();
    expect(record.incidents.some((i) => i.kind === "usage_unreported")).toBe(false);
  });

  it("stamps the compaction identity so a comparison can tell compaction settings apart", async () => {
    const t = task();
    const a = await runTask(t, options(t, [done]));
    const cfg = config();
    cfg.compaction.threshold = 0.5;
    const b = await runTask(t, options(t, [done], { config: cfg }));
    const c = await runTask(t, options(t, [done]));
    expect(a.record.compactionHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.record.compactionHash).toBe(c.record.compactionHash);
    expect(a.record.compactionHash).not.toBe(b.record.compactionHash);
  });
});

describe("budgets (D5)", () => {
  it("maxToolCalls: aborts on call max+1 before it executes and keeps verifiers running", async () => {
    const t = task({
      budget: { maxTurns: 10, maxWallMs: 20_000, maxToolCalls: 2 },
      verifiers: [{ kind: "file-absent", id: "no-new", path: "new.txt" }],
    });
    const turns = [
      { calls: [read("a.txt")] },
      { calls: [read("a.txt")] },
      { calls: [write("new.txt")] },
    ];
    const { record, keptDir } = await runTask(t, options(t, turns, { keep: true }));
    expect(record.status).toBe("budget_exceeded");
    expect(record.budgetExceeded).toBe("maxToolCalls");
    expect(record.measured.toolCalls).toBe(2);
    expect(record.verifiers).toEqual([{ id: "no-new", status: "pass" }]);
    expect(existsSync(join(keptDir as string, "ws", "new.txt"))).toBe(false);
  });

  it("maxTurns: the runner's turn cap is a budget, not a pass", async () => {
    const t = task({ budget: { maxTurns: 2, maxWallMs: 20_000 } });
    const { record } = await runTask(t, options(t, [{ calls: [read("a.txt")] }]));
    expect(record.status).toBe("budget_exceeded");
    expect(record.budgetExceeded).toBe("maxTurns");
    expect(record.incidents).toContainEqual({ kind: "turns_exceeded", count: 1 });
  });

  it("maxWallMs: aborts a stalled provider with the wall budget as the reason", async () => {
    const t = task({ budget: { maxTurns: 10, maxWallMs: 150 } });
    const o = options(t, [done]);
    o.provider = scriptedProvider([done], {
      onCall: (request) =>
        new Promise<void>((_, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          }),
        ),
    });
    const started = Date.now();
    const { record } = await runTask(t, o);
    expect(record.status).toBe("budget_exceeded");
    expect(record.budgetExceeded).toBe("maxWallMs");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("maxTokens: classified from cumulative turn tokens, not from the error text", async () => {
    const t = task({ budget: { maxTurns: 10, maxWallMs: 20_000, maxTokens: 100 } });
    const turns = [{ calls: [read("a.txt")], usage: { input: 60, output: 50 } }];
    const { record } = await runTask(t, options(t, turns));
    expect(record.status).toBe("budget_exceeded");
    expect(record.budgetExceeded).toBe("maxTokens");
    expect(record.measured.inputTokens).toBe(60);
  });

  it("a run within every budget is not flagged", async () => {
    const t = task({
      budget: { maxTurns: 5, maxWallMs: 20_000, maxTokens: 1000, maxToolCalls: 3 },
    });
    const turns = [{ calls: [read("a.txt")], usage: { input: 5, output: 5 } }, { text: "ok" }];
    const { record } = await runTask(t, options(t, turns));
    expect(record.status).toBe("pass");
    expect(record.budgetExceeded).toBeUndefined();
  });
});

describe("isolation (D3)", () => {
  it("removes the run directory unless keep is set", async () => {
    const t = task();
    const gone = await runTask(t, options(t, [done]));
    expect(gone.keptDir).toBeUndefined();
    expect(readdirSync(tmpRoot)).toEqual([]);
    const kept = await runTask(t, options(t, [done], { keep: true }));
    const dir = kept.keptDir as string;
    expect(dir.startsWith(tmpRoot)).toBe(true);
    for (const entry of ["ws", "config", "state", "home", "tmp"])
      expect(existsSync(join(dir, entry))).toBe(true);
    expect(existsSync(join(dir, "config", "config.json"))).toBe(true);
    expect(existsSync(join(dir, "state", "sessions.sqlite"))).toBe(true);
  });

  it("removes the run directory also when the run fails", async () => {
    const t = task({ agent: "ghost" });
    await runTask(t, options(t, [done]));
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("works on a copy: the fixture is never modified", async () => {
    const t = task();
    const o = options(t, [{ calls: [write("inside.txt", "new")] }, done]);
    const fixture = o.suite.fixtureDirs.t1 as string;
    const before = snapshotTree(fixture).hash;
    const { keptDir } = await runTask(t, { ...o, keep: true });
    expect(snapshotTree(fixture).hash).toBe(before);
    expect(readFileSync(join(keptDir as string, "ws", "inside.txt"), "utf8")).toBe("new");
  });

  it("file tools cannot write outside the copy (../x and an absolute path, process off)", async () => {
    const t = task({
      verifiers: [{ kind: "file-absent", id: "none", path: "../x" }],
    });
    const outside = join(root, "outside.txt");
    const turns = [{ calls: [write("../x"), write(outside)] }, done];
    const { record, keptDir } = await runTask(
      t,
      options(t, turns, { keep: true, invoker: { ...NONE, write: true } }),
    );
    expect(existsSync(join(keptDir as string, "x"))).toBe(false);
    expect(existsSync(outside)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["runs", "suite"]);
    expect(record.incidents).toContainEqual({ kind: "tool_error", count: 2 });
  });

  it("rejects a fixture whose symlink resolves outside it, before creating any run directory", async () => {
    const t = task();
    const o = options(t, [done]);
    const fixture = o.suite.fixtureDirs.t1 as string;
    symlinkSync("../../..", join(fixture, "escape"));
    await expect(runTask(t, o)).rejects.toThrow(EvalRunRefusedError);
    await expect(runTask(t, o)).rejects.toThrow(/escape.*outside the fixture/);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(o.provider.requests).toHaveLength(0);
  });

  it("rejects an absolute symlink even when its target is inside the fixture", async () => {
    const t = task();
    const o = options(t, [done]);
    const fixture = o.suite.fixtureDirs.t1 as string;
    symlinkSync(join(fixture, "a.txt"), join(fixture, "abs-link"));
    await expect(runTask(t, o)).rejects.toThrow(/absolute symlink/);
  });

  it("copies a relative symlink that stays inside the fixture verbatim", async () => {
    const t = task();
    const o = options(t, [done]);
    symlinkSync("a.txt", join(o.suite.fixtureDirs.t1 as string, "link"));
    const { keptDir } = await runTask(t, { ...o, keep: true });
    expect(readFileSync(join(keptDir as string, "ws", "link"), "utf8")).toBe("hello\n");
  });

  it("scopes config, state and tmp homes to the run directory and restores them afterwards", async () => {
    process.env.ALISIO_CONFIG_HOME = "/sentinel/config";
    delete process.env.ALISIO_STATE_HOME;
    delete process.env.ALISIO_TMPDIR;
    const seen: string[] = [];
    const probe: BuiltinPlugin = {
      id: "probe",
      description: "records the homes it is given",
      create: (_options, context) => {
        seen.push(context.stateHome, context.configHome);
        return { id: "probe", version: "1.0.0", apiVersion: 1, setup() {} };
      },
    };
    const t = task();
    const { keptDir } = await runTask(t, options(t, [done], { keep: true, builtins: [probe] }));
    expect(seen).toEqual([join(keptDir as string, "state"), join(keptDir as string, "config")]);
    expect(process.env.ALISIO_CONFIG_HOME).toBe("/sentinel/config");
    expect(process.env.ALISIO_STATE_HOME).toBeUndefined();
    expect("ALISIO_STATE_HOME" in process.env).toBe(false);
    expect("ALISIO_TMPDIR" in process.env).toBe(false);
  });

  it("restores the environment even when the run fails", async () => {
    process.env.ALISIO_STATE_HOME = "/sentinel/state";
    const t = task();
    const o = options(t, [done]);
    o.provider = scriptedProvider([done], {
      onCall: () => {
        throw new Error("boom");
      },
    });
    expect((await runTask(t, o)).record.status).toBe("error");
    expect(process.env.ALISIO_STATE_HOME).toBe("/sentinel/state");
  });

  it("writes an isolated config layer without plugins, MCP, extra roots, scratch root or memory dbPath", async () => {
    const dirty = configSchema.parse({
      plugins: ["some-plugin"],
      additionalDirectories: [root],
      mcp: { servers: { s: { transport: "stdio", command: "echo" } } },
      forge: { scratch: { root: "/somewhere/real" } },
      builtinPlugins: { memory: { enabled: true, dbPath: "/real/memory.db" } },
      limits: { maxTurns: 17 },
    });
    const t = task();
    const { keptDir } = await runTask(t, options(t, [done], { keep: true, config: dirty }));
    const written = JSON.parse(
      readFileSync(join(keptDir as string, "config", "config.json"), "utf8"),
    );
    expect(written.plugins).toEqual([]);
    expect(written.additionalDirectories).toEqual([]);
    expect(written.mcp.servers).toEqual({});
    expect(written.forge.scratch.root).toBeNull();
    expect(written.builtinPlugins.memory).toEqual({ enabled: true });
    expect(written.limits.maxTurns).toBe(17);
  });

  it("writes no user skill roots into the isolated config layer", async () => {
    const dirty = configSchema.parse({ skills: ["/home/user/my-skills"] });
    const t = task();
    const { keptDir } = await runTask(t, options(t, [done], { keep: true, config: dirty }));
    const written = JSON.parse(
      readFileSync(join(keptDir as string, "config", "config.json"), "utf8"),
    );
    expect(written.skills).toEqual([]);
  });

  it("serializes concurrent runs so the process environment is never shared", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gate = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 80));
      inFlight--;
    };
    const t = task();
    const make = () => {
      const o = options(t, [done]);
      o.provider = scriptedProvider([done], { onCall: gate });
      return o;
    };
    const results = await Promise.all([runTask(t, make()), runTask(t, make())]);
    expect(results.map((r) => r.record.status)).toEqual(["pass", "pass"]);
    expect(maxInFlight).toBe(1);
  });

  it("a rejected run does not wedge the queue", async () => {
    const t = task();
    const bad = options(t, [done], { invoker: NONE });
    await expect(runTask(t, bad)).rejects.toThrow(EvalRunRefusedError);
    expect((await runTask(t, options(t, [done]))).record.status).toBe("pass");
  });

  it.skipIf(spawnSync("git", ["--version"]).status !== 0)(
    "initializes git in the copy only when the task asks for it",
    async () => {
      const plain = task();
      const withGit = task({ fixtureGit: true });
      const a = await runTask(plain, options(plain, [done], { keep: true }));
      expect(existsSync(join(a.keptDir as string, "ws", ".git"))).toBe(false);
      const b = await runTask(withGit, options(withGit, [done], { keep: true }));
      const ws = join(b.keptDir as string, "ws");
      expect(existsSync(join(ws, ".git"))).toBe(true);
      const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" });
      expect(head.status).toBe(0);
    },
  );
});

describe("policy (D16)", () => {
  it("rejects a task asking for full without allowSuiteFull, before any run", async () => {
    const t = task({ policy: { mode: "full" } });
    const o = options(t, [done]);
    await expect(runTask(t, o)).rejects.toThrow(/allow-suite-full/);
    expect(o.provider.requests).toHaveLength(0);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect((await runTask(t, { ...o, allowSuiteFull: true })).record.status).toBe("pass");
  });

  it("refuses an effect the invoker lacks instead of narrowing it silently", async () => {
    const auto = task({ policy: { mode: "auto" } });
    await expect(
      runTask(auto, options(auto, [done], { invoker: { ...ALL, write: false } })),
    ).rejects.toThrow(/write/);
    const allow = task({ policy: { mode: "ask", allow: ["process"] } });
    await expect(
      runTask(allow, options(allow, [done], { invoker: { ...ALL, process: false } })),
    ).rejects.toThrow(/process/);
    const analysis = task({ policy: { mode: "ask", allow: ["analysis"] } });
    await expect(
      runTask(analysis, options(analysis, [done], { invoker: { ...ALL, analysis: false } })),
    ).rejects.toThrow(/analysis/);
    const full = task({ policy: { mode: "full" } });
    await expect(
      runTask(
        full,
        options(full, [done], { allowSuiteFull: true, invoker: { ...ALL, external: false } }),
      ),
    ).rejects.toThrow(/external/);
    await expect(
      runTask(auto, options(auto, [done], { invoker: { ...ALL, readOnly: true } })),
    ).rejects.toThrow(EvalRunRefusedError);
  });

  it("readOnly wins: a read-only task cannot write even in auto mode", async () => {
    const t = task({
      policy: { mode: "auto", readOnly: true },
      verifiers: [{ kind: "file-absent", id: "no-new", path: "new.txt" }],
    });
    const { record } = await runTask(t, options(t, [{ calls: [write("new.txt")] }, done]));
    expect(record.verifiers).toEqual([{ id: "no-new", status: "pass" }]);
    expect(record.incidents).toContainEqual({ kind: "tool_error", count: 1 });
  });

  it("ask mode denies headless and counts the denial as an approval_denied incident", async () => {
    const t = task({
      policy: { mode: "ask" },
      verifiers: [{ kind: "file-absent", id: "no-new", path: "new.txt" }],
    });
    const { record } = await runTask(
      t,
      options(t, [{ calls: [write("new.txt")] }, done], { invoker: NONE }),
    );
    expect(record.verifiers).toEqual([{ id: "no-new", status: "pass" }]);
    expect(record.incidents).toContainEqual({ kind: "approval_denied", count: 1 });
    expect(record.incidents).toContainEqual({ kind: "tool_error", count: 1 });
  });
});

describe("tool events and agents", () => {
  it("builds ToolEvents with a canonical args key so a repeated failing call is detected", async () => {
    const t = task({
      verifiers: [
        {
          kind: "tool-sequence",
          id: "no-repeat",
          rule: { type: "no-repeat-failure", tool: "read_file" },
        },
      ],
    });
    const turns = [
      { calls: [{ name: "read_file", args: '{"path":"missing.txt"}' }] },
      { calls: [{ name: "read_file", args: '{ "path" : "missing.txt" }' }] },
      done,
    ];
    const { record } = await runTask(t, options(t, turns));
    expect(record.status).toBe("fail");
    expect(record.verifiers[0]?.detail).toMatch(/repeated/);
  });

  it("a task naming an agent without resolveAgent ends error with a clear detail", async () => {
    const t = task({ agent: "reviewer" });
    const o = options(t, [done]);
    const { record } = await runTask(t, o);
    expect(record.status).toBe("error");
    expect(record.error).toMatch(/agent "reviewer".*resolveAgent/);
    expect(o.provider.requests).toHaveLength(0);
  });

  it("applies the RunOptions returned by resolveAgent", async () => {
    const t = task({ agent: "reviewer" });
    const o = options(t, [done], {
      resolveAgent: (_app, agent) => ({ instructions: `PERSONA-${agent}` }),
    });
    await runTask(t, o);
    expect(JSON.stringify(o.provider.requests[0])).toContain("PERSONA-reviewer");
  });
});

describe("configHash (D2)", () => {
  const extras = {
    policy: { write: true, process: false, external: false, analysis: false },
    approvalMode: "auto",
    budget: { maxTurns: 10, maxWallMs: 1000 },
    builtinIds: ["memory"],
  };

  it("is stable and sensitive to what changes behavior", () => {
    const base = computeConfigHash(config(), extras);
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeConfigHash(config(), extras)).toBe(base);
    expect(computeConfigHash(configSchema.parse({ limits: { maxTurns: 9 } }), extras)).not.toBe(
      base,
    );
    expect(computeConfigHash(config(), { ...extras, approvalMode: "ask" })).not.toBe(base);
    expect(
      computeConfigHash(config(), { ...extras, budget: { maxTurns: 11, maxWallMs: 1000 } }),
    ).not.toBe(base);
    expect(
      computeConfigHash(config(), { ...extras, policy: { ...extras.policy, process: true } }),
    ).not.toBe(base);
    expect(computeConfigHash(config(), { ...extras, builtinIds: [] })).not.toBe(base);
  });

  it("ignores secrets, endpoints, models, plugin options and absolute paths", () => {
    const base = computeConfigHash(config(), extras);
    const noisy = configSchema.parse({
      provider: { apiKeyEnv: "OTHER_KEY", baseURL: "https://elsewhere.example/v1", model: "m-2" },
      additionalDirectories: [root],
      forge: { scratch: { root: "/abs/scratch" } },
      builtinPlugins: { memory: { dbPath: "/abs/memory.db", enabled: true } },
      plugins: ["x"],
    });
    expect(computeConfigHash(noisy, extras)).toBe(base);
  });

  it("covers every top-level config key: a new key must be classified as hashed or excluded", () => {
    const keys = Object.keys(configSchema.parse({})).sort();
    expect(Object.keys(CONFIG_HASH_COVERAGE).sort()).toEqual(keys);
  });
});
