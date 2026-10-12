/**
 * The JavaScript engine through the real kernel, real QuickJS and a real worker host
 * (FJ-AC-01..04, 08..11, 13..17). Tools and the model are the only doubles. Tests that can block a
 * thread use short deadlines and check that this very test thread stays responsive.
 */
import type { ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { fullPolicy, kernelFixture, noPolicy, probeTools } from "./forge-kernel-helpers.ts";

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture(options: Parameters<typeof kernelFixture>[0] = {}) {
  const fx = await kernelFixture(options);
  fixtures.push(fx);
  return fx;
}

/** Polls a condition on state the test can observe, so no test depends on a wall-clock margin. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("results and the sandbox surface", () => {
  it("FJ-AC-01: computes and returns JSON with no calls", async () => {
    const fx = await fixture();
    const result = await fx.run(
      "const xs = [1, 2, 3].map((n) => n * n); return { sum: xs.reduce((a, b) => a + b, 0), xs };",
    );
    expect(result.status).toBe("succeeded");
    expect(result.value).toEqual({ sum: 14, xs: [1, 4, 9] });
    expect(result.calls).toEqual({ total: 0, failed: 0, denied: 0 });
    expect(result.engine).toBe("javascript-quickjs");
    expect(result.selectionReason).toBe("language=javascript");
    expect(fx.journal.get(result.executionId)?.status).toBe("succeeded");
  });

  it("collects text and console output in order, with the value", async () => {
    const fx = await fixture();
    const result = await fx.run(
      "text('a'); console.log('b', 1); console.warn({ k: 2 }); return 'done';",
    );
    expect(result.output).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b 1\n" },
      { type: "text", text: '{"k":2}\n' },
    ]);
    expect(result.value).toBe("done");
  });

  it("FJ-AC-04: no process, require, import(), fetch, timers, SharedArrayBuffer or QuickJS host objects", async () => {
    const fx = await fixture();
    const names = [
      "process",
      "require",
      "fetch",
      "setTimeout",
      "setInterval",
      "SharedArrayBuffer",
      "Atomics",
      "WebAssembly",
      "print",
      "std",
      "os",
      "scriptArgs",
      "gc",
      "Buffer",
      "XMLHttpRequest",
    ];
    const result = await fx.run(
      `const present = ${JSON.stringify(names)}.filter((n) => typeof globalThis[n] !== 'undefined');
       let imported = 'resolved';
       try { await import('node:fs'); } catch (e) { imported = 'rejected'; }
       return { present, imported, bridge: typeof __forge_bridge };`,
    );
    expect(result.value).toEqual({ present: [], imported: "rejected", bridge: "undefined" });
  });

  it("freezes the API: a script cannot replace tools or the prelude's globals", async () => {
    const fx = await fixture();
    const result = await fx.run(
      `'use strict'; const out = [];
       for (const name of ['tools', 'catalog', 'state', 'text', 'parallel', 'console', 'callTool']) {
         try { globalThis[name] = 1; out.push(name + ':writable'); } catch (e) { /* read-only */ }
       }
       try { tools.call = () => 1; out.push('tools.call:writable'); } catch (e) { /* frozen */ }
       return out;`,
    );
    expect(result.value).toEqual([]);
  });

  it("reports syntax errors and runtime errors with distinct codes", async () => {
    const fx = await fixture();
    expect((await fx.run("let x = ;")).error?.code).toBe("SCRIPT_SYNTAX");
    const hinted = await fx.run("import fs from 'node:fs';");
    expect(hinted.error?.code).toBe("SCRIPT_SYNTAX");
    expect(hinted.error?.hint?.topic).toBe("js.api");
    const runtime = await fx.run("null.x");
    expect(runtime.status).toBe("failed");
    expect(runtime.error?.code).toBe("SCRIPT_RUNTIME");
  });

  it("rejects an empty or oversized script before any isolate starts", async () => {
    const fx = await fixture();
    expect((await fx.run("   ")).error?.code).toBe("INVALID_INPUT");
    const big = await fx.run(`return '${"x".repeat(70_000)}'`);
    expect(big.error?.code).toBe("INVALID_INPUT");
    expect(fx.journal.get(big.executionId)?.status).toBe("failed");
  });
});

describe("nested calls", () => {
  it("FJ-AC-02: parallel.map keeps order and never exceeds maxConcurrency", async () => {
    const probe = probeTools();
    const fx = await fixture({ tools: [probe.echo], limits: { maxConcurrency: 4 } });
    const result = await fx.run(
      `const items = Array.from({ length: 10 }, (_, i) => i);
       return await parallel.map(items, async (i) => (await tools.call('echo', { n: i, delayMs: 20 })).n);`,
    );
    expect(result.value).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(probe.maxActive()).toBeLessThanOrEqual(4);
    expect(probe.maxActive()).toBeGreaterThan(1);
    expect(result.calls.total).toBe(10);
  });

  it("Promise.all does not escape the concurrency limit either", async () => {
    const probe = probeTools();
    const fx = await fixture({ tools: [probe.echo], limits: { maxConcurrency: 2 } });
    const result = await fx.run(
      "return (await Promise.all([1, 2, 3, 4, 5, 6].map((n) => tools.call('echo', { n, delayMs: 15 })))).map((r) => r.n);",
    );
    expect(result.value).toEqual([1, 2, 3, 4, 5, 6]);
    expect(probe.maxActive()).toBeLessThanOrEqual(2);
  });

  it("parallel.settle collects every outcome; parallel.map stops launching after the first failure", async () => {
    const probe = probeTools();
    const fx = await fixture({ tools: [probe.echo] });
    const settled = await fx.run(
      `return await parallel.settle([1, 'bad', 3], async (v) => tools.call('echo', { n: v }), { concurrency: 1 });`,
    );
    const values = settled.value as Array<{ ok: boolean; error?: { code: string } }>;
    expect(values.map((v) => v.ok)).toEqual([true, false, true]);
    expect(values[1]?.error?.code).toBe("TOOL_INPUT_INVALID");

    const mapped = await fx.run(
      `const started = [];
       try { await parallel.map([1, 'bad', 3, 4], async (v) => { started.push(v); return tools.call('echo', { n: v }); }, { concurrency: 1 }); }
       catch (e) { return { code: e.code, started }; }`,
    );
    expect(mapped.value).toEqual({ code: "TOOL_INPUT_INVALID", started: [1, "bad"] });
  });

  it("FJ-AC-03: the call after maxToolCalls ends the execution with BUDGET_EXCEEDED, uncatchably", async () => {
    const probe = probeTools();
    const fx = await fixture({ tools: [probe.echo], limits: { maxToolCalls: 50 } });
    const result = await fx.run(
      `let caught = 0;
       for (let i = 0; i < 60; i++) { try { await tools.call('echo', { n: i }); } catch (e) { caught++; } }
       return caught;`,
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("BUDGET_EXCEEDED");
    expect(result.calls.total).toBe(50);
  });

  it("FJ-AC-11: input outside the tool's schema fails with TOOL_INPUT_INVALID and never runs the tool", async () => {
    const probe = probeTools();
    const fx = await fixture({ tools: [probe.echo] });
    const result = await fx.run(
      "try { await tools.call('echo', { n: 'not a number' }); return 'ran'; } catch (e) { return e.code; }",
    );
    expect(result.value).toBe("TOOL_INPUT_INVALID");
    expect(probe.maxActive()).toBe(0);
    expect(result.calls.failed).toBe(1);
  });

  it("FJ-AC-13: js_run, exit_plan, forge_guide, task and execute are not reachable", async () => {
    const mk = (name: string): ToolDefinition => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute() {
        return { content: [{ type: "text", text: "ran" }] };
      },
    });
    const names = [
      "js_run",
      "exit_plan",
      "forge_guide",
      "task",
      "task_wait",
      "send_message",
      "execute",
    ];
    const fx = await fixture({ tools: names.map(mk) });
    const result = await fx.run(
      `const out = {};
       for (const name of ${JSON.stringify(names)}) { try { await tools.call(name, {}); out[name] = 'ran'; } catch (e) { out[name] = e.code; } }
       return out;`,
    );
    expect(Object.values(result.value as Record<string, string>)).toEqual(
      names.map(() => "TOOL_UNAVAILABLE"),
    );
  });

  it("FJ-AC-13: ask_user_question (an interactive prompt) is not reachable and never runs", async () => {
    const ran: string[] = [];
    const ask: ToolDefinition = {
      name: "ask_user_question",
      description: "opens a prompt",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute() {
        ran.push("ask_user_question");
        return { content: [{ type: "text", text: "asked" }] };
      },
    };
    const fx = await fixture({ tools: [ask] });
    const result = await fx.run(
      `try { await tools.call('ask_user_question', {}); return 'ran'; } catch (e) { return e.code; }`,
    );
    expect(result.value).toBe("TOOL_UNAVAILABLE");
    expect(ran).toEqual([]);
  });

  it("FJ-AC-14: python_run is reachable only through the analysis flag, never a stored grant", async () => {
    const python: ToolDefinition = {
      name: "python_run",
      description: "python",
      inputSchema: { type: "object", properties: {} },
      effect: "process",
      capability: "analysis.run",
      async execute() {
        return { content: [{ type: "text", text: '"py"' }] };
      },
    };
    const fx = await fixture({ tools: [python] });
    const script =
      "try { return await tools.call('python_run', {}); } catch (e) { return e.code; }";
    expect((await fx.run(script, { policy: noPolicy })).value).toBe("PERMISSION_DENIED");
    expect((await fx.run(script, { policy: { ...noPolicy, analysis: true } })).value).toBe("py");
  });

  it("an effect that would need an approval fails with APPROVAL_REQUIRED and counts as denied", async () => {
    const write: ToolDefinition = {
      name: "writer",
      description: "writes",
      inputSchema: { type: "object", properties: {} },
      effect: "write",
      async execute() {
        throw new Error("must not run");
      },
    };
    const fx = await fixture({ tools: [write] });
    const result = await fx.run(
      "try { await tools.call('writer', {}); } catch (e) { return e.code; }",
      { policy: noPolicy, approvals: true },
    );
    expect(result.value).toBe("APPROVAL_REQUIRED");
    expect(result.calls).toEqual({ total: 1, failed: 0, denied: 1 });
  });

  it("journals every nested call, with hashes and the paths of writes", async () => {
    const probe = probeTools();
    const fx = await fixture({ tools: [probe.echo] });
    const result = await fx.run(
      "await tools.call('echo', { n: 1 }); try { await tools.call('echo', { n: 'x' }); } catch (e) {} return 1;",
    );
    const calls = fx.journal.calls(result.executionId);
    expect(calls.map((c) => [c.toolName, c.status, c.errorCode])).toEqual([
      ["echo", "succeeded", undefined],
      ["echo", "failed", "TOOL_INPUT_INVALID"],
    ]);
    expect(calls[0]?.callId).toMatch(/:forge:1$/);
    expect(calls[0]?.inputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers a call that returns too much with OUTPUT_LIMIT and how to page", async () => {
    const big: ToolDefinition = {
      name: "big",
      description: "big",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute() {
        return { content: [{ type: "text", text: JSON.stringify({ blob: "x".repeat(2000) }) }] };
      },
    };
    const fx = await fixture({ tools: [big], limits: { maxCallResponseBytes: 1000 } });
    const result = await fx.run(
      "try { await tools.call('big', {}); } catch (e) { return [e.code, e.message]; }",
    );
    const [code, message] = result.value as string[];
    expect(code).toBe("OUTPUT_LIMIT");
    expect(message).toMatch(/ask for less/);
  });

  it("catalog.search and catalog.describe list only what the run lets the script call", async () => {
    const probe = probeTools();
    const writer: ToolDefinition = {
      name: "writer",
      description: "Writes a file.",
      inputSchema: { type: "object", properties: {} },
      effect: "write",
      async execute() {
        return { content: [{ type: "text", text: "no" }] };
      },
    };
    const fx = await fixture({ tools: [probe.echo, writer], policy: noPolicy });
    const result = await fx.run(
      `return { found: (await catalog.search('echo')).map((e) => e.name),
                all: (await catalog.search('')).map((e) => e.name),
                detail: (await catalog.describe('echo')).inputSchema.required };`,
    );
    expect(result.value).toEqual({ found: ["echo"], all: ["echo"], detail: ["n"] });
  });
});

describe("stored state", () => {
  it("FJ-AC-17: a script that fails after state.set leaves nothing behind; a success commits", async () => {
    const fx = await fixture();
    expect((await fx.run("state.set('k', { n: 1 }); throw new Error('boom');")).status).toBe(
      "failed",
    );
    expect(fx.stateStore.snapshot(fx.session).values).toEqual({});
    expect((await fx.run("state.set('k', { n: 1 }); return state.get('k');")).value).toEqual({
      n: 1,
    });
    expect(
      (await fx.run("const v = state.get('k'); state.set('k', { n: v.n + 1 }); return v;")).value,
    ).toEqual({ n: 1 });
    expect(fx.stateStore.snapshot(fx.session).values).toEqual({ k: { n: 2 } });
    expect((await fx.run("state.delete('k'); return state.get('k') === undefined;")).value).toBe(
      true,
    );
    expect(fx.stateStore.snapshot(fx.session).values).toEqual({});
  });

  it("FJ-AC-16: of two executions that saw the same revision, one commits and the other gets STATE_CONFLICT", async () => {
    const fx = await fixture({ tools: [probeTools().echo] });
    // Both start from an empty snapshot; the slow one commits second.
    const slow = fx.run(
      "state.set('k', 'slow'); await tools.call('echo', { n: 1, delayMs: 150 }); return 'slow';",
      { session: fx.store.create(fx.root, "test", "m").id },
    );
    const quick = await fx.run("state.set('k', 'quick'); return 'quick';");
    const late = await slow;
    expect(quick.status).toBe("succeeded");
    expect(late.status).toBe("failed");
    expect(late.error?.code).toBe("STATE_CONFLICT");
    expect(fx.stateStore.snapshot(fx.session).values).toEqual({ k: "quick" });
  });

  it("switching stored state off makes state.set a clear error", async () => {
    const fx = await fixture({ config: { stateEnabled: false } });
    const result = await fx.run("state.set('k', 1); return 1;");
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/state is switched off/);
  });
});

describe("limits that must hold", () => {
  it("FJ-AC-15: a root promise nothing can settle ends with UNRESOLVABLE_PROMISE", async () => {
    const fx = await fixture();
    const result = await fx.run("await new Promise(() => {});");
    expect(result.error?.code).toBe("UNRESOLVABLE_PROMISE");
  });

  it("FJ-AC-08: an endless microtask loop times out and the test thread stays responsive", async () => {
    const fx = await fixture();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const result = await fx.run(
      "function f() { Promise.resolve().then(f); } f(); await new Promise(() => {});",
      {
        requestedLimits: { timeoutMs: 400 },
      },
    );
    clearInterval(timer);
    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("TIMEOUT");
    expect(result.metrics.wallMs).toBeLessThan(1500);
    expect(ticks).toBeGreaterThan(5);
    expect(fx.journal.get(result.executionId)?.terminationUnconfirmed).toBe(false);
  });

  it("a busy loop times out within the deadline plus a second", async () => {
    const fx = await fixture();
    const result = await fx.run("while (true) {}", { requestedLimits: { timeoutMs: 300 } });
    expect(result.status).toBe("timed_out");
    expect(result.metrics.wallMs).toBeLessThan(1300);
  });

  it("FJ-AC-09: heap exhaustion and runaway recursion are reported and cleaned up", async () => {
    const fx = await fixture({ limits: { memoryBytes: 8 * 1024 * 1024 } });
    const heap = await fx.run("const a = []; for (;;) a.push(new Array(1000).fill(1));");
    expect(heap.error?.code).toBe("MEMORY_LIMIT");
    const stack = await fx.run("function r() { return r() + 1; } r();");
    expect(stack.error?.code).toBe("STACK_LIMIT");
    for (const r of [heap, stack]) expect(fx.journal.get(r.executionId)?.status).toBe("failed");
    expect(fx.slots.active).toBe(0);
  });

  it("FJ-AC-10: cancelling during compute ends as cancelled with a confirmed stop", async () => {
    const fx = await fixture();
    const controller = new AbortController();
    let abortedAt = 0;
    // Cancel only once the script is provably computing, however loaded the machine is.
    void until(
      () => fx.progress.some((p) => p.message === "spinning"),
      "the script to start spinning",
    ).then(() => {
      abortedAt = Date.now();
      controller.abort(new Error("stop"));
    });
    const result = await fx.run("progress({ message: 'spinning' }); while (true) {}", {
      signal: controller.signal,
    });
    const stoppedAfterMs = Date.now() - abortedAt;
    expect(abortedAt).toBeGreaterThan(0);
    expect(result.status).toBe("cancelled");
    expect(result.error?.code).toBe("CANCELLED");
    expect(stoppedAfterMs).toBeLessThan(5000);
    const row = fx.journal.get(result.executionId);
    expect(row?.status).toBe("cancelled");
    expect(row?.terminationUnconfirmed).toBe(false);
  });

  it("cancelling while a nested call runs aborts the call and finishes", async () => {
    let seenAbort = false;
    let callRunning = false;
    const slow: ToolDefinition = {
      name: "slow",
      description: "slow",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute(_input, context) {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => {
            seenAbort = true;
            resolve();
          });
          callRunning = true;
          setTimeout(resolve, 5000);
        });
        return { content: [{ type: "text", text: "late" }] };
      },
    };
    const fx = await fixture({ tools: [slow] });
    const controller = new AbortController();
    // Cancel only once the nested call is really waiting, so the abort always reaches it.
    void until(() => callRunning, "the nested call to start").then(() =>
      controller.abort(new Error("stop")),
    );
    const result = await fx.run("await tools.call('slow', {});", { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(seenAbort).toBe(true);
    expect(fx.journal.calls(result.executionId).every((c) => c.status !== "started")).toBe(true);
  });

  it("a deadline while a nested call waits aborts the call too", async () => {
    let seenAbort = false;
    const slow: ToolDefinition = {
      name: "slow",
      description: "slow",
      inputSchema: { type: "object", properties: {} },
      effect: "read",
      async execute(_input, context) {
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) {
            seenAbort = true;
            return resolve();
          }
          context.signal.addEventListener("abort", () => {
            seenAbort = true;
            resolve();
          });
          setTimeout(resolve, 15_000);
        });
        return { content: [{ type: "text", text: "late" }] };
      },
    };
    const fx = await fixture({ tools: [slow] });
    const result = await fx.run("await tools.call('slow', {});", {
      requestedLimits: { timeoutMs: 1500 },
    });
    expect(result.status).toBe("timed_out");
    expect(seenAbort).toBe(true);
  });

  it("bounds retained output: more than maxRetainedOutputBytes ends with OUTPUT_LIMIT", async () => {
    const fx = await fixture({ limits: { maxRetainedOutputBytes: 5000 } });
    const result = await fx.run("for (let i = 0; i < 100; i++) text('x'.repeat(500)); return 1;");
    expect(result.error?.code).toBe("OUTPUT_LIMIT");
  });
});

describe("slots and cleanup", () => {
  it("D-29: a second execution in the same session is refused while the first runs", async () => {
    const fx = await fixture({ tools: [probeTools().echo] });
    const first = fx.run("await tools.call('echo', { n: 1, delayMs: 200 }); return 1;");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = await fx.run("return 2;");
    expect(second.error?.code).toBe("BUDGET_EXCEEDED");
    expect((await first).status).toBe("succeeded");
    expect((await fx.run("return 3;")).status).toBe("succeeded");
  });

  it("FJ-AC-27: 100 back-to-back executions leave no worker alive and no slot held", async () => {
    const fx = await fixture();
    const { threadId, isMainThread } = await import("node:worker_threads");
    expect(isMainThread || threadId >= 0).toBe(true);
    const before = process
      .getActiveResourcesInfo()
      .filter((r) => r === "MessagePort" || r === "Worker").length;
    for (let i = 0; i < 100; i++) {
      const result = await fx.run(`return ${i};`);
      expect(result.value).toBe(i);
    }
    expect(fx.slots.active).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = process
      .getActiveResourcesInfo()
      .filter((r) => r === "MessagePort" || r === "Worker").length;
    expect(after).toBeLessThanOrEqual(before);
    const rows = fx.journal.listByRoot(fx.session);
    expect(rows).toHaveLength(100);
    expect(rows.every((r) => r.status === "succeeded" && !r.terminationUnconfirmed)).toBe(true);
  });

  it("the live log keeps the run's output under tasks/, private to the user", async () => {
    const fx = await fixture();
    const result = await fx.run("text('hello log'); return 1;");
    const { readFile, stat } = await import("node:fs/promises");
    const path = `${fx.root}/tasks/${result.executionId}.log`;
    expect(await readFile(path, "utf8")).toMatch(/hello log/);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("security review: what the script controls", () => {
  it("M2: a tool name outside [a-zA-Z0-9_-]{1,64} is TOOL_UNAVAILABLE in the guest and never reaches the host", async () => {
    const fx = await fixture({ tools: [probeTools().echo] });
    const result = await fx.run(
      `const out = [];
       for (const name of ['x'.repeat(500), 'a b', 'a/../b', '\u00e9', 'x'.repeat(65)]) {
         try { await tools.call(name, {}); out.push('ran'); } catch (e) { out.push(e.code); }
       }
       return out;`,
    );
    expect(result.status).toBe("succeeded");
    expect(result.value).toEqual(Array(5).fill("TOOL_UNAVAILABLE"));
    expect(result.calls.total).toBe(0);
  });

  it.each([
    "CANCELLED",
    "TIMEOUT",
    "E_MINE",
    "PROTOCOL_VIOLATION",
    "MEMORY_LIMIT",
    "ISOLATE_FAILURE",
  ])(
    "M3: throwing { code: %s } is a failed SCRIPT_RUNTIME, never a terminal state of the guest's choosing",
    async (code) => {
      const fx = await fixture();
      const result = await fx.run(`throw { code: ${JSON.stringify(code)}, message: 'mine' };`);
      expect(result.status).toBe("failed");
      expect(result.error).toMatchObject({ code: "SCRIPT_RUNTIME", message: "mine" });
    },
  );

  it("M3: the codes of a nested call still reach the caller of an uncaught error", async () => {
    const fx = await fixture();
    const result = await fx.run("await tools.call('missing_tool', {});");
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("TOOL_UNAVAILABLE");
  });

  it("L7: only the engine's own limit errors are MEMORY_LIMIT or STACK_LIMIT, not a message the script writes", async () => {
    const fx = await fixture();
    const forged = await fx.run("throw new Error('out of memory');");
    expect(forged.error?.code).toBe("SCRIPT_RUNTIME");
    const stack = await fx.run("throw new Error('Maximum call stack size exceeded');");
    expect(stack.error?.code).toBe("SCRIPT_RUNTIME");
    const internal = await fx.run(
      "try { null.x; } catch (e) { throw new RangeError('out of memory'); }",
    );
    expect(internal.error?.code).toBe("SCRIPT_RUNTIME");
    const real = await fx.run(
      "const keep = []; while (true) keep.push(new Array(10000).fill(1));",
      { requestedLimits: { memoryBytes: 4 * 1024 * 1024 } },
    );
    expect(real.status).toBe("failed");
    expect(real.error?.code).toBe("MEMORY_LIMIT");
    const deep = await fx.run("const f = (n) => f(n + 1) + 1; return f(0);");
    expect(deep.error?.code).toBe("STACK_LIMIT");
  });

  it("L5: tampering with Array and Promise prototypes does not break parallel or tools.call", async () => {
    const fx = await fixture({ tools: [probeTools().echo] });
    const result = await fx.run(
      `const boom = () => { throw new Error('tampered'); };
       Array.prototype.map = boom; Array.prototype.shift = boom; Array.prototype.join = boom;
       Array.prototype.push = boom; Array.prototype.slice = boom;
       String.prototype.slice = boom; String.prototype.charCodeAt = boom;
       Promise.prototype.then = boom; Promise.resolve = boom; Promise.reject = boom;
       const rows = await parallel.map(Array.from({ length: 12 }, (_, i) => i), async (n) => (await tools.call('echo', { n })).n);
       console.log('still', 'logging');
       progress({ message: 'ok', completed: 1, total: 2 });
       return rows.length === 12 && rows[11] === 11;`,
      { requestedLimits: { maxConcurrency: 2 } },
    );
    expect(result.status).toBe("succeeded");
    expect(result.value).toBe(true);
    expect(result.calls.total).toBe(12);
  });
});

void fullPolicy;
