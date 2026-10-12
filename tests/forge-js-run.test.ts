/**
 * `js_run` through the real runner, gate and journal (FJ-AC-05, 06, 27a, 27b, 30, and the D-28
 * replacement test): a scripted model calls `js_run`, the script calls other tools, and what the
 * gate decides is compared with what a direct call decides. The QuickJS engine and the isolate
 * host are real.
 */
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../packages/core/src/config.ts";
import type { Policy } from "../packages/core/src/core/contracts.ts";
import { SqliteExecutionJournal } from "../packages/core/src/forge/journal.ts";
import { createForgeRuntime } from "../packages/core/src/forge/runtime.ts";
import { ensureSessionDir } from "../packages/core/src/forge/session-dir.ts";
import { SqliteStateStore } from "../packages/core/src/forge/state-store.ts";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { PathAccess } from "../packages/core/src/runtime/access.ts";
import { registerJsRun } from "../packages/core/src/tools/js-run.ts";
import { effectTool, gateFixture } from "./forge-gate-helpers.ts";

const ask: Policy = { ...PERMISSION_MODE_TABLE.ask.policy };
const full: Policy = { ...PERMISSION_MODE_TABLE.full.policy };

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function open(
  options: {
    policy?: Policy;
    approve?: false;
    tools?: ToolDefinition[];
    readConcurrency?: number;
    pathAccess?: boolean;
    host?: "worker" | "process";
    forgeConfig?: Record<string, unknown>;
  } = {},
) {
  const events: RunEvent[] = [];
  let workspaceRoot = "";
  /** The one scratchpad provider both the path gate and js_run use, as the application wires it. */
  const scratchpad = async (session: string) => {
    const dir = await ensureSessionDir({
      rootSessionId: session,
      workspace: workspaceRoot,
      workspaceKey: "wk",
      stateHome: join(workspaceRoot, "state"),
      configRoot: join(workspaceRoot, "tmp"),
    });
    return dir.scratchpad;
  };
  const fx = await gateFixture({
    policy: options.policy ?? ask,
    ...(options.approve === false ? { approve: false as const } : {}),
    tools: options.tools ?? [],
    ...(options.readConcurrency ? { readConcurrency: options.readConcurrency } : {}),
    onEvent: (event) => events.push(event),
    ...(options.pathAccess
      ? {
          pathAccess: (root: string) => {
            workspaceRoot = root;
            return new PathAccess({
              workspace: root,
              scratchpad,
              scratchMaxBytes: () => 1_000_000,
            });
          },
        }
      : {}),
  });
  fixtures.push(fx);
  workspaceRoot = fx.root;
  const forge = configSchema.parse({
    forge: {
      javascript: { enabled: true, host: options.host ?? "worker", ...options.forgeConfig },
    },
  }).forge;
  const journal = new SqliteExecutionJournal(fx.store.db);
  const runtime = await createForgeRuntime({
    forge: () => forge,
    journal,
    state: new SqliteStateStore(fx.store.db),
  });
  expect(runtime.jsReady).toBe(true);
  registerJsRun(fx.registry, {
    kernel: runtime.kernel,
    rootOf: (session) => fx.store.rootOf(session),
    scratchpad: async (session) =>
      options.pathAccess ? scratchpad(fx.store.rootOf(session)) : undefined,
    policy: () => options.policy ?? ask,
  });
  const js = (code: string, extra: Record<string, unknown> = {}) => ({
    name: "js_run",
    arguments: { code, ...extra },
  });
  return { fx, journal, events, js, runtime };
}

const write = (ran: string[]): ToolDefinition =>
  effectTool("t_write", "write", {}, () => ran.push("t_write"));
const read = (ran: string[]): ToolDefinition =>
  effectTool("t_read", "read", {}, () => ran.push("t_read"));

