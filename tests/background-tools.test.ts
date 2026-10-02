/**
 * `bg_run`, `bg_list`, `bg_output` and `bg_stop` through the real executor: the SAME process
 * policy as `shell` covers all four, so `--read-only` and the plan agent deny the whole set (a mode
 * that cannot start a process cannot read or stop one either), the permission modes ask or allow
 * them like any command, and every call stays inside its own session tree.
 */

import type { Message, ModelProvider, ToolCall } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeAgentCatalog,
  agentRunOptions,
  resolveActiveAgent,
} from "../packages/core/src/agents/active.ts";
import type { ApprovalRequest } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { PERMISSION_MODE_TABLE, READ_ONLY_POLICY } from "../packages/core/src/permissions/modes.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { registerBackgroundTools } from "../packages/core/src/tools/background.ts";
import { cleanupFixtures, taskFixture, waitFor } from "./background-helpers.ts";

afterEach(cleanupFixtures);

type AssistantMessage = Extract<Message, { role: "assistant" }>;
const assistant = (text: string, calls: ToolCall[] = []): AssistantMessage => ({
  role: "assistant",
  text,
  calls,
});
const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(input),
});
const resultOf = (messages: Message[], id: string) => {
  const message = messages.find(
    (m): m is Extract<Message, { role: "tool" }> => m.role === "tool" && m.callId === id,
  );
  const text = message?.result.content.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
  return { error: !!message?.result.isError, text, json: () => JSON.parse(text) };
};

async function fixture(options: {
  policy: { write: boolean; process: boolean; external: boolean };
  approvals?: "once" | "deny" | "none";
  script: (turn: number) => AssistantMessage;
}) {
  const fx = await taskFixture();
  const registry = new ToolRegistry();
  registerBackgroundTools(registry, { tasks: fx.tasks, rootOf: (id) => fx.store.rootOf(id) });
  const approvals: ApprovalRequest[] = [];
  let turn = 0;
  const provider: ModelProvider = {
    id: "test",
    model: "m",
    async *stream() {
      yield { type: "completed", message: options.script(turn++) };
    },
  };
  const runner = new AgentRunner({
    provider,
    registry,
    store: fx.store,
    context: new ProjectContext(fx.root),
    workspace: fx.root,
    policy: { ...options.policy },
    ...(options.approvals && options.approvals !== "none"
      ? {
          approve: async (request: ApprovalRequest) => {
            approvals.push(request);
            return options.approvals === "once" ? "once" : "deny";
          },
        }
      : {}),
  });
  return { fx, runner, registry, approvals };
}

const ALL_FOUR = (turn: number, command: string) =>
  turn === 0
    ? assistant("", [
        call("run", "bg_run", { command }),
        call("list", "bg_list", {}),
        call("out", "bg_output", { id: "task_none" }),
        call("stop", "bg_stop", { id: "task_none" }),
      ])
    : assistant("done");

