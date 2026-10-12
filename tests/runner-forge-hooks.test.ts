/**
 * The runner changes of spec D-23 that js_run needs. Each one was characterized first (the
 * "before" tests, now flipped where the behaviour changed) and then changed:
 *  (a) the parallel read batch respects `concurrent: false`;
 *  (b) a call can flag itself `effectful`, and a cancelled read that did is left pending;
 *  (c) a nested dispatcher can reuse the run's `guard` (see forge-nested-dispatcher.test.ts).
 */
import type { ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { callInternals } from "../packages/core/src/core/call-internals.ts";
import { gateFixture } from "./forge-gate-helpers.ts";

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

/** A tool that records how many tools of its group ran at the same time. */
function overlapProbe() {
  let active = 0;
  let max = 0;
  const tool = (
    name: string,
    effect: ToolDefinition["effect"],
    extra: Partial<ToolDefinition> = {},
  ): ToolDefinition => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    ...(effect ? { effect } : {}),
    async execute() {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
      return { content: [{ type: "text", text: name }] };
    },
    ...extra,
  });
  return { tool, maxActive: () => max };
}

describe("parallel read batch (D-23a)", () => {
  const full = { write: true, process: true, external: true };

  it("runs consecutive reads together", async () => {
    const probe = overlapProbe();
    const fx = await gateFixture({
      policy: full,
      tools: [probe.tool("a", "read"), probe.tool("b", "read")],
    });
    fixtures.push(fx);
    await fx.play([{ name: "a" }, { name: "b" }]);
    expect(probe.maxActive()).toBe(2);
  });

  it("runs a non-read tool marked concurrent:true together with others", async () => {
    const probe = overlapProbe();
    const fx = await gateFixture({
      policy: full,
      tools: [
        probe.tool("a", "write", { concurrent: true }),
        probe.tool("b", "write", { concurrent: true }),
      ],
    });
    fixtures.push(fx);
    await fx.play([{ name: "a" }, { name: "b" }]);
    expect(probe.maxActive()).toBe(2);
  });

  it("runs other effects one after another", async () => {
    const probe = overlapProbe();
    const fx = await gateFixture({
      policy: full,
      tools: [probe.tool("a", "write"), probe.tool("b", "write")],
    });
    fixtures.push(fx);
    await fx.play([{ name: "a" }, { name: "b" }]);
    expect(probe.maxActive()).toBe(1);
  });

  it("keeps a read tool that declares concurrent:false out of the parallel batch", async () => {
    const probe = overlapProbe();
    const fx = await gateFixture({
      policy: full,
      tools: [
        probe.tool("js", "read", { concurrent: false }),
        probe.tool("r1", "read"),
        probe.tool("r2", "read"),
      ],
    });
    fixtures.push(fx);
    await fx.play([{ name: "js" }, { name: "r1" }, { name: "r2" }]);
    // r1 and r2 still batch with each other, but never with the concurrent:false tool.
    expect(probe.maxActive()).toBe(2);
    const alone = overlapProbe();
    const fx2 = await gateFixture({
      policy: full,
      tools: [alone.tool("js", "read", { concurrent: false }), alone.tool("r1", "read")],
    });
    fixtures.push(fx2);
    await fx2.play([{ name: "js" }, { name: "r1" }]);
    expect(alone.maxActive()).toBe(1);
    await fx2.play([{ name: "r1" }, { name: "js" }]);
    expect(alone.maxActive()).toBe(1);
  });
});

describe("cancelled call journal (D-23b)", () => {
  const full = { write: true, process: true, external: true };
  /** A tool that stops the run while it executes and then fails, like an interrupted call. */
  const cancelling = (
    name: string,
    effect: ToolDefinition["effect"],
    controller: AbortController,
    before?: (context: Parameters<ToolDefinition["execute"]>[1]) => void,
  ): ToolDefinition => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    ...(effect ? { effect } : {}),
    async execute(_input, context) {
      before?.(context);
      controller.abort(new Error("Cancelled"));
      throw new Error("interrupted");
    },
  });

  it("closes a cancelled read as completed, and leaves a cancelled write pending", async () => {
    const controller = new AbortController();
    const fx = await gateFixture({
      policy: full,
      tools: [cancelling("rd", "read", controller), cancelling("wr", "write", controller)],
    });
    fixtures.push(fx);
    await fx.play([{ name: "rd" }], {}, controller.signal);
    expect(fx.callStatus("c1")).toBe("completed");
    const second = new AbortController();
    const fx2 = await gateFixture({ policy: full, tools: [cancelling("wr", "write", second)] });
    fixtures.push(fx2);
    await fx2.play([{ name: "wr" }], {}, second.signal);
    expect(fx2.callStatus("c1")).toBe("pending");
  });

  it("leaves a cancelled read pending once the call flagged itself effectful", async () => {
    const controller = new AbortController();
    const fx = await gateFixture({
      policy: full,
      tools: [
        cancelling("js", "read", controller, (context) => {
          callInternals(context)?.markEffectful();
        }),
      ],
    });
    fixtures.push(fx);
    await fx.play([{ name: "js" }], {}, controller.signal);
    expect(fx.callStatus("c1")).toBe("pending");
  });

  it("does not expose the internals to a tool that is handed a bare context", () => {
    expect(
      callInternals({ signal: new AbortController().signal, workspace: "/", emit: () => {} }),
    ).toBeUndefined();
  });
});
