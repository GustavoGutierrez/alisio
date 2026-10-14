/**
 * Record and replay through the real engine (specs/010 Phase 4): a scripted provider is recorded,
 * then the same task is replayed from the cassette with the network blocked. No credentials.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { EvalRunRecord, EvalTask, RunEvent } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Cassette,
  CassetteRecorder,
  CassetteWriteError,
  serializeCassette,
  writeCassette,
} from "../packages/core/src/eval/cassette.ts";
import {
  EvalRunRefusedError,
  type InvokerPermissions,
  type RunTaskOptions,
  runTask,
} from "../packages/core/src/eval/engine.ts";
import { type BuiltinPlugin, configSchema } from "../packages/core/src/index.ts";
import { newUuid } from "../packages/core/src/runtime/ids.ts";
import { makeSuite, type ScriptedTurn, scriptedProvider, task } from "./eval-helpers.ts";

let root: string;
let tmpRoot: string;
const ENV_KEYS = ["ALISIO_CONFIG_HOME", "ALISIO_STATE_HOME", "ALISIO_TMPDIR"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "eval-replay-test-")));
  tmpRoot = join(root, "runs");
  mkdirSync(tmpRoot);
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const ALL: InvokerPermissions = { write: true, process: true, external: true, analysis: true };
const read = (path: string) => ({ name: "read_file", args: { path } });
const write = (path: string, content = "x") => ({
  name: "write_file",
  args: { path, content, expectedHash: null },
});

const SCRIPT: ScriptedTurn[] = [
  {
    text: "Reading",
    calls: [read("a.txt"), read("missing.txt")],
    usage: { input: 100, output: 20 },
    providerData: [{ type: "reasoning", signature: "sig==" }],
    callIds: ["call_AbC123", "toolu_01XyZ"],
  },
  { calls: [write("b.txt", "written")], usage: { input: 150, output: 30 }, callIds: ["call_w1"] },
  { text: "done", usage: { input: 200, output: 10 } },
];

/** A built-in plugin whose only tool has the description we want to vary. */
const probePlugin = (description: string): BuiltinPlugin => ({
  id: "probe-tool",
  description: "test tool",
  create: () => ({
    id: "probe-tool",
    version: "1.0.0",
    apiVersion: 1,
    setup(api) {
      api.tools.register({
        name: "probe_tool",
        description,
        effect: "read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: [{ type: "text", text: "probe" }] };
        },
      });
    },
  }),
});

interface Captured {
  record: EvalRunRecord;
  events: RunEvent[];
}

function base(t: EvalTask, files: Record<string, string> = { "a.txt": "hello\n" }) {
  return {
    suite: makeSuite(mkdtempSync(join(root, "s-")), [t], files),
    config: configSchema.parse({}),
    seed: 7,
    repetition: 0,
    invoker: ALL,
    tmpRoot,
  };
}

async function capture(
  t: EvalTask,
  options: Partial<RunTaskOptions> & Pick<RunTaskOptions, "mode">,
  files?: Record<string, string>,
): Promise<Captured> {
  const events: RunEvent[] = [];
  const { record } = await runTask(t, {
    ...base(t, files),
    ...options,
    onEvent: (event) => events.push(event),
  } as RunTaskOptions);
  return { record, events };
}

async function recordRun(
  t: EvalTask,
  turns: ScriptedTurn[],
  extra: Partial<RunTaskOptions> = {},
  files?: Record<string, string>,
) {
  const recorder = new CassetteRecorder();
  const provider = scriptedProvider(turns);
  const result = await capture(
    t,
    { mode: "record", provider, cassette: recorder, ...extra },
    files,
  );
  const cassette = recorder.unstable
    ? undefined
    : recorder.toCassette({
        suiteId: "demo",
        taskId: t.id,
        harnessVersion: result.record.harnessVersion,
        configHash: result.record.configHash,
        recordedAt: 1,
        provider: result.record.provider,
        model: result.record.model,
      });
  return { ...result, cassette: cassette as Cassette, recorder, provider };
}

/** Events with exactly the fields that legitimately differ between two runs removed. */
function comparable(event: RunEvent) {
  const { runId: _r, sessionId: _s, timestamp: _t, eventId: _e, ...rest } = event;
  const data = { ...(event.data as Record<string, unknown>) };
  if (event.type === "turn_completed") {
    delete data.durationMs;
    delete data.ttftMs;
  }
  if (event.type === "tool_completed") delete data.durationMs;
  if (event.type === "request_retry") delete data.afterMs;
  return { ...rest, data };
}

const blockNetwork = () => {
  vi.stubGlobal("fetch", () => {
    throw new Error("network access during replay");
  });
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("network access during replay");
  });
};

