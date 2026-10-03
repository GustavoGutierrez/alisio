/**
 * The run limit (`limits.timeoutMs`) counts ACTIVE time: a wait for a person (a tool approval,
 * `ask_user_question`, the plan review) never consumes it, while a model or tool that really runs
 * too long still fails with `code: "timeout"`. Real timers with wide margins.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AskQuestionsRequest,
  AskQuestionsResult,
  Message,
  ModelProvider,
  RunEvent,
  ToolCall,
  ToolDefinition,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeAgentCatalog,
  agentRunOptions,
  resolveActiveAgent,
} from "../packages/core/src/agents/active.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { goalOutcome } from "../packages/core/src/goal/host.ts";
import { registerExitPlan } from "../packages/core/src/plan/exit-plan.ts";
import { currentPlan, settlePlanRun } from "../packages/core/src/plan/state.ts";
import { PluginHost } from "../packages/core/src/plugins/host.ts";
import { ProviderRegistry } from "../packages/core/src/providers/registry.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Assistant = Extract<Message, { role: "assistant" }>;
const assistant = (text: string, calls: ToolCall[] = []): Assistant => ({
  role: "assistant",
  text,
  calls,
});
const call = (id: string, name: string, args: unknown = {}): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
const PLAN = "# Add a flag\n\n## Steps\n1. Edit `src/a.ts`.\n";

async function fixture(options: {
  timeoutMs: number;
  script: (turn: number) => Assistant | Promise<Assistant>;
  approve?: () => Promise<"once" | "session" | "deny">;
  /** The answer of the interactive UI (bound through the plugin host, as the hosts do). */
  ui?: (request: AskQuestionsRequest) => Promise<AskQuestionsResult>;
  tools?: ToolDefinition[];
}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-human-wait-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const registry = new ToolRegistry();
  const host = new PluginHost(
    registry,
    { getState: () => undefined, setState: () => {} },
    {},
    new ProviderRegistry(),
  );
  const asks: ToolDefinition = {
    name: "ask",
    description: "asks the user",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    async execute(_input, context) {
      const answer = await host.ui.askQuestions({
        questions: [
          { id: "q", header: "h", question: "q?", options: [{ value: "a", label: "a" }] },
        ],
        ...(context.session ? { session: context.session } : {}),
        signal: context.signal,
      });
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    },
  };
  const writes: ToolDefinition = {
    name: "write_file",
    description: "writes",
    inputSchema: { type: "object", properties: {} },
    effect: "write",
    async execute() {
      return { content: [{ type: "text", text: "written" }] };
    },
  };
  for (const tool of [asks, writes, ...(options.tools ?? [])]) registry.register(tool);
  registerExitPlan(registry, { store, ui: host.ui });
  if (options.ui)
    host.setInteractiveUI({
      select: async () => undefined,
      askQuestions: options.ui,
      open: () => false,
    });
  const events: RunEvent[] = [];
  let turn = 0;
  const provider: ModelProvider = {
    id: "test",
    model: "m",
    async *stream() {
      yield { type: "completed", message: await options.script(turn++) };
    },
  };
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    timeoutMs: options.timeoutMs,
    ...(options.approve ? { approve: options.approve } : {}),
    onEvent: (event) => events.push(event),
    extensions: host,
  });
  host.setHumanWaits(runner.humanWaits);
  return {
    root,
    store,
    runner,
    events,
    session: store.create(root, "test", "m").id,
    close: () => store.close(),
  };
}

const failure = (events: RunEvent[]) => events.find((e) => e.type === "run_failed");

