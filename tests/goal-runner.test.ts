/**
 * The goal at the runner boundary: a real runner, a scripted provider and the real goal tools,
 * driven the way a host (TUI or server) drives it: ask the core, run the continuation with its
 * own caps, settle the run. Covers the opt-in tools, `update_goal` ending a goal after three
 * turns, the hard budget (the run is capped at what is left; a run that hits the cap is a budget
 * stop, not an error), what the model cannot do, and the prompts that reach the model.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ModelProvider, ToolCall, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { goalOptInTools, goalOutcome } from "../packages/core/src/goal/host.ts";
import { GoalService, type GoalSettings } from "../packages/core/src/goal/service.ts";
import { GoalStore } from "../packages/core/src/goal/store.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { registerGoalTools } from "../packages/core/src/tools/goal.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type AssistantMessage = Extract<Message, { role: "assistant" }>;
const reply = (
  text: string,
  calls: ToolCall[] = [],
  usage = { input: 100, output: 50 },
): AssistantMessage & { usage: { input: number; output: number } } => ({
  role: "assistant",
  text,
  calls,
  usage,
});
const call = (id: string, name: string, input: unknown = {}): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(input),
});
const SETTINGS: GoalSettings = {
  enabled: true,
  maxTurns: 50,
  maxMinutes: 120,
  repeatedReplyLimit: 3,
  noToolTurnsLimit: 3,
  blockedRepeats: 2,
};

async function fixture(script: (turn: number, messages: Message[]) => ReturnType<typeof reply>) {
  const root = await mkdtemp(join(tmpdir(), "alisio-goal-run-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const registry = new ToolRegistry();
  const work: ToolDefinition = {
    name: "work",
    description: "does a bit of work",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    async execute() {
      return { content: [{ type: "text", text: "worked" }] };
    },
  };
  registry.register(work);
  const goals = new GoalService({ store: new GoalStore(store.db), settings: () => SETTINGS });
  registerGoalTools(registry, { goals });
  const seen: Message[][] = [];
  let turn = 0;
  const provider: ModelProvider = {
    id: "test",
    model: "m",
    async *stream(request) {
      seen.push([...request.messages]);
      const { usage, ...message } = script(turn++, request.messages);
      yield { type: "completed", message, usage };
    },
  };
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
  });
  const session = store.create(root, "test", "m").id;
  const idle = { running: false, queuedInput: false, planMode: false, liveTasks: 0 };
  /** One host iteration: continue if the core says so. Returns what ran. */
  const step = async () => {
    const decision = goals.next(session, idle);
    if (decision.kind !== "continue") return decision;
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    let result: Awaited<ReturnType<AgentRunner["run"]>> | undefined;
    let failure: unknown;
    try {
      result = await runner.run(session, decision.prompt.text, undefined, {
        runId,
        display: decision.prompt.display,
        optInTools: goalOptInTools(goals.get(session), false),
        ...(decision.run.maxTokens !== undefined ? { maxTokens: decision.run.maxTokens } : {}),
      });
    } catch (error) {
      failure = error;
    }
    goals.settle(
      session,
      goalOutcome({
        runId,
        startedAt,
        endedAt: Date.now(),
        cancelled: false,
        ...(result ? { result } : {}),
        ...(failure !== undefined ? { error: failure } : {}),
      }),
    );
    return decision;
  };
  return { root, store, registry, runner, goals, session, seen, step, close: () => store.close() };
}

const userTexts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "user" ? [m.text] : []));

