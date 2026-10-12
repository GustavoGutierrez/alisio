/**
 * The pure decisions around a Forja execution: concurrency slots (D-29), progress coalescing (D14),
 * the compact text the model reads, the catalog a script browses, the routing rule and the
 * terminal verdict. No I/O, no timers beyond an injected clock.
 */
import type { ForgeProgress, ToolDefinition } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { describeTool, searchCatalog, summarize } from "../packages/core/src/forge/catalog-view.ts";
import {
  encodeFrame,
  FrameDecoder,
  FrameStreamError,
} from "../packages/core/src/forge/javascript/hosts/framing.ts";
import { ProgressCoalescer } from "../packages/core/src/forge/progress.ts";
import {
  clipText,
  type ForgeResult,
  hintFor,
  renderForgeResult,
} from "../packages/core/src/forge/result.ts";
import {
  buildRoutingRule,
  ROUTING_RULE_MAX_CHARS,
} from "../packages/core/src/forge/routing-rule.ts";
import { SlotTable } from "../packages/core/src/forge/slots.ts";
import { verdictOf } from "../packages/core/src/forge/verdict.ts";

describe("SlotTable (D-29)", () => {
  it("allows one execution per session and four per process", () => {
    const slots = new SlotTable();
    const a = slots.acquire("s1");
    expect(() => slots.acquire("s1")).toThrow(/Another js_run is still running in this session/);
    const releases = [a, slots.acquire("s2"), slots.acquire("s3"), slots.acquire("s4")];
    expect(slots.active).toBe(4);
    expect(() => slots.acquire("s5")).toThrow(/Too many js_run executions .* \(4\)/);
    releases[1]?.();
    expect(slots.acquire("s5")).toBeTypeOf("function");
  });

  it("a child session does not wait for its parent's slot", () => {
    const slots = new SlotTable();
    slots.acquire("root");
    expect(() => slots.acquire("child")).not.toThrow();
  });

  it("a release frees exactly once, however often it is called", () => {
    const slots = new SlotTable({ perSession: 1, perProcess: 4 });
    const release = slots.acquire("s");
    release();
    release();
    expect(slots.active).toBe(0);
    slots.acquire("s");
    expect(() => slots.acquire("s")).toThrow();
    expect(slots.activeIn("s")).toBe(1);
  });

  it("with more than one slot per session, releasing one keeps the others counted", () => {
    const slots = new SlotTable({ perSession: 2, perProcess: 8 });
    const first = slots.acquire("s");
    const second = slots.acquire("s");
    first();
    expect(slots.activeIn("s")).toBe(1);
    expect(() => slots.acquire("s")).not.toThrow();
    second();
    expect(slots.activeIn("s")).toBe(1);
  });

  it("honours other limits and refuses with a code the model can read", () => {
    const slots = new SlotTable({ perSession: 2, perProcess: 2 });
    slots.acquire("s");
    slots.acquire("s");
    expect(() => slots.acquire("s")).toThrowError(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
    );
  });
});