describe("record then replay (criterion 1)", () => {
  it("reproduces the RunEvent sequence with the network blocked", async () => {
    const t = task({ policy: { mode: "auto" } });
    const recorded = await recordRun(t, SCRIPT);
    expect(recorded.record.status).toBe("pass");
    expect(recorded.record.mode).toBe("live");
    expect(recorded.cassette.calls).toHaveLength(3);

    blockNetwork();
    const replayed = await capture(t, { mode: "replay", cassette: recorded.cassette });
    expect(replayed.record.mode).toBe("replay");
    expect(replayed.record.status).toBe("pass");
    expect(replayed.record.provider).toBe("fake");
    expect(replayed.record.measured).toMatchObject({
      inputTokens: 450,
      outputTokens: 60,
      turns: 3,
      toolCalls: 3,
    });
    expect(replayed.events.map(comparable)).toEqual(recorded.events.map(comparable));
    expect(replayed.events.length).toBeGreaterThan(10);
  });

  it("keeps tool-call ids and provider continuation data identical (criterion 4)", async () => {
    const t = task();
    const recorded = await recordRun(t, SCRIPT);
    const replayed = await capture(t, { mode: "replay", cassette: recorded.cassette });
    const ids = (events: RunEvent[]) =>
      events.filter((e) => e.type === "tool_started").map((e) => (e.data as { id: string }).id);
    expect(ids(replayed.events)).toEqual(["call_AbC123", "toolu_01XyZ", "call_w1"]);
    expect(ids(recorded.events)).toEqual(ids(replayed.events));
    // The second request carries the first assistant message with its providerData: if replay had
    // altered it, the fingerprint of call 1 would not match and the run would have diverged.
    expect(replayed.record.divergence).toBeUndefined();
    const stored = recorded.cassette.calls[0]?.events.find((e) => e.type === "completed");
    expect(stored).toMatchObject({
      message: { providerData: [{ type: "reasoning", signature: "sig==" }] },
    });
  });

  it("produces the same event sequence on 100 consecutive replays", {
    timeout: 120_000,
  }, async () => {
    const t = task();
    const recorded = await recordRun(t, [
      { calls: [read("a.txt")], usage: { input: 5, output: 1 } },
      { text: "ok", usage: { input: 6, output: 2 } },
    ]);
    const reference = JSON.stringify(recorded.events.map(comparable));
    for (let n = 0; n < 100; n++) {
      const replayed = await capture(t, { mode: "replay", cassette: recorded.cassette });
      expect(replayed.record.status).toBe("pass");
      expect(JSON.stringify(replayed.events.map(comparable))).toBe(reference);
    }
  });

  it("uses deterministic ids in record and replay and restores randomness afterwards", async () => {
    const t = task();
    const recorded = await recordRun(t, [{ text: "ok" }]);
    const replayed = await capture(t, { mode: "replay", cassette: recorded.cassette });
    const session = (events: RunEvent[]) => events[0]?.sessionId;
    expect(session(recorded.events)).toBeDefined();
    expect(session(replayed.events)).toBe(session(recorded.events));
    expect(newUuid()).not.toBe(newUuid());
    const live = await capture(t, { mode: "live", provider: scriptedProvider([{ text: "ok" }]) });
    expect(session(live.events)).not.toBe(session(recorded.events));
  });

  it("survives two fresh run directories even when a tool prints a run-specific path", async () => {
    const t = task({ policy: { mode: "auto", allow: ["process"] } });
    const turns: ScriptedTurn[] = [
      { calls: [{ name: "shell", args: { command: "pwd" } }] },
      { text: "done" },
    ];
    const recorded = await recordRun(t, turns);
    expect(recorded.record.status).toBe("pass");
    const out = recorded.events
      .filter((e) => e.type === "tool_completed")
      .map((e) => JSON.stringify(e.data))
      .join("");
    expect(out).toContain("/ws");
    const replayed = await capture(t, { mode: "replay", cassette: recorded.cassette });
    expect(replayed.record.divergence).toBeUndefined();
    expect(replayed.record.status).toBe("pass");
  });
});

describe("divergence", () => {
  it("names tools[<name>].description when a tool changed between record and replay (criterion 2)", async () => {
    const t = task();
    const recorded = await recordRun(t, [{ text: "ok" }], { builtins: [probePlugin("Probe v1")] });
    const replayed = await capture(t, {
      mode: "replay",
      cassette: recorded.cassette,
      builtins: [probePlugin("Probe v2")],
    });
    expect(replayed.record.status).toBe("error");
    expect(replayed.record.error).toBe("replay_divergence");
    expect(replayed.record.mode).toBe("replay");
    expect(replayed.record.divergence?.kind).toBe("fingerprint");
    const entry = replayed.record.divergence?.diff.find(
      (d) => d.field === "tools[probe_tool].description",
    );
    expect(entry?.excerpt).toEqual({ before: "Probe v1", after: "Probe v2" });
  });

  it("detects a changed tool result (a fixture change) at the message that carries it", async () => {
    const t = task();
    const recorded = await recordRun(t, [{ calls: [read("a.txt")] }, { text: "ok" }]);
    const replayed = await capture(
      t,
      { mode: "replay", cassette: recorded.cassette },
      { "a.txt": "hello, changed\n" },
    );
    expect(replayed.record.divergence?.diff.map((d) => d.field)).toContain(
      "messages[2].tool.result",
    );
  });

  it("fails when the cassette has fewer calls than the run needs (criterion 3)", async () => {
    const t = task();
    const recorded = await recordRun(t, [{ calls: [read("a.txt")] }, { text: "ok" }]);
    const short: Cassette = { ...recorded.cassette, calls: recorded.cassette.calls.slice(0, 1) };
    const replayed = await capture(t, { mode: "replay", cassette: short });
    expect(replayed.record.status).toBe("error");
    expect(replayed.record.error).toBe("replay_divergence");
    expect(replayed.record.divergence?.kind).toBe("exhausted");
  });

  it("fails when the cassette has calls the run never makes (criterion 3)", async () => {
    const t = task();
    const recorded = await recordRun(t, [{ text: "ok" }]);
    const first = recorded.cassette.calls[0];
    if (!first) throw new Error("no call recorded");
    const long: Cassette = {
      ...recorded.cassette,
      calls: [...recorded.cassette.calls, { ...first, call: 1 }],
    };
    const replayed = await capture(t, { mode: "replay", cassette: long });
    expect(replayed.record.status).toBe("error");
    expect(replayed.record.error).toBe("replay_divergence");
    expect(replayed.record.divergence?.kind).toBe("unconsumed");
  });
});

