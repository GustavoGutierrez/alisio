import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekProvider } from "@alisio/plugin-deepseek";
import type { Message, RunEvent, ToolCall } from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { summarize } from "../packages/core/src/core/compaction.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const checkpoint = {
  checkpoint: {
    goal: "g",
    instructions: [],
    discoveries: [],
    accomplished: [],
    currentState: "s",
    nextSteps: [],
    relevantFiles: [],
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-truncation-"));
  const store = new SQLiteStore(join(root, "store.sqlite"));
  const registry = new ToolRegistry();
  registry.register({
    name: "hello",
    effect: "read",
    description: "hello",
    inputSchema: { type: "object" },
    async execute() {
      return textResult("world");
    },
  });
  return {
    root,
    store,
    registry,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const recorder = () => {
  const events: RunEvent[] = [];
  return { events, onEvent: (event: RunEvent) => events.push(event) };
};

const completed = (
  text: string,
  calls: ToolCall[] = [],
  truncated = false,
): Extract<Message, { role: "assistant" }> => ({
  role: "assistant",
  text,
  calls,
  ...(truncated ? { truncated } : {}),
});

describe("agent loop truncation signaling", () => {
  it("completes a truncated no-tool-call turn and flags it in run_completed", async () => {
    const fx = await fixture();
    try {
      let round = 0;
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          round++;
          yield { type: "text_delta", delta: "partial" };
          yield { type: "completed", message: completed("partial answer", [], true) };
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent,
      });
      const result = await runner.run(session.id, "test");
      expect(result.status).toBe("completed");
      expect(result.text).toBe("partial answer");
      expect(round).toBe(1);
      const warning = events.find((e) => e.type === "response_truncated");
      expect(warning).toBeDefined();
      expect(warning?.data).toMatchObject({ turn: 1 });
      const runCompleted = events.find((e) => e.type === "run_completed");
      expect(runCompleted?.data).toMatchObject({ text: "partial answer", truncated: true });
    } finally {
      await fx.close();
    }
  });

  it("continues tool calls from a truncated turn and only flags a truncated final turn", async () => {
    const fx = await fixture();
    try {
      let round = 0;
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          round++;
          if (round === 1)
            yield {
              type: "completed",
              message: completed(
                "using a tool",
                [{ id: "c1", name: "hello", arguments: "{}" }],
                true,
              ),
            };
          else yield { type: "completed", message: completed("done") };
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent,
      });
      const result = await runner.run(session.id, "test");
      expect(result.status).toBe("completed");
      expect(result.text).toBe("done");
      expect(round).toBe(2);
      expect(events.some((e) => e.type === "response_truncated")).toBe(false);
      const runCompleted = events.find((e) => e.type === "run_completed");
      expect(runCompleted?.data).toMatchObject({ text: "done" });
      expect((runCompleted?.data as Record<string, unknown>).truncated).toBeUndefined();
    } finally {
      await fx.close();
    }
  });
});

describe("agent loop auto-compaction metric", () => {
  const lots = () => "x".repeat(300);
  const provider = {
    id: "test",
    model: "test",
    async *stream() {
      yield { type: "text_delta", delta: "ok" };
      yield { type: "completed", message: completed("ok") };
    },
  };

  async function runWith(options: {
    contextWindow?: number;
    maxContextChars?: number;
    historyChars: number;
  }) {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test");
      // Fill history until it exceeds the target char size (each ~300 chars + JSON overhead).
      let size = 0;
      for (let i = 0; size < options.historyChars; i++) {
        const text = `chunk ${i} ${lots()}`;
        fx.store.append(session.id, { role: "user", text });
        fx.store.append(session.id, { role: "assistant", text: `a${i} ${lots()}`, calls: [] });
        size += text.length * 2 + 200;
      }
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        contextWindow: options.contextWindow ? () => options.contextWindow : undefined,
        maxContextChars: options.maxContextChars,
        onEvent,
      });
      await runner.run(session.id, "test");
      return events;
    } finally {
      await fx.close();
    }
  }

  it("compacts on the char-budget fallback when the window is unknown", async () => {
    // ~6k chars (~1500 est. tokens) vs a 4k-char budget (~1000 tokens): the fallback fires.
    const events = await runWith({ historyChars: 6_000, maxContextChars: 4_000 });
    expect(events.some((e) => e.type === "compaction_started")).toBe(true);
  });

  it("does NOT compact on the char budget when a large window is known (DeepSeek case)", async () => {
    // ~6k chars (~1500 tokens) far below 85% of the 1M window (850k tokens); the known window
    // disables the char fallback, so nothing compacts early. The bar shows the same 0% it
    // measured against, instead of compacting invisibly.
    const events = await runWith({
      historyChars: 6_000,
      maxContextChars: 100_000,
      contextWindow: 1_000_000,
    });
    expect(events.some((e) => e.type === "compaction_started")).toBe(false);
  });

  it("compacts at window * threshold even when the context is far below the char budget", async () => {
    const events = await runWith({
      historyChars: 20_000,
      maxContextChars: 100_000,
      contextWindow: 2_000, // 85% = 1700 tokens; ~5k tokens of history exceed it.
    });
    expect(events.some((e) => e.type === "compaction_started")).toBe(true);
  });
});

