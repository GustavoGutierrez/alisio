/**
 * `plan.diagrams` and `plan.maxDiagrams` wired through the Application and the plan agent: the
 * defaults, the validated range, the live effect on the tool the model is offered and on the
 * plan agent's instructions, and the style guide matching what the server validates.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeAgentCatalog,
  agentRunOptions,
  PLAN_AGENT_ID,
  planInstructions,
  resolveActiveAgent,
} from "../packages/core/src/agents/active.ts";
import { createApplication, settableSettings } from "../packages/core/src/index.ts";
import { DIAGRAM_CLASSES, DIAGRAM_SYNTAXES } from "../packages/core/src/plan/diagrams.ts";

let root: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-plan-config-"));
  await mkdir(join(root, "ws", ".alisio"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const silent: ModelProvider = {
  id: "fake-provider",
  model: "fake-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
};
async function app(options: Parameters<typeof createApplication>[0] = {}) {
  const created = await createApplication({
    cwd: join(root, "ws"),
    db: join(root, "state", "sessions.sqlite"),
    noHerdr: true,
    provider: silent,
    ...options,
  });
  apps.push(created);
  return created;
}
const offered = (a: Awaited<ReturnType<typeof app>>) => {
  const tool = a.registry.get("exit_plan");
  return {
    fields: Object.keys((tool.inputSchema as { properties: object }).properties),
    description: tool.description,
  };
};

describe("plan settings", () => {
  it("are settable with the documented defaults and range", async () => {
    const keys = settableSettings().filter((s) => s.key.startsWith("plan."));
    expect(keys.map((s) => [s.key, s.kind])).toEqual([
      ["plan.diagrams", "boolean"],
      ["plan.maxDiagrams", "number"],
    ]);
    const a = await app();
    expect(a.config.plan).toEqual({ diagrams: true, maxDiagrams: 5 });
    await expect(a.updateSetting("plan.maxDiagrams", 9)).rejects.toThrow(/Invalid value/);
    await expect(a.updateSetting("plan.maxDiagrams", -1)).rejects.toThrow(/Invalid value/);
    await expect(a.updateSetting("plan.maxDiagrams", 2.5)).rejects.toThrow(/Invalid value/);
    await a.updateSetting("plan.maxDiagrams", 8);
    expect(a.config.plan.maxDiagrams).toBe(8);
  });

  it("change what exit_plan offers the model, live", async () => {
    const a = await app();
    expect(offered(a).fields).toEqual(["title", "plan", "diagrams"]);
    expect(offered(a).description).toContain("up to 5");
    await a.updateSetting("plan.maxDiagrams", 3);
    expect(offered(a).description).toContain("up to 3");
    await a.updateSetting("plan.diagrams", false);
    expect(offered(a).fields).toEqual(["title", "plan"]);
    expect(offered(a).description).not.toContain("diagrams");
    await a.updateSetting("plan.diagrams", true);
    await a.updateSetting("plan.maxDiagrams", 0);
    expect(offered(a).fields).toEqual(["title", "plan"]);
  });

  it("start switched off when the configuration says so, and the tool still validates diagrams", async () => {
    await mkdir(join(root, "config"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify({ plan: { diagrams: false } }),
    );
    const a = await app();
    expect(offered(a).fields).toEqual(["title", "plan"]);
    // Turning them on later offers the field again, and the tool accepts it (the schema compiled
    // at start allows `diagrams`).
    await a.updateSetting("plan.diagrams", true);
    expect(offered(a).fields).toContain("diagrams");
    expect(() =>
      a.registry.parse("exit_plan", JSON.stringify({ plan: "# P", diagrams: [{ id: "a" }] })),
    ).not.toThrow();
  });
});

describe("plan agent instructions", () => {
  const plan = () => resolveActiveAgent(activeAgentCatalog(), PLAN_AGENT_ID);

  it("carry the diagram style guide by default: palette classes, types, limits and rules", () => {
    const text = planInstructions();
    expect(plan().instructions).toBe(text);
    for (const name of DIAGRAM_CLASSES) expect(text).toContain(name);
    for (const syntax of DIAGRAM_SYNTAXES) expect(text).toContain(syntax);
    expect(text).toMatch(/0 to 5 per plan/);
    expect(text).toMatch(/about 40 nodes/);
    expect(text).toMatch(/not add information that is not in the plan|never add information/);
    expect(text).toMatch(/EVERY diagram that still applies/);
    expect(text).toContain("exit_plan");
    expect(text).toContain("## Decisions");
  });

  it("omit the style guide when diagrams are off or capped at zero, and use the cap otherwise", () => {
    for (const settings of [
      { diagrams: false, maxDiagrams: 5 },
      { diagrams: true, maxDiagrams: 0 },
    ]) {
      const text = planInstructions(settings);
      expect(text).not.toMatch(/Mermaid|diagram/i);
      expect(text).toContain("exit_plan");
    }
    expect(planInstructions({ diagrams: true, maxDiagrams: 3 })).toMatch(/0 to 3 per plan/);
  });

  it("follow the live settings through agentRunOptions, for the built-in plan agent only", () => {
    const off = agentRunOptions(plan(), { plan: { diagrams: false, maxDiagrams: 5 } });
    expect(off.instructions).not.toMatch(/Mermaid/);
    expect(off.optInTools).toEqual(["exit_plan"]);
    expect(agentRunOptions(plan()).instructions).toMatch(/Mermaid/);
    const build = resolveActiveAgent(activeAgentCatalog(), "build");
    expect(agentRunOptions(build, { plan: { diagrams: true, maxDiagrams: 5 } })).toEqual({});
    const custom = { ...plan(), source: "user" as const, instructions: "my own planner" };
    expect(
      agentRunOptions(custom, { plan: { diagrams: false, maxDiagrams: 5 } }).instructions,
    ).toBe("my own planner");
  });
});
