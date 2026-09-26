import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
