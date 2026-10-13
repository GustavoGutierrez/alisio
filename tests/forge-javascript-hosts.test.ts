/**
 * The isolate hosts (spec D-20, D-21, FJ-AC-07): framing, host choice, and the worker and process
 * hosts driven through the real kernel. A process host here runs the real entry file on this
 * runtime; the same checks run on Bun through `scripts/forge-bun-smoke.ts`.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { chooseHostKind } from "../packages/core/src/forge/javascript/hosts/factory.ts";
import {
  isBunCompiled,
  isolateEnv,
  resolveIsolateCommand,
} from "../packages/core/src/forge/javascript/hosts/process-host.ts";
import {
  workerEntryUrl,
  workerExecArgv,
} from "../packages/core/src/forge/javascript/hosts/worker-host.ts";
import { kernelFixture, probeTools } from "./forge-kernel-helpers.ts";

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

describe("host choice (D-20)", () => {
  it("auto picks the worker on Node and the process on Bun; a setting forces either", () => {
    expect(chooseHostKind("auto", false)).toBe("worker");
    expect(chooseHostKind("auto", true)).toBe("process");
    expect(chooseHostKind("process", false)).toBe("process");
    expect(chooseHostKind("worker", true)).toBe("worker");
  });

  it("a compiled Bun binary re-runs itself with the hidden command; otherwise the entry file runs", () => {
    expect(resolveIsolateCommand({ compiled: true, execPath: "/opt/alisio" })).toEqual({
      execPath: "/opt/alisio",
      args: ["__forge-isolate"],
    });
    const fromSource = resolveIsolateCommand({
      compiled: false,
      base: "file:///x/hosts/process-host.ts",
    });
    expect(fromSource.args.at(-1)).toBe("/x/hosts/process-entry.ts");
    const fromDist = resolveIsolateCommand({
      compiled: false,
      base: "file:///x/hosts/process-host.js",
    });
    expect(fromDist.args).toEqual(["/x/hosts/process-entry.js"]);
    expect(workerEntryUrl("file:///x/hosts/worker-host.js").pathname).toBe(
      "/x/hosts/worker-entry.js",
    );
    expect(isBunCompiled("/home/user/main.js")).toBe(false);
    expect(isBunCompiled("/$bunfs/root/alisio")).toBe(process.versions.bun ? true : false);
  });

  it("the isolate process refuses to run without ALISIO_FORGE_ISOLATE=1", () => {
    const entry = fileURLToPath(
      new URL("../packages/core/src/forge/javascript/hosts/process-entry.ts", import.meta.url),
    );
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", entry],
      {
        env: {},
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/internal/);
  });
});

describe("isolate environment (L8)", () => {
  const parent = { PATH: "/bin", HOME: "/home/x", SystemRoot: "C:\\Windows", TOKEN: "s3cret" };

  it("is only the isolate marker on POSIX", () => {
    expect(isolateEnv("linux", parent)).toEqual({ ALISIO_FORGE_ISOLATE: "1" });
    expect(isolateEnv("darwin", parent)).toEqual({ ALISIO_FORGE_ISOLATE: "1" });
  });

  it("adds SystemRoot and nothing else on Windows, only when the parent has it", () => {
    expect(isolateEnv("win32", parent)).toEqual({
      ALISIO_FORGE_ISOLATE: "1",
      SystemRoot: "C:\\Windows",
    });
    expect(isolateEnv("win32", { PATH: "x" })).toEqual({ ALISIO_FORGE_ISOLATE: "1" });
  });
});

describe.each(["worker", "process"] as const)("%s host through the kernel", (host) => {
  async function fixture() {
    const fx = await kernelFixture({ host, tools: [probeTools().echo] });
    fixtures.push(fx);
    return fx;
  }

  it("runs a script that calls a tool", async () => {
    const fx = await fixture();
    const result = await fx.run(
      "const r = await tools.call('echo', { n: 4 }); text('hi'); return r.n * 2;",
    );
    expect(result.status).toBe("succeeded");
    expect(result.value).toBe(8);
    expect(result.output).toEqual([{ type: "text", text: "hi" }]);
  });

  it("FJ-AC-07: while(true) times out within the deadline plus a second and the host is cleaned up", async () => {
    const fx = await fixture();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    const result = await fx.run("while (true) {}", { requestedLimits: { timeoutMs: 400 } });
    clearInterval(timer);
    expect(result.status).toBe("timed_out");
    expect(Date.now() - started).toBeLessThan(400 + 1000);
    expect(ticks).toBeGreaterThan(10);
    const row = fx.journal.get(result.executionId);
    expect(row?.status).toBe("timed_out");
    expect(row?.terminationUnconfirmed).toBe(false);
  });

  it("a user cancellation stops a busy loop quickly", async () => {
    const fx = await fixture();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop")), 200);
    const started = Date.now();
    const result = await fx.run("while (true) {}", { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(1200);
    expect(fx.journal.get(result.executionId)?.terminationUnconfirmed).toBe(false);
  });

  it("FJ-AC-27: repeated runs leave no slot held and every isolate confirmed gone", async () => {
    const fx = await fixture();
    for (let i = 0; i < 15; i++) expect((await fx.run(`return ${i};`)).value).toBe(i);
    expect(fx.slots.active).toBe(0);
    const rows = fx.journal.listByRoot(fx.session);
    expect(rows).toHaveLength(15);
    expect(rows.every((row) => row.status === "succeeded" && !row.terminationUnconfirmed)).toBe(
      true,
    );
  });

  it("the guest cannot reach the host's environment or files", async () => {
    process.env.FORGE_TEST_SECRET = "hunter2";
    const fx = await fixture();
    const result = await fx.run(
      "return [typeof process, typeof require, typeof Deno, typeof Bun, typeof globalThis.FORGE_TEST_SECRET];",
    );
    delete process.env.FORGE_TEST_SECRET;
    expect(result.value).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
  });

  it("L3: a call input near the limit works, one over it is TOOL_INPUT_INVALID (never a protocol violation), in bytes", async () => {
    const sink: ToolDefinition = {
      name: "sink",
      description: "Accepts a string. Test tool.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { s: { type: "string" } },
        required: ["s"],
        additionalProperties: false,
      },
      async execute(input) {
        return {
          content: [{ type: "text", text: JSON.stringify({ len: String(input.s).length }) }],
        };
      },
    };
    const fx = await kernelFixture({ host, tools: [sink] });
    fixtures.push(fx);
    const result = await fx.run(
      `const out = {};
       const attempt = async (label, s) => {
         try { out[label] = (await tools.call('sink', { s })).len; } catch (e) { out[label] = e.code; }
       };
       await attempt('ascii-fits', 'a'.repeat(250000));
       await attempt('ascii-over', 'a'.repeat(262100));
       await attempt('utf8-fits', '\u00e9'.repeat(120000));
       await attempt('utf8-over', '\u00e9'.repeat(131000));
       await attempt('emoji-over', '\u{1F600}'.repeat(66000));
       return out;`,
    );
    expect(result.status).toBe("succeeded");
    expect(result.value).toEqual({
      "ascii-fits": 250000,
      "ascii-over": "TOOL_INPUT_INVALID",
      "utf8-fits": 120000,
      "utf8-over": "TOOL_INPUT_INVALID",
      "emoji-over": "TOOL_INPUT_INVALID",
    });
  });
});

describe("worker entry flags", () => {
  const ts = new URL("file:///x/worker-entry.ts");
  const js = new URL("file:///x/worker-entry.js");

  it("adds type stripping for a .ts entry on a Node without default stripping (22.16)", () => {
    expect(workerExecArgv(ts, {})).toContain("--experimental-strip-types");
  });

  it("adds nothing for a built .js entry, on Bun, or when Node strips types itself", () => {
    expect(workerExecArgv(js, {})).toEqual([]);
    expect(workerExecArgv(ts, { bun: "1.4.2" })).toEqual([]);
    expect(workerExecArgv(ts, { typescript: "strip" })).toEqual([]);
  });
});