describe("FJ-AC-05 / 06: a nested call gets the decision a direct call gets", () => {
  it("in ask mode a nested write is APPROVAL_REQUIRED, opens no approval and does not run", async () => {
    const ran: string[] = [];
    const { fx, js } = await open({ tools: [write(ran)] });
    const [out] = await fx.play([
      js("try { await tools.call('t_write', {}); return 'ran'; } catch (e) { return e.code; }"),
    ]);
    expect(out?.isError).toBe(false);
    expect(out?.text).toContain('value: "APPROVAL_REQUIRED"');
    expect(fx.asked).toEqual([]);
    expect(ran).toEqual([]);
    // The same tool called directly DOES ask in this session.
    await fx.play([{ name: "t_write" }]);
    expect(fx.asked.map((a) => a.effect)).toEqual(["write"]);
  });

  it("in full mode the nested write runs, like the direct one", async () => {
    const ran: string[] = [];
    const { fx, js } = await open({ policy: full, tools: [write(ran)] });
    const [out] = await fx.play([js("return await tools.call('t_write', {});")]);
    expect(out?.text).toContain('value: "ran t_write"');
    expect(ran).toEqual(["t_write"]);
    expect(fx.asked).toEqual([]);
  });

  it("D-28 superseded: a child session with writes denied cannot write through js_run either", async () => {
    const ran: string[] = [];
    const { fx, js } = await open({ policy: full, tools: [write(ran), read(ran)] });
    const script = js(
      `const out = {}; for (const name of ['t_write', 't_read']) { try { out[name] = await tools.call(name, {}); } catch (e) { out[name] = e.code; } } return out;`,
    );
    // The child run: write tools are filtered out and approvals are off, as for a read-only subagent.
    const [out] = await fx.play([script], {
      policy: { write: false, process: false, external: false },
      approvals: false,
      toolFilter: (tool) => tool.effect === "read" || tool.name === "js_run",
    });
    expect(out?.text).toContain('"t_write":"TOOL_UNAVAILABLE"');
    expect(out?.text).toContain('"t_read":"ran t_read"');
    expect(ran).toEqual(["t_read"]);
    // With the filter lifted but the policy still denying writes (no approver): a plain denial.
    ran.length = 0;
    const [second] = await fx.play([script], {
      policy: { write: false, process: false, external: false },
      approvals: false,
    });
    expect(second?.text).toContain('"t_write":"PERMISSION_DENIED"');
    expect(ran).toEqual(["t_read"]);
  });
});

describe("D-23: effect, concurrency and recovery", () => {
  it("FJ-AC-27b: js_run is not run in parallel with a read in the same turn", async () => {
    let active = 0;
    let overlap = 0;
    const timed = (name: string): ToolDefinition => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute() {
        active++;
        overlap = Math.max(overlap, active);
        await new Promise((resolve) => setTimeout(resolve, 60));
        active--;
        return { content: [{ type: "text", text: name }] };
      },
    });
    const { fx, js, runtime } = await open({ tools: [timed("slow_read")], readConcurrency: 4 });
    // js_run itself spends ~100ms in the isolate; the read must not start before it ends.
    const original = runtime.kernel.execute.bind(runtime.kernel);
    runtime.kernel.execute = async (invocation) => {
      active++;
      overlap = Math.max(overlap, active);
      try {
        return await original(invocation);
      } finally {
        active--;
      }
    };
    await fx.play([js("return 1;"), { name: "slow_read" }]);
    expect(overlap).toBe(1);
  });

  it("FJ-AC-27a: cancelled after a nested write, the call stays pending and the execution is cancelled", async () => {
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const writer: ToolDefinition = {
      name: "t_write",
      description: "write",
      inputSchema: { type: "object", properties: {} },
      effect: "write",
      async execute() {
        return { content: [{ type: "text", text: "written" }] };
      },
    };
    const gate: ToolDefinition = {
      name: "hold",
      description: "waits for cancellation",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute(_input, context) {
        enter();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve()),
        );
        return { content: [{ type: "text", text: "late" }] };
      },
    };
    const { fx, journal, js } = await open({ policy: full, tools: [writer, gate] });
    const controller = new AbortController();
    const done = fx.play(
      [js("await tools.call('t_write', {}); await tools.call('hold', {});")],
      {},
      controller.signal,
    );
    await entered;
    controller.abort(new Error("stop"));
    await done;
    expect(fx.callStatus("c1")).toBe("pending");
    const [row] = journal.listByRoot(fx.session);
    expect(row?.status).toBe("cancelled");
    const calls = journal.calls(row?.id ?? "");
    expect(calls.map((c) => [c.toolName, c.effect])).toEqual([
      ["t_write", "write"],
      ["hold", "read"],
    ]);
    expect(calls[0]?.status).toBe("succeeded");
    // Whatever was running when the stop came has ended: nothing is left `started`.
    expect(calls.some((c) => c.status === "started")).toBe(false);
  });

  it("a cancelled js_run that only read is closed, not left pending", async () => {
    const hold: ToolDefinition = {
      name: "hold",
      description: "waits",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute(_input, context) {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve()),
        );
        return { content: [{ type: "text", text: "late" }] };
      },
    };
    const { fx, js } = await open({ tools: [hold] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop")), 400);
    await fx.play([js("await tools.call('hold', {});")], {}, controller.signal);
    expect(fx.callStatus("c1")).not.toBe("pending");
  });

  it("is offered in --read-only style runs: reads compose, anything else is denied", async () => {
    const ran: string[] = [];
    const { fx, js } = await open({
      policy: { write: false, process: false, external: false },
      approve: false,
      tools: [read(ran), write(ran)],
    });
    const [out] = await fx.play([
      js(
        `const a = await tools.call('t_read', {}); let b; try { await tools.call('t_write', {}); } catch (e) { b = e.code; } return [a, b];`,
      ),
    ]);
    expect(out?.text).toContain('value: ["ran t_read","PERMISSION_DENIED"]');
  });
});

