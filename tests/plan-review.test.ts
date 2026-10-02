/**
 * Plan review (`exit_plan`) at the core boundary: the tool exists for the plan agent only, no
 * permission mode widens the plan run, every decision returns a tool result (no dangling calls),
 * the artifact is created per revision, headless sessions degrade instead of hanging and an
 * approval starts ONE implementation turn that carries the approved snapshot.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AskQuestionsRequest,
  AskQuestionsResult,
  Message,
  ModelProvider,
  PlanReview,
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
import { createArtifactPublisher } from "../packages/core/src/artifacts/publisher.ts";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import type { ApprovalRequest } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { registerExitPlan } from "../packages/core/src/plan/exit-plan.ts";
import {
  claimApprovedPlan,
  currentPlan,
  discardApprovedPlan,
  implementationPrompt,
  PLAN_OPTIONS,
  PLAN_REVIEW_TITLE,
  planHash,
  proposePlan,
  settlePlanRun,
} from "../packages/core/src/plan/state.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const PLAN = "# Add a flag\n\n## Goal\nShip the flag.\n\n## Steps\n1. Edit `src/a.ts`.\n";
type AssistantMessage = Extract<Message, { role: "assistant" }>;
const assistant = (text: string, calls: ToolCall[] = []): AssistantMessage => ({
  role: "assistant",
  text,
  calls,
});

type Script = (turn: number, messages: Message[]) => AssistantMessage;

async function fixture(options: {
  script: Script;
  /** What the (fake) UI answers; `undefined` = no interactive UI is bound. */
  ui?: (request: AskQuestionsRequest) => Promise<AskQuestionsResult> | AskQuestionsResult;
  readOnly?: boolean;
  diagrams?: () => { enabled: boolean; max: number };
}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-plan-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const registry = new ToolRegistry();
  const ran: string[] = [];
  const effectTool = (name: string, effect: ToolDefinition["effect"]): ToolDefinition => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    effect,
    async execute() {
      ran.push(name);
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  registry.register(effectTool("write_file", "write"));
  registry.register(effectTool("shell", "process"));
  registry.register(effectTool("webfetch", "external"));
  const asked: AskQuestionsRequest[] = [];
  registerExitPlan(registry, {
    store,
    ui: {
      interactive: () => !!options.ui,
      askQuestions: async (request) => {
        asked.push(request);
        return options.ui?.(request) ?? {};
      },
    },
    readOnly: !!options.readOnly,
    ...(options.diagrams ? { diagrams: options.diagrams } : {}),
  });
  const artifacts = new ArtifactStore({ root, db: store.db });
  const events: RunEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const seen: Message[][] = [];
  let turn = 0;
  const provider: ModelProvider = {
    id: "test",
    model: "m",
    async *stream(request) {
      seen.push([...request.messages]);
      yield { type: "completed", message: options.script(turn++, request.messages) };
    },
  };
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    approve: async (request) => {
      approvals.push(request);
      return "once";
    },
    artifacts: (call, announce) =>
      createArtifactPublisher(
        artifacts,
        { sessionId: call.sessionId, rootSessionId: call.sessionId, workspace: root },
        announce,
      ),
    onEvent: (event) => events.push(event),
  });
  const planAgent = resolveActiveAgent(activeAgentCatalog(), "plan");
  const buildAgent = resolveActiveAgent(activeAgentCatalog(), "build");
  return {
    root,
    store,
    registry,
    runner,
    artifacts,
    events,
    approvals,
    asked,
    ran,
    seen,
    planAgent,
    buildAgent,
    session: store.create(root, "test", "m").id,
    close: () => store.close(),
  };
}

const exitPlan = (id: string, plan = PLAN, title?: string): ToolCall => ({
  id,
  name: "exit_plan",
  arguments: JSON.stringify({ plan, ...(title ? { title } : {}) }),
});
const toolResults = (messages: Message[]) =>
  messages.filter((m): m is Extract<Message, { role: "tool" }> => m.role === "tool");
