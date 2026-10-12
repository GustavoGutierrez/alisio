/**
 * Characterization of the runner's call gate (spec §12.1, D-25): written BEFORE `decideEffect` was
 * extracted, so they pin what the gate does today across ask/auto/full/read-only, the capability
 * flags and grants, and the tool filters. They must stay green through the extraction.
 */
import type { ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityGate, Policy } from "../packages/core/src/core/contracts.ts";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { effectTool, gateFixture } from "./forge-gate-helpers.ts";

const tools = (): ToolDefinition[] => [
  effectTool("t_read", "read"),
  effectTool("t_internal", "internal"),
  effectTool("t_write", "write"),
  effectTool("t_process", "process"),
  effectTool("t_external", "external"),
  effectTool("t_untyped", undefined),
];
const everything = ["t_read", "t_internal", "t_write", "t_process", "t_external", "t_untyped"].map(
  (name) => ({ name }),
);

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const open = async (...args: Parameters<typeof gateFixture>) => {
  const fx = await gateFixture(...args);
  fixtures.push(fx);
  return fx;
};

describe("runner call gate, by permission mode", () => {
  it("ask: read and internal run; write, process, external and untyped tools ask first", async () => {
    const fx = await open({ policy: { ...PERMISSION_MODE_TABLE.ask.policy }, tools: tools() });
    const out = await fx.play(everything);
    expect(out.every((o) => !o.isError)).toBe(true);
    expect(fx.asked.map((a) => a.effect)).toEqual(["write", "process", "external", "external"]);
    // A tool with no declared effect is treated as `external`.
    expect(fx.asked.at(-1)?.call.name).toBe("t_untyped");
  });

  it("auto: write runs unasked; process and external still ask", async () => {
    const fx = await open({ policy: { ...PERMISSION_MODE_TABLE.auto.policy }, tools: tools() });
    await fx.play(everything);
    expect(fx.asked.map((a) => a.effect)).toEqual(["process", "external", "external"]);
  });

  it("full: nothing asks", async () => {
    const fx = await open({ policy: { ...PERMISSION_MODE_TABLE.full.policy }, tools: tools() });
    const out = await fx.play(everything);
    expect(fx.asked).toEqual([]);
    expect(out.every((o) => !o.isError)).toBe(true);
    expect(fx.ran).toHaveLength(6);
  });

  it("read-only (policy off, no approval handler): only read and internal run, the rest are denied", async () => {
    const fx = await open({
      policy: { write: false, process: false, external: false },
      approve: false,
      tools: tools(),
    });
    const out = await fx.play(everything);
    expect(out.map((o) => o.isError)).toEqual([false, false, true, true, true, true]);
    expect(out[2]?.text).toBe("Capability denied: write");
    expect(out[3]?.text).toBe("Capability denied: process");
    expect(out[5]?.text).toBe("Capability denied: external");
    expect(fx.ran).toEqual(["t_read", "t_internal"]);
  });

  it("a run with approvals:false denies what would have asked, even with a handler", async () => {
    const fx = await open({
      policy: { write: false, process: false, external: false },
      tools: tools(),
    });
    const out = await fx.play(everything, { approvals: false });
    expect(fx.asked).toEqual([]);
    expect(out.map((o) => o.isError)).toEqual([false, false, true, true, true, true]);
  });

  it("a denied approval stops the call; 'once' does not widen the policy", async () => {
    const policy: Policy = { write: false, process: false, external: false };
    const fx = await open({
      policy,
      approve: (request) => (request.call.id === "c1" ? "deny" : "once"),
      tools: [effectTool("t_write", "write")],
    });
    const denied = await fx.play([{ name: "t_write" }]);
    expect(denied[0]).toMatchObject({ isError: true });
    expect(denied[0]?.text).toBe("Capability write denied by the user for this call");
    const once = await fx.play([{ name: "t_write" }]);
    expect(once[0]?.isError).toBe(false);
    expect(policy.write).toBe(false);
  });

  it("'allow for the session' widens the shared policy object for later calls", async () => {
    const policy: Policy = { write: false, process: false, external: false };
    const fx = await open({
      policy,
      approve: () => "session",
      tools: [effectTool("t_write", "write")],
    });
    await fx.play([{ name: "t_write" }]);
    expect(policy.write).toBe(true);
    await fx.play([{ name: "t_write" }]);
    expect(fx.asked).toHaveLength(1);
  });

  it("a per-run policy replaces the runner policy for that run only", async () => {
    const fx = await open({
      policy: { write: false, process: false, external: false },
      tools: [effectTool("t_write", "write")],
    });
    await fx.play([{ name: "t_write" }], {
      policy: { write: true, process: false, external: false },
    });
    expect(fx.asked).toEqual([]);
    await fx.play([{ name: "t_write" }]);
    expect(fx.asked).toHaveLength(1);
  });
});

