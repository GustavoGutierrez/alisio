/**
 * Characterization of the `execute` (Code Mode) tool's nested calls (spec §12.1, D-7, D-28):
 * written BEFORE the gate was extracted. Nested calls deny instead of asking, never reach opt-in
 * tools or themselves, honour the `analysis.run` flag rule and stop at the nested-call limit.
 *
 * `execute` is registered only while `forge.javascript.enabled` is false (spec D6); these tests keep
 * running against `runExecute`, the code that still serves that configuration. D-28 (it ignores the
 * run's policy and `toolFilter`) stays pinned below as a KNOWN DEFECT of the legacy tool. It is
 * SUPERSEDED for everyone else: `js_run` fixes it, and `forge-js-run.test.ts` ("D-28 superseded")
 * proves the same child session, with writes denied, cannot write through a script.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Policy } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { Skills } from "../packages/core/src/resources/skills.ts";
import {
  EXECUTE_TIMEOUT_MS,
  MAX_NESTED_CALLS,
  runExecute,
} from "../packages/core/src/tools/execute.ts";
import { registerStandard } from "../packages/core/src/tools/standard.ts";
import { effectTool, gateFixture } from "./forge-gate-helpers.ts";

const none: Policy = { write: false, process: false, external: false };
const signal = () => new AbortController().signal;

function registryOf(ran: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, effect] of [
    ["t_read", "read"],
    ["t_internal", "internal"],
    ["t_write", "write"],
    ["t_process", "process"],
    ["t_external", "external"],
    ["exit_plan", "read"],
  ] as const)
    registry.register(effectTool(name, effect, {}, () => ran.push(name)));
  registry.register(
    effectTool("py", "process", { capability: "analysis.run" }, () => ran.push("py")),
  );
  registry.register({
    name: "echo",
    description: "echo",
    inputSchema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    },
    effect: "read",
    async execute(input) {
      return { content: [{ type: "text", text: JSON.stringify({ n: input.n }) }] };
    },
  });
  registry.register({
    name: "fails",
    description: "fails",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    async execute() {
      return { content: [{ type: "text", text: "boom" }], isError: true };
    },
  });
  return registry;
}

/** Runs a snippet that calls `name` and returns either its value or the thrown message. */
const attempt = (registry: ToolRegistry, policy: Policy, name: string, input = "{}") =>
  runExecute(
    `try { return { ok: await callTool(${JSON.stringify(name)}, ${input}) }; }
     catch (e) { return { error: e.message }; }`,
    { registry, policy, workspace: process.cwd(), signal: signal(), emit: () => {} },
  ) as Promise<{ ok?: unknown; error?: string }>;