const resultText = (message: Extract<Message, { role: "tool" }>) =>
  message.result.content.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("exit_plan visibility", () => {
  it("is offered to the plan agent's run only", async () => {
    const fx = await fixture({ script: () => assistant("x") });
    try {
      const names = (run: Parameters<AgentRunner["availableTools"]>[0]) =>
        fx.runner.availableTools(run).map((t) => t.name);
      expect(names(agentRunOptions(fx.planAgent))).toContain("exit_plan");
      expect(names(agentRunOptions(fx.buildAgent))).not.toContain("exit_plan");
      expect(names({})).not.toContain("exit_plan");
      expect(names({ ...agentRunOptions(fx.planAgent), toolFilter: () => true })).toContain(
        "exit_plan",
      );
      // A custom agent never gets it, even when it is read-only like the plan agent.
      const custom = {
        id: "reviewer",
        name: "reviewer",
        description: "d",
        readOnly: true,
        source: "user" as const,
      };
      expect(names(agentRunOptions(custom))).not.toContain("exit_plan");
    } finally {
      fx.close();
    }
  });

  it("refuses the call from a run that did not opt in", async () => {
    const fx = await fixture({
      script: (turn) => (turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("done")),
      ui: () => ({ plan: "approve" }),
    });
    try {
      await fx.runner.run(fx.session, "go", undefined, agentRunOptions(fx.buildAgent));
      const [result] = toolResults(fx.store.messages(fx.session));
      expect(result?.result.isError).toBe(true);
      expect(resultText(result as never)).toContain("not available");
      expect(fx.asked).toHaveLength(0);
      expect(currentPlan(fx.store, fx.session)).toBeUndefined();
    } finally {
      fx.close();
    }
  });

  it("cannot be reached from Code Mode", async () => {
    const { runExecute } = await import("../packages/core/src/tools/execute.ts");
    const fx = await fixture({ script: () => assistant("x"), ui: () => ({}) });
    try {
      await expect(
        runExecute('return await callTool("exit_plan", { plan: "# p" })', {
          registry: fx.registry,
          policy: { write: false, process: false, external: false },
          workspace: fx.root,
          signal: new AbortController().signal,
          emit: () => {},
          session: fx.session,
        }),
      ).rejects.toThrow(/not available from execute/);
    } finally {
      fx.close();
    }
  });
});

describe("the plan run stays read-only in every permission mode", () => {
  for (const mode of ["ask", "auto", "full"] as const) {
    it(`${mode}: write, process and external calls are denied by the executor`, async () => {
      const fx = await fixture({
        script: (turn) =>
          turn === 0
            ? assistant("", [
                { id: "w", name: "write_file", arguments: "{}" },
                { id: "p", name: "shell", arguments: "{}" },
                { id: "e", name: "webfetch", arguments: "{}" },
              ])
            : assistant("done"),
      });
      try {
        fx.runner.setPolicy(PERMISSION_MODE_TABLE[mode].policy);
        await fx.runner.run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent));
        expect(fx.ran).toEqual([]);
        expect(fx.approvals).toEqual([]);
        const results = toolResults(fx.store.messages(fx.session));
        expect(results).toHaveLength(3);
        for (const result of results) {
          expect(result.result.isError).toBe(true);
          expect(resultText(result)).toContain("Capability denied");
        }
        // The same runner still executes the write for the build agent under `full`.
        if (mode === "full") {
          const again = await fixture({
            script: (turn) =>
              turn === 0
                ? assistant("", [{ id: "w", name: "write_file", arguments: "{}" }])
                : assistant("ok"),
          });
          try {
            again.runner.setPolicy(PERMISSION_MODE_TABLE.full.policy);
            await again.runner.run(
              again.session,
              "go",
              undefined,
              agentRunOptions(again.buildAgent),
            );
            expect(again.ran).toEqual(["write_file"]);
          } finally {
            again.close();
          }
        }
      } finally {
        fx.close();
      }
    });
  }
});

