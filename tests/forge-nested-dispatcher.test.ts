/**
 * The nested-call port (spec D-24, D-28, D-29, FJ-AC-05/06/11): a tool running inside a call can
 * reach other tools only through the gate its run applies, never opening an approval. Driven
 * through the real runner by a small "host" tool that stands in for js_run.
 */
import type { ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { callInternals } from "../packages/core/src/core/call-internals.ts";
import type { CapabilityGate, Policy } from "../packages/core/src/core/contracts.ts";
import type { ForgeErrorCode } from "../packages/core/src/forge/errors.ts";
import {
  createNestedDispatcher,
  FORGE_EXCLUDED_TOOLS,
  type NestedCallOutcome,
} from "../packages/core/src/forge/nested.ts";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { PathAccess } from "../packages/core/src/runtime/access.ts";
import { effectTool, gateFixture } from "./forge-gate-helpers.ts";

interface Seen {
  ok: boolean;
  code?: ForgeErrorCode;
  message?: string;
  id: string;
  value?: unknown;
}
const nestedCalls: Array<{ name: unknown; input?: unknown }> = [];

/** Stands in for js_run: `read`, never concurrent, and it calls what the test scripted. */
const host = (after?: (outcomes: NestedCallOutcome[]) => void): ToolDefinition => ({
  name: "host",
  description: "host",
  inputSchema: { type: "object", properties: {} },
  effect: "read",
  concurrent: false,
  async execute(_input, context) {
    const nested = callInternals(context)?.nested();
    if (!nested) throw new Error("no internals");
    const outcomes: NestedCallOutcome[] = [];
    for (const call of nestedCalls) outcomes.push(await nested.call(call));
    after?.(outcomes);
    const seen: Seen[] = outcomes.map((o) =>
      o.ok
        ? { ok: true, id: o.nestedCallId, value: o.value }
        : { ok: false, code: o.code, message: o.message, id: o.nestedCallId },
    );
    return { content: [{ type: "text", text: JSON.stringify(seen) }] };
  },
});

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  nestedCalls.length = 0;
  for (const f of fixtures.splice(0)) await f.close();
});

async function open(options: Parameters<typeof gateFixture>[0]) {
  const fx = await gateFixture(options);
  fixtures.push(fx);
  const run = async (calls: Array<{ name: unknown; input?: unknown }>, runOptions = {}) => {
    nestedCalls.splice(0, nestedCalls.length, ...calls);
    const [out] = await fx.play([{ name: "host" }], runOptions);
    if (out?.isError) throw new Error(out.text);
    return JSON.parse(out?.text ?? "[]") as Seen[];
  };
  return { fx, run };
}

const codes = (seen: Seen[]) => seen.map((s) => (s.ok ? "ok" : s.code));
const off: Policy = { write: false, process: false, external: false };

describe("nested calls: availability", () => {
  it("rejects unknown, excluded, opt-in and filtered tools with TOOL_UNAVAILABLE", async () => {
    const excluded = [...FORGE_EXCLUDED_TOOLS];
    const { fx, run } = await open({
      policy: { write: true, process: true, external: true },
      tools: [
        host(),
        ...excluded.map((name) => effectTool(name, "read")),
        effectTool("exit_plan", "read"),
        effectTool("hidden", "read"),
        effectTool("t_read", "read"),
      ],
    });
    const seen = await run(
      [
        { name: "nope" },
        ...excluded.map((name) => ({ name })),
        { name: "exit_plan" },
        { name: "hidden" },
        { name: "t_read" },
        { name: 7 },
      ],
      { toolFilter: (t: ToolDefinition) => t.name !== "hidden" },
    );
    expect(codes(seen)).toEqual([
      ...Array(1 + excluded.length + 2).fill("TOOL_UNAVAILABLE"),
      "ok",
      "TOOL_UNAVAILABLE",
    ]);
    expect(fx.ran).toEqual(["host", "t_read"]);
  });

  it("excludes the subagent tools, js_run, forge_guide and execute", () => {
    for (const name of ["js_run", "forge_guide", "task", "task_wait", "send_message", "execute"])
      expect(FORGE_EXCLUDED_TOOLS.has(name)).toBe(true);
  });

  it("allows an opt-in tool only when the run lists it, and still never exit_plan or the goal tools", async () => {
    const { run } = await open({
      policy: off,
      tools: [host(), effectTool("get_goal", "read")],
    });
    const seen = await run([{ name: "get_goal" }], { optInTools: ["get_goal"] });
    expect(codes(seen)).toEqual(["TOOL_UNAVAILABLE"]);
  });

  it("validates the input with the registry schema before running the tool (FJ-AC-11)", async () => {
    const strict: ToolDefinition = {
      ...effectTool("strict", "read"),
      inputSchema: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
        additionalProperties: false,
      },
    };
    const { fx, run } = await open({ policy: off, tools: [host(), strict] });
    const seen = await run([
      { name: "strict", input: { n: "x" } },
      { name: "strict", input: [1] },
      { name: "strict", input: { n: 1 } },
    ]);
    expect(codes(seen)).toEqual(["TOOL_INPUT_INVALID", "TOOL_INPUT_INVALID", "ok"]);
    expect(seen[0]?.message).toContain("must be number");
    expect(fx.ran).toEqual(["host", "strict"]);
  });

  it("numbers nested calls from the parent call id and keeps them out of tool_calls", async () => {
    const { fx, run } = await open({ policy: off, tools: [host(), effectTool("t_read", "read")] });
    const seen = await run([{ name: "t_read" }, { name: "nope" }]);
    expect(seen.map((s) => s.id)).toEqual(["c1:forge:1", "c1:forge:2"]);
    expect(fx.callStatus("c1:forge:1")).toBeUndefined();
  });
});

