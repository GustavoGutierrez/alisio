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
