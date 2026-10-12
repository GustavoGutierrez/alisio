/**
 * A hostile or broken guest (FJ-AC-12): the host validates every message regardless of what the
 * prelude would have sent. The "guest" here is a scripted isolate that speaks the protocol badly;
 * the kernel, engine, validator and broker are the real ones. No tool may run on a violation.
 */
import type { ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { PRELUDE_HASH } from "../packages/core/src/forge/javascript/prelude.ts";
import type {
  IsolateHost,
  IsolateSession,
  TerminationReason,
} from "../packages/core/src/forge/ports.ts";
import { kernelFixture } from "./forge-kernel-helpers.ts";

type Emit = (message: unknown) => void;
const envelope = (type: string, seq: number, payload: unknown) => ({
  protocol: 1,
  type,
  seq,
  payload,
});

/** An isolate that, once the host sends `start`, plays `script` and records how it was stopped. */
function scriptedHost(script: (emit: Emit, started: () => void) => void) {
  const stops: TerminationReason[] = [];
  const factory = (): IsolateHost => ({
    kind: "worker",
    start(): IsolateSession {
      let handler: (raw: unknown) => void = () => {};
      let exitResolve: (value: { code: number; signal: null }) => void = () => {};
      const exited = new Promise<{ code: number; signal: null }>((resolve) => {
        exitResolve = resolve;
      });
      queueMicrotask(() =>
        handler(envelope("ready", 0, { engine: "javascript-quickjs", preludeHash: PRELUDE_HASH })),
      );
      return {
        kind: "worker",
        onMessage(next) {
          handler = next;
        },
        onStreamError() {},
        send(message) {
          if ((message as { type?: string }).type === "start")
            setTimeout(
              () =>
                script(
                  (m) => handler(m),
                  () => {},
                ),
              5,
            );
        },
        exited,
        async stop(reason) {
          stops.push(reason);
          exitResolve({ code: 0, signal: null });
          return { confirmed: true, method: "terminate", elapsedMs: 0 };
        },
      };
    },
  });
  return { factory, stops };
}

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

function sentinel() {
  const ran: string[] = [];
  const tool: ToolDefinition = {
    name: "sentinel",
    description: "records that it ran",
    effect: "read",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      ran.push("sentinel");
      return { content: [{ type: "text", text: "ran" }] };
    },
  };
  return { ran, tool };
}

async function play(script: (emit: Emit) => void) {
  const { ran, tool } = sentinel();
  const host = scriptedHost((emit) => script(emit));
  const fx = await kernelFixture({ isolateHost: host.factory, tools: [tool] });
  fixtures.push(fx);
  const result = await fx.run("return 1;");
  return { result, ran, stops: host.stops, fx };
}