describe("compaction truncation handling", () => {
  const history = (): Message[] => [
    { role: "user", text: "first request" },
    { role: "assistant", text: "first answer", calls: [] },
    { role: "user", text: "second request" },
    { role: "assistant", text: "second answer", calls: [] },
  ];

  it("accepts a truncated-but-usable summary as a partial checkpoint", async () => {
    const fx = await fixture();
    try {
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          yield {
            type: "completed",
            message: completed(JSON.stringify(checkpoint), [], true),
          };
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      for (const message of history()) fx.store.append(session.id, message);
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent,
      });
      const result = await runner.compact(session.id);
      expect(result?.replaced).toBe(2);
      expect(events.some((e) => e.type === "compaction_completed" && (e.data as any).partial)).toBe(
        true,
      );
    } finally {
      await fx.close();
    }
  });

  it("fails with an actionable error when the truncated summary has nothing usable", async () => {
    const fx = await fixture();
    try {
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          throw new Error(
            "Provider response cut off by max output tokens before any usable content; raise limits.maxOutputTokens",
          );
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      for (const message of history()) fx.store.append(session.id, message);
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
      });
      await expect(runner.compact(session.id)).rejects.toThrow(/compaction\.maxOutputTokens/);
    } finally {
      await fx.close();
    }
  });

  it("also fails actionably when a stub provider completes truncated with empty text", async () => {
    const fx = await fixture();
    try {
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          yield { type: "completed", message: completed("", [], true) };
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      for (const message of history()) fx.store.append(session.id, message);
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
      });
      await expect(runner.compact(session.id)).rejects.toThrow(/compaction\.maxOutputTokens/);
      await expect(
        summarize(provider as any, {
          instructions: "summary",
          messages: history(),
          maxOutputTokens: 16000,
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow(/compaction\.maxOutputTokens/);
    } finally {
      await fx.close();
    }
  });

  it("uses compaction.maxOutputTokens for the summary, never the agent-loop budget", async () => {
    const fx = await fixture();
    try {
      let seen: number | undefined;
      const provider = {
        id: "test",
        model: "test",
        async *stream(request: { maxOutputTokens: number }) {
          seen = request.maxOutputTokens;
          yield { type: "completed", message: completed(JSON.stringify(checkpoint)) };
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      for (const message of history()) fx.store.append(session.id, message);
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxOutputTokens: 4096,
        compaction: { maxOutputTokens: 8000 },
      });
      await runner.compact(session.id);
      expect(seen).toBe(8000);
    } finally {
      await fx.close();
    }
  });

  it("falls back to the default summary budget when compaction.maxOutputTokens is unset", async () => {
    const fx = await fixture();
    try {
      let seen: number | undefined;
      const provider = {
        id: "test",
        model: "test",
        async *stream(request: { maxOutputTokens: number }) {
          seen = request.maxOutputTokens;
          yield { type: "completed", message: completed(JSON.stringify(checkpoint)) };
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      for (const message of history()) fx.store.append(session.id, message);
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxOutputTokens: 4096,
      });
      await runner.compact(session.id);
      expect(seen).toBe(4096);
    } finally {
      await fx.close();
    }
  });

  it("ends a run normally when the DeepSeek responses stream completes truncated after text", async () => {
    const fx = await fixture();
    try {
      const responsesClient = {
        responses: {
          async create() {
            return (async function* () {
              yield { type: "response.output_text.delta", delta: "partial " };
              yield { type: "response.output_text.delta", delta: "answer" };
              yield {
                type: "response.incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                response: {
                  output: [
                    { type: "message", content: [{ type: "output_text", text: "partial answer" }] },
                  ],
                },
              };
            })();
          },
        },
      };
      const deepseek = new DeepSeekProvider(
        {
          baseURL: "https://api.deepseek.com",
          apiKey: "fake",
          apiKeyEnv: "UNUSED",
          model: "deepseek-flash",
          apiMode: "responses",
          auth: "bearer",
          tokenParameter: "max_tokens",
          streamUsage: false,
        },
        responsesClient as any,
      );
      const session = fx.store.create(fx.root, deepseek.id, "deepseek-flash");
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: deepseek,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxTurns: 3,
        onEvent,
      });
      const result = await runner.run(session.id, "test");
      expect(result.status).toBe("completed");
      expect(result.text).toBe("partial answer");
      const warning = events.find((e) => e.type === "response_truncated");
      expect(warning).toBeDefined();
      expect(
        (events.find((e) => e.type === "run_completed")?.data as { truncated?: boolean }).truncated,
      ).toBe(true);
      expect(events.some((e) => e.type === "run_completed")).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it("keeps a truncated DeepSeek responses summary as a partial checkpoint", async () => {
    const fx = await fixture();
    try {
      const responsesClient = {
        responses: {
          async create() {
            return (async function* () {
              yield {
                type: "response.incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                response: {
                  output: [
                    {
                      type: "message",
                      content: [{ type: "output_text", text: JSON.stringify(checkpoint) }],
                    },
                  ],
                },
              };
            })();
          },
        },
      };
      const deepseek = new DeepSeekProvider(
        {
          baseURL: "https://api.deepseek.com",
          apiKey: "fake",
          apiKeyEnv: "UNUSED",
          model: "deepseek-flash",
          apiMode: "responses",
          auth: "bearer",
          tokenParameter: "max_tokens",
          streamUsage: false,
        },
        responsesClient as any,
      );
      const session = fx.store.create(fx.root, "deepseek", "deepseek-flash");
      for (const message of history()) fx.store.append(session.id, message);
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: deepseek,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent,
      });
      const result = await runner.compact(session.id);
      expect(result?.replaced).toBe(2);
      expect(events.some((e) => e.type === "compaction_completed" && (e.data as any).partial)).toBe(
        true,
      );
    } finally {
      await fx.close();
    }
  });

  it("fails a DeepSeek responses compaction that is truncated before any text", async () => {
    const fx = await fixture();
    try {
      const responsesClient = {
        responses: {
          async create() {
            return (async function* () {
              yield {
                type: "response.incomplete",
                incomplete_details: { reason: "max_output_tokens" },
                response: { output: [] },
              };
            })();
          },
        },
      };
      const deepseek = new DeepSeekProvider(
        {
          baseURL: "https://api.deepseek.com",
          apiKey: "fake",
          apiKeyEnv: "UNUSED",
          model: "deepseek-flash",
          apiMode: "responses",
          auth: "bearer",
          tokenParameter: "max_tokens",
          streamUsage: false,
        },
        responsesClient as any,
      );
      const session = fx.store.create(fx.root, "deepseek", "deepseek-flash");
      for (const message of history()) fx.store.append(session.id, message);
      const runner = new AgentRunner({
        provider: deepseek,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
      });
      await expect(runner.compact(session.id)).rejects.toThrow(/compaction\.maxOutputTokens/);
    } finally {
      await fx.close();
    }
  });
});

