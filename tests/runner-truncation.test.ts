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
 * `maxContextChars`, the runner reduces retained content in place against a TOTAL character
 * target (largest items first, in descending cap rounds) instead of failing, and only a
 * pathological session (instructions alone crowding out the limit) produces the
 * actionable error (with the session still usable), and the fixed tool catalog is NOT
 * counted against the hard limit (a huge MCP catalog never corrupts the transcript).
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
        toolMessage.role === "tool"
          ? toolMessage.result.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n")
          : "";
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

  it("walks a tail of five huge results down the cap rounds and completes", async () => {
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
      // The five kept results (~201k) cannot fit the 30k limit at the 8k cap: the budget
      // reducer walks the cap rounds (8000 -> 4096) clipping the largest first, stopping as
      // soon as the transcript fits — so only SOME results reach the lower round.
      const result = await runner.run(session.id, "continue");
      expect(result.status).toBe("completed");
      const reduced = events.find((e) => e.type === "context_reduced");
      expect(reduced).toBeDefined();
      expect(reduced?.data).toEqual({ messages: 5 });
      expect(events.some((e) => e.type === "run_failed")).toBe(false);
      const stored = fx.store.messages(session.id);
      const tools = stored.filter((m) => m.role === "tool");
      expect(tools).toHaveLength(5);
      const texts = tools.map((m) =>
        m.result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      );
      for (const text of texts) {
        expect(text.length).toBeLessThanOrEqual(8_000 + marker.length + 1);
        expect(text).toContain(marker);
      }
      // The round walk really happened: at least one result dropped below the 8k cap, and the
      // persisted transcript now fits the limit (instructions ~238 + tools ~67 + messages).
      expect(texts.some((t) => t.length < 8_000 + marker.length + 1)).toBe(true);
      expect(JSON.stringify(stored).length + 238 + 67).toBeLessThanOrEqual(30_000);
      // The reduction was still persisted, so the leap past the cap is gone for the next turn.
      const again = await runner.run(session.id, "hi");
      expect(again.status).toBe("completed");
      expect(again.text).toMatch(/^answer /);
    } finally {
      await fx.close();
    }
  });

  it("recovers a session with ~25 medium tool results (each under 8k) that used to die", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test");
      // An old huge turn (summarized away by auto-compaction) plus a recent turn holding 25
      // medium results of 7 000 chars each: every one individually under the 8k per-message cap,
      // together ~180k — the historical per-message reducer reported `truncated: 0` and the run
      // died with the fatal context-budget error on this very prompt.
      for (const message of bigTurn("old turn", "ca", 40_000)) fx.store.append(session.id, message);
      const callIds = Array.from({ length: 25 }, (_, i) => `m${i}`);
      fx.store.append(session.id, { role: "user", text: "medium results" });
      fx.store.append(session.id, {
        role: "assistant",
        text: "",
        calls: callIds.map((id) => ({ id, name: "hello", arguments: "{}" })),
      });
      for (const id of callIds)
        fx.store.append(session.id, {
          role: "tool",
          callId: id,
          result: { content: [{ type: "text", text: big(7_000) }] },
        });
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: twoFaceProvider() as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxContextChars: 160_000,
        onEvent,
      });
      // Auto-compaction summarizes the old turn, the kept medium tail still exceeds the limit,
      // and the budget reducer brings it under 160k; no fatal error.
      const result = await runner.run(session.id, "continue");
      expect(result.status).toBe("completed");
      expect(events.some((e) => e.type === "run_failed")).toBe(false);
      const reduced = events.find((e) => e.type === "context_reduced");
      expect(reduced).toBeDefined();
      // Transcript stays structurally valid: roles and call IDs untouched.
      const stored = fx.store.messages(session.id);
      const ids = stored.flatMap((m) => (m.role === "assistant" ? m.calls.map((c) => c.id) : []));
      const done = new Set(stored.filter((m) => m.role === "tool").map((m) => m.callId));
      for (const id of ids) expect(done.has(id)).toBe(true);
      // The next prompt completes WITHOUT the fatal error (the reported bug).
      const again = await runner.run(session.id, "next prompt");
      expect(again.status).toBe("completed");
      expect(again.text).toMatch(/^answer /);
    } finally {
      await fx.close();
    }
  });

  it("fails actionably when instructions alone exceed the limit, and later prompts still work", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test");
      for (const message of bigTurn("turn a", "c1", 40_000)) fx.store.append(session.id, message);
      const runner = new AgentRunner({
        provider: twoFaceProvider() as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxContextChars: 30_000,
      });
      // Instructions alone (~35k) exceed the 30k limit: even the 4k reduction floor cannot fit,
      // so the run fails with the actionable error.
      const error = await runner
        .run(session.id, "continue", undefined, { instructions: big(35_000) })
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      expect(error).not.toBeNull();
      expect(error?.message).toContain("Context budget exceeded");
      expect(error?.message).toContain("/compact");
      expect(error?.message).toContain("/plugins");
      expect(error?.message).toMatch(/approximately \d+ characters/);
      // A later prompt in the same session succeeds: no leftovers poison the TUI.
      const again = await runner.run(session.id, "hi");
      expect(again.status).toBe("completed");
      expect(again.text).toMatch(/^answer /);
    } finally {
      await fx.close();
    }
  });

  it("does not fail when the fixed tool catalog alone exceeds the char budget", async () => {
    const fx = await fixture();
    try {
      // The reported bug: an MCP-style server exposing a huge catalog (devforge ~95 tools +
      // assignable tools) makes the serialized toolsText alone ~200k chars — over the 160k
      // limit — so an EMPTY transcript used to die with the fatal context-budget error. The
      // hard cap now measures only reducible content (instructions + transcript): the catalog
      // is a fixed deployment reality (a /plugins decision), not session growth.
      fx.registry.register({
        name: "huge",
        effect: "read",
        description: "x".repeat(200_000),
        inputSchema: { type: "object" },
        async execute() {
          return textResult("ok");
        },
      });
      const session = fx.store.create(fx.root, "test", "test");
      fx.store.append(session.id, { role: "user", text: "hi" });
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider: twoFaceProvider() as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxContextChars: 160_000,
        // A known window keeps the window-based auto-compaction branch (which measures the
        // FULL request including tools) from firing: 200k chars ≈ 50k tokens is far below
        // 1M × 0.85.
        contextWindow: () => 1_000_000,
        onEvent,
      });
      const result = await runner.run(session.id, "continue");
      expect(result.status).toBe("completed");
      expect(result.text).toMatch(/^answer /);
      expect(events.some((e) => e.type === "run_failed")).toBe(false);
      // The small transcript must NOT be reduced or compacted by the catalog's weight.
      expect(events.some((e) => e.type === "context_reduced")).toBe(false);
      expect(events.some((e) => e.type === "compaction_completed")).toBe(false);
      const stored = fx.store.messages(session.id);
      expect(stored.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
        "hi",
        "continue",
      ]);
      // A follow-up prompt keeps working (the historical fatal error is gone for good).
      const again = await runner.run(session.id, "next prompt");
      expect(again.status).toBe("completed");
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
      expect(
        tool && "result" in tool && tool.result.content.find((p) => p.type === "text")?.text,
      ).toBe("x".repeat(200));
    } finally {
      await fx.close();
    }
  });
});