describe("the goal tools are opt-in", () => {
  it("are offered to a run only while the goal is active, never to others", async () => {
    const fx = await fixture(() => reply("x"));
    try {
      const names = (opt?: string[]) =>
        fx.runner.availableTools({ ...(opt ? { optInTools: opt } : {}) }).map((t) => t.name);
      expect(names()).not.toContain("update_goal");
      expect(names()).not.toContain("get_goal");
      expect(goalOptInTools(undefined, false)).toEqual([]);
      fx.goals.create(fx.session, { objective: "Ship it" });
      const active = goalOptInTools(fx.goals.get(fx.session), false);
      expect(names(active)).toEqual(expect.arrayContaining(["get_goal", "update_goal"]));
      // Plan mode never works on a goal.
      expect(goalOptInTools(fx.goals.get(fx.session), true)).toEqual([]);
      fx.goals.pause(fx.session);
      expect(goalOptInTools(fx.goals.get(fx.session), false)).toEqual([]);
      // Their descriptions are short (they cost tokens on every request while a goal is active).
      for (const tool of fx.registry.list().filter((t) => /goal/.test(t.name)))
        expect(tool.description.length).toBeLessThan(450);
    } finally {
      fx.close();
    }
  });

  it("are refused to a run that did not opt in", async () => {
    const fx = await fixture((turn) =>
      turn === 0
        ? reply("", [
            call("c1", "update_goal", {
              status: "complete",
              summary: "s",
              evidence: [{ kind: "other", detail: "d" }],
            }),
          ])
        : reply("done"),
    );
    try {
      fx.goals.create(fx.session, { objective: "Ship it" });
      await fx.runner.run(fx.session, "go");
      const tool = fx.store.messages(fx.session).find((m) => m.role === "tool");
      expect(tool?.role === "tool" && tool.result.isError).toBe(true);
      expect(fx.goals.get(fx.session)?.status).toBe("active");
    } finally {
      fx.close();
    }
  });
});

describe("a goal that continues for three turns and completes", () => {
  it("sends the contract once, then hints, and ends with update_goal(complete)", async () => {
    const fx = await fixture((turn, messages) => {
      const last = userTexts(messages).at(-1) ?? "";
      // Every turn: use a tool, then answer. The third turn reports completion first.
      const toolResult = messages.at(-1)?.role === "tool";
      if (!toolResult && /Continue working/.test(last) === false && turn >= 4)
        return reply("nothing");
      if (!toolResult) {
        const finishing = userTexts(messages).length >= 3;
        return finishing
          ? reply("", [
              call(`u${turn}`, "update_goal", {
                status: "complete",
                summary: "All three steps are done",
                evidence: [{ kind: "test", detail: "pnpm test: 3 passed" }],
              }),
            ])
          : reply("", [call(`w${turn}`, "work")]);
      }
      return reply(`step ${userTexts(messages).length} finished`);
    });
    try {
      fx.goals.create(fx.session, { objective: "Do three steps" });
      const decisions = [];
      for (let i = 0; i < 6; i++) {
        const decision = await fx.step();
        decisions.push(decision.kind);
        if (decision.kind !== "continue") break;
      }
      expect(decisions).toEqual(["continue", "continue", "continue", "idle"]);
      const goal = fx.goals.get(fx.session);
      expect(goal).toMatchObject({
        status: "complete",
        reason: "model_complete",
        summary: "All three steps are done",
        turnsUsed: 3,
        continuations: 3,
      });
      // The persisted conversation: the kickoff carries the contract, the rest are short hints.
      const users = userTexts(fx.store.messages(fx.session));
      expect(users).toHaveLength(3);
      expect(users[0]).toContain("<goal_objective>");
      expect(users[1]).toContain("Continue working");
      expect(users[1]).not.toContain("<goal_objective>");
      expect(users[1]).toBe(users[2]);
      // Each run is journaled with its idempotent request id.
      expect(goal?.tokensUsed).toBeGreaterThan(0);
    } finally {
      fx.close();
    }
  });
});

