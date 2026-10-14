/**
 * Cassette building blocks of the reliability lab (specs/010 Phase 4): canonical JSON, the
 * run-scoped normalizer, the request fingerprint and its structured diff, and the cassette
 * reader/writer with its secret scan. Engine-level replay lives in `eval-replay.test.ts`.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ProviderEvent } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOutputTruncationError } from "../packages/core/src/core/truncation.ts";
import { canonicalJson, hashCanonical } from "../packages/core/src/eval/canonical.ts";
import {
  type Cassette,
  CassetteRecorder,
  CassetteWriteError,
  parseCassette,
  RecordingProvider,
  ReplayDivergenceError,
  ReplayExhausted,
  ReplayProvider,
  ReplayUnconsumedError,
  readCassette,
  serializeCassette,
  writeCassette,
} from "../packages/core/src/eval/cassette.ts";
import {
  absorb,
  computeFingerprint,
  diffFingerprints,
  emptyStore,
} from "../packages/core/src/eval/fingerprint.ts";
import {
  Normalizer,
  type RunLiteralsInput,
  runLiterals,
} from "../packages/core/src/eval/normalize.ts";

describe("canonical JSON", () => {
  it("sorts keys by UTF-16 code unit at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] }, "￿": 1, "😀": 2 })).toBe(
      '{"a":{"c":[{"y":2,"z":1}]},"b":1,"😀":2,"￿":1}',
    );
  });

  it("keeps null, turns -0 into 0 and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: null, b: -0 })).toBe('{"a":null,"b":0}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/i);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(/non-finite/i);
  });

  it("normalizes string values to NFC but leaves keys alone", () => {
    const composed = "é";
    const decomposed = "é";
    expect(canonicalJson({ k: decomposed })).toBe(canonicalJson({ k: composed }));
    expect(Object.keys(JSON.parse(canonicalJson({ [decomposed]: 1 })))[0]).toBe(decomposed);
  });

  it("hashes as sha256:<64 hex> and equal values give equal hashes", () => {
    const hash = hashCanonical({ a: 1, b: [1, 2] });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashCanonical({ b: [1, 2], a: 1 })).toBe(hash);
    expect(hashCanonical({ b: [2, 1], a: 1 })).not.toBe(hash);
  });
});

describe("Normalizer", () => {
  const run = (name: string) => `/tmp/alisio-eval-${name}`;
  const make = (name: string, extra: Partial<RunLiteralsInput> = {}) =>
    new Normalizer({
      literals: runLiterals({
        runDir: run(name),
        workspace: `${run(name)}/ws`,
        home: "/home/someone",
        osTmp: "/tmp",
        uid: 1000,
        ...extra,
      }),
    });

  it("replaces the workspace and the run directory, longest first, and is the same across run dirs", () => {
    const a = make("AAAA");
    const b = make("BBBB");
    const text = (n: Normalizer, dir: string) =>
      n.text(`cwd ${dir}/ws/src/a.ts, state ${dir}/state/db, scratch ${dir}/cache/x`);
    expect(text(a, run("AAAA"))).toBe(
      "cwd <WS>/src/a.ts, state <RUN>/state/db, scratch <RUN>/cache/x",
    );
    expect(text(b, run("BBBB"))).toBe(text(a, run("AAAA")));
  });

  it("normalizes the workspace slug, workspace key, uid folder, home and tmp", () => {
    const n = make("CCCC", { workspaceKey: "0123456789abcdef" });
    const slug = "-tmp-alisio-eval-CCCC-ws";
    expect(
      n.text(
        `/tmp/x/alisio-1000/${slug}/s/scratchpad key=0123456789abcdef short=01234567 ${slug} /home/someone/.cache /tmp/other`,
      ),
    ).toBe(
      "<TMP>/x/alisio-<UID>/<WS_SLUG>/s/scratchpad key=<WS_KEY> short=<WS_KEY8> <WS_SLUG> <HOME>/.cache <TMP>/other",
    );
  });

  it("gives registered sessions and runs typed ordinal placeholders", () => {
    const n = make("DDDD");
    const s1 = "11111111-1111-4111-8111-111111111111";
    const s2 = "22222222-2222-4222-8222-222222222222";
    expect(n.registerSession(s1)).toBe("<SESSION#1>");
    expect(n.registerSession(s2)).toBe("<SESSION#2>");
    expect(n.registerSession(s1)).toBe("<SESSION#1>");
    n.registerRun("33333333-3333-4333-8333-333333333333");
    expect(n.text(`/s/${s1}/scratchpad and ${s2} run 33333333-3333-4333-8333-333333333333`)).toBe(
      "/s/<SESSION#1>/scratchpad and <SESSION#2> run <RUN#1>",
    );
    expect(n.sessionLabel(s2)).toBe("<SESSION#2>");
    expect(n.sessionLabel("other")).toBeUndefined();
  });

  it("numbers generated ids by kind in order of first appearance", () => {
    const n = make("EEEE");
    const ulid1 = "01J0000000000000000000000A";
    const ulid2 = "01J0000000000000000000000B";
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(
      n.text(`task_${ulid1} task_${ulid2} task_${ulid1} art_${ulid1} fx_${uuid} ${uuid} ${uuid}`),
    ).toBe("<id:task#1> <id:task#2> <id:task#1> <id:art#1> <id:fx#1> <id:uuid#1> <id:uuid#1>");
  });

  it("changes only string values, never keys, and leaves tool-call ids and numbers alone", () => {
    const n = make("FFFF");
    const dir = run("FFFF");
    expect(
      n.value({ [`${dir}/ws`]: `${dir}/ws/a`, id: "call-0-0", tokens: 1234, list: [`${dir}/ws`] }),
    ).toEqual({ [`${dir}/ws`]: "<WS>/a", id: "call-0-0", tokens: 1234, list: ["<WS>"] });
  });

  it("keeps a relative path distinct from an absolute one (a real regression still shows)", () => {
    const n = make("GGGG");
    expect(n.text(`${run("GGGG")}/ws/a.txt`)).not.toBe(n.text("a.txt"));
  });

  it("applies the suite's replay rules last", () => {
    const n = new Normalizer({
      literals: [],
      replay: [{ pattern: "\\d{4}-\\d{2}-\\d{2}", replace: "<DATE>" }],
    });
    expect(n.text("built 2026-10-13 ok")).toBe("built <DATE> ok");
  });

  it("rejects an invalid replay pattern with a clear message", () => {
    expect(() => new Normalizer({ literals: [], replay: [{ pattern: "(", replace: "" }] })).toThrow(
      /replayNormalize/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------------------------

type StreamRequest = Parameters<ModelProvider["stream"]>[0];

const tool = (name: string, description = `${name} tool`, extra: Record<string, unknown> = {}) =>
  ({
    name,
    description,
    effect: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => ({ content: [] }),
    ...extra,
  }) as unknown as StreamRequest["tools"][number];

const baseRequest = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  instructions: "You are Alisio.\nWorkspace rules apply.",
  messages: [
    { role: "user", text: "Fix the bug" },
    {
      role: "assistant",
      text: "",
      calls: [{ id: "call-0-0", name: "read_file", arguments: "{}" }],
    },
    { role: "tool", callId: "call-0-0", result: { content: [{ type: "text", text: "contents" }] } },
  ],
  tools: [tool("read_file"), tool("write_file")],
  maxOutputTokens: 4096,
  signal: new AbortController().signal,
  model: "fake-model",
  sessionId: "11111111-1111-4111-8111-111111111111",
  ...overrides,
});

const norm = () => new Normalizer({ literals: [] });
const fp = (request: StreamRequest, n: Normalizer = norm()) => computeFingerprint(request, n);

describe("fingerprint", () => {
  it("is sha256:<64 hex> and ignores signal, sessionId and tool fields beyond name/description/schema", () => {
    const a = fp(baseRequest());
    expect(a.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const b = fp(
      baseRequest({
        signal: AbortSignal.abort(),
        sessionId: "22222222-2222-4222-8222-222222222222",
        tools: [tool("write_file", undefined, { effect: "write" }), tool("read_file")],
      }),
    );
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  const changes: Array<[string, Partial<StreamRequest>]> = [
    ["instructions", { instructions: "You are Alisio.\nOther rules." }],
    ["a message", { messages: [{ role: "user", text: "Fix the other bug" }] }],
    ["a tool description", { tools: [tool("read_file", "changed"), tool("write_file")] }],
    [
      "a tool schema",
      {
        tools: [
          tool("read_file", undefined, { inputSchema: { type: "object" } }),
          tool("write_file"),
        ],
      },
    ],
    ["a removed tool", { tools: [tool("read_file")] }],
    ["maxOutputTokens", { maxOutputTokens: 8192 }],
    ["model", { model: "other-model" }],
    ["reasoningEffort", { reasoningEffort: "high" }],
    ["nativeTools", { nativeTools: [{ type: "web_search" }] }],
  ];
  for (const [label, change] of changes)
    it(`changes when ${label} changes`, () => {
      expect(fp(baseRequest(change)).fingerprint).not.toBe(fp(baseRequest()).fingerprint);
    });

  it("is stable across two fresh run directories once the engine's literals are applied", () => {
    const make = (dir: string) =>
      new Normalizer({
        literals: runLiterals({
          runDir: dir,
          workspace: `${dir}/ws`,
          home: "/home/u",
          osTmp: "/tmp",
        }),
      });
    const request = (dir: string) =>
      baseRequest({
        instructions: `Working in ${dir}/ws; scratch ${dir}/tmp-x/alisio-1000`,
        messages: [
          { role: "user", text: "ls" },
          {
            role: "tool",
            callId: "c",
            result: { content: [{ type: "text", text: `${dir}/ws/a.txt` }] },
          },
        ],
      });
    const a = fp(request("/tmp/alisio-eval-AAAA"), make("/tmp/alisio-eval-AAAA"));
    const b = fp(request("/tmp/alisio-eval-BBBB"), make("/tmp/alisio-eval-BBBB"));
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("still changes when a tool result turns a relative path into an absolute one", () => {
    const n = () =>
      new Normalizer({
        literals: runLiterals({
          runDir: "/tmp/r",
          workspace: "/tmp/r/ws",
          home: "/h",
          osTmp: "/tmp",
        }),
      });
    const result = (text: string) =>
      baseRequest({
        messages: [{ role: "tool", callId: "c", result: { content: [{ type: "text", text }] } }],
      });
    expect(fp(result("/tmp/r/ws/a.txt"), n()).fingerprint).not.toBe(
      fp(result("a.txt"), n()).fingerprint,
    );
  });
});

describe("fingerprint diff", () => {
  const diff = (recorded: StreamRequest, actual: StreamRequest, call = 3) => {
    const store = emptyStore();
    const before = fp(recorded);
    absorb(store, before);
    return diffFingerprints(call, before.parts, store, fp(actual));
  };

  it("is empty for the same request", () => {
    expect(diff(baseRequest(), baseRequest())).toEqual([]);
  });

  it("names a changed tool description and quotes around the first difference", () => {
    const long = `${"a".repeat(300)}OLD${"b".repeat(300)}`;
    const entries = diff(
      baseRequest({ tools: [tool("read_file", long), tool("write_file")] }),
      baseRequest({ tools: [tool("read_file", long.replace("OLD", "NEW")), tool("write_file")] }),
    );
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.call).toBe(3);
    expect(entry?.field).toBe("tools[read_file].description");
    expect(entry?.excerpt.before).toContain("OLD");
    expect(entry?.excerpt.after).toContain("NEW");
    expect(entry?.excerpt.before.length).toBeLessThanOrEqual(245);
  });

  it("names instructions, a message part, the message count and scalar fields", () => {
    const fields = (entries: ReturnType<typeof diff>) => entries.map((e) => e.field);
    expect(
      fields(diff(baseRequest(), baseRequest({ instructions: "You are Alisio.\nDifferent." }))),
    ).toEqual(["instructions"]);
    expect(
      fields(
        diff(
          baseRequest(),
          baseRequest({
            messages: [
              { role: "user", text: "Fix the bug" },
              {
                role: "assistant",
                text: "",
                calls: [{ id: "call-0-0", name: "read_file", arguments: "{}" }],
              },
              {
                role: "tool",
                callId: "call-0-0",
                result: { content: [{ type: "text", text: "changed" }] },
              },
            ],
          }),
        ),
      ),
    ).toEqual(["messages[2].tool.result"]);
    expect(
      fields(
        diff(baseRequest(), baseRequest({ messages: [{ role: "user", text: "Fix the bug" }] })),
      ),
    ).toEqual(expect.arrayContaining(["messages.length"]));
    expect(
      fields(
        diff(
          baseRequest(),
          baseRequest({
            messages: [
              { role: "user", text: "Changed" },
              {
                role: "assistant",
                text: "x",
                calls: [{ id: "call-0-0", name: "read_file", arguments: "{}" }],
              },
              {
                role: "tool",
                callId: "call-0-0",
                result: { content: [{ type: "text", text: "contents" }] },
              },
            ],
          }),
        ),
      ),
    ).toEqual(["messages[0].user.text", "messages[1].assistant.text"]);
    expect(
      fields(
        diff(
          baseRequest(),
          baseRequest({
            messages: [
              { role: "user", text: "Fix the bug" },
              {
                role: "assistant",
                text: "",
                calls: [{ id: "call-9-9", name: "read_file", arguments: "{}" }],
              },
              {
                role: "tool",
                callId: "call-0-0",
                result: { content: [{ type: "text", text: "contents" }] },
              },
            ],
          }),
        ),
      ),
    ).toEqual(["messages[1].assistant.calls"]);
    expect(
      fields(
        diff(
          baseRequest(),
          baseRequest({
            maxOutputTokens: 1,
            model: "m2",
            reasoningEffort: "low",
            nativeTools: [{ type: "web_search" }],
          }),
        ),
      ),
    ).toEqual(["maxOutputTokens", "model", "reasoningEffort", "nativeTools"]);
  });

  it("names added and removed tools", () => {
    const entries = diff(baseRequest(), baseRequest({ tools: [tool("read_file"), tool("shell")] }));
    expect(entries.map((e) => e.field)).toEqual(["tools.added", "tools.removed"]);
    expect(entries[0]?.excerpt.after).toBe("shell");
    expect(entries[1]?.excerpt.before).toBe("write_file");
  });

  it("reports at most 10 entries", () => {
    const many = (suffix: string) =>
      baseRequest({
        messages: Array.from({ length: 30 }, (_, i) => ({
          role: "user" as const,
          text: `message ${i} ${suffix}`,
        })),
      });
    expect(diff(many("a"), many("b"))).toHaveLength(10);
  });

  it("redacts secrets from the excerpts", () => {
    const entries = diff(
      baseRequest({ instructions: "key sk-abcdefghijklmnopqrstuvwxyz0123456789 end" }),
      baseRequest({ instructions: "key other end" }),
    );
    expect(JSON.stringify(entries)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(entries[0]?.excerpt.before).toContain("[redacted]");
  });
});

// ---------------------------------------------------------------------------------------------
// Cassette file, recording and replay providers
// ---------------------------------------------------------------------------------------------

const META = {
  suiteId: "demo",
  taskId: "t1",
  harnessVersion: "0.6.0",
  configHash: "sha256:aaa",
  recordedAt: 1_700_000_000_000,
};

const SESSION = "11111111-1111-4111-8111-111111111111";

function scripted(
  turns: Array<{ events: ProviderEvent[]; throws?: Error }>,
  extra: Partial<ModelProvider> = {},
): ModelProvider & { requests: StreamRequest[] } {
  const requests: StreamRequest[] = [];
  return {
    id: "fake",
    model: "fake-model",
    requests,
    async *stream(request) {
      const turn = turns[requests.length];
      requests.push(request);
      if (!turn) throw new Error("scripted provider exhausted");
      for (const event of turn.events) yield event;
      if (turn.throws) throw turn.throws;
    },
    ...extra,
  };
}

const done = (text: string, extra: Record<string, unknown> = {}): ProviderEvent => ({
  type: "completed",
  message: { role: "assistant", text, calls: [], ...extra },
});

async function drain(provider: ModelProvider, request: StreamRequest): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

function record(
  inner: ModelProvider,
  requests: StreamRequest[],
  options: { sessions?: string[] } = {},
) {
  const normalizer = new Normalizer({ literals: [] });
  for (const id of options.sessions ?? [SESSION]) normalizer.registerSession(id);
  const recorder = new CassetteRecorder();
  recorder.bind(normalizer);
  const provider = new RecordingProvider(inner, recorder);
  return { recorder, provider, normalizer, run: () => requests.map((r) => drain(provider, r)) };
}

describe("RecordingProvider", () => {
  it("tees events verbatim: tool-call ids, providerData, truncated and usage; drops reasoning", async () => {
    const message = {
      role: "assistant" as const,
      text: "calling",
      calls: [{ id: "call_abc123", name: "read_file", arguments: '{"path":"a"}' }],
      providerData: [{ type: "reasoning", opaque: "blob==", n: 1 }],
      truncated: true,
    };
    const inner = scripted([
      {
        events: [
          { type: "reasoning_delta", delta: "thinking" },
          { type: "text_delta", delta: "calling" },
          { type: "completed", message, usage: { input: 11, output: 7, cachedInput: 3 } },
        ],
      },
    ]);
    const { recorder, provider } = record(inner, []);
    const seen = await drain(provider, baseRequest());
    expect(seen.map((e) => e.type)).toEqual(["reasoning_delta", "text_delta", "completed"]);
    const cassette = recorder.toCassette({ ...META, provider: "fake", model: "fake-model" });
    const [call] = cassette.calls;
    expect(call?.events.map((e) => e.type)).toEqual(["text_delta", "completed"]);
    expect(call?.events[1]).toEqual({
      type: "completed",
      message,
      usage: { input: 11, output: 7, cachedInput: 3 },
    });
    expect(call?.lane).toBe("<SESSION#1>");
    expect(call?.call).toBe(0);
  });

  it("stores a provider error so a truncation can be replayed", async () => {
    const error = Object.assign(new Error("cut off"), { code: "output_truncated" });
    const inner = scripted([{ events: [{ type: "text_delta", delta: "par" }], throws: error }]);
    const { recorder, provider } = record(inner, []);
    await expect(drain(provider, baseRequest())).rejects.toBe(error);
    const [call] = recorder.toCassette({ ...META, provider: "fake", model: "fake-model" }).calls;
    expect(call?.error).toEqual({ message: "cut off", code: "output_truncated" });
    expect(call?.events).toEqual([{ type: "text_delta", delta: "par" }]);
    expect(recorder.unstable).toBeUndefined();
  });

  it("marks the recording unstable when a call is aborted before any event", async () => {
    const controller = new AbortController();
    const inner: ModelProvider = {
      id: "fake",
      model: "m",
      async *stream(request) {
        await new Promise((_, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason)),
        );
        yield done("never");
      },
    };
    const { recorder, provider } = record(inner, []);
    const pending = drain(provider, baseRequest({ signal: controller.signal }));
    controller.abort(new Error("first token timeout"));
    await expect(pending).rejects.toThrow("first token timeout");
    expect(recorder.unstable).toMatch(/unstable.*re-record/i);
    expect(() => recorder.toCassette({ ...META, provider: "fake", model: "m" })).toThrow(
      /unstable/i,
    );
  });

  it("marks the recording unstable when the consumer abandons a stream", async () => {
    const inner = scripted([{ events: [{ type: "text_delta", delta: "a" }, done("b")] }]);
    const { recorder, provider } = record(inner, []);
    for await (const _ of provider.stream(baseRequest())) break;
    expect(recorder.unstable).toMatch(/re-record/i);
  });

  it("records the catalog the provider lists and passes dispose through", async () => {
    let disposed = false;
    const inner = scripted([{ events: [done("x")] }], {
      listModels: async () => [{ id: "fake-model", maxOutputTokens: 1234 }],
      dispose: () => {
        disposed = true;
      },
    });
    const { recorder, provider } = record(inner, []);
    expect(await provider.listModels?.(new AbortController().signal)).toEqual([
      { id: "fake-model", maxOutputTokens: 1234 },
    ]);
    await provider.dispose?.();
    expect(disposed).toBe(true);
    expect(
      recorder.toCassette({ ...META, provider: "fake", model: "fake-model" }).header.models,
    ).toEqual([{ id: "fake-model", maxOutputTokens: 1234 }]);
  });
});

describe("cassette file", () => {
  async function sample(): Promise<Cassette> {
    const inner = scripted([
      { events: [{ type: "text_delta", delta: "hi" }, done("hi")] },
      { events: [done("bye")] },
    ]);
    const { recorder, provider } = record(inner, []);
    await drain(provider, baseRequest());
    await drain(provider, baseRequest({ messages: [{ role: "user", text: "again" }] }));
    return recorder.toCassette({ ...META, provider: "fake", model: "fake-model" });
  }

  it("round-trips through JSONL with a versioned header line", async () => {
    const cassette = await sample();
    const text = serializeCassette(cassette);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      v: 1,
      cassetteVersion: 1,
      suiteId: "demo",
      taskId: "t1",
      harnessVersion: "0.6.0",
      configHash: "sha256:aaa",
      recordedAt: META.recordedAt,
    });
    expect(parseCassette(text)).toEqual(cassette);
  });

  it("stores each distinct instruction text once and new messages only on the call they appear", async () => {
    const cassette = await sample();
    const instructionHashes = Object.values(cassette.header.texts).filter((t) =>
      t.startsWith("You are Alisio."),
    );
    expect(instructionHashes).toHaveLength(1);
    expect(Object.keys(cassette.calls[0]?.messages ?? {})).toHaveLength(3);
    expect(Object.keys(cassette.calls[1]?.messages ?? {})).toHaveLength(1);
  });

  it("rejects malformed cassettes with actionable messages", async () => {
    const text = serializeCassette(await sample());
    expect(() => parseCassette("")).toThrow(/empty/i);
    expect(() => parseCassette("not json\n")).toThrow(/line 1/);
    expect(() => parseCassette(text.replace('"v":1', '"v":2'))).toThrow(/cassette\/v1/);
    const [header, first, second] = text.trimEnd().split("\n");
    expect(() => parseCassette([header, second].join("\n"))).toThrow(/call 1.*expected 0/i);
    expect(() => parseCassette([header, first, "{}"].join("\n"))).toThrow(/line 3/);
  });

  describe("writer", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "cassette-write-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("writes the file and reads it back", async () => {
      const cassette = await sample();
      const path = join(dir, "t1.cassette.jsonl");
      writeCassette(path, cassette);
      expect(readCassette(path)).toEqual(cassette);
    });

    it("refuses a planted key, names the field and writes nothing", async () => {
      const cassette = await sample();
      const call = cassette.calls[0];
      const completed = call?.events[1];
      if (completed?.type === "completed")
        completed.message.text = "key: sk-abcdefghijklmnopqrstuvwxyz0123456789";
      const path = join(dir, "t1.cassette.jsonl");
      let error: unknown;
      try {
        writeCassette(path, cassette);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(CassetteWriteError);
      expect((error as Error).message).toContain("calls[0].events[1].message.text");
      expect((error as Error).message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(existsSync(path)).toBe(false);
    });

    it.each([
      ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
      ["github_pat_11ABCDEFG0abcdefghijklmnop"],
      ["AKIAABCDEFGHIJKLMNOP"],
      ["xoxb-1234567890-abcdefghij"],
      ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
      ["-----BEGIN RSA PRIVATE KEY-----"],
      ["OPENAI_API_KEY=abcd1234"],
    ])("refuses %s", async (secret) => {
      const cassette = await sample();
      cassette.header.configHash = secret;
      expect(() => writeCassette(join(dir, "x.cassette.jsonl"), cassette)).toThrow(
        /header\.configHash/,
      );
    });

    it("refuses the exact credential values it is given", async () => {
      const cassette = await sample();
      const call = cassette.calls[0];
      if (call?.events[0]?.type === "text_delta") call.events[0].delta = "my-profile-secret-123";
      expect(() =>
        writeCassette(join(dir, "x.cassette.jsonl"), cassette, {
          secrets: ["my-profile-secret-123"],
        }),
      ).toThrow(/calls\[0\]\.events\[0\]\.delta/);
    });

    it("refuses a cassette over 256 KB and a directory over 2 MB", async () => {
      const big = await sample();
      const call = big.calls[0];
      if (call?.events[0]?.type === "text_delta") call.events[0].delta = "x".repeat(300_000);
      expect(() => writeCassette(join(dir, "big.cassette.jsonl"), big)).toThrow(/256 KB/);

      const small = await sample();
      const grow = (bytes: number) => {
        const copy = structuredClone(small);
        const first = copy.calls[0]?.events[0];
        if (first?.type === "text_delta") first.delta = "y".repeat(bytes);
        return copy;
      };
      for (let n = 0; n < 8; n++) writeCassette(join(dir, `a${n}.cassette.jsonl`), grow(250_000));
      expect(() => writeCassette(join(dir, "z.cassette.jsonl"), grow(250_000))).toThrow(/2 MB/);
      // Overwriting an existing cassette does not count its old size twice.
      expect(() => writeCassette(join(dir, "a0.cassette.jsonl"), grow(250_000))).not.toThrow();
    });
  });
});

describe("ReplayProvider", () => {
  const recordTwo = async () => {
    const inner = scripted([
      { events: [{ type: "text_delta", delta: "one" }, done("one")] },
      { events: [done("two", { calls: [{ id: "call_x", name: "t", arguments: "{}" }] })] },
    ]);
    const requests = [baseRequest(), baseRequest({ messages: [{ role: "user", text: "second" }] })];
    const { recorder, provider } = record(inner, []);
    const events: ProviderEvent[][] = [];
    for (const r of requests) events.push(await drain(provider, r));
    const cassette = recorder.toCassette({
      ...META,
      provider: "fake",
      model: "fake-model",
    });
    return { cassette, requests, events };
  };
  const replayer = (cassette: Cassette, sessions: string[] = [SESSION]) => {
    const normalizer = new Normalizer({ literals: [] });
    for (const id of sessions) normalizer.registerSession(id);
    return new ReplayProvider(cassette, { normalizer });
  };

  it("serves the recorded id, model and catalog and the recorded events in order", async () => {
    const { cassette, requests, events } = await recordTwo();
    cassette.header.models = [{ id: "fake-model" }];
    const replay = replayer(cassette);
    expect(replay.id).toBe("fake");
    expect(replay.model).toBe("fake-model");
    expect(await replay.listModels?.(new AbortController().signal)).toEqual([{ id: "fake-model" }]);
    expect(await drain(replay, requests[0] as StreamRequest)).toEqual(
      events[0]?.filter((e) => e.type !== "reasoning_delta"),
    );
    expect(await drain(replay, requests[1] as StreamRequest)).toEqual(events[1]);
    expect(() => replay.assertConsumed()).not.toThrow();
  });

  it("has no listModels when the recording had no catalog", async () => {
    const { cassette } = await recordTwo();
    expect(replayer(cassette).listModels).toBeUndefined();
  });

  it("fails with a structured diff when the request changed, and does not continue", async () => {
    const { cassette } = await recordTwo();
    const replay = replayer(cassette);
    const changed = baseRequest({
      tools: [tool("read_file", "NEW description"), tool("write_file")],
    });
    let error: unknown;
    try {
      await drain(replay, changed);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ReplayDivergenceError);
    const divergence = error as ReplayDivergenceError;
    expect(divergence.call).toBe(0);
    expect(divergence.diff.map((d) => d.field)).toEqual(["tools[read_file].description"]);
    expect(divergence.message).toContain("tools[read_file].description");
  });

  it("fails with ReplayExhausted when the run asks for more calls than were recorded", async () => {
    const { cassette, requests } = await recordTwo();
    const replay = replayer(cassette);
    for (const r of requests) await drain(replay, r);
    await expect(drain(replay, baseRequest())).rejects.toBeInstanceOf(ReplayExhausted);
  });

  it("reports leftover calls from assertConsumed", async () => {
    const { cassette, requests } = await recordTwo();
    const replay = replayer(cassette);
    await drain(replay, requests[0] as StreamRequest);
    expect(() => replay.assertConsumed()).toThrow(ReplayUnconsumedError);
    expect(() => replay.assertConsumed()).toThrow(/1 recorded call/);
  });

  it("throws the abort reason without consuming a call when the signal is already aborted", async () => {
    const { cassette, requests } = await recordTwo();
    const replay = replayer(cassette);
    const reason = new Error("stopped");
    await expect(
      drain(replay, { ...(requests[0] as StreamRequest), signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    await drain(replay, requests[0] as StreamRequest);
  });

  it("replays a recorded provider error after its partial events", async () => {
    const error = Object.assign(new Error("cut off"), { code: "output_truncated" });
    const inner = scripted([{ events: [{ type: "text_delta", delta: "par" }], throws: error }]);
    const { recorder, provider } = record(inner, []);
    await drain(provider, baseRequest()).catch(() => {});
    const replay = replayer(
      recorder.toCassette({ ...META, provider: "fake", model: "fake-model" }),
    );
    const seen: ProviderEvent[] = [];
    let thrown: unknown;
    try {
      for await (const e of replay.stream(baseRequest())) seen.push(e);
    } catch (e) {
      thrown = e;
    }
    expect(seen).toEqual([{ type: "text_delta", delta: "par" }]);
    expect(thrown).toMatchObject({ message: "cut off", code: "output_truncated" });
    expect(isOutputTruncationError(thrown)).toBe(true);
  });

  it("keeps lanes apart: sessions may interleave differently on replay", async () => {
    const S2 = "22222222-2222-4222-8222-222222222222";
    const reqA = baseRequest({ sessionId: SESSION });
    const reqB = baseRequest({ sessionId: S2, messages: [{ role: "user", text: "other" }] });
    const reqA2 = baseRequest({ sessionId: SESSION, messages: [{ role: "user", text: "a2" }] });
    const inner = scripted([
      { events: [done("A1")] },
      { events: [done("B1")] },
      { events: [done("A2")] },
    ]);
    const { recorder, provider } = record(inner, [], { sessions: [SESSION, S2] });
    await drain(provider, reqA);
    await drain(provider, reqB);
    await drain(provider, reqA2);
    const replay = replayer(recorder.toCassette({ ...META, provider: "fake", model: "m" }), [
      SESSION,
      S2,
    ]);
    // A2 asked before B1 on replay: lanes make that order irrelevant.
    expect(await drain(replay, reqA)).toEqual([done("A1")]);
    expect(await drain(replay, reqA2)).toEqual([done("A2")]);
    expect(await drain(replay, reqB)).toEqual([done("B1")]);
  });

  it("binds an unregistered (child) session to the lane of its first request", async () => {
    const C1 = "33333333-3333-4333-8333-333333333333";
    const C2 = "44444444-4444-4444-8444-444444444444";
    const first = (id: string) =>
      baseRequest({
        sessionId: id,
        messages: [{ role: "user", text: `task ${id === C1 ? 1 : 2}` }],
      });
    const second = (id: string) =>
      baseRequest({
        sessionId: id,
        messages: [
          { role: "user", text: `task ${id === C1 ? 1 : 2}` },
          { role: "assistant", text: "r", calls: [] },
        ],
      });
    const inner = scripted([
      { events: [done("c1-1")] },
      { events: [done("c2-1")] },
      { events: [done("c1-2")] },
      { events: [done("c2-2")] },
    ]);
    const { recorder, provider } = record(inner, [], { sessions: [] });
    await drain(provider, first(C1));
    await drain(provider, first(C2));
    await drain(provider, second(C1));
    await drain(provider, second(C2));
    const cassette = recorder.toCassette({ ...META, provider: "fake", model: "m" });
    expect(new Set(cassette.calls.map((c) => c.lane)).size).toBe(2);
    // On replay the children get other ids and run in the opposite order.
    const D1 = "55555555-5555-4555-8555-555555555555";
    const D2 = "66666666-6666-4666-8666-666666666666";
    const replay = replayer(cassette, []);
    const rename = (r: StreamRequest, from: string, to: string) => ({
      ...r,
      sessionId: to,
      messages: r.messages.map((m) => ({ ...m })),
    });
    expect(await drain(replay, rename(first(C2), C2, D2))).toEqual([done("c2-1")]);
    expect(await drain(replay, rename(first(C1), C1, D1))).toEqual([done("c1-1")]);
    expect(await drain(replay, rename(second(C1), C1, D1))).toEqual([done("c1-2")]);
    expect(await drain(replay, rename(second(C2), C2, D2))).toEqual([done("c2-2")]);
    expect(() => replay.assertConsumed()).not.toThrow();
  });
});