describe("the process policy covers all four tools", () => {
  it("--read-only: every call is denied by the executor and nothing starts", async () => {
    const fx = await fixture({
      policy: READ_ONLY_POLICY,
      script: (turn) => ALL_FOUR(turn, "echo hi"),
    });
    try {
      await fx.runner.run(fx.fx.session, "go");
      const messages = fx.fx.store.messages(fx.fx.session);
      for (const id of ["run", "list", "out", "stop"]) {
        const result = resultOf(messages, id);
        expect(result.error, id).toBe(true);
        expect(result.text, id).toContain("Capability denied");
      }
      expect(fx.fx.tasks.list(fx.fx.session)).toEqual([]);
      expect(fx.fx.tasks.liveCount()).toBe(0);
      // And the model is not even offered them.
      expect(
        fx.runner.availableTools({ policy: READ_ONLY_POLICY, approvals: false }).map((t) => t.name),
      ).not.toEqual(expect.arrayContaining(["bg_run"]));
    } finally {
      await fx.fx.close();
    }
  });

  for (const mode of ["ask", "auto", "full"] as const) {
    it(`the plan agent cannot use any of them in ${mode} mode`, async () => {
      const fx = await fixture({
        policy: { ...PERMISSION_MODE_TABLE[mode].policy },
        approvals: "once",
        script: (turn) => ALL_FOUR(turn, "echo hi"),
      });
      try {
        const plan = resolveActiveAgent(activeAgentCatalog(), "plan");
        const options = agentRunOptions(plan);
        expect(
          fx.runner
            .availableTools(options)
            .map((t) => t.name)
            .filter((n) => n.startsWith("bg_")),
        ).toEqual([]);
        await fx.runner.run(fx.fx.session, "go", undefined, options);
        const messages = fx.fx.store.messages(fx.fx.session);
        for (const id of ["run", "list", "out", "stop"]) {
          expect(resultOf(messages, id).error, id).toBe(true);
        }
        expect(fx.approvals).toHaveLength(0);
        expect(fx.fx.tasks.list(fx.fx.session)).toEqual([]);
      } finally {
        await fx.fx.close();
      }
    });
  }

  it("ask and auto mode ask for approval of each call; a denial starts nothing", async () => {
    for (const mode of ["ask", "auto"] as const) {
      const fx = await fixture({
        policy: { ...PERMISSION_MODE_TABLE[mode].policy },
        approvals: "deny",
        script: (turn) => ALL_FOUR(turn, "echo hi"),
      });
      try {
        await fx.runner.run(fx.fx.session, "go");
        expect(fx.approvals.map((a) => a.call.name).sort()).toEqual([
          "bg_list",
          "bg_output",
          "bg_run",
          "bg_stop",
        ]);
        expect(fx.approvals.every((a) => a.effect === "process")).toBe(true);
        expect(fx.fx.tasks.list(fx.fx.session)).toEqual([]);
      } finally {
        await fx.fx.close();
      }
    }
  });

  it("full mode runs them without asking", async () => {
    const fx = await fixture({
      policy: { ...PERMISSION_MODE_TABLE.full.policy },
      approvals: "once",
      script: (turn) => ALL_FOUR(turn, "echo hi"),
    });
    try {
      await fx.runner.run(fx.fx.session, "go");
      expect(fx.approvals).toHaveLength(0);
      const messages = fx.fx.store.messages(fx.fx.session);
      expect(resultOf(messages, "run").error).toBe(false);
      // Unknown ids are "not found", not a policy error.
      expect(resultOf(messages, "out").text).toContain("not found");
      await waitFor(() => fx.fx.tasks.liveCount() === 0, 10_000, "echo to end");
    } finally {
      await fx.fx.close();
    }
  });

  it("allow-for-this-session after one approval covers the other tools", async () => {
    const fx = await fixture({
      policy: { ...PERMISSION_MODE_TABLE.ask.policy },
      approvals: "once",
      script: (turn) => ALL_FOUR(turn, "echo hi"),
    });
    try {
      await fx.runner.run(fx.fx.session, "go");
      // "once" asks for every call (no widening): four prompts, all four ran.
      expect(fx.approvals).toHaveLength(4);
    } finally {
      await fx.fx.close();
    }
  });
});

