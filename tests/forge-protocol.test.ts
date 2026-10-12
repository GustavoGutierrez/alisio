/**
 * The host-side validation of guest messages (spec §5.4): shape, direction-wise sequence numbers,
 * call correlation, size and depth bounds, forbidden keys, JSON-only values, terminal closure and
 * the tool-call capability gate. Every rejection is a PROTOCOL_VIOLATION.
 */
import { describe, expect, it } from "vitest";
import { GuestMessageValidator } from "../packages/core/src/forge/protocol.ts";

const MAX_BYTES = 256 * 1024;

function envelope(type: string, payload: unknown, seq: number): Record<string, unknown> {
  return { protocol: 1, type, seq, payload };
}
const output = (text: string, seq: number) => envelope("output", { type: "text", text }, seq);
const call = (callId: number, seq: number) =>
  envelope("call", { callId, tool: "read_file", input: { path: "a.txt" } }, seq);
const nest = (levels: number): unknown => {
  let value: unknown = 1;
  for (let i = 0; i < levels; i++) value = [value];
  return value;
};

function expectViolation(result: { ok: boolean; error?: { code: string } }): void {
  expect(result.ok).toBe(false);
  expect(result.error?.code).toBe("PROTOCOL_VIOLATION");
}

describe("forge protocol validator", () => {
  const make = (toolCalls = true) => new GuestMessageValidator({ toolCalls });

  it("accepts a well-formed conversation", () => {
    const v = make();
    const messages = [
      envelope("ready", { engine: "javascript-quickjs", preludeHash: "abc" }, 0),
      envelope("progress", { message: "working", completed: 1, total: 4 }, 1),
      output("hello", 2),
      envelope("state.set", { key: "k", value: { a: [1, "x", null, true] } }, 3),
      envelope("state.delete", { key: "k" }, 4),
      call(1, 5),
      envelope("catalog", { requestId: 1, op: "search", query: "files", limit: 5 }, 6),
      envelope("complete", { value: 42 }, 7),
    ];
    for (const message of messages)
      expect(v.accept(message).ok, JSON.stringify(message)).toBe(true);
  });

  it("returns the validated message itself", () => {
    const result = make().accept(output("hi", 0));
    expect(result.ok && result.message).toEqual(output("hi", 0));
  });

  it.each([
    ["an unknown type", envelope("exec", {}, 0)],
    [
      "a wrong protocol version",
      { protocol: 2, type: "output", seq: 0, payload: { type: "text", text: "x" } },
    ],
    ["a missing payload", { protocol: 1, type: "progress", seq: 0 }],
    ["a negative seq", output("x", -1)],
    ["a fractional seq", output("x", 1.5)],
    ["a payload of the wrong shape", envelope("progress", { message: 5 }, 0)],
    ["an unexpected payload field", envelope("progress", { message: "x", extra: true }, 0)],
    ["an unknown fatal code", envelope("fatal", { code: "NOPE", message: "x" }, 0)],
    ["a non-object message", "output"],
    ["null", null],
  ])("rejects %s", (_name, message) => {
    expectViolation(make().accept(message));
  });

  it("requires strictly increasing seq numbers", () => {
    const v = make();
    expect(v.accept(output("a", 3)).ok).toBe(true);
    expectViolation(v.accept(output("b", 3)));
    const w = make();
    expect(w.accept(output("a", 3)).ok).toBe(true);
    expectViolation(w.accept(output("b", 2)));
  });

  it("rejects a call that reuses a callId, pending or resolved", () => {
    const v = make();
    expect(v.accept(call(7, 0)).ok).toBe(true);
    expectViolation(v.accept(call(7, 1)));

    const w = make();
    expect(w.accept(call(7, 0)).ok).toBe(true);
    expect(w.resolveCall(7).ok).toBe(true);
    expectViolation(w.accept(call(7, 1)));
  });

  it("rejects resolving an unknown or already resolved callId", () => {
    const v = make();
    expectViolation(v.resolveCall(99));
    expect(v.accept(call(1, 0)).ok).toBe(true);
    expect(v.resolveCall(1).ok).toBe(true);
    expectViolation(v.resolveCall(1));
  });

  it("correlates catalog requests the same way", () => {
    const v = make();
    const request = (id: number, seq: number) =>
      envelope("catalog", { requestId: id, op: "describe", query: "read_file" }, seq);
    expect(v.accept(request(1, 0)).ok).toBe(true);
    expectViolation(v.accept(request(1, 1)));
    const w = make();
    expectViolation(w.resolveCatalog(5));
    expect(w.accept(request(5, 0)).ok).toBe(true);
    expect(w.resolveCatalog(5).ok).toBe(true);
    expectViolation(w.resolveCatalog(5));
  });

  it("rejects call and catalog when the engine cannot call tools", () => {
    const v = make(false);
    expectViolation(v.accept(call(1, 0)));
    const w = make(false);
    expectViolation(w.accept(envelope("catalog", { requestId: 1, op: "search", query: "x" }, 0)));
    expect(make(false).accept(output("fine", 0)).ok).toBe(true);
  });

  it("bounds a message to 256 KiB serialized", () => {
    const overhead = JSON.stringify(output("", 0)).length;
    expect(make().accept(output("a".repeat(MAX_BYTES - overhead), 0)).ok).toBe(true);
    expectViolation(make().accept(output("a".repeat(MAX_BYTES - overhead + 1), 0)));
  });

  it("counts the size in bytes, not characters", () => {
    const overhead = JSON.stringify(output("", 0)).length;
    const chars = Math.floor((MAX_BYTES - overhead) / 3) + 1;
    expectViolation(make().accept(output("€".repeat(chars), 0)));
  });

  it("bounds JSON depth to 32 levels counting the envelope", () => {
    const state = (levels: number) => envelope("state.set", { key: "k", value: nest(levels) }, 0);
    // envelope (1) + payload (2) + value nesting
    expect(make().accept(state(30)).ok).toBe(true);
    expectViolation(make().accept(state(31)));
  });

  it("rejects the forbidden keys at any depth", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const top = JSON.parse(
        `{"protocol":1,"type":"complete","seq":0,"payload":{"value":{"${key}":1}}}`,
      );
      expectViolation(make().accept(top));
      const deep = JSON.parse(
        `{"protocol":1,"type":"state.set","seq":0,"payload":{"key":"k","value":[{"a":{"${key}":null}}]}}`,
      );
      expectViolation(make().accept(deep));
    }
  });

  it("rejects values that are not JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class Box {
      v = 1;
    }
    const bad: unknown[] = [
      undefined,
      () => 1,
      Symbol("s"),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      new Map(),
      new Box(),
      cyclic,
    ];
    for (const value of bad) {
      expectViolation(make().accept(envelope("state.set", { key: "k", value: [value] }, 0)));
    }
  });

  it("rejects every message after a terminal one", () => {
    for (const terminal of [
      envelope("complete", {}, 0),
      envelope("fatal", { code: "SCRIPT_RUNTIME", message: "boom" }, 0),
    ]) {
      const v = make();
      expect(v.accept(terminal).ok).toBe(true);
      expectViolation(v.accept(output("late", 1)));
    }
  });

  it("rejects messages after the host closed the channel and after a violation", () => {
    const closed = make();
    closed.close();
    expectViolation(closed.accept(output("late", 0)));

    const poisoned = make();
    expectViolation(poisoned.accept(envelope("exec", {}, 0)));
    expectViolation(poisoned.accept(output("after", 1)));
  });

  it("M2: a tool name over 128 characters, empty or outside [a-zA-Z0-9_-]{1,64} is a violation", () => {
    const named = (tool: string) => envelope("call", { callId: 1, tool, input: {} }, 1);
    for (const tool of ["x".repeat(129), "x".repeat(65), "", "a b", "a/b", "caf\u00e9", "a\nb"])
      expectViolation(make().accept(named(tool)));
    expect(make().accept(named("x".repeat(64))).ok).toBe(true);
    expect(make().accept(named("mcp_a-b_C9")).ok).toBe(true);
  });
});