describe("what a cassette may contain (criterion 5)", () => {
  it("holds no sessionId and none of the planted credentials", async () => {
    process.env.ALISIO_FAKE_PROVIDER_KEY = "sk-planted-0123456789abcdefghijklmn";
    try {
      const t = task();
      const recorded = await recordRun(t, SCRIPT);
      const file = serializeCassette(recorded.cassette);
      const sessionId = recorded.events[0]?.sessionId ?? "missing";
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(file).not.toContain(sessionId);
      expect(file).not.toContain(process.env.ALISIO_FAKE_PROVIDER_KEY);
      expect(file).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
      expect(file).not.toContain(recorded.events[0]?.runId ?? "missing");
    } finally {
      delete process.env.ALISIO_FAKE_PROVIDER_KEY;
    }
  });

  it("refuses to write a cassette when the model saw a key in a tool result", async () => {
    const t = task();
    const recorded = await recordRun(
      t,
      [{ calls: [read("secrets.txt")] }, { text: "ok" }],
      {},
      { "secrets.txt": "OPENAI_API_KEY=sk-live-0123456789abcdefghijkl\n" },
    );
    expect(() => writeCassette(join(root, "out", "t1.cassette.jsonl"), recorded.cassette)).toThrow(
      CassetteWriteError,
    );
    expect(existsSync(join(root, "out", "t1.cassette.jsonl"))).toBe(false);
  });
});

describe("record failures and option checks", () => {
  it("fails the record when a call is aborted before any event (unstable)", async () => {
    const t = task({ budget: { maxTurns: 5, maxWallMs: 300 } });
    const recorder = new CassetteRecorder();
    const provider = scriptedProvider([{ text: "never" }], {
      onCall: (request) =>
        new Promise<void>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    });
    const { record } = await capture(t, { mode: "record", provider, cassette: recorder });
    expect(record.status).toBe("error");
    expect(record.error).toMatch(/unstable/i);
    expect(recorder.unstable).toBeDefined();
  });

  it("refuses modes that lack what they need before creating anything", async () => {
    const t = task();
    const refusal = (options: Partial<RunTaskOptions>) =>
      runTask(t, {
        ...base(t),
        provider: scriptedProvider([{ text: "x" }]),
        ...options,
      } as RunTaskOptions);
    await expect(refusal({ mode: "replay" })).rejects.toBeInstanceOf(EvalRunRefusedError);
    await expect(refusal({ mode: "record" })).rejects.toThrow(/CassetteRecorder/);
    await expect(refusal({ mode: "live", cassette: new CassetteRecorder() })).rejects.toThrow(
      /cassette/i,
    );
    await expect(
      runTask(t, {
        ...base(t),
        mode: "record",
        cassette: new CassetteRecorder(),
      } as RunTaskOptions),
    ).rejects.toThrow(/provider/i);
  });
});

// ---------------------------------------------------------------------------------------------
// Static: the replay path imports no network module
// ---------------------------------------------------------------------------------------------

describe("the replay provider stays off the network", () => {
  const FORBIDDEN = /^(node:)?(http|https|http2|net|tls|dgram|dns|dns\/promises|undici|ws)$/;
  const EVAL = resolve(__dirname, "../packages/core/src/eval");

  function importsOf(file: string): string[] {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map(
      (m) => m[1] as string,
    );
  }

  it("has no network import or fetch/WebSocket use in its transitive local graph", () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
      for (const specifier of importsOf(file)) {
        expect(FORBIDDEN.test(specifier), `${file} imports ${specifier}`).toBe(false);
        if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
      }
    };
    visit(join(EVAL, "cassette.ts"));
    const names = [...seen].map((f) => f.slice(EVAL.length - "eval".length));
    expect(names.some((n) => n.endsWith("fingerprint.ts"))).toBe(true);
    expect(names.some((n) => n.endsWith("normalize.ts"))).toBe(true);
  });
});