describe("exit_plan decisions", () => {
  const review = (fx: Awaited<ReturnType<typeof fixture>>): PlanReview => {
    const plan = fx.asked[0]?.plan;
    expect(plan).toBeDefined();
    return plan as PlanReview;
  };
  const run = (
    fx: Awaited<ReturnType<typeof fixture>>,
    calls = [exitPlan("c1", PLAN, "Flag plan")],
  ) =>
    fx.runner
      .run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent))
      .then(() => calls);

  it("shows the plan with the three exact options and records the artifact", async () => {
    const fx = await fixture({
      script: (turn) =>
        turn === 0 ? assistant("", [exitPlan("c1", PLAN, "Flag plan")]) : assistant("ok"),
      ui: () => ({ plan: "skip" }),
    });
    try {
      await run(fx);
      const request = fx.asked[0] as AskQuestionsRequest;
      expect(request.questions[0]?.question).toBe(PLAN_REVIEW_TITLE);
      expect(request.questions[0]?.options.map((o) => o.label)).toEqual([
        "Agree and start implementation",
        "Skip for now",
        "Add context",
      ]);
      expect(request.questions[0]?.options).toEqual(PLAN_OPTIONS);
      expect(review(fx)).toMatchObject({ title: "Flag plan", revision: 1, markdown: PLAN.trim() });
      expect(review(fx).artifact).toMatchObject({ fileName: "plan.md", kind: "document" });
      const published = fx.events.find((e) => e.type === "artifact_published");
      expect(published?.data).toMatchObject({ callId: "c1", artifact: { fileName: "plan.md" } });
      const proposed = fx.events.find((e) => e.type === "plan_proposed");
      expect(proposed?.data).toMatchObject({ callId: "c1", revision: 1, title: "Flag plan" });
      expect(proposed?.eventId).toBeDefined();
    } finally {
      fx.close();
    }
  });

  it("approve: records the snapshot and tells the model to stop", async () => {
    const fx = await fixture({
      script: (turn) =>
        turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("Plan approved."),
      ui: () => ({ plan: "approve" }),
    });
    try {
      await run(fx);
      const [result] = toolResults(fx.store.messages(fx.session));
      expect(JSON.parse(resultText(result as never))).toMatchObject({ decision: "approved" });
      expect(currentPlan(fx.store, fx.session)).toMatchObject({
        status: "approved",
        revision: 1,
        plan: PLAN.trim(),
      });
      expect(fx.events.find((e) => e.type === "plan_decided")?.data).toMatchObject({
        decision: "approve",
        callId: "c1",
      });
      // The agent did not change and nothing was implemented by the plan run.
      expect(fx.store.get(fx.session).options?.agent).toBeUndefined();
      expect(fx.ran).toEqual([]);
    } finally {
      fx.close();
    }
  });

  it("skip: the plan agent stays put and nothing is queued", async () => {
    const fx = await fixture({
      script: (turn) => (turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("Ok.")),
      ui: () => ({ plan: "skip" }),
    });
    try {
      await run(fx);
      const [result] = toolResults(fx.store.messages(fx.session));
      expect(JSON.parse(resultText(result as never))).toMatchObject({ decision: "skipped" });
      expect(currentPlan(fx.store, fx.session)?.status).toBe("skipped");
      expect(claimApprovedPlan(fx.store, fx.session)).toBeUndefined();
    } finally {
      fx.close();
    }
  });

  it("add context: the text goes back as the tool result and the model plans again (revision 2)", async () => {
    let answers = 0;
    const fx = await fixture({
      script: (turn) =>
        turn === 0
          ? assistant("", [exitPlan("c1", PLAN, "First")])
          : turn === 1
            ? assistant("", [exitPlan("c2", `${PLAN}\n3. Add a test.\n`, "Second")])
            : assistant("Done."),
      ui: () =>
        answers++ === 0
          ? { plan: "context", "plan:text": "Also cover Windows paths" }
          : { plan: "skip" },
    });
    try {
      await run(fx);
      const results = toolResults(fx.store.messages(fx.session));
      expect(JSON.parse(resultText(results[0] as never))).toMatchObject({
        decision: "feedback",
        feedback: "Also cover Windows paths",
      });
      expect(fx.asked.map((a) => a.plan?.revision)).toEqual([1, 2]);
      expect(currentPlan(fx.store, fx.session)).toMatchObject({ revision: 2, status: "skipped" });
      // One plan.md artifact per revision, the second one marked as such, both linked to the run.
      const list = fx.artifacts.list(fx.session);
      expect(list.map((a) => a.fileName)).toEqual(["plan.md", "plan.md"]);
      expect(list.map((a) => a.title).sort()).toEqual(["First", "Second (revision 2)"]);
      const decided = fx.events.filter((e) => e.type === "plan_decided").map((e) => e.data);
      expect(decided).toMatchObject([{ decision: "context" }, { decision: "skip" }]);
    } finally {
      fx.close();
    }
  });

  it("add context without text counts as skip", async () => {
    const fx = await fixture({
      script: (turn) => (turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("Ok.")),
      ui: () => ({ plan: "context", "plan:text": "   " }),
    });
    try {
      await run(fx);
      expect(currentPlan(fx.store, fx.session)?.status).toBe("skipped");
    } finally {
      fx.close();
    }
  });

  it("a cancelled or dismissed screen is a skip and leaves no dangling tool call", async () => {
    const controller = new AbortController();
    const fx = await fixture({
      script: (turn) => (turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("Ok.")),
      ui: () => ({ plan: undefined }),
    });
    try {
      await fx.runner.run(fx.session, "plan it", controller.signal, agentRunOptions(fx.planAgent));
      expect(currentPlan(fx.store, fx.session)?.status).toBe("skipped");
      const messages = fx.store.messages(fx.session);
      const calls = messages.flatMap((m) =>
        m.role === "assistant" ? m.calls.map((c) => c.id) : [],
      );
      const answered = toolResults(messages).map((m) => m.callId);
      expect(answered).toEqual(calls);
    } finally {
      fx.close();
    }
  });

  it("a run aborted while the review is pending withdraws it", async () => {
    const controller = new AbortController();
    let release: (value: AskQuestionsResult) => void = () => {};
    const fx = await fixture({
      script: (turn) => (turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("Ok.")),
      ui: (request) =>
        new Promise<AskQuestionsResult>((resolve) => {
          release = resolve;
          request.signal?.addEventListener("abort", () => resolve({ plan: undefined }), {
            once: true,
          });
        }),
    });
    try {
      const running = fx.runner.run(
        fx.session,
        "plan it",
        controller.signal,
        agentRunOptions(fx.planAgent),
      );
      for (let i = 0; i < 200 && currentPlan(fx.store, fx.session)?.status !== "pending"; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(currentPlan(fx.store, fx.session)?.status).toBe("pending");
      controller.abort(new Error("cancelled"));
      await running.catch(() => {});
      release({ plan: "approve" }); // too late: nobody is waiting for it any more
      expect(currentPlan(fx.store, fx.session)?.status).not.toBe("approved");
    } finally {
      controller.abort();
      fx.close();
    }
  });
});

