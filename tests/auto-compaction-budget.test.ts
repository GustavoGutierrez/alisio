import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, RunEvent } from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
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
const done = (text: string): Extract<Message, { role: "assistant" }> => ({
  role: "assistant",
  text,
  calls: [],
});
const big = (n: number) => "x".repeat(n);
const bigTurn = (user: string, callId: string, size: number): Message[] => [
  { role: "user", text: user },
  { role: "assistant", text: "", calls: [{ id: callId, name: "hello", arguments: "{}" }] },
  { role: "tool", callId, result: { content: [{ type: "text", text: big(size) }] } },
];

async function setup(
  opts: { summarizerFails?: boolean; runner?: Record<string, unknown>; messages?: Message[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "alisio-auto-compaction-"));
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
  const events: RunEvent[] = [];
  const stats = { summaries: 0 };
  const provider = {
    id: "test",
    model: "test",
    async *stream(request: { tools?: unknown[] }) {
      if (!request.tools?.length) {
        stats.summaries++;
        if (opts.summarizerFails) throw new Error("summarizer boom");
        yield { type: "completed", message: done(JSON.stringify(checkpoint)) };
      } else yield { type: "completed", message: done("answer") };
    },
  };
  const session = store.create(root, "test", "test");
  for (const m of opts.messages ?? []) store.append(session.id, m);
  const runner = new AgentRunner({
    provider: provider as never,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    maxContextChars: 30_000,
    onEvent: (e: RunEvent) => events.push(e),
    ...opts.runner,
  });
  return {
    runner,
    session,
    events,
    stats,
    store,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
// Many small messages: clipping cannot shrink them, only summarizing can.
const chatter: Message[] = Array.from({ length: 60 }, (_, i): Message[] => [
  { role: "user", text: `${i} ${big(300)}` },
  { role: "assistant", text: big(300), calls: [] },
]).flat();
const two = [...bigTurn("turn a", "c1", 13_000), ...bigTurn("turn b", "c2", 13_000)];
const failure = (fn: Promise<unknown>) =>
  fn.then(
    () => null,
    (e: unknown) => e as Error,
  );

describe("automatic compaction respects the character budget", () => {
  it("compacts a large-window model once chars pass 85 percent of the limit", async () => {
    const fx = await setup({ messages: two, runner: { contextWindow: () => 1_000_000 } });
    try {
      const result = await fx.runner.run(fx.session.id, "continue");
      expect(result.status).toBe("completed");
      const started = fx.events.find((e) => e.type === "compaction_started");
      expect(started?.data).toMatchObject({ reason: "auto" });
      expect(fx.events.some((e) => e.type === "context_reduced")).toBe(false);
      expect(fx.events.some((e) => e.type === "run_failed")).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it("never auto-compacts when compaction.auto is false", async () => {
    const fx = await setup({
      messages: two,
      runner: { contextWindow: () => 1_000_000, compaction: { auto: false } },
    });
    try {
      const result = await fx.runner.run(fx.session.id, "continue");
      expect(result.status).toBe("completed");
      expect(fx.events.some((e) => e.type === "compaction_started")).toBe(false);
      expect(fx.stats.summaries).toBe(0);
    } finally {
      await fx.close();
    }
  });

  it("runs one last-chance compaction at the hard check before failing", async () => {
    // threshold 1.5 keeps the proactive trigger quiet, so only the hard check can compact.
    const fx = await setup({
      messages: chatter,
      runner: { compaction: { threshold: 1.5 }, contextWindow: () => 1_000_000 },
    });
    try {
      const result = await fx.runner.run(fx.session.id, "continue");
      expect(result.status).toBe("completed");
      const started = fx.events.filter((e) => e.type === "compaction_started");
      expect(started).toHaveLength(1);
      expect(started[0]?.data).toMatchObject({ reason: "budget" });
    } finally {
      await fx.close();
    }
  });

  it("attempts compaction only once per turn and says it ran", async () => {
    const fx = await setup({ messages: two });
    try {
      const err = await failure(
        fx.runner.run(fx.session.id, "continue", undefined, { instructions: big(35_000) }),
      );
      expect(err?.message).toContain("Context budget exceeded");
      expect(err?.message).toMatch(/Automatic compaction ran but/);
      expect(err?.message).toContain("/compact");
      expect(err?.message).toContain("/plugins");
      expect(fx.stats.summaries).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it("says compaction was skipped when there is no safe boundary", async () => {
    const fx = await setup();
    try {
      const err = await failure(
        fx.runner.run(fx.session.id, "continue", undefined, { instructions: big(35_000) }),
      );
      expect(err?.message).toContain("Context budget exceeded");
      expect(err?.message).toMatch(/Automatic compaction was skipped/);
      expect(err?.message).toContain("no safe boundary");
      expect(fx.stats.summaries).toBe(0);
    } finally {
      await fx.close();
    }
  });

  it("says compaction failed when the last-chance summary errors", async () => {
    const fx = await setup({
      messages: chatter,
      summarizerFails: true,
      runner: { compaction: { threshold: 1.5 }, contextWindow: () => 1_000_000 },
    });
    try {
      const err = await failure(fx.runner.run(fx.session.id, "continue"));
      expect(err).not.toBeNull();
      expect(err?.message).toContain("Context budget exceeded");
      expect(err?.message).toMatch(/Automatic compaction failed/);
      expect(err?.message).toContain("summarizer boom");
      expect(fx.stats.summaries).toBe(1);
    } finally {
      await fx.close();
    }
  });

  it("says compaction is disabled when auto is false and the limit cannot be met", async () => {
    const fx = await setup({ runner: { compaction: { auto: false } } });
    try {
      const err = await failure(
        fx.runner.run(fx.session.id, "continue", undefined, { instructions: big(35_000) }),
      );
      expect(err?.message).toContain("Context budget exceeded");
      expect(err?.message).toMatch(/Automatic compaction is disabled/);
      expect(fx.events.some((e) => e.type === "compaction_started")).toBe(false);
    } finally {
      await fx.close();
    }
  });

  describe("does not recompact every turn", () => {
    // Three small turns, then ONE long turn (a user message followed by 31 assistant messages of
    // 900 characters, below every clipping cap) that stays verbatim as the kept tail together
    // with the new prompt: summarizing cannot get below 85 percent of the 30_000 limit.
    const longTurn: Message[] = [
      { role: "user", text: "long turn" },
      ...Array.from(
        { length: 31 },
        (): Message => ({ role: "assistant", text: big(900), calls: [] }),
      ),
    ];
    const stuck: Message[] = [
      { role: "user", text: "old one" },
      { role: "assistant", text: "ok", calls: [] },
      { role: "user", text: "old two" },
      { role: "assistant", text: "ok", calls: [] },
      { role: "user", text: "old three" },
      { role: "assistant", text: "ok", calls: [] },
      ...longTurn,
    ];

    it("does not retrigger on the next turns, and retriggers after growing by the margin", async () => {
      const fx = await setup({ messages: stuck, runner: { contextWindow: () => 1_000_000 } });
      try {
        await fx.runner.run(fx.session.id, "continue");
        expect(fx.stats.summaries).toBe(1);
        await fx.runner.run(fx.session.id, "again");
        await fx.runner.run(fx.session.id, "and again");
        expect(fx.stats.summaries).toBe(1);
        // Grow past the 10 percent margin (3_000 characters of a 30_000 limit).
        fx.store.append(fx.session.id, { role: "user", text: "grow" });
        fx.store.append(fx.session.id, { role: "assistant", text: big(3_200), calls: [] });
        await fx.runner.run(fx.session.id, "after growth");
        expect(fx.stats.summaries).toBe(2);
      } finally {
        await fx.close();
      }
    });

    it("still gives the hard limit its single last-chance attempt", async () => {
      const fx = await setup({ messages: stuck, runner: { contextWindow: () => 1_000_000 } });
      try {
        await fx.runner.run(fx.session.id, "continue");
        expect(fx.stats.summaries).toBe(1);
        // Under the margin, but over the hard limit with small unclippable messages.
        fx.store.append(fx.session.id, { role: "user", text: "grow" });
        for (let i = 0; i < 6; i++)
          fx.store.append(fx.session.id, { role: "assistant", text: big(300), calls: [] });
        const before = fx.events.filter((e) => e.type === "compaction_started").length;
        await fx.runner.run(fx.session.id, "hard");
        const started = fx.events.filter((e) => e.type === "compaction_started");
        expect(started.length - before).toBe(1);
        expect(started.at(-1)?.data).toMatchObject({ reason: "budget" });
        expect(fx.stats.summaries).toBe(2);
      } finally {
        await fx.close();
      }
    });

    it("keeps compacting normally when summarizing gets below the trigger", async () => {
      const fx = await setup({ messages: chatter, runner: { contextWindow: () => 1_000_000 } });
      try {
        await fx.runner.run(fx.session.id, "continue");
        expect(fx.stats.summaries).toBe(1);
        // Rebuild a large conversation: the post-compaction baseline is small, so it fires again.
        for (const m of chatter) fx.store.append(fx.session.id, m);
        await fx.runner.run(fx.session.id, "again");
        expect(fx.stats.summaries).toBe(2);
      } finally {
        await fx.close();
      }
    });
  });
});