describe("human waits do not consume the run limit", () => {
  it("a tool approval answered long after the limit still completes the run", async () => {
    const fx = await fixture({
      timeoutMs: 1500,
      script: (turn) =>
        turn === 0 ? assistant("", [call("c1", "write_file")]) : assistant("done"),
      approve: async () => {
        await sleep(2500);
        return "once";
      },
    });
    try {
      const result = await fx.runner.run(fx.session, "go");
      expect(result.status).toBe("completed");
      expect(result.text).toBe("done");
      expect(result.activeMs).toBeLessThan(1400);
      expect(failure(fx.events)).toBeUndefined();
    } finally {
      fx.close();
    }
  });

  it("ask_user_question style waits (the host's interactive UI) pause the clock too", async () => {
    const fx = await fixture({
      timeoutMs: 1500,
      script: (turn) => (turn === 0 ? assistant("", [call("c1", "ask")]) : assistant("done")),
      ui: async () => {
        await sleep(2500);
        return { q: "a" };
      },
    });
    try {
      expect((await fx.runner.run(fx.session, "go")).status).toBe("completed");
    } finally {
      fx.close();
    }
  });

  it("parallel waits keep it paused until the last answer", async () => {
    const fx = await fixture({
      timeoutMs: 1500,
      script: (turn) =>
        turn === 0
          ? assistant("", [call("c1", "ask"), call("c2", "ask"), call("c3", "write_file")])
          : assistant("done"),
      ui: async () => {
        await sleep(2000);
        return { q: "a" };
      },
      approve: async () => {
        await sleep(2800);
        return "once";
      },
    });
    try {
      expect((await fx.runner.run(fx.session, "go")).status).toBe("completed");
    } finally {
      fx.close();
    }
  });

  it("a tool that really runs longer than the limit still times out", async () => {
    const slow: ToolDefinition = {
      name: "slow",
      description: "busy",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute(_input, context) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          context.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return { content: [{ type: "text", text: "late" }] };
      },
    };
    const fx = await fixture({
      timeoutMs: 400,
      tools: [slow],
      script: (turn) => (turn === 0 ? assistant("", [call("c1", "slow")]) : assistant("done")),
    });
    try {
      await expect(fx.runner.run(fx.session, "go")).rejects.toThrow(/active time/);
      const failed = failure(fx.events);
      expect(failed?.data).toMatchObject({
        code: "timeout",
        timeout: { kind: "run", tool: "slow" },
      });
    } finally {
      fx.close();
    }
  });

  it("a wait in the middle does not reset the active time before and after it", async () => {
    const busy = (name: string): ToolDefinition => ({
      name,
      description: "busy",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute(_input, context) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 600);
          context.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return { content: [{ type: "text", text: name }] };
      },
    });
    const script = (turn: number) =>
      turn === 0
        ? assistant("", [call("c1", "busy_a")])
        : turn === 1
          ? assistant("", [call("c2", "ask")])
          : turn === 2
            ? assistant("", [call("c3", "busy_b")])
            : assistant("done");
    const ui = async () => {
      await sleep(1500);
      return { q: "a" };
    };
    // 600 + 600 ms of work against a 1000 ms limit: the 1500 ms wait must not hide it.
    const over = await fixture({
      timeoutMs: 1000,
      tools: [busy("busy_a"), busy("busy_b")],
      script,
      ui,
    });
    try {
      await expect(over.runner.run(over.session, "go")).rejects.toThrow(/active time/);
    } finally {
      over.close();
    }
    // The same work fits a 2500 ms limit even though the wall time is longer than the limit.
    const fits = await fixture({
      timeoutMs: 2500,
      tools: [busy("busy_a"), busy("busy_b")],
      script,
      ui,
    });
    try {
      const result = await fits.runner.run(fits.session, "go");
      expect(result.status).toBe("completed");
      expect(result.activeMs).toBeGreaterThanOrEqual(1100);
      expect(result.activeMs).toBeLessThan(2400);
    } finally {
      fits.close();
    }
  });

  it("a model that stays silent past the limit still fails with the run timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-human-wait-"));
    roots.push(root);
    const store = new SQLiteStore(join(root, "s.sqlite"));
    const events: RunEvent[] = [];
    const runner = new AgentRunner({
      provider: {
        id: "test",
        model: "m",
        async *stream(request: { signal: AbortSignal }) {
          await new Promise<void>((_, reject) =>
            request.signal.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        },
      } as unknown as ModelProvider,
      registry: new ToolRegistry(),
      store,
      context: new ProjectContext(root),
      workspace: root,
      policy: { write: false, process: false, external: false },
      timeoutMs: 400,
      onEvent: (event) => events.push(event),
    });
    try {
      const session = store.create(root, "test", "m").id;
      await expect(runner.run(session, "go")).rejects.toThrow(/did not respond/);
      expect(failure(events)?.data).toMatchObject({ code: "timeout" });
    } finally {
      store.close();
    }
  });

  it("a stop while the person is still deciding ends the run as a cancellation", async () => {
    const controller = new AbortController();
    const fx = await fixture({
      timeoutMs: 1500,
      script: (turn) => (turn === 0 ? assistant("", [call("c1", "ask")]) : assistant("done")),
      ui: (request) =>
        new Promise((resolve) =>
          request.signal?.addEventListener("abort", () => resolve({ q: undefined }), {
            once: true,
          }),
        ),
    });
    try {
      const running = fx.runner.run(fx.session, "go", controller.signal);
      await sleep(700);
      controller.abort(new Error("stopped"));
      await running.catch(() => {});
      expect(fx.events.some((e) => e.type === "run_cancelled")).toBe(true);
      expect(failure(fx.events)).toBeUndefined();
    } finally {
      fx.close();
    }
  });
});

describe("exit_plan: the review stays open as long as the person needs", () => {
  const plan = (decision: "approve" | "skip") =>
    fixture({
      timeoutMs: 1500,
      script: (turn) =>
        turn === 0
          ? assistant("", [call("c1", "exit_plan", { plan: PLAN, title: "Flag plan" })])
          : assistant("Ok."),
      ui: async () => {
        await sleep(2500);
        return { plan: decision };
      },
    });
  const planAgent = () => agentRunOptions(resolveActiveAgent(activeAgentCatalog(), "plan"));

  it("approve after the limit would have expired: the run completes and the plan is approved", async () => {
    const fx = await plan("approve");
    try {
      const result = await fx.runner.run(fx.session, "plan it", undefined, planAgent());
      expect(result.status).toBe("completed");
      expect(failure(fx.events)).toBeUndefined();
      expect(settlePlanRun(fx.store, fx.session, { aborted: false }).kind).toBe("implement");
    } finally {
      fx.close();
    }
  });

  it("skip after the limit would have expired: the run completes and nothing is implemented", async () => {
    const fx = await plan("skip");
    try {
      const result = await fx.runner.run(fx.session, "plan it", undefined, planAgent());
      expect(result.status).toBe("completed");
      expect(currentPlan(fx.store, fx.session)?.status).toBe("skipped");
    } finally {
      fx.close();
    }
  });
});

describe("goal time", () => {
  it("counts the run's active time, never the time spent waiting for the person", () => {
    const outcome = (activeMs?: number) =>
      goalOutcome({
        runId: "r",
        startedAt: 0,
        endedAt: 10 * 60_000,
        cancelled: false,
        result: {
          text: "",
          status: "completed",
          usage: { input: 0, output: 0 },
          ...(activeMs !== undefined ? { activeMs } : {}),
        },
      }).durationMs;
    expect(outcome(90_000)).toBe(90_000);
    expect(outcome()).toBe(10 * 60_000);
  });
});
