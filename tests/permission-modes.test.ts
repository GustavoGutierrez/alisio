import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ActiveAgent,
  BUILTIN_AGENTS,
  cycleableAgents,
  nextAgent,
} from "../packages/core/src/agents/active.ts";
import type { ApprovalRequest, Policy } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import {
  describePermissionStatus,
  modeFromFlags,
  modeToPreset,
  PERMISSION_MODE_TABLE,
  PERMISSION_MODES,
  parsePermissionCommand,
  parsePermissionMode,
  presetToMode,
} from "../packages/core/src/permissions/modes.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { presetInfo } from "../packages/server/src/host/presets.ts";

describe("permission mode table (single source of truth)", () => {
  it("maps ask, auto and full to fixed effect policies", () => {
    expect(PERMISSION_MODE_TABLE.ask.policy).toEqual({
      write: false,
      process: false,
      external: false,
    });
    // Auto = workspace edits run without asking; commands, network and external dirs still ask.
    expect(PERMISSION_MODE_TABLE.auto.policy).toEqual({
      write: true,
      process: false,
      external: false,
    });
    expect(PERMISSION_MODE_TABLE.full.policy).toEqual({
      write: true,
      process: true,
      external: true,
    });
    for (const mode of PERMISSION_MODES) expect(PERMISSION_MODE_TABLE[mode].approvals).toBe(true);
  });

  it("shares the table with the web presets, ceiling aside", () => {
    const open = {
      policy: { write: true, process: true, external: true },
      approvals: true,
      readOnly: false,
    };
    for (const mode of PERMISSION_MODES) {
      const preset = modeToPreset(mode);
      expect(presetToMode(preset)).toBe(mode);
      const info = presetInfo(preset, open);
      expect(info.mode).toBe(mode);
      expect(info.policy).toEqual(PERMISSION_MODE_TABLE[mode].policy);
      expect(info.approvals).toBe(PERMISSION_MODE_TABLE[mode].approvals);
    }
    expect(presetToMode("read-only")).toBeUndefined();
    expect(presetInfo("read-only", open).mode).toBeUndefined();
    expect(presetInfo("read-only", open)).toMatchObject({
      approvals: false,
      policy: { write: false, process: false, external: false },
    });
  });

  it("parses the /permission arguments, including the preset spellings", () => {
    expect(parsePermissionCommand("")).toEqual({ type: "menu" });
    expect(parsePermissionCommand("  status ")).toEqual({ type: "status" });
    expect(parsePermissionCommand("ASK")).toEqual({ type: "set", mode: "ask" });
    expect(parsePermissionCommand("auto")).toEqual({ type: "set", mode: "auto" });
    expect(parsePermissionCommand("full")).toEqual({ type: "set", mode: "full" });
    expect(parsePermissionCommand("full-access")).toEqual({ type: "set", mode: "full" });
    expect(parsePermissionMode("workspace-write")).toBe("auto");
    expect(parsePermissionCommand("yolo")).toEqual({ type: "invalid", input: "yolo" });
  });

  it("labels the initial TUI mode from the launch flags", () => {
    expect(modeFromFlags({})).toBe("ask");
    expect(modeFromFlags({ allowWrite: true })).toBe("auto");
    expect(modeFromFlags({ allowWrite: true, allowProcess: true, allowExternal: true })).toBe(
      "full",
    );
    expect(modeFromFlags({ readOnly: true, allowWrite: true })).toBe("locked");
    expect(modeFromFlags({ allowProcess: true })).toBe("custom");
    expect(modeFromFlags({ allowWrite: true, allowProcess: true })).toBe("custom");
  });

  it("describes the real policy per effect and never calls a mode a sandbox", () => {
    const text = describePermissionStatus({
      mode: "auto",
      policy: { write: true, process: false, external: false },
      approvals: true,
    });
    expect(text).toContain("**auto**");
    expect(text).toContain("- write: on");
    expect(text).toContain("- process: ask");
    expect(text).toContain("not a sandbox");
    const locked = describePermissionStatus({
      mode: "locked",
      policy: { write: false, process: false, external: false },
      approvals: false,
    });
    expect(locked).toContain("locked");
    expect(locked).toContain("- write: off");
  });
});