describe("execute: nested call gate", () => {
  it("reaches read and internal tools with every effect denied", async () => {
    const ran: string[] = [];
    const registry = registryOf(ran);
    expect((await attempt(registry, none, "t_read")).ok).toBe("ran t_read");
    expect((await attempt(registry, none, "t_internal")).ok).toBe("ran t_internal");
    expect(ran).toEqual(["t_read", "t_internal"]);
  });

  it("denies write, process and external instead of asking, and runs nothing", async () => {
    const ran: string[] = [];
    const registry = registryOf(ran);
    for (const [name, effect] of [
      ["t_write", "write"],
      ["t_process", "process"],
      ["t_external", "external"],
    ] as const) {
      const out = await attempt(registry, none, name);
      expect(out.error).toBe(
        `callTool: capability denied for "${name}" (effect: ${effect}); execute cannot request ` +
          "new approvals, only use capabilities already allowed for this session",
      );
    }
    expect(ran).toEqual([]);
  });

  it("allows exactly the effects the policy allows", async () => {
    const ran: string[] = [];
    const registry = registryOf(ran);
    const policy: Policy = { write: true, process: false, external: true };
    expect((await attempt(registry, policy, "t_write")).ok).toBe("ran t_write");
    expect((await attempt(registry, policy, "t_external")).ok).toBe("ran t_external");
    expect((await attempt(registry, policy, "t_process")).error).toContain("capability denied");
  });

  it("reads the policy object live: a later widening applies to the next call", async () => {
    const registry = registryOf([]);
    const policy: Policy = { ...none };
    expect((await attempt(registry, policy, "t_write")).error).toContain("capability denied");
    policy.write = true;
    expect((await attempt(registry, policy, "t_write")).ok).toBe("ran t_write");
  });

  it("never reaches opt-in tools, even when the policy would allow them", async () => {
    const out = await attempt(
      registryOf([]),
      { write: true, process: true, external: true },
      "exit_plan",
    );
    expect(out.error).toBe('callTool: "exit_plan" is not available from execute');
  });

  it("cannot call itself", async () => {
    const registry = registryOf([]);
    registry.register(effectTool("execute", "process"));
    const out = await attempt(registry, { write: true, process: true, external: true }, "execute");
    expect(out.error).toBe("callTool: execute cannot call itself");
  });

  it("reaches an analysis.run tool with --allow-analysis or a process policy, never otherwise", async () => {
    const ran: string[] = [];
    const registry = registryOf(ran);
    expect((await attempt(registry, none, "py")).error).toContain("capability denied");
    expect((await attempt(registry, { ...none, analysis: true }, "py")).ok).toBe("ran py");
    expect((await attempt(registry, { ...none, process: true }, "py")).ok).toBe("ran py");
    // --allow-analysis does not open an ordinary process tool.
    expect((await attempt(registry, { ...none, analysis: true }, "t_process")).error).toContain(
      "capability denied",
    );
    expect(ran).toEqual(["py", "py"]);
  });

  it("stops at the nested-call limit", async () => {
    const registry = registryOf([]);
    const out = (await runExecute(
      `let n = 0;
       try { for (let i = 0; i < ${MAX_NESTED_CALLS + 5}; i++) { await callTool("t_read"); n++; } }
       catch (e) { return { n, error: e.message }; }
       return { n };`,
      { registry, policy: none, workspace: process.cwd(), signal: signal(), emit: () => {} },
    )) as { n: number; error?: string };
    expect(out.n).toBe(MAX_NESTED_CALLS);
    expect(out.error).toBe(`callTool: exceeded the limit of ${MAX_NESTED_CALLS} nested tool calls`);
    expect(EXECUTE_TIMEOUT_MS).toBe(10_000);
  });

  it("rejects unknown tools and inputs outside the schema before running anything", async () => {
    const registry = registryOf([]);
    expect((await attempt(registry, none, "nope")).error).toBe("Unknown tool: nope");
    expect((await attempt(registry, none, "echo", '{"n":"x"}')).error).toContain("must be number");
    expect((await attempt(registry, none, "echo", '{"n":3}')).ok).toEqual({ n: 3 });
  });

  it("turns a failing tool into a thrown error with its text", async () => {
    expect((await attempt(registryOf([]), none, "fails")).error).toBe("boom");
  });
});

describe("execute: defect D-28 (run policy and toolFilter are ignored)", () => {
  const fixtures: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const f of fixtures.splice(0)) await f.close();
  });

  it("KNOWN DEFECT D-28 (legacy execute only; fixed in js_run): a child run with write denied and a filtered tool still reaches it through execute", async () => {
    // The application hands `execute` the runner's GLOBAL policy (`runner.policy`), not the policy
    // of the run that called it. Flip this test when js_run's dispatcher replaces `execute`.
    const fx = await gateFixture({
      policy: { write: true, process: true, external: false },
      tools: [effectTool("t_write", "write")],
    });
    fixtures.push(fx);
    registerStandard(fx.registry, fx.root, new Skills(), new ProjectContext(fx.root), undefined, {
      policy: () => fx.runner.policy,
    });
    const childRun = {
      policy: { write: false, process: true, external: false } as Policy,
      toolFilter: (t: { name: string }) => t.name !== "t_write",
    };
    const snippet = { code: 'return await callTool("t_write");' };
    const direct = await fx.play([{ name: "t_write" }], childRun);
    expect(direct[0]).toMatchObject({
      isError: true,
      text: "Tool t_write is not available in this session",
    });
    const viaExecute = await fx.play([{ name: "execute", arguments: snippet }], childRun);
    // Today's behaviour (the defect): the nested write runs although the child may not write.
    expect(viaExecute[0]?.isError).toBe(false);
    expect(viaExecute[0]?.text).toBe('{"result":"ran t_write"}');
    expect(fx.ran).toContain("t_write");
  });
});
