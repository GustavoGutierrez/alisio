import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type ActiveAgent,
  activeAgentCatalog,
  agentCatalogFromState,
  agentPickerItems,
  agentRunOptions,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_ID,
  mainAgentFromRecord,
  resolveActiveAgent,
} from "../packages/cli/src/tui/agents.ts";
import {
  COMMANDS,
  effectiveEffort,
  effortPickerItems,
  fitIdentityParts,
  identityParts,
  parseCommand,
  reservedCommandNames,
  resolveCommand,
  validateEffortLevel,
} from "../packages/cli/src/tui/state.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const root = await mkdtemp(join(tmpdir(), "alisio-active-agent-"));
afterAll(() => vi.unstubAllEnvs());

const planAgent = activeAgentCatalog().find((a) => a.id === "plan");
const buildAgent = activeAgentCatalog().find((a) => a.id === "build");

describe("active agent catalog", () => {
  it("defaults the active agent to the built-in build with no added persona", () => {
    const catalog = activeAgentCatalog();
    expect(DEFAULT_AGENT_ID).toBe("build");
    expect(catalog.map((a) => a.id)).toEqual(["build", "plan"]);
    // The default agent keeps the CURRENT behavior: no instructions, no tool narrowing.
    expect(agentRunOptions(buildAgent)).toEqual({});
    expect(resolveActiveAgent(catalog, undefined).id).toBe("build");
    expect(resolveActiveAgent(catalog, "does-not-exist").id).toBe("build");
  });

  it("appends main-capable contributions after the built-ins without shadowing them", () => {
    const contribution: ActiveAgent = {
      id: "reviewer",
      name: "reviewer",
      description: "Reviews candidates",
      instructions: "You are a reviewer.",
      source: "user",
    };
    const catalog = activeAgentCatalog([
      contribution,
      { id: "plan", name: "plan", description: "ignored", source: "user" },
      { id: "build", name: "build", description: "ignored", source: "user" },
    ]);
    expect(catalog.map((a) => a.id)).toEqual(["build", "plan", "reviewer"]);
    expect(resolveActiveAgent(catalog, "reviewer")).toMatchObject({ id: "reviewer" });
    // An unknown persisted id falls back to build.
    expect(resolveActiveAgent(catalog, "reviewer").instructions).toContain("reviewer");
  });

  it("maps subagents-published main-capable records (mode primary/all) to active agents", () => {
    const catalog = agentCatalogFromState([
      { name: "reviewer", description: "Reviews", prompt: "Review carefully.", source: "project" },
      { name: "plug:bot", description: "Bot", prompt: "Bot prompt.", source: "plugin:plug" },
      { name: "nogood", description: "", prompt: "x" },
      "not-an-object",
    ]);
    expect(catalog.map((a) => a.id)).toEqual(["build", "plan", "reviewer", "plug:bot"]);
    expect(
      mainAgentFromRecord({ name: "x", description: "d", prompt: "p", source: "project" }),
    ).toMatchObject({
      id: "x",
      source: "user",
    });
    expect(
      mainAgentFromRecord({ name: "y", description: "d", prompt: "p", source: "plugin:p" }),
    ).toMatchObject({
      id: "y",
      source: "plugin",
    });
    expect(
      mainAgentFromRecord({
        name: "r",
        description: "d",
        prompt: "p",
        readOnly: true,
        source: "user",
      }),
    ).toMatchObject({ id: "r", readOnly: true, source: "user" });
  });

  it("builds picker rows with current, default and read-only markers and descriptions", () => {
    const items = agentPickerItems(activeAgentCatalog(), "plan");
    expect(items.map((i) => i.value)).toEqual(["build", "plan"]);
    expect(items[0]).toMatchObject({ label: "build · (default)" });
    expect(items[1]).toMatchObject({ label: "plan · (current) · read-only" });
    expect(items[1]?.description).toContain("plan");
  });
});