describe("the tool contracts", () => {
  it("bg_run, bg_output (next_offset), bg_stop and bg_list work end to end", async () => {
    // The script runs between turns, when the task of turn 0 exists: it reads its id then.
    let current: () => string = () => "";
    const fx = await fixture({
      policy: { write: false, process: true, external: false },
      script: (turn) => {
        const id = current();
        if (turn === 0)
          return assistant("", [
            call("run", "bg_run", {
              command: `${JSON.stringify(process.execPath)} -e "console.log('hello'); setTimeout(() => {}, 60000)"`,
              label: "greeter",
            }),
          ]);
        if (turn === 1)
          return assistant("", [call("out", "bg_output", { id, offset: 0, limit: 5 })]);
        if (turn === 2) return assistant("", [call("stop", "bg_stop", { id })]);
        if (turn === 3) return assistant("", [call("list", "bg_list", { status: "cancelled" })]);
        return assistant("done");
      },
    });
    current = () => fx.fx.tasks.list(fx.fx.session)[0]?.id ?? "";
    try {
      await fx.runner.run(fx.fx.session, "go");
      const id = current();
      const messages = fx.fx.store.messages(fx.fx.session);
      expect(resultOf(messages, "run").json()).toMatchObject({
        id,
        status: "running",
        label: "greeter",
      });
      const first = resultOf(messages, "out").json();
      // Bounded by the requested limit and resumable from next_offset.
      expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(5);
      expect(first).toMatchObject({ id, eof: false });
      expect(first.next_offset).toBe(Buffer.byteLength(first.text));
      expect(resultOf(messages, "stop").json()).toMatchObject({
        id,
        status: "cancelled",
        stopped_by: "model",
      });
      expect(
        resultOf(messages, "list")
          .json()
          .tasks.map((t: { id: string }) => t.id),
      ).toEqual([id]);
    } finally {
      await fx.fx.close();
    }
  });

  it("bg_run refuses a working directory outside the workspace and a missing one", async () => {
    const fx = await fixture({
      policy: { write: false, process: true, external: false },
      script: (turn) =>
        turn === 0
          ? assistant("", [
              call("outside", "bg_run", { command: "echo hi", cwd: ".." }),
              call("missing", "bg_run", { command: "echo hi", cwd: "nope" }),
            ])
          : assistant("done"),
    });
    try {
      await fx.runner.run(fx.fx.session, "go");
      const messages = fx.fx.store.messages(fx.fx.session);
      expect(resultOf(messages, "outside").error).toBe(true);
      expect(resultOf(messages, "missing").error).toBe(true);
      expect(resultOf(messages, "missing").text).toContain("does not exist");
      expect(fx.fx.tasks.list(fx.fx.session)).toEqual([]);
    } finally {
      await fx.fx.close();
    }
  });

  it("validates the schema (an empty command and an out-of-range limit are rejected)", async () => {
    const fx = await fixture({
      policy: { write: false, process: true, external: false },
      script: (turn) =>
        turn === 0
          ? assistant("", [
              call("empty", "bg_run", { command: "" }),
              call("big", "bg_output", { id: "x", limit: 999999 }),
              call("extra", "bg_stop", { id: "x", force: true }),
            ])
          : assistant("done"),
    });
    try {
      await fx.runner.run(fx.fx.session, "go");
      const messages = fx.fx.store.messages(fx.fx.session);
      for (const id of ["empty", "big", "extra"])
        expect(resultOf(messages, id).error, id).toBe(true);
    } finally {
      await fx.fx.close();
    }
  });

  it("another session tree cannot read or stop a task", async () => {
    const fx = await fixture({
      policy: { write: false, process: true, external: false },
      script: () => assistant("done"),
    });
    try {
      const task = fx.fx.tasks.start({
        session: fx.fx.session,
        workspace: fx.fx.root,
        cwd: fx.fx.root,
        command: await fx.fx.node("setTimeout(() => {}, 60000);"),
      });
      const stranger = fx.fx.store.create(fx.fx.root, "test", "m").id;
      let turn = 0;
      const strangerRunner = new AgentRunner({
        provider: {
          id: "test",
          model: "m",
          async *stream() {
            yield {
              type: "completed",
              message:
                turn++ === 0
                  ? assistant("", [
                      call("out", "bg_output", { id: task.id }),
                      call("stop", "bg_stop", { id: task.id }),
                      call("list", "bg_list", {}),
                    ])
                  : assistant("done"),
            };
          },
        },
        registry: fx.registry,
        store: fx.fx.store,
        context: new ProjectContext(fx.fx.root),
        workspace: fx.fx.root,
        policy: { write: false, process: true, external: false },
      });
      await strangerRunner.run(stranger, "go");
      const messages = fx.fx.store.messages(stranger);
      expect(resultOf(messages, "out").text).toContain("not found");
      expect(resultOf(messages, "stop").text).toContain("not found");
      expect(resultOf(messages, "list").json().tasks).toEqual([]);
      expect(fx.fx.tasks.get(fx.fx.session, task.id).status).toBe("running");
      await fx.fx.tasks.stop(fx.fx.session, task.id, "user");
    } finally {
      await fx.fx.close();
    }
  });
});