describe("ProgressCoalescer (D14)", () => {
  const event = (n: number, phase: ForgeProgress["phase"] = "running"): ForgeProgress => ({
    kind: "forge",
    executionId: "x",
    engine: "javascript-quickjs",
    phase,
    completed: n,
  });
  function rig() {
    let now = 10_000;
    const skew = (ms: number) => {
      now += ms;
    };
    const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
    const seen: ForgeProgress[] = [];
    const coalescer = new ProgressCoalescer((p) => seen.push(p), {
      now: () => now,
      schedule(run, ms) {
        const timer = { at: now + ms, run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    });
    const advance = (ms: number) => {
      now += ms;
      for (const timer of timers)
        if (timer.live && timer.at <= now) {
          timer.live = false;
          timer.run();
        }
    };
    return { coalescer, seen, advance, skew };
  }

  it("delivers the first event at once and at most 4 per second after that", () => {
    const { coalescer, seen, advance } = rig();
    for (let i = 0; i < 10; i++) coalescer.update(event(i));
    expect(seen.map((p) => p.completed)).toEqual([0]);
    advance(250);
    expect(seen.map((p) => p.completed)).toEqual([0, 9]);
    coalescer.update(event(10));
    advance(100);
    expect(seen).toHaveLength(2);
    advance(150);
    expect(seen.map((p) => p.completed)).toEqual([0, 9, 10]);
  });

  it("an event exactly one interval after the last is delivered at once", () => {
    const { coalescer, seen, advance } = rig();
    coalescer.update(event(1));
    advance(250);
    coalescer.update(event(2));
    expect(seen.map((p) => p.completed)).toEqual([1, 2]);
  });

  it("keeps order when a timer fires late: a waiting event is replaced, never overtaken", () => {
    const { coalescer, seen, advance, skew } = rig();
    coalescer.update(event(1));
    coalescer.update(event(2));
    skew(400); // the interval passed but the timer has not run yet
    coalescer.update(event(3));
    expect(seen.map((p) => p.completed)).toEqual([1]);
    advance(0);
    expect(seen.map((p) => p.completed)).toEqual([1, 3]);
  });

  it("keeps the latest event of each category: script progress is not replaced by a call starting", () => {
    const { coalescer, seen, advance } = rig();
    const call = (id: number): ForgeProgress => ({
      kind: "forge",
      executionId: "x",
      engine: "javascript-quickjs",
      phase: "call",
      call: { callId: id, tool: "read_file", status: "started" },
    });
    coalescer.update(event(1));
    coalescer.update(call(1));
    coalescer.update(event(2));
    coalescer.update(call(2));
    // The first of each category is delivered at once; the rest wait for their own window.
    expect(seen.map((p) => p.phase)).toEqual(["running", "call"]);
    advance(250);
    expect(seen.map((p) => [p.phase, p.completed ?? p.call?.callId])).toEqual([
      ["running", 1],
      ["call", 1],
      ["running", 2],
      ["call", 2],
    ]);
  });

  it("closing with nothing waiting delivers nothing", () => {
    const { coalescer, seen } = rig();
    coalescer.close();
    expect(seen).toEqual([]);
  });

  it("never drops a terminal event, and delivers what waited before it", () => {
    const { coalescer, seen } = rig();
    coalescer.update(event(1));
    coalescer.update(event(2));
    coalescer.terminal(event(3, "call"));
    expect(seen.map((p) => [p.phase, p.completed])).toEqual([
      ["running", 1],
      ["running", 2],
      ["call", 3],
    ]);
  });

  it("close flushes the last waiting event and nothing fires afterwards", () => {
    const { coalescer, seen, advance } = rig();
    coalescer.update(event(1));
    coalescer.update(event(2));
    coalescer.close();
    expect(seen.map((p) => p.completed)).toEqual([1, 2]);
    advance(1000);
    expect(seen).toHaveLength(2);
  });
});

describe("ForgeResult text for the model", () => {
  const base = (over: Partial<ForgeResult> = {}): ForgeResult => ({
    schemaVersion: 1,
    executionId: "fx",
    engine: "javascript-quickjs",
    isolation: "wasm-isolate",
    selectionReason: "language=javascript",
    status: "succeeded",
    output: [],
    calls: { total: 2, failed: 1, denied: 0 },
    truncated: false,
    metrics: { wallMs: 5, queueMs: 1, outputBytes: 0 },
    ...over,
  });

  it("states status, value, output, call counts and the error, in that order", () => {
    const text = renderForgeResult(
      base({
        value: { a: 1 },
        output: [
          { type: "text", text: "hello\n" },
          { type: "json", value: [1] },
        ],
        status: "failed",
        error: {
          code: "TOOL_FAILED",
          message: "boom",
          hint: { topic: "js.tools", reason: "see catalog.search" },
        },
      }),
      1000,
    );
    expect(text.text).toBe(
      'status: failed\nvalue: {"a":1}\noutput:\nhello\n[1]\ncalls: 2 total, 1 failed, 0 denied\nerror: TOOL_FAILED: boom\nhint: see catalog.search (forge_guide topic "js.tools")',
    );
    expect(text.truncated).toBe(false);
  });

  it("shares the character budget between value and output but keeps the report", () => {
    const rendered = renderForgeResult(
      base({ output: [{ type: "text", text: "x".repeat(500) }] }),
      100,
    );
    expect(rendered.truncated).toBe(true);
    expect(rendered.text).toContain("[output truncated at 100 characters");
    expect(rendered.text).toMatch(/calls: 2 total/);
    expect(rendered.text.length).toBeLessThan(400);
  });

  it("a report with no value, no output and no hint is just status, counts and error", () => {
    const rendered = renderForgeResult(
      base({
        status: "failed",
        calls: { total: 0, failed: 0, denied: 0 },
        error: { code: "TIMEOUT", message: "late" },
      }),
      100,
    );
    expect(rendered.text).toBe(
      "status: failed\ncalls: 0 total, 0 failed, 0 denied\nerror: TIMEOUT: late",
    );
    expect(renderForgeResult(base({ output: [{ type: "text", text: "" }] }), 100).text).not.toMatch(
      /output:/,
    );
  });

  it("clipText only trims a high surrogate left alone at the cut", () => {
    const high = String.fromCharCode(0xd800);
    const highest = String.fromCharCode(0xdbff);
    const low = String.fromCharCode(0xdc00);
    const below = String.fromCharCode(0xd7ff);
    expect(clipText(`ab${high}c`, 3).text).toBe("ab");
    expect(clipText(`ab${highest}c`, 3).text).toBe("ab");
    expect(clipText(`ab${low}c`, 3).text).toBe(`ab${low}`);
    expect(clipText(`ab${below}c`, 3).text).toBe(`ab${below}`);
  });

  it("clipText does not split a surrogate pair and reports whether it cut", () => {
    expect(clipText("abc", 3)).toEqual({ text: "abc", clipped: false });
    expect(clipText("abcd", 3)).toEqual({ text: "abc", clipped: true });
    expect(clipText("ab😀", 3).text).toBe("ab");
  });

  it("points at the guide only for causes it knows", () => {
    expect(hintFor("SCRIPT_SYNTAX", "unexpected token", "import x from 'y'")?.topic).toBe("js.api");
    expect(hintFor("SCRIPT_SYNTAX", "unexpected token", "let x = ;")).toBeUndefined();
    expect(hintFor("TOOL_UNAVAILABLE", "")?.topic).toBe("js.tools");
    expect(hintFor("OUTPUT_LIMIT", "")?.topic).toBe("js.patterns#filtering");
    expect(hintFor("TIMEOUT", "")).toBeUndefined();
    expect(hintFor("SCRIPT_RUNTIME", "cannot import this", "import x")).toBeUndefined();
  });
});

describe("catalog view (D13)", () => {
  const tool = (
    name: string,
    description: string,
    effect?: ToolDefinition["effect"],
  ): ToolDefinition => ({
    name,
    description,
    inputSchema: { type: "object" },
    ...(effect ? { effect } : {}),
    async execute() {
      return { content: [] };
    },
  });
  const tools = [
    tool("read_file", "Read UTF-8 text by line. Returns a hash.", "read"),
    tool("grep", "Search file contents with ripgrep.", "read"),
    tool("write_file", "Write a file. Needs the hash.", "write"),
    tool("mystery", "No effect declared."),
  ];

  it("finds tools whose name or description holds every term, sorted by name", () => {
    expect(searchCatalog(tools, "file").map((e) => e.name)).toEqual([
      "grep",
      "read_file",
      "write_file",
    ]);
    expect(searchCatalog(tools, "file hash").map((e) => e.name)).toEqual([
      "read_file",
      "write_file",
    ]);
    expect(searchCatalog(tools, "nothing here")).toEqual([]);
    expect(searchCatalog(tools, "").map((e) => e.name)).toHaveLength(4);
  });

  it("bounds the number of entries and defaults an undeclared effect to external", () => {
    expect(searchCatalog(tools, "", 2)).toHaveLength(2);
    expect(searchCatalog(tools, "", 0)).toHaveLength(1);
    expect(
      searchCatalog(
        Array.from({ length: 40 }, (_, i) => tool(`t${i}`, "x")),
        "",
        1000,
      ),
    ).toHaveLength(25);
    expect(searchCatalog(tools, "mystery")[0]?.effect).toBe("external");
  });

  it("summarises with the first sentence, bounded", () => {
    expect(summarize("Read UTF-8 text by line. Returns a hash.")).toBe("Read UTF-8 text by line.");
    expect(summarize("a ".repeat(200)).length).toBeLessThanOrEqual(160);
    expect(searchCatalog(tools, "grep")[0]?.summary).toBe("Search file contents with ripgrep.");
  });

  it("summaries are cut at 160 characters exactly, and a leading space is dropped", () => {
    expect(summarize("x".repeat(160))).toBe("x".repeat(160));
    expect(summarize("x".repeat(161))).toBe(`${"x".repeat(159)}…`);
    expect(summarize("  padded text")).toBe("padded text");
    expect(summarize(".")).toBe(".");
  });

  it("describes one tool with its schema, or nothing", () => {
    expect(describeTool(tools, "grep")).toMatchObject({
      name: "grep",
      effect: "read",
      inputSchema: { type: "object" },
    });
    expect(describeTool(tools, "nope")).toBeUndefined();
  });
});

describe("routing rule (§8.1)", () => {
  it("is empty with no Forja tool, mentions js_run and the scratchpad when present", () => {
    expect(buildRoutingRule({ javascript: false, python: false })).toBe("");
    const rule = buildRoutingRule({
      javascript: true,
      python: false,
      scratchpad: "/tmp/alisio-1000/ws/s1/scratchpad",
    });
    expect(rule).toContain("`js_run`");
    expect(rule).toContain("/tmp/alisio-1000/ws/s1/scratchpad");
    expect(rule).toContain("`codePath`");
    expect(rule).not.toContain("python_run");
  });

  it("adds the Python line only when python_run exists, and always fits the bound", () => {
    const both = buildRoutingRule({
      javascript: true,
      python: true,
      scratchpad: `/${"p".repeat(120)}`,
    });
    expect(both).toContain("python_run");
    expect(both.length).toBeLessThanOrEqual(ROUTING_RULE_MAX_CHARS);
    expect(
      buildRoutingRule({ javascript: true, python: true, scratchpad: `/${"p".repeat(3000)}` })
        .length,
    ).toBe(ROUTING_RULE_MAX_CHARS);
  });
});

describe("verdictOf: who decides the terminal state", () => {
  const completed = { kind: "completed", value: 3 } as const;
  const failed = (
    code: Parameters<typeof verdictOf>[0] extends infer O
      ? O extends { code: infer C }
        ? C
        : never
      : never,
  ) => ({ kind: "failed", code, message: "m" }) as const;

  it("the host's own stop wins over whatever the guest reported", () => {
    expect(verdictOf(completed, "timeout", 500)).toMatchObject({
      status: "timed_out",
      error: { code: "TIMEOUT", message: "Execution exceeded 500 ms" },
    });
    expect(verdictOf(failed("SCRIPT_RUNTIME"), "cancelled", 500)).toMatchObject({
      status: "cancelled",
      error: { code: "CANCELLED" },
    });
  });

  it("completed is succeeded with its value; other failures keep their code", () => {
    expect(verdictOf(completed, undefined, 500)).toEqual({ status: "succeeded", value: 3 });
    expect(verdictOf({ kind: "completed" }, undefined, 500)).toStrictEqual({ status: "succeeded" });
    expect(verdictOf(failed("BUDGET_EXCEEDED"), undefined, 500)).toEqual({
      status: "failed",
      error: { code: "BUDGET_EXCEEDED", message: "m" },
    });
  });
});

describe("length-prefixed framing", () => {
  it("round-trips messages split across arbitrary chunk boundaries", () => {
    const decoder = new FrameDecoder(1024);
    const bytes = Buffer.concat([
      encodeFrame({ a: 1 }),
      encodeFrame({ b: "é" }),
      encodeFrame([1, 2]),
    ]);
    const seen: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) seen.push(...decoder.push(bytes.subarray(i, i + 3)));
    expect(seen).toEqual([{ a: 1 }, { b: "é" }, [1, 2]]);
  });

  it("accepts a frame of exactly the limit and rejects one byte more", () => {
    const body = Buffer.from(JSON.stringify("x".repeat(10)));
    const at = Buffer.alloc(4);
    at.writeUInt32BE(body.length);
    expect(new FrameDecoder(body.length).push(Buffer.concat([at, body]))).toEqual(["x".repeat(10)]);
    expect(() => new FrameDecoder(body.length - 1).push(Buffer.concat([at, body]))).toThrow(
      FrameStreamError,
    );
  });

  it("rejects an oversized frame from its header, before buffering the body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(5_000_000);
    expect(() => new FrameDecoder(1024).push(header)).toThrow(FrameStreamError);
  });

  it("rejects a body that is not JSON", () => {
    const body = Buffer.from("not json");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    expect(() => new FrameDecoder(1024).push(Buffer.concat([header, body]))).toThrow(
      /not valid JSON/,
    );
  });
});