/**
 * Turn-limit soft completion: reaching `maxTurns` ends the run successfully-but-marked
 * (`turns-exceeded`) instead of the historical fatal throw. Everything produced up to that
 * point stays in the transcript, no `run_failed` is emitted, and the next run in the same
 * session continues where the capped run left off. The token budget and timeout remain the
 * hard stops — the turn count is a safety rail, mirroring Claude Code / OpenCode.
 */
describe("turn-limit soft completion", () => {
  it("returns turns-exceeded with partial text instead of throwing past the cap", async () => {
    const fx = await fixture();
    try {
      let round = 0;
      let finish = false;
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          round++;
          if (finish) yield { type: "completed", message: completed("final answer") };
          else
            yield {
              type: "completed",
              message: completed(`step ${round}`, [
                { id: `c${round}`, name: "hello", arguments: "{}" },
              ]),
            };
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
        maxTurns: 20,
        onEvent,
      });
      const result = await runner.run(session.id, "audit");
      expect(round).toBe(20);
      expect(result.status).toBe("turns-exceeded");
      expect(result.text).toBe("step 20");
      expect(result.usage).toMatchObject({ input: 0, output: 0 });
      const turnsEvent = events.find((e) => e.type === "run_turns_exceeded");
      expect(turnsEvent?.data).toEqual({ turns: 20, maxTurns: 20 });
      // No fatal path: run_failed is never emitted and the transcript is intact.
      expect(events.some((e) => e.type === "run_failed")).toBe(false);
      expect(events.some((e) => e.type === "run_completed")).toBe(false);
      const stored = fx.store.messages(session.id);
      const assistants = stored.filter((m) => m.role === "assistant");
      expect(assistants).toHaveLength(20);
      const calls = assistants.flatMap((m) =>
        m.role === "assistant" ? m.calls.map((c) => c.id) : [],
      );
      expect(calls).toHaveLength(20);
      const done = new Set(stored.filter((m) => m.role === "tool").map((m) => m.callId));
      for (const id of calls) expect(done.has(id)).toBe(true);
      // The next run in the SAME session continues where the capped run left off.
      finish = true;
      const again = await runner.run(session.id, "continue");
      expect(again.status).toBe("completed");
      expect(again.text).toBe("final answer");
      expect(round).toBe(21);
      expect(events.some((e) => e.type === "run_turns_exceeded")).toBe(true); // only the first run
    } finally {
      await fx.close();
    }
  });

  it("runs 25 tool turns under the default 100-turn cap and completes", async () => {
    // The default maxTurns is 100, not 20: a 25-turn read-heavy tool loop completes instead of
    // dying at the old cap.
    const fx = await fixture();
    try {
      let round = 0;
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          round++;
          if (round < 25)
            yield {
              type: "completed",
              message: completed(`step ${round}`, [
                { id: `c${round}`, name: "hello", arguments: "{}" },
              ]),
            };
          else yield { type: "completed", message: completed("audit done") };
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
      const result = await runner.run(session.id, "audit everything");
      expect(result.status).toBe("completed");
      expect(round).toBe(25);
      expect(result.text).toBe("audit done");
      expect(events.some((e) => e.type === "run_turns_exceeded")).toBe(false);
      expect(events.some((e) => e.type === "run_failed")).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it("lets a per-run maxTurns override beat the runner-level cap", async () => {
    const fx = await fixture();
    try {
      let round = 0;
      const provider = {
        id: "test",
        model: "test",
        async *stream() {
          round++;
          yield {
            type: "completed",
            message: completed(`step ${round}`, [
              { id: `c${round}`, name: "hello", arguments: "{}" },
            ]),
          };
        },
      };
      const session = fx.store.create(fx.root, "test", "test");
      const runner = new AgentRunner({
        provider: provider as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        maxTurns: 100,
      });
      const result = await runner.run(session.id, "audit", undefined, { maxTurns: 2 });
      expect(result.status).toBe("turns-exceeded");
      expect(round).toBe(2);
      expect(result.text).toBe("step 2");
    } finally {
      await fx.close();
    }
  });
});
