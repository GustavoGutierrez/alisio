/**
 * `forge_guide` through the real runner and gate, and the error hints of `python_run` (spec §8.3,
 * §8.4): `js.tools` shows what the current permission mode lets a script call, a hint is a one-line
 * pointer that never changes the tool description, and without the guide tool there is no hint.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { GuideProvider } from "../packages/core/src/forge/guides/provider.ts";
import { DEFAULT_FORGE_LIMITS } from "../packages/core/src/forge/limits.ts";
import { hintFor, pythonHintFor, renderForgeResult } from "../packages/core/src/forge/result.ts";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { registerForgeGuide } from "../packages/core/src/tools/forge-guide.ts";
import { type AnalysisHarness, analysisHarness, fake } from "./analysis-run-helpers.ts";
import { effectTool, gateFixture } from "./forge-gate-helpers.ts";
import { fakeContainer } from "./forge-python-helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function guideTool() {
  const registry = new ToolRegistry();
  registerForgeGuide(
    registry,
    new GuideProvider({
      javascript: async () => ({
        version: "quickjs-wasi@3.6.2",
        isolation: "wasm-isolate",
        host: "worker",
        limits: { ...DEFAULT_FORGE_LIMITS },
      }),
    }),
  );
  return registry.get("forge_guide");
}

async function toolsGuideUnder(mode: "ask" | "full" | "readOnly") {
  const policy = PERMISSION_MODE_TABLE[mode === "readOnly" ? "ask" : mode].policy;
  const fx = await gateFixture({
    policy: { ...policy },
    tools: [
      guideTool(),
      effectTool("reader", "read"),
      effectTool("writer", "write"),
      effectTool("runner_x", "process"),
      effectTool("js_run", "read"),
    ],
  });
  cleanups.push(() => fx.close());
  const [out] = await fx.play([{ name: "forge_guide", arguments: { topic: "js.tools" } }]);
  expect(out?.isError).toBe(false);
  return out?.text ?? "";
}

describe("js.tools follows the permission mode of the call", () => {
  it("ask: only the reads a script may run without asking, never the excluded tools", async () => {
    const text = await toolsGuideUnder("ask");
    expect(text).toContain("- reader (read)");
    expect(text).not.toContain("writer");
    expect(text).not.toContain("runner_x");
    expect(text).not.toMatch(/- js_run|- forge_guide/);
  });

  it("full: writes and processes appear too", async () => {
    const text = await toolsGuideUnder("full");
    expect(text).toContain("- reader (read)");
    expect(text).toContain("- writer (write)");
    expect(text).toContain("- runner_x (process)");
    expect(text).not.toMatch(/- js_run|- forge_guide/);
  });

  it("starts with an etag line and a repeated call with it answers unchanged", async () => {
    const fx = await gateFixture({
      policy: { ...PERMISSION_MODE_TABLE.ask.policy },
      tools: [guideTool()],
    });
    cleanups.push(() => fx.close());
    const [first] = await fx.play([{ name: "forge_guide", arguments: { topic: "js.api" } }]);
    const etag = /^etag: ([0-9a-f]{16})/.exec(first?.text ?? "")?.[1];
    expect(etag).toBeDefined();
    const [again] = await fx.play([
      { name: "forge_guide", arguments: { topic: "js.api", ifNoneMatch: etag } },
    ]);
    expect(JSON.parse(again?.text ?? "{}")).toEqual({ unchanged: true, etag });
  });
});

describe("error hints (spec §8.4)", () => {
  it("maps each known cause to its topic", () => {
    expect(hintFor("SCRIPT_SYNTAX", "x", "import fs from 'fs'")?.topic).toBe("js.api");
    expect(hintFor("TOOL_UNAVAILABLE", "")?.topic).toBe("js.tools");
    expect(hintFor("OUTPUT_LIMIT", "")?.topic).toBe("js.patterns#filtering");
    expect(pythonHintFor("PACKAGE_UNAVAILABLE").topic).toBe("python.environment");
    expect(pythonHintFor("RUNTIME_UNAVAILABLE").topic).toBe("python.environment");
  });

  it("the model text carries one pointer line, not the guide", () => {
    const text = renderForgeResult(
      {
        schemaVersion: 1,
        executionId: "e",
        engine: "javascript-quickjs",
        isolation: "wasm-isolate",
        selectionReason: "r",
        status: "failed",
        output: [],
        error: {
          code: "OUTPUT_LIMIT",
          message: "too much",
          hint: { topic: "js.patterns#filtering", reason: "filter first" },
        },
        calls: { total: 0, failed: 0, denied: 0 },
        truncated: false,
        metrics: { wallMs: 1, queueMs: 0, outputBytes: 0 },
      },
      1000,
    ).text;
    const hint = text.split("\n").filter((line) => line.startsWith("hint:"));
    expect(hint).toHaveLength(1);
    expect(hint[0]).toContain("js.patterns");
    expect(hint[0]).toContain("#filtering");
    expect(text.length).toBeLessThan(400);
  });
});

describe("python_run hints", () => {
  async function harness(guide: boolean, deps: Parameters<typeof analysisHarness>[0] = {}) {
    const h = await analysisHarness({
      ...deps,
      deps: { ...deps.deps, guideHints: () => guide },
    });
    cleanups.push(() => h.dispose());
    return h;
  }

  it("no backend can run: the result text ends with a pointer to python.environment", async () => {
    const c = await fakeContainer({ engineMissing: true });
    cleanups.push(() => c.dispose());
    const h = await harness(true, {
      deps: { oci: { mode: () => "oci", runtime: () => c.runtime } },
    });
    const { text, result } = await h.run({ code: fake({}) });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^runtime_unavailable: docker was not found on PATH/);
    expect(text.split("\n").at(-1)).toMatch(/^hint: .*forge_guide topic "python.environment"/);
  });

  it("without forge_guide the same failure carries no pointer", async () => {
    const c = await fakeContainer({ engineMissing: true });
    cleanups.push(() => c.dispose());
    const h = await harness(false, {
      deps: { oci: { mode: () => "oci", runtime: () => c.runtime } },
    });
    const { text } = await h.run({ code: fake({}) });
    expect(text).not.toContain("hint:");
  });

  it("a script that fails on a missing module points at python.environment", async () => {
    const h: AnalysisHarness = await harness(true);
    const { text, result } = await h.run({
      code: fake({
        stderr: "ModuleNotFoundError: No module named 'sklearn'\n",
        exit: 1,
      }),
    });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/hint: .*python\.environment/);
  });

  it("a script that fails for another reason gets no hint", async () => {
    const h: AnalysisHarness = await harness(true);
    const { text } = await h.run({ code: fake({ stderr: "ValueError: nope\n", exit: 1 }) });
    expect(text).not.toContain("hint:");
  });
});