describe("FJ-AC-12: protocol violations end the execution and run nothing", () => {
  it("a message over 256 KiB", async () => {
    const { result, ran, stops } = await play((emit) => {
      emit(envelope("output", 1, { type: "text", text: "x".repeat(300_000) }));
      emit(envelope("call", 2, { callId: 1, tool: "sentinel", input: {} }));
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("PROTOCOL_VIOLATION");
    expect(ran).toEqual([]);
    expect(stops).toContain("protocol_violation");
  });

  it("a repeated or regressing sequence number", async () => {
    const { result, ran } = await play((emit) => {
      emit(envelope("progress", 1, { message: "a" }));
      emit(envelope("call", 1, { callId: 1, tool: "sentinel", input: {} }));
    });
    expect(result.error?.code).toBe("PROTOCOL_VIOLATION");
    expect(ran).toEqual([]);
  });

  it("forbidden keys in a payload", async () => {
    const { result } = await play((emit) => {
      emit(envelope("state.set", 1, { key: "k", value: JSON.parse('{"__proto__": {"x": 1}}') }));
    });
    expect(result.error?.code).toBe("PROTOCOL_VIOLATION");
    expect(result.error?.message).toMatch(/forbidden key/);
  });

  it("an unknown message type and a payload that does not match its type", async () => {
    const unknown = await play((emit) => emit(envelope("shell", 1, { command: "id" })));
    expect(unknown.result.error?.code).toBe("PROTOCOL_VIOLATION");
    const malformed = await play((emit) => emit(envelope("call", 1, { callId: "one", tool: 3 })));
    expect(malformed.result.error?.code).toBe("PROTOCOL_VIOLATION");
    expect(malformed.ran).toEqual([]);
  });

  it("JSON nested deeper than 32 levels", async () => {
    const deep = Array.from({ length: 40 }).reduce<unknown>((inner) => ({ inner }), 1);
    const { result } = await play((emit) =>
      emit(envelope("state.set", 1, { key: "k", value: deep })),
    );
    expect(result.error?.code).toBe("PROTOCOL_VIOLATION");
  });

  it("anything after the terminal message is dropped and runs nothing", async () => {
    const { result, ran } = await play((emit) => {
      emit(envelope("complete", 1, { value: 7 }));
      emit(envelope("call", 2, { callId: 1, tool: "sentinel", input: {} }));
    });
    expect(result.status).toBe("succeeded");
    expect(result.value).toBe(7);
    expect(ran).toEqual([]);
  });

  it("a call without a granted credit ends the execution (the host keeps its own count)", async () => {
    const { result, ran } = await play((emit) => {
      // The kernel grants credits on `ready`; spend more than were granted at once.
      for (let i = 1; i <= 10; i++)
        emit(envelope("call", i, { callId: i, tool: "sentinel", input: {} }));
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BUDGET_EXCEEDED");
    expect(ran.length).toBeLessThanOrEqual(4);
  });

  it("a prelude the host does not recognise is refused before it can start anything", async () => {
    const { ran } = sentinel();
    const stops: string[] = [];
    const fx = await kernelFixture({
      isolateHost: () => ({
        kind: "worker",
        start() {
          let handler: (raw: unknown) => void = () => {};
          queueMicrotask(() =>
            handler(
              envelope("ready", 0, { engine: "javascript-quickjs", preludeHash: "0".repeat(64) }),
            ),
          );
          return {
            kind: "worker",
            onMessage(next) {
              handler = next;
            },
            onStreamError() {},
            send() {},
            exited: new Promise(() => {}),
            async stop(reason) {
              stops.push(reason);
              return { confirmed: true, method: "terminate", elapsedMs: 0 };
            },
          };
        },
      }),
    });
    fixtures.push(fx);
    const result = await fx.run("return 1;");
    expect(result.error?.code).toBe("PROTOCOL_VIOLATION");
    expect(ran).toEqual([]);
    expect(stops).toContain("protocol_violation");
  });

  it("a broken byte stream (oversized or malformed frame) is a protocol violation and stops the isolate", async () => {
    const stops: TerminationReason[] = [];
    const fx = await kernelFixture({
      isolateHost: () => ({
        kind: "process",
        start(): IsolateSession {
          let streamError: (reason: string) => void = () => {};
          setTimeout(() => streamError("frame of 9000000 bytes exceeds the 266240 limit"), 5);
          return {
            kind: "process",
            onMessage() {},
            onStreamError(handler) {
              streamError = handler;
            },
            send() {},
            exited: new Promise(() => {}),
            async stop(reason) {
              stops.push(reason);
              return { confirmed: true, method: "kill", elapsedMs: 0 };
            },
          };
        },
      }),
    });
    fixtures.push(fx);
    const result = await fx.run("return 1;");
    expect(result.error?.code).toBe("PROTOCOL_VIOLATION");
    expect(result.error?.message).toMatch(/exceeds/);
    expect(stops).toContain("protocol_violation");
  });

  it("an isolate that dies without a terminal message is an ISOLATE_FAILURE", async () => {
    const fx = await kernelFixture({
      isolateHost: () => ({
        kind: "worker",
        start() {
          let handler: (raw: unknown) => void = () => {};
          const exited = Promise.resolve({ code: 1, signal: null });
          queueMicrotask(() =>
            handler(
              envelope("ready", 0, { engine: "javascript-quickjs", preludeHash: PRELUDE_HASH }),
            ),
          );
          return {
            kind: "worker",
            onMessage(next) {
              handler = next;
            },
            onStreamError() {},
            send() {},
            exited,
            async stop() {
              return { confirmed: true, method: "terminate", elapsedMs: 0 };
            },
          };
        },
      }),
    });
    fixtures.push(fx);
    const result = await fx.run("return 1;");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ISOLATE_FAILURE");
  });
});

describe("security review: what a hostile guest can make the host store or decide", () => {
  const finishLater = (emit: Emit, seq: number) =>
    setTimeout(() => emit(envelope("complete", seq, {})), 60);

  it("M2: an unknown tool name is answered TOOL_UNAVAILABLE and its raw text is never journaled or broadcast", async () => {
    const secret = "totally_unknown_tool_name_xyz";
    const { result, fx } = await play((emit) => {
      emit(envelope("call", 1, { callId: 1, tool: secret, input: {} }));
      finishLater(emit, 2);
    });
    expect(result.status).toBe("succeeded");
    expect(result.calls.failed).toBe(1);
    const rows = fx.journal.calls(result.executionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolName).not.toContain(secret);
    expect(rows[0]?.toolName).toMatch(/^unknown:[0-9a-f]{12}$/);
    expect(rows[0]?.errorCode).toBe("TOOL_UNAVAILABLE");
    expect(JSON.stringify(fx.progress)).not.toContain(secret);
  });

  it("M2: a registered tool keeps its own name in the journal and the progress", async () => {
    const { result, fx } = await play((emit) => {
      emit(envelope("call", 1, { callId: 1, tool: "sentinel", input: {} }));
      finishLater(emit, 2);
    });
    expect(fx.journal.calls(result.executionId)[0]?.toolName).toBe("sentinel");
    expect(JSON.stringify(fx.progress)).toContain("sentinel");
  });

  it.each(["CANCELLED", "TIMEOUT"])(
    "M3: a guest that reports %s without the host having stopped it fails with SCRIPT_RUNTIME",
    async (code) => {
      const { result } = await play((emit) =>
        emit(envelope("fatal", 1, { code, message: "mine" })),
      );
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("SCRIPT_RUNTIME");
    },
  );

  it("L4: progress text is cut to 500 characters and only the first 10,000 messages are kept", async () => {
    const { result, fx } = await play((emit) => {
      for (let i = 1; i <= 10_050; i++)
        emit(envelope("progress", i, { message: i === 1 ? "p".repeat(5000) : "tick" }));
      finishLater(emit, 10_051);
    });
    expect(result.status).toBe("succeeded");
    const messages = fx.progress
      .map((event) => (event as { message?: string }).message)
      .filter((m): m is string => typeof m === "string");
    expect(Math.max(...messages.map((m) => m.length))).toBeLessThanOrEqual(500);
    const row = fx.journal.get(result.executionId);
    expect(row?.metrics?.progressDropped).toBe(50);
  });

  it("L2: a timed-out isolate that never confirms it is gone still ends the run, is journaled as unconfirmed and keeps its slot only until settled", async () => {
    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const fx = await kernelFixture({
      isolateHost: () => ({
        kind: "worker",
        start(): IsolateSession {
          let handler: (raw: unknown) => void = () => {};
          queueMicrotask(() =>
            handler(
              envelope("ready", 0, { engine: "javascript-quickjs", preludeHash: PRELUDE_HASH }),
            ),
          );
          return {
            kind: "worker",
            onMessage(next) {
              handler = next;
            },
            onStreamError() {},
            send() {},
            exited: new Promise(() => {}),
            async stop() {
              return { confirmed: false, method: "kill", elapsedMs: 5, settled };
            },
          };
        },
      }),
    });
    fixtures.push(fx);
    const outcome = await Promise.race([
      fx.run("return 1;", { requestedLimits: { timeoutMs: 100 } }),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5000)),
    ]);
    expect(outcome).not.toBe("hung");
    const result = outcome as Exclude<typeof outcome, "hung">;
    expect(result.status).toBe("timed_out");
    expect(fx.journal.get(result.executionId)?.terminationUnconfirmed).toBe(true);
    expect(fx.slots.active).toBe(1);
    settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fx.slots.active).toBe(0);
  }, 15_000);

  it("L2: an unconfirmed stop with nothing to wait for releases the slot at once", async () => {
    const fx = await kernelFixture({
      isolateHost: () => ({
        kind: "worker",
        start(): IsolateSession {
          let handler: (raw: unknown) => void = () => {};
          queueMicrotask(() =>
            handler(
              envelope("ready", 0, { engine: "javascript-quickjs", preludeHash: PRELUDE_HASH }),
            ),
          );
          return {
            kind: "worker",
            onMessage(next) {
              handler = next;
            },
            onStreamError() {},
            send() {},
            exited: new Promise(() => {}),
            async stop() {
              return { confirmed: false, method: "kill", elapsedMs: 5 };
            },
          };
        },
      }),
    });
    fixtures.push(fx);
    const result = await fx.run("return 1;", { requestedLimits: { timeoutMs: 100 } });
    expect(result.status).toBe("timed_out");
    expect(fx.journal.get(result.executionId)?.terminationUnconfirmed).toBe(true);
    expect(fx.slots.active).toBe(0);
  }, 15_000);
});