describe("progress (D14)", () => {
  it("reports the phases and each nested call through tool_progress, terminals included", async () => {
    const ran: string[] = [];
    const { fx, js, events } = await open({ tools: [read(ran)] });
    await fx.play([
      js(
        "progress({ message: 'halfway', completed: 1, total: 2 }); await tools.call('t_read', {}); return 1;",
      ),
    ]);
    const progress = events
      .filter((event) => event.type === "tool_progress")
      .map(
        (event) =>
          (event.data as { data: { phase: string; call?: { status: string; tool: string } } }).data,
      )
      .filter((data) => (data as { kind?: string }).kind === "forge");
    const phases = progress.map((p) => p.phase);
    expect(phases[0]).toBe("preparing");
    expect(phases).toContain("running");
    expect(phases.at(-1)).toBe("collecting");
    const callEvents = progress
      .filter((p) => p.phase === "call")
      .map((p) => `${p.call?.tool}:${p.call?.status}`);
    expect(callEvents.at(-1)).toBe("t_read:succeeded");
  });
});

describe("codePath (D-30, FJ-AC-30)", () => {
  async function withPad() {
    const ctx = await open({ pathAccess: true });
    // Touch the scratchpad into existence by running anything.
    await ctx.fx.play([ctx.js("return 1;")]);
    const pad = join(ctx.fx.root, "tmp");
    return { ...ctx, pad };
  }
  const scratch = async (fx: { root: string }) => {
    const { readdir } = await import("node:fs/promises");
    const base = join(fx.root, "tmp");
    const find = async (dir: string): Promise<string | undefined> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === "scratchpad") return join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await find(join(dir, entry.name));
          if (found) return found;
        }
      }
      return undefined;
    };
    return find(base);
  };

  it("runs a .js file from the scratchpad", async () => {
    const { fx } = await withPad();
    const pad = (await scratch(fx)) as string;
    await writeFile(join(pad, "plan.js"), "return 6 * 7;");
    const [out] = await fx.play([{ name: "js_run", arguments: { codePath: "plan.js" } }]);
    expect(out?.text).toContain("value: 42");
  });

  it("refuses a path outside the scratchpad, a symlink out of it, and a wrong extension", async () => {
    const { fx } = await withPad();
    const pad = (await scratch(fx)) as string;
    await writeFile(join(fx.root, "outside.js"), "return 1;");
    await symlink(join(fx.root, "outside.js"), join(pad, "link.js"));
    await mkdir(join(pad, "dir"));
    await writeFile(join(pad, "notes.txt"), "return 1;");
    for (const codePath of [
      "../outside.js",
      join(fx.root, "outside.js"),
      "link.js",
      "notes.txt",
      "dir",
      "missing.js",
    ]) {
      const [out] = await fx.play([{ name: "js_run", arguments: { codePath } }]);
      expect(out?.isError, codePath).toBe(true);
      expect(out?.text, codePath).toMatch(/^INVALID_INPUT/);
    }
  });

  it("needs exactly one of code and codePath, and a file within 64 KiB", async () => {
    const { fx } = await withPad();
    const pad = (await scratch(fx)) as string;
    await writeFile(join(pad, "big.js"), `/*${"x".repeat(70_000)}*/ return 1;`);
    for (const args of [{}, { code: "return 1;", codePath: "plan.js" }, { codePath: "big.js" }]) {
      const [out] = await fx.play([{ name: "js_run", arguments: args }]);
      expect(out?.text).toMatch(/^INVALID_INPUT/);
    }
    expect(await readFile(join(pad, "big.js"), "utf8")).toContain("return 1");
  });

  it("without a scratchpad (read-only, or the engine's folder is unavailable) codePath is unusable", async () => {
    const { fx } = await open();
    const [out] = await fx.play([{ name: "js_run", arguments: { codePath: "plan.js" } }]);
    expect(out?.text).toMatch(/needs the session scratchpad/);
  });
});

describe("the result the model reads", () => {
  it("renders the status, value, output and counts compactly, and cuts at maxOutputChars", async () => {
    const { fx, js } = await open({ forgeConfig: { maxOutputChars: 300 } });
    const [out] = await fx.play([js("text('line\\n'.repeat(200)); return { ok: true };")]);
    expect(out?.isError).toBe(false);
    expect(out?.text).toMatch(/^status: succeeded\nvalue: \{"ok":true\}\noutput:\nline/);
    expect(out?.text).toMatch(/\[output truncated at 300 characters/);
    expect(out?.text).toMatch(/calls: 0 total, 0 failed, 0 denied$/);
    expect(out?.text.length).toBeLessThan(600);
  });

  it("a failed script is an error result with its code, and a timeout is one too", async () => {
    const { fx, js } = await open();
    const [failed, timedOut] = await fx.play([
      js("throw new Error('nope');"),
      js("while (true) {}", { timeoutMs: 300 }),
    ]);
    expect(failed?.isError).toBe(true);
    expect(failed?.text).toMatch(/error: SCRIPT_RUNTIME: nope/);
    expect(timedOut?.isError).toBe(true);
    expect(timedOut?.text).toMatch(/status: timed_out/);
  });
});