describe("headless and read-only sessions", () => {
  it("does not hang: the plan is saved and the model is told to answer with it", async () => {
    const fx = await fixture({
      script: (turn) => (turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("Final plan.")),
    });
    try {
      await fx.runner.run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent));
      const [result] = toolResults(fx.store.messages(fx.session));
      const parsed = JSON.parse(resultText(result as never));
      expect(parsed.decision).toBe("unavailable");
      expect(parsed.message).toContain("not interactive");
      expect(parsed.message).toContain("final reply");
      expect(fx.asked).toHaveLength(0);
      expect(fx.artifacts.list(fx.session)).toHaveLength(1);
      expect(claimApprovedPlan(fx.store, fx.session)).toBeUndefined();
    } finally {
      fx.close();
    }
  });

  it("read-only sessions never start a review even when a UI is bound", async () => {
    const fx = await fixture({
      script: (turn) => (turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("Final plan.")),
      ui: () => ({ plan: "approve" }),
      readOnly: true,
    });
    try {
      await fx.runner.run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent));
      const [result] = toolResults(fx.store.messages(fx.session));
      expect(JSON.parse(resultText(result as never)).message).toContain("read-only");
      expect(fx.asked).toHaveLength(0);
    } finally {
      fx.close();
    }
  });
});