describe("per-run options of the active agent", () => {
  it("injects the plan system prompt and narrows the run to reads (no approvals)", () => {
    const options = agentRunOptions(planAgent);
    expect(options.instructions).toBe(planAgent?.instructions);
    expect(agentRunOptions(planAgent)).toMatchObject({
      policy: { write: false, process: false, external: false },
      approvals: false,
    });
    expect(options.instructions).toBeTruthy();
    expect(options.instructions?.toLowerCase()).toContain("read-only");
    expect(options.instructions?.toLowerCase()).toContain("plan");
  });

  it("is a no-op for an undefined agent", () => {
    expect(agentRunOptions(undefined)).toEqual({});
  });

  it("reaches the runner as RunOptions.instructions (the withPersona seam)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-active-run-"));
    const store = new SQLiteStore(join(dir, "store.sqlite"));
    const registry = new ToolRegistry();
    registry.register({
      name: "read_thing",
      effect: "read",
      description: "read",
      inputSchema: { type: "object" },
      async execute() {
        return { content: [{ type: "text", text: "data" }] };
      },
    });
    try {
      let received = "";
      const provider: ModelProvider = {
        id: "test",
        model: "test",
        async *stream(request) {
          received = request.instructions;
          yield { type: "completed", message: { role: "assistant", text: "done", calls: [] } };
        },
      };
      const session = store.create(dir, "test", "test");
      const runner = new AgentRunner({
        provider,
        registry,
        store,
        context: new ProjectContext(dir),
        workspace: dir,
        policy: { write: true, process: true, external: true },
        compaction: { auto: false },
      });
      await runner.run(session.id, "plan this", undefined, { ...agentRunOptions(planAgent) });
      // The plan system prompt is appended on top of the base context instructions.
      expect(received).toContain(planAgent?.instructions);
      await runner.run(session.id, "build this", undefined, { ...agentRunOptions(buildAgent) });
      expect(received.endsWith(planAgent?.instructions ?? "")).toBe(false);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reasoning effort resolution", () => {
  const capability = {
    supportedLevels: ["minimal", "low", "medium", "high", "max"],
    defaultLevel: "medium",
  };
  it("picks the persisted level when supported, else the model default, else nothing", () => {
    expect(effectiveEffort("max", capability)).toBe("max");
    expect(effectiveEffort("high", capability)).toBe("high");
    // Unsupported persisted value silently falls back to the model's default level.
    expect(effectiveEffort("turbo", capability)).toBe("medium");
    // Clearing (undefined) falls back to the default level too.
    expect(effectiveEffort(undefined, capability)).toBe("medium");
    // A model without supported levels never sends effort, whatever is persisted.
    expect(effectiveEffort("max", undefined)).toBeUndefined();
    expect(effectiveEffort("max", { supportedLevels: [] })).toBeUndefined();
    // No default level: unsupported persisted values resolve to nothing.
    expect(effectiveEffort("turbo", { supportedLevels: ["low"] })).toBeUndefined();
  });

  it("validates /effort arguments against the active model's supported levels", () => {
    expect(validateEffortLevel("max", capability)).toBeUndefined();
    expect(validateEffortLevel("ultra", capability)).toMatch(/Unsupported effort level "ultra"/);
    expect(validateEffortLevel("ultra", capability)).toContain("minimal, low, medium, high, max");
    expect(validateEffortLevel("max", undefined)).toMatch(/does not advertise/);
  });

  it("marks the active and default levels in the effort picker, with a clear entry", () => {
    const items = effortPickerItems(capability, "max");
    expect(items.map((i) => i.value)).toEqual([...capability.supportedLevels, "!clear"]);
    expect(items[0]).toMatchObject({ label: "minimal" });
    expect(items.at(-1)).toMatchObject({ value: "!clear" });
    const max = items.find((i) => i.value === "max");
    expect(max?.label).toContain("(current)");
    const medium = items.find((i) => i.value === "medium");
    expect(medium?.label).toContain("(default)");
  });
});