/**
 * Context-budget recovery: after a compaction that still leaves the kept tail over
 * `maxContextChars`, the runner reduces oversized retained content in place instead of failing,
 * and only an irreducible tail produces the actionable error (with the session still usable).
 */
describe("context-budget reduction after compaction", () => {
  const marker = "… [truncated by context budget]";
  const big = (n: number) => "x".repeat(n);
  // Summarizer/agent stub: streams the checkpoint JSON when called with no tools (compaction),
  // otherwise completes a normal answer. Compaction summarizer calls arrive with `tools: []`.
  const twoFaceProvider = () => {
    let rounds = 0;
    return {
      id: "test",
      model: "test",
      async *stream(request: { tools?: unknown[] }) {
        rounds++;
        if (!request.tools?.length)
          yield { type: "completed", message: completed(JSON.stringify(checkpoint)) };
        else yield { type: "completed", message: completed(`answer ${rounds}`) };
      },
    };
  };

  const bigTurn = (user: string, callId: string, size: number): Message[] => [
    { role: "user", text: user },
    { role: "assistant", text: "", calls: [{ id: callId, name: "hello", arguments: "{}" }] },
    { role: "tool", callId, result: { content: [{ type: "text", text: big(size) }] } },
  ];

  it("reduces an oversized kept tail after compaction, completes, and keeps the transcript valid", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test");
      for (const message of [
        ...bigTurn("turn a", "c1", 40_000),
        ...bigTurn("turn b", "c2", 40_000),
      ])
        fx.store.append(session.id, message);
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: twoFaceProvider() as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxContextChars: 30_000,
        onEvent,
      });
      // Compaction runs first; the kept tail (turn b + this prompt) is ~41k chars over the 30k
      // cap, so the runner reduces the oversized tool result instead of failing.
      const result = await runner.run(session.id, "continue");
      expect(result.status).toBe("completed");
      const reduced = events.find((e) => e.type === "context_reduced");
      expect(reduced).toBeDefined();
      expect(reduced?.data).toEqual({ messages: 1 });
      expect(events.some((e) => e.type === "run_failed")).toBe(false);
      // Transcript: roles and call IDs intact; the kept tool result was cut with the marker.
      const stored = fx.store.messages(session.id);
      expect(stored.map((m) => m.role)).toEqual([
        "user", // summary checkpoint
        "user",
        "assistant",
        "tool",
        "user",
        "assistant",
      ]);
      const toolMessage = stored.find((m) => m.role === "tool")!;
      expect(toolMessage.callId).toBe("c2");
      const text =
        toolMessage.role === "tool" ? toolMessage.result.content.map((c) => c.text).join("\n") : "";
      expect(text.length).toBeLessThanOrEqual(8_000 + marker.length + 1);
      expect(text).toContain(marker);
      // Every assistant call still has its result (valid, replayable transcript).
      const ids = stored.flatMap((m) => (m.role === "assistant" ? m.calls.map((c) => c.id) : []));
      const done = new Set(stored.filter((m) => m.role === "tool").map((m) => m.callId));
      for (const id of ids) expect(done.has(id)).toBe(true);
      // The same session keeps working after the recovery.
      const again = await runner.run(session.id, "next prompt");
      expect(again.status).toBe("completed");
      expect(again.text).toMatch(/^answer /);
    } finally {
      await fx.close();
    }
  });

  it("throws the actionable error when even the reduced tail exceeds the cap, and the session still works", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test");
      const turnB: Message[] = [
        { role: "user", text: "turn b" },
        {
          role: "assistant",
          text: "",
          calls: ["c1", "c2", "c3", "c4", "c5"].map((id) => ({
            id,
            name: "hello",
            arguments: "{}",
          })),
        },
        ...["c1", "c2", "c3", "c4", "c5"].map(
          (id): Message => ({
            role: "tool",
            callId: id,
            result: { content: [{ type: "text", text: big(40_000) }] },
          }),
        ),
      ];
      for (const message of [...bigTurn("turn a", "ca", 40_000), ...turnB])
        fx.store.append(session.id, message);
      const runner = new AgentRunner({
        provider: twoFaceProvider() as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxContextChars: 30_000,
      });
      // Even at the 8k cap the five kept tool results (~40k+ chars) exceed the 30k limit:
      // the run fails with an actionable error, naming size and remedies.
      const error = await runner.run(session.id, "continue").then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error).not.toBeNull();
      expect(error?.message).toContain("start a new session");
      expect(error?.message).toContain("/compact");
      expect(error?.message).toMatch(/approximately \d+ characters/);
      // The reduction was still persisted, so the leap past the cap is gone for the next turn.
      const stored = fx.store.messages(session.id);
      expect(stored.filter((m) => m.role === "tool")).toHaveLength(5);
      for (const m of stored) {
        if (m.role !== "tool") continue;
        const text = m.result.content.map((c) => c.text).join("\n");
        expect(text.length).toBeLessThanOrEqual(8_000 + marker.length + 1);
        expect(text).toContain(marker);
      }
      // A subsequent prompt in the same session succeeds: auto-compaction now keeps only the
      // two most recent (small) turns, the big turn is summarized away, and no fatal error.
      const again = await runner.run(session.id, "hi");
      expect(again.status).toBe("completed");
      expect(again.text).toMatch(/^answer /);
    } finally {
      await fx.close();
    }
  });

  it("does not touch sessions already under the hard limit", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test");
      for (const message of bigTurn("small", "c1", 200)) fx.store.append(session.id, message);
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: twoFaceProvider() as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxContextChars: 30_000,
        onEvent,
      });
      const result = await runner.run(session.id, "hi");
      expect(result.status).toBe("completed");
      expect(events.some((e) => e.type === "context_reduced")).toBe(false);
      const tool = fx.store.messages(session.id).find((m) => m.role === "tool");
      expect(tool?.role).toBe("tool");
      expect(tool && "result" in tool && tool.result.content[0]?.text).toBe("x".repeat(200));
    } finally {
      await fx.close();
    }
  });
});
