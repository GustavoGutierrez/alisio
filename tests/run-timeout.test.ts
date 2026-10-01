import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import {
  describeTimeout,
  isTimeoutReason,
  providerLabel,
} from "../packages/core/src/core/timeout.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const done = (text: string): Extract<Message, { role: "assistant" }> => ({
  role: "assistant",
  text,
  calls: [],
});

/** A provider whose request never produces anything until it is aborted (a silent connection). */
const silentProvider = {
  id: "openai-compatible:chat:https://api.example.test/v1",
  model: "slow-model",
  started: 0,
  async *stream(request: { signal: AbortSignal }) {
    silentProvider.started++;
    await new Promise<void>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("transport aborted")));
    });
  },
};

async function harness(provider: unknown, limits: Record<string, number>) {
  const root = await mkdtemp(join(tmpdir(), "alisio-timeout-"));
  const store = new SQLiteStore(join(root, "store.sqlite"));
  const events: RunEvent[] = [];
  const runner = new AgentRunner({
    provider: provider as never,
    registry: new ToolRegistry(),
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    onEvent: (event) => events.push(event),
    ...limits,
  });
  const session = store.create(root, (provider as { id: string }).id, "slow-model");
  return {
    runner,
    store,
    events,
    session,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("timeout messages", () => {
  it("names the model, the provider host, the limit and what to do", () => {
    const text = describeTimeout({
      kind: "run",
      ms: 300_000,
      model: "deepseek-flash",
      provider: "api.deepseek.com",
      stage: "waiting_model",
      firstRequest: true,
    });
    expect(text).toContain("deepseek-flash");
    expect(text).toContain("api.deepseek.com");
    expect(text).toContain("300 s");
    expect(text).toContain("no tokens were received");
    expect(text).toContain("limits.timeoutMs");
  });
  it("does not claim silence when the run was busy with a tool", () => {
    const text = describeTimeout({ kind: "run", ms: 60_000, stage: "tool", tool: "python_run" });
    expect(text).toContain("while running python_run");
    expect(text).not.toContain("did not respond");
  });
  it("points at the first-token key for a silent request", () => {
    const text = describeTimeout({
      kind: "first_token",
      ms: 90_000,
      model: "m",
      stage: "waiting_model",
    });
    expect(text).toContain("90 s");
    expect(text).toContain("limits.firstTokenTimeoutMs");
  });
  it("labels OpenAI-compatible provider ids by their host", () => {
    expect(providerLabel("openai-compatible:chat:https://api.deepseek.com/v1")).toBe(
      "api.deepseek.com",
    );
    expect(providerLabel("custom")).toBe("custom");
    expect(providerLabel(undefined)).toBeUndefined();
  });
  it("recognises only timer aborts as timeouts", () => {
    expect(isTimeoutReason(AbortSignal.abort().reason)).toBe(false);
    expect(isTimeoutReason(new DOMException("t", "TimeoutError"))).toBe(true);
  });
});

describe("run timeout at the runner boundary", () => {
  it("fails with a readable timeout (not a bare cancellation) when the model stays silent", async () => {
    const fx = await harness(silentProvider, { timeoutMs: 800 });
    try {
      await expect(fx.runner.run(fx.session.id, "hello")).rejects.toThrow(/slow-model/);
      const failed = fx.events.find((e) => e.type === "run_failed");
      expect(fx.events.some((e) => e.type === "run_cancelled")).toBe(false);
      expect(failed?.data).toMatchObject({
        code: "timeout",
        timeout: {
          kind: "run",
          ms: 800,
          model: "slow-model",
          provider: "api.example.test",
          stage: "waiting_model",
          firstRequest: true,
        },
      });
      expect((failed?.data as { error: string }).error).toContain("did not respond");
      const [run] = fx.store.runs(fx.session.id);
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("limits.timeoutMs");
    } finally {
      await fx.close();
    }
  });

  it("a user stop stays a cancellation", async () => {
    silentProvider.started = 0;
    const fx = await harness(silentProvider, { timeoutMs: 10_000 });
    try {
      const controller = new AbortController();
      const pending = fx.runner.run(fx.session.id, "hello", controller.signal);
      const poll = setInterval(() => {
        if (silentProvider.started > 0) {
          clearInterval(poll);
          controller.abort();
        }
      }, 10);
      await expect(pending).rejects.toThrow();
      expect(fx.events.some((e) => e.type === "run_cancelled")).toBe(true);
      expect(fx.events.some((e) => e.type === "run_failed")).toBe(false);
      expect(fx.store.runs(fx.session.id)[0]?.status).toBe("cancelled");
    } finally {
      await fx.close();
    }
  });

  it("stops a completely silent request early when firstTokenTimeoutMs is set", async () => {
    const fx = await harness(silentProvider, { timeoutMs: 10_000, firstTokenTimeoutMs: 300 });
    try {
      const started = Date.now();
      await expect(fx.runner.run(fx.session.id, "hello")).rejects.toThrow(/sent nothing/);
      expect(Date.now() - started).toBeLessThan(3_000);
      const failed = fx.events.find((e) => e.type === "run_failed");
      expect(failed?.data).toMatchObject({ code: "timeout", timeout: { kind: "first_token" } });
    } finally {
      await fx.close();
    }
  });

  it("does not cut off a slow model that has started to answer", async () => {
    const slowButAlive = {
      id: "p",
      model: "slow-model",
      async *stream() {
        await new Promise((r) => setTimeout(r, 40));
        yield { type: "reasoning_delta", delta: "thinking" };
        await new Promise((r) => setTimeout(r, 200));
        yield { type: "completed", message: done("ok") };
      },
    };
    const fx = await harness(slowButAlive, { timeoutMs: 5_000, firstTokenTimeoutMs: 120 });
    try {
      const result = await fx.runner.run(fx.session.id, "hello");
      expect(result.status).toBe("completed");
      expect(fx.events.some((e) => e.type === "run_failed")).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it("a runner without a first-token setting never cuts a late but alive request", async () => {
    const lateButAlive = {
      id: "p",
      model: "slow-model",
      async *stream() {
        await new Promise((r) => setTimeout(r, 300));
        yield { type: "completed", message: done("ok") };
      },
    };
    const fx = await harness(lateButAlive, { timeoutMs: 5_000 });
    try {
      expect((await fx.runner.run(fx.session.id, "hello")).status).toBe("completed");
    } finally {
      await fx.close();
    }
  });
});
