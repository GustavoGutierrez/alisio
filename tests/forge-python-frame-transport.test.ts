/**
 * `StdoutFrameTransport` (Python spec §7, PD9): frames are untrusted guest messages. Only the
 * common protocol without tool calls gets through, in order, within the message budget; ordinary
 * output passes untouched. FP-AC-18 at this boundary.
 */
import { describe, expect, it } from "vitest";
import { type ForgeError } from "../packages/core/src/forge/errors.ts";
import type { GuestMessage } from "../packages/core/src/forge/protocol.ts";
import { framePrefix, MAX_FRAME_CHARS } from "../packages/core/src/forge/python/frame-parser.ts";
import { StdoutFrameTransport } from "../packages/core/src/forge/python/frame-transport.ts";

const NONCE = "00112233445566778899aabbccddeeff";
const line = (type: string, payload: unknown, seq: number) =>
  `${framePrefix(NONCE)}${JSON.stringify({ protocol: 1, type, seq, payload })}\n`;

function setup(options: { receive?: (m: GuestMessage) => Promise<unknown> } = {}) {
  const received: GuestMessage[] = [];
  const text: string[] = [];
  const failures: ForgeError[] = [];
  const transport = new StdoutFrameTransport({
    nonce: NONCE,
    receive: async (message) => {
      received.push(message);
      return options.receive?.(message);
    },
    onText: (chunk) => text.push(chunk),
    onFailure: (error) => failures.push(error),
  });
  return { transport, received, text, failures };
}

describe("StdoutFrameTransport", () => {
  it("delivers progress, output and state messages in order and passes other output through", async () => {
    const t = setup();
    t.transport.feed(`start\n${line("progress", { message: "a", completed: 1, total: 2 }, 0)}`);
    t.transport.feed(
      `${line("output", { type: "text", text: "hi" }, 1)}${line("state.set", { key: "k", value: 7 }, 2)}mid\n`,
    );
    t.transport.feed(line("state.delete", { key: "old" }, 3));
    await t.transport.end();
    expect(t.received.map((m) => m.type)).toEqual([
      "progress",
      "output",
      "state.set",
      "state.delete",
    ]);
    expect(t.text.join("")).toBe("start\nmid\n");
    expect(t.failures).toEqual([]);
  });

  it("never lets a slow message overtake the next one", async () => {
    const order: string[] = [];
    const t = setup({
      receive: async (message) => {
        if (message.type === "progress") await new Promise((r) => setTimeout(r, 30));
        order.push(message.type);
      },
    });
    t.transport.feed(
      line("progress", { message: "slow" }, 0) + line("output", { type: "text", text: "x" }, 1),
    );
    await t.transport.end();
    expect(order).toEqual(["progress", "output"]);
  });

  it("a frame with another nonce is plain output and authorizes nothing", async () => {
    const t = setup();
    const fake = `${framePrefix("ffffffffffffffffffffffffffffffff")}{"protocol":1,"type":"complete","seq":0,"payload":{}}\n`;
    t.transport.feed(fake);
    await t.transport.end();
    expect(t.received).toEqual([]);
    expect(t.text.join("")).toBe(fake);
    expect(t.transport.completion).toBeUndefined();
  });

  it.each([
    ["a tool call", line("call", { callId: 0, tool: "read_file", input: {} }, 0)],
    ["a catalog lookup", line("catalog", { requestId: 0, op: "search", query: "x" }, 0)],
    ["a message of an unknown type", line("grant", { calls: 1, bytes: 1 }, 0)],
    ["malformed JSON", `${framePrefix(NONCE)}{not json\n`],
    ["a payload that does not fit its type", line("progress", { message: 5 }, 0)],
  ])("%s is a PROTOCOL_VIOLATION that ends the execution once", async (_name, frame) => {
    const t = setup();
    t.transport.feed(frame);
    t.transport.feed(line("progress", { message: "after" }, 1));
    await t.transport.end();
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]?.code).toBe("PROTOCOL_VIOLATION");
    expect(t.received).toEqual([]);
  });

  it("a repeated or regressing seq is a violation", async () => {
    const t = setup();
    t.transport.feed(line("progress", { message: "a" }, 4) + line("progress", { message: "b" }, 4));
    await t.transport.end();
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]?.code).toBe("PROTOCOL_VIOLATION");
    expect(t.failures[0]?.message).toMatch(/not increasing/);
  });

  it("a frame over 256 KiB is a violation, without buffering it", async () => {
    const t = setup();
    t.transport.feed(framePrefix(NONCE));
    t.transport.feed("x".repeat(MAX_FRAME_CHARS + 1));
    t.transport.feed("\n");
    await t.transport.end();
    expect(t.failures[0]?.code).toBe("PROTOCOL_VIOLATION");
  });

  it("a JSON value deeper than 32 levels is a violation", async () => {
    const t = setup();
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { a: deep };
    t.transport.feed(line("state.set", { key: "k", value: deep }, 0));
    await t.transport.end();
    expect(t.failures[0]?.code).toBe("PROTOCOL_VIOLATION");
  });

  it("past 1000 messages the rest is ignored with one warning and the run goes on", async () => {
    const t = setup();
    for (let i = 0; i < 1500; i++) t.transport.feed(line("progress", { message: `m${i}` }, i));
    await t.transport.end();
    expect(t.received).toHaveLength(1000);
    expect(t.failures).toEqual([]);
    expect(t.transport.warnings).toHaveLength(1);
    expect(t.transport.warnings[0]).toMatch(/1000/);
  });

  it("a message the kernel refuses ends the execution with the kernel's code and stops delivering", async () => {
    const { ForgeError } = await import("../packages/core/src/forge/errors.ts");
    const t = setup({
      receive: async (message) => {
        if (message.type === "state.set") throw new ForgeError("BUDGET_EXCEEDED", "too much state");
      },
    });
    t.transport.feed(line("state.set", { key: "k", value: 1 }, 0));
    t.transport.feed(line("progress", { message: "later" }, 1));
    await t.transport.end();
    expect(t.failures.map((f) => f.code)).toEqual(["BUDGET_EXCEEDED"]);
    expect(t.received.map((m) => m.type)).toEqual(["state.set"]);
  });

  it("keeps the final value of `complete`, and refuses anything after it", async () => {
    const t = setup();
    t.transport.feed(line("complete", { value: { best: 0.9 } }, 0));
    await t.transport.end();
    expect(t.transport.completion).toEqual({ value: { best: 0.9 } });
    expect(t.failures).toEqual([]);

    const late = setup();
    late.transport.feed(line("complete", {}, 0) + line("progress", { message: "x" }, 1));
    await late.transport.end();
    expect(late.failures[0]?.code).toBe("PROTOCOL_VIOLATION");
  });

  it("keeps a guest `fatal` for the engine without forwarding it", async () => {
    const t = setup();
    t.transport.feed(line("fatal", { code: "SCRIPT_RUNTIME", message: "bad" }, 0));
    await t.transport.end();
    expect(t.transport.fatal).toEqual({ code: "SCRIPT_RUNTIME", message: "bad" });
    expect(t.received).toEqual([]);
    expect(t.failures).toEqual([]);
  });

  it("flushes an unterminated final frame at the end of the stream", async () => {
    const t = setup();
    t.transport.feed(line("progress", { message: "a" }, 0).trimEnd());
    await t.transport.end();
    expect(t.received).toHaveLength(1);
  });
});