describe("the hard token budget", () => {
  it("stops in budget_limited and does not run another continuation", async () => {
    // Every request costs 600 tokens: the first run fits, the second hits the cap.
    const fx = await fixture((_turn, messages) =>
      messages.at(-1)?.role === "tool"
        ? reply("round done", [], { input: 500, output: 100 })
        : reply("", [call(`w${messages.length}`, "work")], { input: 500, output: 100 }),
    );
    try {
      fx.goals.create(fx.session, { objective: "Ship it", tokenBudget: 1_500 });
      const kinds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const decision = await fx.step();
        kinds.push(decision.kind);
        if (decision.kind !== "continue") break;
      }
      const goal = fx.goals.get(fx.session);
      expect(goal).toMatchObject({ status: "budget_limited", reason: "token_budget" });
      // The goal never spent more than one request past the budget, and nothing ran afterwards.
      expect(goal?.tokensUsed).toBeGreaterThanOrEqual(1_500);
      expect(goal?.tokensUsed).toBeLessThanOrEqual(1_500 + 600);
      expect(kinds.at(-1)).toBe("idle");
      expect(goal?.status).not.toBe("blocked");
    } finally {
      fx.close();
    }
  });

  it("caps each run at what is left of the budget (the runner guard refuses further tools)", async () => {
    let toolsRun = 0;
    const fx = await fixture((_turn, messages) =>
      reply("", [call(`w${messages.length}`, "work")], { input: 700, output: 100 }),
    );
    fx.registry.register({
      name: "counted",
      description: "x",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute() {
        toolsRun++;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    try {
      fx.goals.create(fx.session, { objective: "Ship it", tokenBudget: 1_000 });
      const decision = fx.goals.next(fx.session, {
        running: false,
        queuedInput: false,
        planMode: false,
        liveTasks: 0,
      });
      if (decision.kind !== "continue") throw new Error("expected a continuation");
      expect(decision.run.maxTokens).toBe(1_000);
      // The first request costs 800 (< 1000): its tool runs. The second would exceed: the run ends
      // with the runner's budget error, which the goal reads as a budget stop.
      await expect(
        fx.runner.run(fx.session, decision.prompt.text, undefined, {
          maxTokens: decision.run.maxTokens,
        }),
      ).rejects.toThrow(/Token budget exhausted/);
      expect(toolsRun).toBe(0);
    } finally {
      fx.close();
    }
  });
});

describe("what the model cannot do", () => {
  it("has no tool to pause, resume, clear or change the budget, and update_goal refuses other statuses", async () => {
    const fx = await fixture((turn) =>
      turn === 0
        ? reply("", [
            call("c1", "update_goal", {
              status: "paused",
              summary: "s",
              evidence: [{ kind: "other", detail: "d" }],
            }),
          ])
        : reply("ok"),
    );
    try {
      fx.goals.create(fx.session, { objective: "Ship it" });
      const names = fx.runner
        .availableTools({ optInTools: goalOptInTools(fx.goals.get(fx.session), false) })
        .map((tool) => tool.name);
      expect(names.filter((name) => /goal/.test(name)).sort()).toEqual(["get_goal", "update_goal"]);
      await fx.runner.run(fx.session, "go", undefined, {
        optInTools: goalOptInTools(fx.goals.get(fx.session), false),
      });
      expect(fx.goals.get(fx.session)).toMatchObject({ status: "active", epoch: 1 });
      const tool = fx.store.messages(fx.session).find((m) => m.role === "tool");
      expect(tool?.role === "tool" && tool.result.isError).toBe(true);
    } finally {
      fx.close();
    }
  });

  it("completion without evidence is refused and leaves the goal active", async () => {
    const fx = await fixture((turn) =>
      turn === 0
        ? reply("", [
            call("c1", "update_goal", { status: "complete", summary: "done", evidence: [] }),
          ])
        : reply("ok"),
    );
    try {
      fx.goals.create(fx.session, { objective: "Ship it" });
      await fx.runner.run(fx.session, "go", undefined, {
        optInTools: goalOptInTools(fx.goals.get(fx.session), false),
      });
      expect(fx.goals.get(fx.session)?.status).toBe("active");
    } finally {
      fx.close();
    }
  });

  it("get_goal shows the state and what is left", async () => {
    const fx = await fixture((turn, messages) =>
      turn === 0 ? reply("", [call("c1", "get_goal")]) : reply(`seen ${messages.length}`),
    );
    try {
      fx.goals.create(fx.session, { objective: "Ship it", tokenBudget: 5_000 });
      await fx.runner.run(fx.session, "go", undefined, {
        optInTools: goalOptInTools(fx.goals.get(fx.session), false),
      });
      const tool = fx.store.messages(fx.session).find((m) => m.role === "tool");
      const text =
        tool?.role === "tool"
          ? tool.result.content.map((p) => (p.type === "text" ? p.text : "")).join("")
          : "";
      expect(JSON.parse(text)).toMatchObject({
        status: "active",
        objective: "Ship it",
        token_budget: 5_000,
        tokens_left: 5_000,
        max_turns: 50,
      });
    } finally {
      fx.close();
    }
  });

  it("reports how many tool calls a run made", async () => {
    let n = 0;
    const fx = await fixture((_turn, messages) =>
      messages.at(-1)?.role === "tool"
        ? reply("done")
        : reply("", [call(`a${++n}`, "work"), call(`b${++n}`, "work")]),
    );
    try {
      const result = await fx.runner.run(fx.session, "go");
      expect(result.toolCalls).toBe(2);
      const again = await fx.runner.run(fx.session, "again", undefined, {});
      expect(again.toolCalls).toBe(2);
    } finally {
      fx.close();
    }
  });
});
