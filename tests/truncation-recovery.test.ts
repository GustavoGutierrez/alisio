import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Message,
  OutputTruncatedError,
  type ProviderEvent,
  type RunEvent,
  type ToolCall,
  textResult,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import {
  incompleteCalls,
  isOutputTruncationError,
  lowerEffort,
  TRUNCATION_NOTICE,
} from "../packages/core/src/core/truncation.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

type Assistant = Extract<Message, { role: "assistant" }>;
type Reply =
  | { message: Assistant }
  | { throws: Error }
  | ((request: Request) => { message: Assistant } | { throws: Error });
interface Request {
  messages: Message[];
  reasoningEffort?: string;
  maxOutputTokens: number;
}

const assistant = (text: string, calls: ToolCall[] = [], truncated = false): Assistant => ({
  role: "assistant",
  text,
  calls,
  ...(truncated ? { truncated } : {}),
});
const call = (id: string, args: string, name = "work"): ToolCall => ({ id, name, arguments: args });
const LEGACY =
  "Provider response cut off by max output tokens before any usable content; raise limits.maxOutputTokens (/settings → Agent max output tokens)";

async function harness(
  replies: Reply[],
  settings: {
    truncationRecoveries?: number;
    maxTurns?: number;
    reasoningEffort?: string;
    effortLevels?: { supportedLevels: string[]; defaultLevel?: string };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "alisio-recovery-"));
  const store = new SQLiteStore(join(root, "store.sqlite"));
  const executed: string[] = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "work",
    effect: "read",
    description: "work",
    inputSchema: { type: "object" },
    async execute(input: Record<string, unknown>) {
      executed.push(JSON.stringify(input));
      return textResult("done");
    },
  });
  const requests: Request[] = [];
  const events: RunEvent[] = [];
  const provider = {
    id: "fake",
    model: "fake-model",
    async *stream(request: Request): AsyncGenerator<ProviderEvent> {
      requests.push({
        messages: structuredClone(request.messages),
        maxOutputTokens: request.maxOutputTokens,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
      });
      const next = replies[requests.length - 1];
      if (!next) throw new Error("no more scripted replies");
      const reply = typeof next === "function" ? next(request) : next;
      if ("throws" in reply) throw reply.throws;
      yield { type: "completed", message: reply.message };
    },
  };
  const runner = new AgentRunner({
    provider: provider as never,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    onEvent: (event) => events.push(event),
    maxOutputTokens: 1234,
    // The config default.
    truncationRecoveries: settings.truncationRecoveries ?? 2,
    ...(settings.maxTurns !== undefined ? { maxTurns: settings.maxTurns } : {}),
    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    ...(settings.effortLevels ? { effortLevels: () => settings.effortLevels } : {}),
  });
  const session = store.create(root, "fake", "fake-model");
  return {
    runner,
    store,
    events,
    executed,
    requests,
    session,
    stored: () => store.messages(session.id),
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Every persisted tool call has exactly one result, and no result is orphaned. */
function expectConsistent(messages: Message[]) {
  const called = messages.flatMap((m) => (m.role === "assistant" ? m.calls.map((c) => c.id) : []));
  const answered = messages.flatMap((m) => (m.role === "tool" ? [m.callId] : []));
  expect(answered.sort()).toEqual(called.sort());
}

const lastUser = (request: Request | undefined) => {
  const last = request?.messages.at(-1);
  return last?.role === "user" ? last.text : undefined;
};

describe("recovery from a response cut off by the output limit", () => {
  it("discards a half tool call, never executes it, and completes on the next response", async () => {
    const fx = await harness(
      [
        { message: assistant("", [call("c1", '{"script":"print(1')], true) },
        { message: assistant("", [call("c2", '{"ok":true}')]) },
        { message: assistant("all done") },
      ],
      { maxTurns: 2 },
    );
    try {
      const result = await fx.runner.run(fx.session.id, "build the dashboard");
      expect(result).toMatchObject({ status: "completed", text: "all done" });
      expect(fx.executed).toEqual(['{"ok":true}']);
      // The truncated call id never reaches the store; everything persisted is consistent.
      const stored = fx.stored();
      expect(JSON.stringify(stored)).not.toContain("c1");
      expectConsistent(stored);
      // maxTurns: 2 is enough for the real turns (tool turn + final turn): the recovery is free.
      expect(fx.events.some((e) => e.type === "run_turns_exceeded")).toBe(false);
      const recovery = fx.events.filter((e) => e.type === "truncation_recovery");
      expect(recovery).toHaveLength(1);
      expect(recovery[0]?.data).toMatchObject({
        attempt: 1,
        of: 2,
        reason: "tool_call_cut",
        maxOutputTokens: 1234,
      });
      // Only the recovery request carries the continuation notice, and it is never persisted.
      expect(lastUser(fx.requests[0])).toBe("build the dashboard");
      expect(lastUser(fx.requests[1])).toBe(TRUNCATION_NOTICE);
      expect(TRUNCATION_NOTICE).toMatch(/cut off/);
      expect(TRUNCATION_NOTICE).toMatch(/Do not repeat/);
      expect(lastUser(fx.requests[2])).not.toBe(TRUNCATION_NOTICE);
      expect(JSON.stringify(stored)).not.toContain("output-token limit");
      // No new turn was reported for the discarded response.
      expect(fx.events.filter((e) => e.type === "turn_completed")).toHaveLength(2);
    } finally {
      await fx.close();
    }
  });

  it("keeps the visible text of the cut response as an assistant message without the calls", async () => {
    const fx = await harness([
      { message: assistant("Let me write the script", [call("c1", '{"a":')], true) },
      { message: assistant("finished") },
    ]);
    try {
      expect((await fx.runner.run(fx.session.id, "go")).status).toBe("completed");
      const stored = fx.stored();
      expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
      expect(stored[1]).toMatchObject({ text: "Let me write the script", calls: [] });
      expectConsistent(stored);
    } finally {
      await fx.close();
    }
  });

  it("recovers an empty truncated response (reasoning exhausted) with one lower effort level", async () => {
    const fx = await harness([{ message: assistant("", [], true) }, { message: assistant("ok") }], {
      reasoningEffort: "high",
      effortLevels: { supportedLevels: ["low", "medium", "high"], defaultLevel: "medium" },
    });
    try {
      expect((await fx.runner.run(fx.session.id, "go")).status).toBe("completed");
      expect(fx.requests[0]?.reasoningEffort).toBe("high");
      expect(fx.requests[1]?.reasoningEffort).toBe("medium");
      expect(fx.events.find((e) => e.type === "truncation_recovery")?.data).toMatchObject({
        reason: "empty_response",
        effort: "medium",
      });
    } finally {
      await fx.close();
    }
  });

  it("leaves the effort alone when the model's levels are unknown", async () => {
    const fx = await harness([{ message: assistant("", [], true) }, { message: assistant("ok") }], {
      reasoningEffort: "high",
    });
    try {
      await fx.runner.run(fx.session.id, "go");
      expect(fx.requests[1]?.reasoningEffort).toBe("high");
      expect(fx.events.find((e) => e.type === "truncation_recovery")?.data).not.toHaveProperty(
        "effort",
      );
    } finally {
      await fx.close();
    }
  });

  it("recovers the legacy plugin error and the typed signal the same way", async () => {
    for (const error of [new Error(LEGACY), new OutputTruncatedError()]) {
      const fx = await harness([{ throws: error }, { message: assistant("ok") }]);
      try {
        expect((await fx.runner.run(fx.session.id, "go")).status).toBe("completed");
        expect(fx.events.filter((e) => e.type === "truncation_recovery")).toHaveLength(1);
        expect(lastUser(fx.requests[1])).toBe(TRUNCATION_NOTICE);
        expect(fx.stored().map((m) => m.role)).toEqual(["user", "assistant"]);
      } finally {
        await fx.close();
      }
    }
  });

  it("fails readably after the recoveries are exhausted and leaves a consistent session", async () => {
    const fx = await harness(
      [
        { message: assistant("", [call("c1", '{"a":')], true) },
        { throws: new Error(LEGACY) },
        { message: assistant("", [call("c3", "{")], true) },
        { message: assistant("never requested") },
      ],
      { truncationRecoveries: 2 },
    );
    try {
      const error = await fx.runner.run(fx.session.id, "go").catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/3 times/);
      expect(message).toContain("1234 tokens, set by you");
      expect(message).toContain("fake-model");
      expect(message).toContain("limits.maxOutputTokens");
      expect(message).toContain("/effort");
      expect(message).not.toContain("usable content");
      expect(fx.requests).toHaveLength(3);
      expect(fx.executed).toEqual([]);
      const failed = fx.events.find((e) => e.type === "run_failed");
      expect(failed?.data).toMatchObject({
        code: "output_truncated",
        error: message,
        truncation: {
          attempts: 3,
          maxOutputTokens: 1234,
          model: "fake-model",
          source: "user",
        },
      });
      expect(fx.events.filter((e) => e.type === "truncation_recovery")).toHaveLength(2);
      expectConsistent(fx.stored());
      expect(fx.store.runs(fx.session.id)[0]?.status).toBe("failed");
    } finally {
      await fx.close();
    }
  });

  it("does not recover when limits.truncationRecoveries is 0, but still fails readably", async () => {
    const fx = await harness([{ throws: new Error(LEGACY) }, { message: assistant("no") }], {
      truncationRecoveries: 0,
    });
    try {
      await expect(fx.runner.run(fx.session.id, "go")).rejects.toThrow(/once by the output-token/);
      expect(fx.requests).toHaveLength(1);
      expect(fx.events.some((e) => e.type === "truncation_recovery")).toBe(false);
      expect(fx.events.find((e) => e.type === "run_failed")?.data).toMatchObject({
        code: "output_truncated",
      });
    } finally {
      await fx.close();
    }
  });

  it("keeps a truncated answer with usable text and no calls as a completed, flagged run", async () => {
    const fx = await harness([{ message: assistant("a long partial answer", [], true) }]);
    try {
      const result = await fx.runner.run(fx.session.id, "go");
      expect(result).toMatchObject({ status: "completed", text: "a long partial answer" });
      expect(fx.requests).toHaveLength(1);
      expect(fx.events.some((e) => e.type === "response_truncated")).toBe(true);
      expect(fx.events.some((e) => e.type === "truncation_recovery")).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it("does not discard complete tool calls of a response cut after them", async () => {
    const fx = await harness([
      { message: assistant("", [call("c1", '{"n":1}'), call("c2", "{}")], true) },
      { message: assistant("fin") },
    ]);
    try {
      expect((await fx.runner.run(fx.session.id, "go")).status).toBe("completed");
      expect(fx.executed).toEqual(['{"n":1}', "{}"]);
      expect(fx.events.some((e) => e.type === "truncation_recovery")).toBe(false);
      expectConsistent(fx.stored());
    } finally {
      await fx.close();
    }
  });

  it("discards ALL calls of a response when any one of them is cut", async () => {
    const fx = await harness([
      { message: assistant("", [call("c1", '{"n":1}'), call("c2", '{"big":"abc')], true) },
      { message: assistant("fin") },
    ]);
    try {
      expect((await fx.runner.run(fx.session.id, "go")).status).toBe("completed");
      expect(fx.executed).toEqual([]);
      expectConsistent(fx.stored());
    } finally {
      await fx.close();
    }
  });

  it("a stop during the recovery is a cancellation, not a truncation failure", async () => {
    const controller = new AbortController();
    const fx = await harness([
      () => {
        queueMicrotask(() => controller.abort(new Error("stopped by user")));
        return { throws: new Error(LEGACY) };
      },
      { message: assistant("never") },
    ]);
    try {
      await expect(fx.runner.run(fx.session.id, "go", controller.signal)).rejects.toThrow();
      expect(fx.requests).toHaveLength(1);
      expect(fx.events.some((e) => e.type === "run_cancelled")).toBe(true);
      expect(fx.events.some((e) => e.type === "run_failed")).toBe(false);
    } finally {
      await fx.close();
    }
  });
});

describe("truncation helpers", () => {
  it("recognises the typed signal and the legacy message, and nothing else", () => {
    expect(isOutputTruncationError(new OutputTruncatedError())).toBe(true);
    expect(
      isOutputTruncationError(Object.assign(new Error("x"), { code: "output_truncated" })),
    ).toBe(true);
    expect(isOutputTruncationError(new Error(LEGACY))).toBe(true);
    expect(isOutputTruncationError(new Error("Provider refusal: no"))).toBe(false);
    expect(isOutputTruncationError(undefined)).toBe(false);
  });

  it("judges calls: invalid or non-object JSON and a bare last call are incomplete", () => {
    expect(incompleteCalls([call("a", "{}"), call("b", '{"x":[1,2]}')])).toBe(false);
    expect(incompleteCalls([call("a", ""), call("b", "{}")])).toBe(false);
    expect(incompleteCalls([call("a", "{}"), call("b", "")])).toBe(true);
    expect(incompleteCalls([call("a", '{"x":')])).toBe(true);
    expect(incompleteCalls([call("a", "[1]")])).toBe(true);
    expect(incompleteCalls([{ id: "", name: "work", arguments: "{}" }])).toBe(true);
  });

  it("lowers the effort one step only when it can tell which way is lower", () => {
    expect(lowerEffort("high", ["low", "medium", "high"])).toBe("medium");
    expect(lowerEffort("max", ["high", "low", "max"])).toBe("high");
    expect(lowerEffort("low", ["low", "medium", "high"])).toBeUndefined();
    expect(lowerEffort("high", ["fast", "slow"])).toBeUndefined();
    expect(lowerEffort("turbo", ["low", "high"])).toBeUndefined();
    expect(lowerEffort(undefined, ["low", "high"])).toBeUndefined();
    expect(lowerEffort("high", undefined)).toBeUndefined();
  });
});