describe("status-line identity parts", () => {
  const input = {
    agent: "build",
    model: "DeepSeek V4 Flash",
    provider: "OpenCode Go",
    effort: "max",
  };
  it("orders agent · model · provider · effort with distinct roles", () => {
    const parts = identityParts(input);
    expect(parts.map((p) => p.role)).toEqual(["agent", "model", "provider", "effort"]);
    expect(parts.map((p) => p.text)).toEqual([
      "agent: build",
      "DeepSeek V4 Flash",
      "OpenCode Go",
      "max",
    ]);
  });

  it("omits the effort part when the model advertises no supported levels", () => {
    const parts = identityParts({ ...input, effort: undefined });
    expect(parts.map((p) => p.role)).toEqual(["agent", "model", "provider"]);
    expect(parts.some((p) => p.role === "effort")).toBe(false);
  });

  it("drops the lowest-priority parts (effort, then provider) when the line gets narrow", () => {
    expect(fitIdentityParts(input, 200).map((p) => p.role)).toEqual([
      "agent",
      "model",
      "provider",
      "effort",
    ]);
    expect(fitIdentityParts(input, 48).map((p) => p.role)).toEqual(["agent", "model", "provider"]);
    expect(fitIdentityParts(input, 34).map((p) => p.role)).toEqual(["agent", "model"]);
    // A lone surviving part is truncated with an ellipsis instead of overflowing.
    const survivor = fitIdentityParts(input, 8);
    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.role).toBe("agent");
    expect(survivor[0]?.text).toBe("agent: …");
  });
});

describe("command surface", () => {
  it("registers /agents and /effort as reserved commands", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining(["agents", "effort"]));
    expect(resolveCommand("agents")).toBe("agents");
    expect(resolveCommand("effort")).toBe("effort");
    expect(reservedCommandNames()).toContain("agents");
    expect(reservedCommandNames()).toContain("effort");
  });

  it("parses /effort arguments and /agents without arguments", () => {
    expect(parseCommand("/effort max")).toEqual({ name: "effort", args: "max" });
    expect(parseCommand("/agents")).toEqual({ name: "agents", args: "" });
    expect(parseCommand("/effort")).toEqual({ name: "effort", args: "" });
  });
});

describe("application wiring", () => {
  it("defaults the persisted active agent to build and publishes main-capable definitions", async () => {
    // The full createApplication path: global config defaults + subagents plugin publishing.
    const dir = await mkdtemp(join(tmpdir(), "alisio-agent-app-"));
    const { createApplication } = await import("../packages/core/src/application.ts");
    const { BUILTIN_PLUGINS } = await import("../packages/cli/src/builtin.ts");
    const configHome = join(dir, "config");
    const stateHome = join(dir, "state");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(configHome, { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", configHome);
    vi.stubEnv("ALISIO_STATE_HOME", stateHome);
    await writeFile(
      join(configHome, "config.json"),
      JSON.stringify({
        provider: { baseURL: "http://127.0.0.1:9/v1", model: "test", auth: "none" },
        builtinPlugins: {
          subagents: {
            agents: {
              reviewer: {
                description: "Reviews candidates",
                prompt: "Review carefully.",
                mode: "primary",
              },
              helper: { description: "Delegated helper", prompt: "Help out." },
            },
          },
        },
      }),
    );
    const fakeProvider: ModelProvider = {
      id: "fake",
      model: "test",
      async *stream() {
        yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
      },
    };
    const app = await createApplication({
      cwd: dir,
      config: join(configHome, "config.json"),
      noHerdr: true,
      builtins: BUILTIN_PLUGINS.filter((p) => p.id === "subagents"),
      provider: fakeProvider,
    });
    try {
      // Schema default: `agents.active` is "build".
      expect(app.config.agents.active).toBe("build");
      // The subagents plugin publishes ONLY main-capable (mode primary/all) definitions.
      const published = app.plugins.pluginState("subagents", "mainAgents") as Array<{
        name: string;
      }>;
      expect(published.map((a) => a.name)).toEqual(["reviewer"]);
      // Apply a main-capable agent and the live config follows.
      await app.updateSetting("agents.active", "reviewer");
      expect(app.config.agents.active).toBe("reviewer");
      await app.updateSetting("agents.effort", undefined);
      expect(app.config.agents.effort).toBeUndefined();
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