describe("nested calls: the same gate as a direct call (FJ-AC-05, FJ-AC-06)", () => {
  const nestedTools = () => [
    host(),
    effectTool("t_read", "read"),
    effectTool("t_write", "write"),
    effectTool("t_process", "process"),
    effectTool("t_external", "external"),
  ];

  it("gives, in every mode, the answer a direct call gets: run, would-ask or denied", async () => {
    for (const mode of ["ask", "auto", "full"] as const) {
      const direct = await open({
        policy: { ...PERMISSION_MODE_TABLE[mode].policy },
        tools: nestedTools(),
      });
      await direct.fx.play([{ name: "t_write" }, { name: "t_process" }, { name: "t_external" }]);
      const askedDirect = direct.fx.asked.map((a) => a.call.name);
      const nested = await open({
        policy: { ...PERMISSION_MODE_TABLE[mode].policy },
        tools: nestedTools(),
      });
      const seen = await nested.run([
        { name: "t_write" },
        { name: "t_process" },
        { name: "t_external" },
      ]);
      const names = ["t_write", "t_process", "t_external"];
      names.forEach((name, i) =>
        expect(seen[i]?.ok ? "run" : seen[i]?.code, `${mode}/${name}`).toBe(
          askedDirect.includes(name) ? "APPROVAL_REQUIRED" : "run",
        ),
      );
      // A nested call never opens an approval, whatever the mode.
      expect(nested.fx.asked).toEqual([]);
    }
  });

  it("is PERMISSION_DENIED where a direct call could not even ask (no handler, approvals off)", async () => {
    const headless = await open({ policy: off, approve: false, tools: nestedTools() });
    expect(codes(await headless.run([{ name: "t_write" }, { name: "t_read" }]))).toEqual([
      "PERMISSION_DENIED",
      "ok",
    ]);
    const noApprovals = await open({ policy: off, tools: nestedTools() });
    expect(codes(await noApprovals.run([{ name: "t_write" }], { approvals: false }))).toEqual([
      "PERMISSION_DENIED",
    ]);
  });

  it("D-28 fixed: a child run with write denied is denied, although the runner policy allows it", async () => {
    const { fx, run } = await open({
      policy: { write: true, process: true, external: false },
      tools: nestedTools(),
    });
    const seen = await run([{ name: "t_write" }], {
      policy: { write: false, process: true, external: false },
      approvals: false,
    });
    expect(codes(seen)).toEqual(["PERMISSION_DENIED"]);
    expect(fx.ran).not.toContain("t_write");
  });

  it("D-28 fixed: a child run with an allow-list cannot reach a tool outside it", async () => {
    const { fx, run } = await open({
      policy: { write: true, process: true, external: true },
      tools: nestedTools(),
    });
    const seen = await run([{ name: "t_write" }, { name: "t_read" }], {
      toolFilter: (t: ToolDefinition) => ["host", "t_read"].includes(t.name),
    });
    expect(codes(seen)).toEqual(["TOOL_UNAVAILABLE", "ok"]);
    expect(fx.ran).not.toContain("t_write");
  });

  it("follows the live policy: a session approval earlier in the run opens the next nested call", async () => {
    const policy: Policy = { ...off };
    const { fx } = await open({
      policy,
      approve: () => "session",
      tools: nestedTools(),
    });
    nestedCalls.splice(0, nestedCalls.length, { name: "t_write" });
    const out = await fx.play([{ name: "t_write" }, { name: "host" }]);
    expect(policy.write).toBe(true);
    expect(JSON.parse(out[1]?.text ?? "[]")[0].ok).toBe(true);
  });

  it("reaches an analysis.run tool on a flag, never on a stored grant", async () => {
    const granted: CapabilityGate = { granted: () => true, record: () => {} };
    const python = effectTool("py", "process", { capability: "analysis.run" });
    const grantOnly = await open({ policy: off, capabilities: granted, tools: [host(), python] });
    expect(codes(await grantOnly.run([{ name: "py" }]))).toEqual(["APPROVAL_REQUIRED"]);
    const flagged = await open({
      policy: { ...off, analysis: true },
      capabilities: granted,
      tools: [host(), python],
    });
    expect(codes(await flagged.run([{ name: "py" }]))).toEqual(["ok"]);
    const process = await open({
      policy: { ...off, process: true },
      capabilities: granted,
      tools: [host(), python],
    });
    expect(codes(await process.run([{ name: "py" }]))).toEqual(["ok"]);
  });

  it("lists in catalog() only what a nested call could run now", async () => {
    let listed: string[] = [];
    const probe: ToolDefinition = {
      ...host(),
      name: "probe",
      async execute(_input, context) {
        listed = (callInternals(context)?.nested().catalog() ?? []).map((t) => t.name).sort();
        return { content: [{ type: "text", text: "[]" }] };
      },
    };
    const { fx } = await open({
      policy: { ...off, write: true },
      tools: [probe, ...nestedTools(), effectTool("task", "read")],
    });
    await fx.play([{ name: "probe" }]);
    // The probe itself is listed because it is not js_run; excluded tools and the denied are not.
    expect(listed).toEqual(["host", "probe", "t_read", "t_write"]);
  });
});