describe("runner call gate, run narrowing", () => {
  it("toolFilter makes a registered tool unavailable at execution, with no approval", async () => {
    const fx = await open({
      policy: { write: false, process: false, external: false },
      tools: tools(),
    });
    const out = await fx.play([{ name: "t_write" }, { name: "t_read" }], {
      toolFilter: (t) => t.name !== "t_write",
    });
    expect(out[0]).toMatchObject({
      isError: true,
      text: "Tool t_write is not available in this session",
    });
    expect(out[1]?.isError).toBe(false);
    expect(fx.asked).toEqual([]);
  });

  it("opt-in tools are unavailable unless the run lists them", async () => {
    const fx = await open({
      policy: { write: true, process: true, external: true },
      tools: [effectTool("exit_plan", "read")],
    });
    const hidden = await fx.play([{ name: "exit_plan" }]);
    expect(hidden[0]?.text).toBe("Tool exit_plan is not available in this session");
    const listed = await fx.play([{ name: "exit_plan" }], { optInTools: ["exit_plan"] });
    expect(listed[0]?.isError).toBe(false);
  });

  it("availableTools offers askable effects only when approvals are possible", async () => {
    const withApprove = await open({
      policy: { write: false, process: false, external: false },
      tools: tools(),
    });
    const names = (list: ToolDefinition[]) => list.map((t) => t.name).sort();
    expect(names(withApprove.runner.availableTools())).toEqual(names(tools()));
    expect(names(withApprove.runner.availableTools({ approvals: false }))).toEqual([
      "t_internal",
      "t_read",
    ]);
    expect(
      names(withApprove.runner.availableTools({ toolFilter: (t) => t.name === "t_write" })),
    ).toEqual(["t_write"]);
    const locked = await open({
      policy: { write: false, process: false, external: false },
      approve: false,
      tools: tools(),
    });
    expect(names(locked.runner.availableTools())).toEqual(["t_internal", "t_read"]);
    expect(
      names(
        locked.runner.availableTools({
          policy: { write: true, process: false, external: false },
        }),
      ),
    ).toEqual(["t_internal", "t_read", "t_write"]);
  });
});

describe("runner call gate, capabilities", () => {
  const scripted = (extra: Partial<ToolDefinition> = {}) =>
    effectTool("py", "process", { capability: "analysis.run", ...extra });
  const gate = (granted: boolean) => {
    const records: Array<{ source: string; decision: string; scope: string }> = [];
    const value: CapabilityGate = {
      granted: () => granted,
      record: (input) => {
        records.push({ source: input.source, decision: input.decision, scope: input.scope });
      },
    };
    return { value, records };
  };

  it("--allow-analysis runs a capability tool without asking and audits it as a flag", async () => {
    const g = gate(false);
    const fx = await open({
      policy: { write: false, process: false, external: false, analysis: true },
      capabilities: g.value,
      tools: [scripted()],
    });
    const out = await fx.play([{ name: "py" }]);
    expect(out[0]?.isError).toBe(false);
    expect(fx.asked).toEqual([]);
    expect(g.records).toEqual([{ source: "flag", decision: "allow", scope: "once" }]);
  });

  it("--allow-process also runs it, audited as a flag", async () => {
    const g = gate(false);
    const fx = await open({
      policy: { write: false, process: true, external: false },
      capabilities: g.value,
      tools: [scripted()],
    });
    await fx.play([{ name: "py" }]);
    expect(fx.asked).toEqual([]);
    expect(g.records.map((r) => r.source)).toEqual(["flag"]);
  });

  it("a stored grant runs it without asking and without a flag audit", async () => {
    const g = gate(true);
    const fx = await open({
      policy: { write: false, process: false, external: false },
      capabilities: g.value,
      tools: [scripted()],
    });
    const out = await fx.play([{ name: "py" }]);
    expect(out[0]?.isError).toBe(false);
    expect(fx.asked).toEqual([]);
    expect(g.records).toEqual([]);
  });

  it("without a flag or grant it asks with the capability, and a session answer never widens process", async () => {
    const g = gate(false);
    const policy: Policy = { write: false, process: false, external: false };
    const fx = await open({
      policy,
      approve: () => "session",
      capabilities: g.value,
      tools: [scripted()],
    });
    await fx.play([{ name: "py" }]);
    expect(fx.asked[0]).toMatchObject({ effect: "process", capability: "analysis.run" });
    expect(policy.process).toBe(false);
    expect(g.records).toEqual([{ source: "tui", decision: "allow", scope: "session" }]);
  });

  it("--allow-analysis does not open a non-capability process tool", async () => {
    const fx = await open({
      policy: { write: false, process: false, external: false, analysis: true },
      approve: false,
      tools: [effectTool("t_process", "process")],
    });
    const out = await fx.play([{ name: "t_process" }]);
    expect(out[0]?.text).toBe("Capability denied: process");
  });

  it("a denied capability call says which capability was denied", async () => {
    const fx = await open({
      policy: { write: false, process: false, external: false },
      approve: false,
      capabilities: gate(false).value,
      tools: [scripted()],
    });
    const out = await fx.play([{ name: "py" }]);
    expect(out[0]?.text).toBe("Capability denied: analysis.run");
  });
});