describe("approval starts one implementation turn", () => {
  it("claims the approved plan exactly once and switches to build in the same transaction", async () => {
    const fx = await fixture({
      script: (turn) =>
        turn === 0 ? assistant("", [exitPlan("c1", PLAN, "Flag plan")]) : assistant("Approved."),
      ui: () => ({ plan: "approve" }),
    });
    try {
      await fx.runner.run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent));
      const claims = [
        claimApprovedPlan(fx.store, fx.session, { agent: "build" }),
        claimApprovedPlan(fx.store, fx.session, { agent: "build" }),
        claimApprovedPlan(fx.store, fx.session, { agent: "build" }),
      ];
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(fx.store.get(fx.session).options).toMatchObject({
        agent: "build",
        plan: { status: "implementing" },
      });
      // The snapshot left the options: it now lives only in the implementation message.
      expect(currentPlan(fx.store, fx.session)).not.toHaveProperty("plan");
    } finally {
      fx.close();
    }
  });

  it("runs the implementation through the normal runner with the plan snapshot, build agent, no dangling calls", async () => {
    const fx = await fixture({
      script: (turn, messages) => {
        if (turn === 0) return assistant("", [exitPlan("c1", PLAN, "Flag plan")]);
        if (turn === 1) return assistant("Approved.");
        // The implementation turn: the build agent writes a file, then finishes.
        const last = messages.at(-1);
        return last?.role === "tool"
          ? assistant("Implemented.")
          : assistant("", [{ id: "w1", name: "write_file", arguments: "{}" }]);
      },
      ui: () => ({ plan: "approve" }),
    });
    try {
      fx.runner.setPolicy(PERMISSION_MODE_TABLE.full.policy);
      await fx.runner.run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent));
      expect(fx.ran).toEqual([]);
      const claimed = claimApprovedPlan(fx.store, fx.session, { agent: "build" });
      expect(claimed).toBeDefined();
      const { text, display } = implementationPrompt(claimed as NonNullable<typeof claimed>);
      await fx.runner.run(fx.session, text, undefined, {
        ...agentRunOptions(fx.buildAgent),
        display,
      });
      expect(fx.ran).toEqual(["write_file"]);
      const messages = fx.store.messages(fx.session);
      const user = messages.filter((m) => m.role === "user").at(-1);
      expect(user).toMatchObject({
        role: "user",
        display: "Implement the approved plan: Flag plan",
      });
      expect((user as { text: string }).text).toContain("<approved_plan");
      expect((user as { text: string }).text).toContain("Edit `src/a.ts`.");
      // Tool call ids are preserved: every call has exactly one result, in order.
      const calls = messages.flatMap((m) =>
        m.role === "assistant" ? m.calls.map((c) => c.id) : [],
      );
      expect(toolResults(messages).map((m) => m.callId)).toEqual(calls);
      expect(calls).toEqual(["c1", "w1"]);
    } finally {
      fx.close();
    }
  });

  it("a cancelled run never starts the implementation", async () => {
    const fx = await fixture({
      script: (turn) => (turn === 0 ? assistant("", [exitPlan("c1")]) : assistant("Approved.")),
      ui: () => ({ plan: "approve" }),
    });
    try {
      await fx.runner.run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent));
      expect(discardApprovedPlan(fx.store, fx.session)).toBe(true);
      expect(currentPlan(fx.store, fx.session)?.status).toBe("cancelled");
      expect(claimApprovedPlan(fx.store, fx.session)).toBeUndefined();
      expect(discardApprovedPlan(fx.store, fx.session)).toBe(false);
    } finally {
      fx.close();
    }
  });
});

describe("settling a plan when its run ends (shared by the TUI and the server)", () => {
  const approved = async (decision: "approve" | "skip") => {
    const fx = await fixture({
      script: (turn) =>
        turn === 0 ? assistant("", [exitPlan("c1", PLAN, "Flag plan")]) : assistant("Ok."),
      ui: () => ({ plan: decision }),
    });
    await fx.runner.run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent));
    return fx;
  };

  it("approved: one implement result, whatever number of hosts or retries ask", async () => {
    const fx = await approved("approve");
    try {
      const results = [1, 2, 3].map(() => settlePlanRun(fx.store, fx.session, { aborted: false }));
      expect(results.map((r) => r.kind)).toEqual(["implement", "none", "none"]);
      const first = results[0];
      if (first?.kind !== "implement") throw new Error("expected implement");
      expect(first.display).toBe("Implement the approved plan: Flag plan");
      expect(first.text).toContain(PLAN.trim());
    } finally {
      fx.close();
    }
  });

  it("cancelled run: the approval is dropped, nothing is implemented later", async () => {
    const fx = await approved("approve");
    try {
      expect(settlePlanRun(fx.store, fx.session, { aborted: true }).kind).toBe("dropped");
      expect(settlePlanRun(fx.store, fx.session, { aborted: false }).kind).toBe("none");
    } finally {
      fx.close();
    }
  });

  it("skip and unanswered reviews never implement; an unanswered one counts as skipped", async () => {
    const fx = await approved("skip");
    try {
      expect(settlePlanRun(fx.store, fx.session, { aborted: false }).kind).toBe("none");
      proposePlan(fx.store, fx.session, { planId: "p2", revision: 2, hash: "h", title: "t" });
      expect(currentPlan(fx.store, fx.session)?.status).toBe("pending");
      expect(settlePlanRun(fx.store, fx.session, { aborted: false }).kind).toBe("none");
      expect(currentPlan(fx.store, fx.session)?.status).toBe("skipped");
    } finally {
      fx.close();
    }
  });
});