describe("security review: verdictOf trusts only the host for a stop", () => {
  const failed = (
    code: Parameters<typeof verdictOf>[0] extends infer O
      ? O extends { kind: "failed"; code: infer C }
        ? C
        : never
      : never,
  ) => ({ kind: "failed", code, message: "from the guest" }) as const;

  it("M3: a guest-reported TIMEOUT or CANCELLED without a host stop is a failed SCRIPT_RUNTIME", () => {
    for (const code of ["TIMEOUT", "CANCELLED"] as const) {
      const verdict = verdictOf(failed(code), undefined, 500);
      expect(verdict.status).toBe("failed");
      expect(verdict.error?.code).toBe("SCRIPT_RUNTIME");
      expect(verdict.error?.message).toContain("from the guest");
    }
  });

  it("M3: other codes the guest reports keep passing through", () => {
    expect(verdictOf(failed("MEMORY_LIMIT"), undefined, 500)).toMatchObject({
      status: "failed",
      error: { code: "MEMORY_LIMIT" },
    });
  });
});

describe("security review: renderForgeResult bounds the error text (L6)", () => {
  it("clips a long error message to the output budget and says so", () => {
    const result: ForgeResult = {
      schemaVersion: 1,
      executionId: "fx_1",
      engine: "javascript-quickjs",
      isolation: "wasm-isolate",
      selectionReason: "language=javascript",
      status: "failed",
      output: [],
      error: { code: "SCRIPT_RUNTIME", message: "boom ".repeat(100_000) },
      calls: { total: 0, failed: 0, denied: 0 },
      truncated: false,
      metrics: { wallMs: 1, queueMs: 0, outputBytes: 0 },
    };
    const rendered = renderForgeResult(result, 200);
    expect(rendered.text.length).toBeLessThan(900);
    expect(rendered.text).toContain("error: SCRIPT_RUNTIME: boom");
    expect(rendered.text).toMatch(/\[error message truncated at 200 characters\]/);
    expect(rendered.truncated).toBe(true);
  });
});