describe("nested calls: paths, results and the call context", () => {
  it("resolves declared paths without ever asking for a directory (outside the roots: denied)", async () => {
    const asks: string[] = [];
    const { fx } = await open({
      policy: { write: true, process: true, external: true },
      tools: [host()],
    });
    const access = new PathAccess({
      workspace: fx.root,
      approve: async (request) => {
        asks.push(request.path);
        return "once";
      },
    });
    const pathTool = effectTool("t_path", "read", {
      paths: (input) => [String(input.path)],
    });
    fx.registry.register(pathTool);
    const dispatcher = createNestedDispatcher({
      registry: fx.registry,
      policy: { write: true, process: true, external: true },
      approvals: true,
      workspace: fx.root,
      session: fx.session,
      parentCallId: "p1",
      signal: new AbortController().signal,
      pathAccess: access,
      markEffectful: () => {},
    });
    const inside = await dispatcher.call({ name: "t_path", input: { path: "a.txt" } });
    const outside = await dispatcher.call({ name: "t_path", input: { path: "/etc/hostname" } });
    expect(inside.ok).toBe(true);
    expect(outside).toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    expect(asks).toEqual([]);
  });

  it("binds artifacts and decisions to the parent call and refuses installs", async () => {
    let seen: { callId?: string; install?: string; artifacts: boolean } | undefined;
    const probe: ToolDefinition = {
      name: "ctx_probe",
      description: "probe",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute(_input, context) {
        seen = {
          ...(context.callId ? { callId: context.callId } : {}),
          install: await context.approveInstall?.({ extras: ["pandas"] } as never),
          artifacts: !!context.artifacts,
        };
        return { content: [{ type: "text", text: "{}" }] };
      },
    };
    const { run } = await open({ policy: off, tools: [host(), probe] });
    await run([{ name: "ctx_probe" }]);
    expect(seen).toEqual({ callId: "c1", install: "deny", artifacts: false });
  });

  it("returns a failing tool as TOOL_FAILED with its text, and a cancelled one as CANCELLED", async () => {
    const failing: ToolDefinition = {
      ...effectTool("fails", "read"),
      async execute() {
        return { content: [{ type: "text", text: "boom" }], isError: true };
      },
    };
    const throwing: ToolDefinition = {
      ...effectTool("throws", "read"),
      async execute() {
        throw new Error("kaput");
      },
    };
    const { run } = await open({ policy: off, tools: [host(), failing, throwing] });
    const seen = await run([{ name: "fails" }, { name: "throws" }]);
    expect(seen.map((s) => [s.code, s.message])).toEqual([
      ["TOOL_FAILED", "boom"],
      ["TOOL_FAILED", "kaput"],
    ]);
    const { fx } = await open({ policy: off, tools: [] });
    const controller = new AbortController();
    const slow: ToolDefinition = {
      ...effectTool("slow", "read"),
      async execute(_input, context) {
        controller.abort();
        context.signal.throwIfAborted();
        return { content: [{ type: "text", text: "late" }] };
      },
    };
    fx.registry.register(slow);
    const dispatcher = createNestedDispatcher({
      registry: fx.registry,
      policy: off,
      approvals: false,
      workspace: fx.root,
      session: fx.session,
      parentCallId: "p1",
      signal: new AbortController().signal,
      markEffectful: () => {},
    });
    expect(await dispatcher.call({ name: "slow", signal: controller.signal })).toMatchObject({
      ok: false,
      code: "CANCELLED",
    });
  });

  it("parses a JSON result and keeps plain text as text", async () => {
    const json: ToolDefinition = {
      ...effectTool("json", "read"),
      async execute() {
        return { content: [{ type: "text", text: '{"a":[1,2]}' }] };
      },
    };
    const { run } = await open({ policy: off, tools: [host(), json, effectTool("plain", "read")] });
    const seen = await run([{ name: "json" }, { name: "plain" }]);
    expect(seen.map((s) => s.value)).toEqual([{ a: [1, 2] }, "ran plain"]);
  });

  it("refuses the call when the run's guard throws, running nothing", async () => {
    const { fx } = await open({ policy: off, tools: [effectTool("t_read", "read")] });
    const dispatcher = createNestedDispatcher({
      registry: fx.registry,
      policy: off,
      approvals: false,
      workspace: fx.root,
      session: fx.session,
      parentCallId: "p1",
      signal: new AbortController().signal,
      guard: (effect) => {
        if (effect !== "read") throw new Error("Context changed; reconsider this call");
        throw new Error("Token budget exhausted; tool was not executed");
      },
      markEffectful: () => {},
    });
    expect(await dispatcher.call({ name: "t_read" })).toMatchObject({
      ok: false,
      code: "PERMISSION_DENIED",
      message: "Token budget exhausted; tool was not executed",
    });
    expect(fx.ran).toEqual([]);
  });
});