const FLOW = "flowchart LR\n  a([Request]):::input --> b[API]:::system --> c[(Store)]:::data";
const SEQUENCE =
  "sequenceDiagram\n  participant U as User\n  participant A as API\n  U->>A: ask\n  A-->>U: answer";
const diagramCall = (id: string, diagrams: unknown[], plan = PLAN): ToolCall => ({
  id,
  name: "exit_plan",
  arguments: JSON.stringify({ plan, title: "Flag plan", diagrams }),
});
const diagram = (id: string, mermaid = FLOW, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Diagram ${id}`,
  explanation: `What ${id} shows.`,
  section: "Steps",
  mermaid,
  ...extra,
});

describe("exit_plan with diagrams", () => {
  const onePlan = (
    calls: ToolCall[][],
    answers: Array<Record<string, string>>,
    extra: { diagrams?: () => { enabled: boolean; max: number }; ui?: boolean } = {},
  ) => {
    let answered = 0;
    return fixture({
      script: (turn) => (turn < calls.length ? assistant("", calls[turn]) : assistant("Done.")),
      ...(extra.ui === false
        ? {}
        : { ui: () => answers[Math.min(answered++, answers.length - 1)] ?? { plan: "skip" } }),
      ...(extra.diagrams ? { diagrams: extra.diagrams } : {}),
    });
  };
  const runPlan = (fx: Awaited<ReturnType<typeof fixture>>) =>
    fx.runner.run(fx.session, "plan it", undefined, agentRunOptions(fx.planAgent));

  it("a call without diagrams keeps the single plan.md artifact and the old result", async () => {
    const fx = await onePlan([[exitPlan("c1")]], [{ plan: "skip" }]);
    try {
      await runPlan(fx);
      const [artifact] = fx.artifacts.list(fx.session);
      expect(artifact).toMatchObject({ fileName: "plan.md", kind: "document", fileCount: 1 });
      const result = JSON.parse(resultText(toolResults(fx.store.messages(fx.session))[0] as never));
      expect(result).not.toHaveProperty("diagrams");
      expect(fx.asked[0]?.plan).not.toHaveProperty("diagrams");
      expect(currentPlan(fx.store, fx.session)?.hash).toBe(planHash(PLAN.trim()));
    } finally {
      fx.close();
    }
  });

  it("publishes one folder artifact: entry plan.md, plan.json and diagrams/*.mmd, kind document", async () => {
    const fx = await onePlan(
      [
        [
          diagramCall("c1", [
            diagram("request-flow"),
            diagram("talk", SEQUENCE, { section: "Goal" }),
          ]),
        ],
      ],
      [{ plan: "skip" }],
    );
    try {
      await runPlan(fx);
      const list = fx.artifacts.list(fx.session);
      expect(list).toHaveLength(1);
      const record = list[0] as NonNullable<(typeof list)[number]>;
      expect(record).toMatchObject({
        kind: "document",
        fileName: "plan.md",
        entry: "plan.md",
        fileCount: 4,
        previewable: true,
      });
      const files = (await fx.artifacts.files(record)).map((f) => f.path).sort();
      expect(files).toEqual([
        "diagrams/request-flow.mmd",
        "diagrams/talk.mmd",
        "plan.json",
        "plan.md",
      ]);
      const manifestFile = await fx.artifacts.resolveFile(record, "plan.json");
      const manifest = JSON.parse(await readFile((manifestFile as { abs: string }).abs, "utf8"));
      expect(manifest).toMatchObject({
        version: 1,
        revision: 1,
        title: "Flag plan",
        diagrams: [
          { id: "request-flow", section: "steps", status: "new", syntax: "flowchart" },
          { id: "talk", section: "goal", type: "sequence", status: "new" },
        ],
      });
      // The review carries the diagrams (terminals show the source) and the folder artifact.
      expect(fx.asked[0]?.plan).toMatchObject({
        artifact: { id: record.id },
        diagrams: [{ id: "request-flow", mermaid: FLOW }, { id: "talk" }],
      });
      const result = JSON.parse(resultText(toolResults(fx.store.messages(fx.session))[0] as never));
      expect(result.diagrams).toEqual({ accepted: ["request-flow", "talk"] });
    } finally {
      fx.close();
    }
  });

  it("drops invalid diagrams with a reason and still publishes the plan and the review", async () => {
    const fx = await onePlan(
      [
        [
          diagramCall("c1", [
            diagram("ok"),
            diagram("evil", `${FLOW}\n  click a "https://x.test"`),
            diagram("Bad Id"),
            diagram("ok", FLOW),
          ]),
        ],
      ],
      [{ plan: "approve" }],
    );
    try {
      await runPlan(fx);
      const result = JSON.parse(resultText(toolResults(fx.store.messages(fx.session))[0] as never));
      expect(result.decision).toBe("approved");
      expect(result.diagrams.accepted).toEqual(["ok"]);
      expect(result.diagrams.dropped.map((d: { id: string }) => d.id)).toEqual([
        "evil",
        "Bad Id",
        "ok",
      ]);
      expect(result.diagrams.dropped[0].reason).toMatch(/click/);
      expect(fx.artifacts.list(fx.session)).toHaveLength(1);
      expect(claimApprovedPlan(fx.store, fx.session)).toMatchObject({ status: "implementing" });
    } finally {
      fx.close();
    }
  });

  it("when every diagram is dropped the plan is the plain plan.md artifact", async () => {
    const fx = await onePlan(
      [[diagramCall("c1", [diagram("bad", "pie\n  title x\n  a: 1")])]],
      [{ plan: "skip" }],
    );
    try {
      await runPlan(fx);
      expect(fx.artifacts.list(fx.session)[0]).toMatchObject({ fileCount: 1, fileName: "plan.md" });
      const result = JSON.parse(resultText(toolResults(fx.store.messages(fx.session))[0] as never));
      expect(result.diagrams).toMatchObject({ accepted: [], dropped: [{ id: "bad" }] });
    } finally {
      fx.close();
    }
  });

  it("respects plan.maxDiagrams and plan.diagrams: false", async () => {
    const calls = [[diagramCall("c1", [diagram("a"), diagram("b"), diagram("c")])]];
    const capped = await onePlan(calls, [{ plan: "skip" }], {
      diagrams: () => ({ enabled: true, max: 2 }),
    });
    try {
      await runPlan(capped);
      const result = JSON.parse(
        resultText(toolResults(capped.store.messages(capped.session))[0] as never),
      );
      expect(result.diagrams.accepted).toEqual(["a", "b"]);
      expect(result.diagrams.dropped).toMatchObject([
        { id: "c", reason: expect.stringContaining("2 diagrams") },
      ]);
    } finally {
      capped.close();
    }
    const off = await onePlan(calls, [{ plan: "skip" }], {
      diagrams: () => ({ enabled: false, max: 0 }),
    });
    try {
      await runPlan(off);
      expect(off.artifacts.list(off.session)[0]).toMatchObject({ fileCount: 1 });
      const result = JSON.parse(
        resultText(toolResults(off.store.messages(off.session))[0] as never),
      );
      expect(result.diagrams.accepted).toEqual([]);
      expect(result.diagrams.dropped[0].reason).toContain("plan.diagrams");
      // The schema offered to the model no longer has the field.
      const tool = off.registry.get("exit_plan");
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual([
        "title",
        "plan",
      ]);
      expect(tool.description).not.toContain("diagrams");
    } finally {
      off.close();
    }
  });

  it("offers the diagrams field while they are on", async () => {
    const fx = await onePlan([[exitPlan("c1")]], [{ plan: "skip" }]);
    try {
      const tool = fx.registry.get("exit_plan");
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual([
        "title",
        "plan",
        "diagrams",
      ]);
      expect(tool.description).toContain("up to 5");
    } finally {
      fx.close();
    }
  });

  it("a revision diffs against the previous one: new, updated, unchanged and removed", async () => {
    const fx = await onePlan(
      [
        [diagramCall("c1", [diagram("keep"), diagram("change"), diagram("gone")])],
        [
          diagramCall("c2", [
            diagram("keep"),
            diagram("change", `${FLOW} --> d[Extra]`),
            diagram("fresh", SEQUENCE),
          ]),
        ],
      ],
      [{ plan: "context", "plan:text": "revise" }, { plan: "skip" }],
    );
    try {
      await runPlan(fx);
      const [second, first] = fx.artifacts.list(fx.session);
      const manifest = JSON.parse(
        await readFile(
          ((await fx.artifacts.resolveFile(second as never, "plan.json")) as { abs: string }).abs,
          "utf8",
        ),
      );
      expect(manifest.revision).toBe(2);
      expect(
        Object.fromEntries(
          manifest.diagrams.map((d: { id: string; status: string }) => [d.id, d.status]),
        ),
      ).toEqual({
        keep: "unchanged",
        change: "updated",
        fresh: "new",
      });
      expect(manifest.removed).toEqual([{ id: "gone", title: "Diagram gone" }]);
      expect(first).toBeDefined();
      const results = toolResults(fx.store.messages(fx.session));
      const second_result = JSON.parse(resultText(results[1] as never));
      expect(second_result.diagrams).toMatchObject({ removed: ["gone"] });
      expect(JSON.parse(resultText(results[0] as never)).message).toContain(
        "every diagram that still applies",
      );
    } finally {
      fx.close();
    }
  });

  it("a change in a diagram alone changes the plan hash; the Markdown alone keeps the old hash", async () => {
    const fx = await onePlan(
      [
        [diagramCall("c1", [diagram("a")])],
        [diagramCall("c2", [diagram("a", `${FLOW} --> d[More]`)])],
      ],
      [{ plan: "context", "plan:text": "again" }, { plan: "skip" }],
    );
    try {
      await runPlan(fx);
      const [one, two] = fx.asked.map((request) => request.plan as PlanReview);
      expect(one?.markdown).toBe(two?.markdown);
      expect(one?.hash).not.toBe(two?.hash);
      expect(one?.hash).not.toBe(planHash(PLAN.trim()));
    } finally {
      fx.close();
    }
  });

  it("when the diagrams are removed in a revision, the folder keeps the removed ids", async () => {
    const fx = await onePlan(
      [[diagramCall("c1", [diagram("a")])], [exitPlan("c2")]],
      [{ plan: "context", "plan:text": "drop it" }, { plan: "skip" }],
    );
    try {
      await runPlan(fx);
      const [second] = fx.artifacts.list(fx.session);
      expect(second).toMatchObject({ entry: "plan.md", fileCount: 2 });
      const manifest = JSON.parse(
        await readFile(
          ((await fx.artifacts.resolveFile(second as never, "plan.json")) as { abs: string }).abs,
          "utf8",
        ),
      );
      expect(manifest).toMatchObject({ diagrams: [], removed: [{ id: "a" }] });
    } finally {
      fx.close();
    }
  });

  it("headless sessions still write the folder and degrade to text", async () => {
    const fx = await onePlan([[diagramCall("c1", [diagram("a")])]], [], { ui: false });
    try {
      await runPlan(fx);
      const result = JSON.parse(resultText(toolResults(fx.store.messages(fx.session))[0] as never));
      expect(result).toMatchObject({ decision: "unavailable", diagrams: { accepted: ["a"] } });
      expect(fx.artifacts.list(fx.session)[0]).toMatchObject({ entry: "plan.md", fileCount: 3 });
      expect(fx.asked).toHaveLength(0);
    } finally {
      fx.close();
    }
  });
});
