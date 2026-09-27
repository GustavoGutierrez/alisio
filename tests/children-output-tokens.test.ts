import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textResult } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { ChildSessions } from "../packages/core/src/sessions/children.ts";

/**
 * Child runs inherit the global agent-loop `maxOutputTokens` (default 4096) unless the stored
 * child spec carries its own budget. Reasoning-heavy models can spend the whole 4096 on
 * reasoning before any usable text, so spawned children must forward a per-call budget. These
 * tests pin the precedence: per-run option > runner budget > 4096 fallback, and the children
 * plumbing carries the spec through spawn and run.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-children-tokens-"));
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
  const seen: number[] = [];
  const provider = {
    id: "test",
    model: "test",
    async *stream(request: { maxOutputTokens: number }) {
      seen.push(request.maxOutputTokens);
      yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
    },
  };
  return {
    root,
    store,
    registry,
    provider,
    seen,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runner(fx: Awaited<ReturnType<typeof fixture>>, maxOutputTokens?: number) {
  return new AgentRunner({
    provider: fx.provider as any,
    registry: fx.registry,
    store: fx.store,
    context: new ProjectContext(fx.root),
    workspace: fx.root,
    policy: { write: false, process: false, external: false },
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  });
}

function children(fx: Awaited<ReturnType<typeof fixture>>, r: AgentRunner) {
  return new ChildSessions({
    store: fx.store,
    runner: r,
    providerId: () => "test",
    rootPolicy: () => ({ write: false, process: false, external: false }),
    rootApprovals: false,
    readOnly: false,
    contextFor: () => new ProjectContext(fx.root),
  });
}

describe("child sessions forward maxOutputTokens", () => {
  it("forwards a child spec maxOutputTokens to the runner call", async () => {
    const fx = await fixture();
    try {
      const r = runner(fx, 4096);
      const parent = fx.store.create(fx.root, "test", "test");
      const child = children(fx, r).spawn({
        parentId: parent.id,
        title: "deep audit",
        agent: "explore",
        maxOutputTokens: 16_384,
      });
      const result = await children(fx, r).run(child.id, "audit everything");
      expect(result.status).toBe("completed");
      expect(fx.seen).toEqual([16_384]);
    } finally {
      await fx.close();
    }
  });

  it("falls back to the runner budget when the spec has no maxOutputTokens", async () => {
    const fx = await fixture();
    try {
      const r = runner(fx, 2048);
      const parent = fx.store.create(fx.root, "test", "test");
      const child = children(fx, r).spawn({
        parentId: parent.id,
        title: "plain child",
        agent: "general",
      });
      const result = await children(fx, r).run(child.id, "work");
      expect(result.status).toBe("completed");
      expect(fx.seen).toEqual([2048]);
      // The stored spec stays lean: nothing was persisted for output tokens.
      expect(fx.store.get(child.id).options?.maxOutputTokens).toBeUndefined();
    } finally {
      await fx.close();
    }
  });

  it("keeps the main session on the runner limits budget (no zoomed default)", async () => {
    const fx = await fixture();
    try {
      const r = runner(fx, 16_384);
      const parent = fx.store.create(fx.root, "test", "test");
      await r.run(parent.id, "main session prompt");
      expect(fx.seen).toEqual([16_384]);
    } finally {
      await fx.close();
    }
  });

  it("lets a per-run option beat the runner budget (embedder path)", async () => {
    const fx = await fixture();
    try {
      const r = runner(fx, 16_384);
      const parent = fx.store.create(fx.root, "test", "test");
      await r.run(parent.id, "embedded", undefined, { maxOutputTokens: 8192 });
      expect(fx.seen).toEqual([8192]);
    } finally {
      await fx.close();
    }
  });
});

describe("child turn-limit soft completion", () => {
  it("marks a turn-capped child as completed with a turnsExceeded partial result, not failed", async () => {
    const fx = await fixture();
    try {
      let round = 0;
      const looping = {
        id: "test",
        model: "test",
        async *stream() {
          round++;
          yield {
            type: "completed",
            message: {
              role: "assistant",
              text: `step ${round}`,
              calls: [{ id: `c${round}`, name: "hello", arguments: "{}" }],
            },
          };
        },
      };
      const r = new AgentRunner({
        provider: looping as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
      });
      const parent = fx.store.create(fx.root, "test", "test");
      const child = children(fx, r).spawn({
        parentId: parent.id,
        title: "deep audit",
        agent: "explore",
        maxTurns: 2,
      });
      const result = await children(fx, r).run(child.id, "audit everything");
      expect(round).toBe(2);
      // The child exhausted its turn cap: usable partial output, NOT a failure.
      expect(result.status).toBe("completed");
      expect(result.turnsExceeded).toBe(true);
      expect(result.text).toBe("step 2");
      expect(result.error).toBeUndefined();
      expect(fx.store.get(child.id).status).toBe("completed");
      // The capped transcript is intact: a continuation run in the same child session completes.
      const continuing = {
        id: "test",
        model: "test",
        async *stream() {
          yield {
            type: "completed",
            message: { role: "assistant", text: "report", calls: [] },
          };
        },
      };
      const r2 = new AgentRunner({
        provider: continuing as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
      });
      const again = await children(fx, r2).run(child.id, "continue");
      expect(again.status).toBe("completed");
      expect(again.turnsExceeded).toBeUndefined();
      expect(again.text).toBe("report");
    } finally {
      await fx.close();
    }
  });

  it("still marks a child failed on a real runner error", async () => {
    const fx = await fixture();
    try {
      // The provider never completes a response: the runner throws, so the child must FAIL.
      const broken = {
        id: "test",
        model: "test",
        async *stream() {
          yield { type: "text_delta", delta: "hello" };
        },
      };
      const r = new AgentRunner({
        provider: broken as any,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
      });
      const parent = fx.store.create(fx.root, "test", "test");
      const child = children(fx, r).spawn({
        parentId: parent.id,
        title: "broken child",
        agent: "general",
      });
      const result = await children(fx, r).run(child.id, "work");
      expect(result.status).toBe("failed");
      expect(result.turnsExceeded).toBeUndefined();
      expect(result.error).toContain("Provider stream ended without a completed response");
      expect(fx.store.get(child.id).status).toBe("failed");
    } finally {
      await fx.close();
    }
  });
});