describe("nested calls mark the parent effectful (D-23b)", () => {
  /** A host that cancels the run after its nested calls, like a js_run stopped by the user. */
  const cancellingHost = (controller: AbortController): ToolDefinition => ({
    ...host(),
    async execute(_input, context) {
      const nested = callInternals(context)?.nested();
      for (const call of nestedCalls) await nested?.call(call);
      controller.abort(new Error("Cancelled"));
      throw new Error("interrupted");
    },
  });

  it("leaves a cancelled js_run pending after a nested write, closed after only reads", async () => {
    const writeController = new AbortController();
    const wrote = await open({
      policy: { write: true, process: false, external: false },
      tools: [cancellingHost(writeController), effectTool("t_write", "write")],
    });
    nestedCalls.splice(0, nestedCalls.length, { name: "t_write" });
    await wrote.fx.play([{ name: "host" }], {}, writeController.signal);
    expect(wrote.fx.callStatus("c1")).toBe("pending");

    const readController = new AbortController();
    const read = await open({
      policy: off,
      tools: [cancellingHost(readController), effectTool("t_read", "read")],
    });
    nestedCalls.splice(0, nestedCalls.length, { name: "t_read" });
    await read.fx.play([{ name: "host" }], {}, readController.signal);
    expect(read.fx.callStatus("c1")).toBe("completed");
  });

  it("does not mark it for a nested call the gate refused", async () => {
    const controller = new AbortController();
    const refused = await open({
      policy: off,
      tools: [cancellingHost(controller), effectTool("t_write", "write")],
    });
    nestedCalls.splice(0, nestedCalls.length, { name: "t_write" });
    await refused.fx.play([{ name: "host" }], {}, controller.signal);
    expect(refused.fx.callStatus("c1")).toBe("completed");
  });
});