describe("runner policy follows a mode", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function fixture(policy: Policy, asked: ApprovalRequest[]) {
    const root = await mkdtemp(join(tmpdir(), "alisio-modes-"));
    roots.push(root);
    const store = new SQLiteStore(join(root, "sessions.sqlite"));
    const registry = new ToolRegistry();
    let ran = 0;
    const tool = (name: string, effect: ToolDefinition["effect"]): ToolDefinition => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      effect,
      async execute() {
        ran++;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    registry.register(tool("t_write", "write"));
    registry.register(tool("t_process", "process"));
    let turn = 0;
    let callId = 0;
    const calls = ["t_write", "t_process"];
    const provider: ModelProvider = {
      id: "test",
      model: "m",
      async *stream() {
        const name = calls[turn++ % 3];
        yield {
          type: "completed",
          message: name
            ? {
                role: "assistant",
                text: "",
                calls: [{ id: `c${++callId}`, name, arguments: "{}" }],
              }
            : { role: "assistant", text: "done", calls: [] },
        };
      },
    };
    const runner = new AgentRunner({
      provider,
      registry,
      store,
      context: new ProjectContext(root),
      workspace: root,
      policy,
      approve: async (request) => {
        asked.push(request);
        return "once";
      },
    });
    return { runner, store, root, ran: () => ran, reset: () => (turn = 0) };
  }

  it("auto stops asking for writes but keeps asking for processes; ask asks for both", async () => {
    const asked: ApprovalRequest[] = [];
    const policy: Policy = { write: false, process: false, external: false };
    const fx = await fixture(policy, asked);
    try {
      const session = fx.store.create(fx.root, "test", "m").id;
      const signal = new AbortController().signal;

      fx.runner.setPolicy(PERMISSION_MODE_TABLE.ask.policy);
      await fx.runner.run(session, "go", signal);
      expect(asked.map((a) => a.effect)).toEqual(["write", "process"]);

      asked.length = 0;
      fx.reset();
      fx.runner.setPolicy(PERMISSION_MODE_TABLE.auto.policy);
      await fx.runner.run(session, "again", signal);
      expect(asked.map((a) => a.effect)).toEqual(["process"]);

      asked.length = 0;
      fx.reset();
      fx.runner.setPolicy(PERMISSION_MODE_TABLE.full.policy);
      await fx.runner.run(session, "once more", signal);
      expect(asked).toEqual([]);
      expect(fx.ran()).toBe(6);
    } finally {
      fx.store.close();
    }
  });

  it("drops an 'allow for this session' widening when the mode is set again", async () => {
    const asked: ApprovalRequest[] = [];
    const policy: Policy = { write: false, process: false, external: false, analysis: true };
    const fx = await fixture(policy, asked);
    try {
      policy.write = true; // what a "session" approval does
      fx.runner.setPolicy(PERMISSION_MODE_TABLE.ask.policy);
      expect(fx.runner.policy).toMatchObject({ write: false, process: false, analysis: true });
    } finally {
      fx.store.close();
    }
  });
});

describe("agent cycle", () => {
  const agent = (id: string, name = id): ActiveAgent => ({
    id,
    name,
    description: `${name} agent`,
    source: "user",
  });

  it("orders build, plan, then custom agents by name, whatever the discovery order", () => {
    const custom = [agent("zeta"), agent("alpha-2", "Alpha"), agent("beta")];
    const forward = cycleableAgents([...custom, ...BUILTIN_AGENTS]).map((a) => a.id);
    const reversed = cycleableAgents([...BUILTIN_AGENTS, ...[...custom].reverse()]).map(
      (a) => a.id,
    );
    expect(forward).toEqual(["build", "plan", "alpha-2", "beta", "zeta"]);
    expect(reversed).toEqual(forward);
  });

  it("wraps forward and backward and starts at build for an unknown id", () => {
    const all = [...BUILTIN_AGENTS, agent("reviewer")];
    expect(nextAgent(all, "build")?.id).toBe("plan");
    expect(nextAgent(all, "plan")?.id).toBe("reviewer");
    expect(nextAgent(all, "reviewer")?.id).toBe("build");
    expect(nextAgent(all, "build", -1)?.id).toBe("reviewer");
    expect(nextAgent(all, "ghost")?.id).toBe("build");
    expect(nextAgent(all, undefined)?.id).toBe("build");
    expect(nextAgent([], "build")).toBeUndefined();
  });

  it("drops duplicated ids and cycles the two built-ins when nothing else is loaded", () => {
    expect(cycleableAgents([...BUILTIN_AGENTS, agent("plan")]).map((a) => a.id)).toEqual([
      "build",
      "plan",
    ]);
    expect(nextAgent(BUILTIN_AGENTS, "plan")?.id).toBe("build");
  });
});
