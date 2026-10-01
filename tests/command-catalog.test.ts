import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  CommandCatalog,
  type CommandHost,
} from "../packages/core/src/commands/catalog.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import * as core from "../packages/core/src/index.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

// Compile-time contract: an application from createApplication() is a CommandHost.
const _appIsHost = (app: Awaited<ReturnType<typeof core.createApplication>>): CommandHost => app;
void _appIsHost;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function host(overrides: Partial<CommandHost> = {}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-catalog-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const registry = new ToolRegistry();
  registry.register({
    name: "read_it",
    description: "r",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    async execute() {
      return { content: [] };
    },
  });
  const provider: ModelProvider = {
    id: "test",
    model: "m",
    async *stream() {
      yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
    },
  };
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
  });
  const commands = new Map<string, (args: string, ctx?: { sessionId?: string }) => Promise<string>>(
    [
      ["wayfinder:explore", async (args, ctx) => `explored ${args} in ${ctx?.sessionId}`],
      ["help", async () => "shadowed plugin help"],
    ],
  );
  const h: CommandHost = {
    workspace: root,
    store,
    runner,
    registry,
    provider: { id: "test" },
    plugins: {
      commands,
      commandInfo: new Map([
        [
          "wayfinder:explore",
          { plugin: "wayfinder", description: "Explore the map", argumentHint: "<area>" },
        ],
        ["help", { plugin: "rogue", description: "tries to shadow help" }],
      ]),
      pluginState: () => undefined,
    },
    prompts: {
      templates: new Map([
        [
          "review",
          {
            name: "review",
            description: "Review the diff",
            argumentHint: "[focus]",
            requires: [],
            body: "",
            source: "user" as const,
            origin: "/x",
          },
        ],
      ]),
    },
    skillCatalog: () => [
      {
        name: "tdd",
        id: "tdd",
        effectiveId: "tdd",
        displayId: "tdd",
        description: "Strict TDD",
        scope: "user" as const,
        source: "user",
        manageable: true,
        locked: false,
        enabled: true,
        effective: true,
        approximateTokens: 10,
      },
      {
        name: "off",
        id: "off",
        effectiveId: "off",
        displayId: "off",
        description: "Disabled skill",
        scope: "user" as const,
        source: "user",
        manageable: true,
        locked: false,
        enabled: false,
        effective: false,
        approximateTokens: 10,
      },
    ],
    ...overrides,
  };
  return { root, store, runner, host: h, close: () => store.close() };
}

describe("CommandCatalog (T-05)", () => {
  it("is exported from @alisio/core", () => {
    expect(core.CommandCatalog).toBe(CommandCatalog);
    expect(core.BUILTIN_COMMANDS).toBe(BUILTIN_COMMANDS);
  });

  it("lists built-in, plugin, prompt and skill sources with owners", async () => {
    const fx = await host();
    try {
      const catalog = new CommandCatalog(fx.host);
      const all = catalog.list();
      const bySource = (source: string) =>
        all.filter((c) => c.source === source).map((c) => c.name);
      expect(bySource("builtin")).toEqual(BUILTIN_COMMANDS.map((c) => c.name));
      expect(all.find((c) => c.name === "wayfinder:explore")).toEqual({
        name: "wayfinder:explore",
        description: "Explore the map",
        argumentHint: "<area>",
        source: "plugin",
        owner: "wayfinder",
        surfaces: ["tui", "web", "api"],
        execution: "core",
      });
      expect(all.find((c) => c.name === "review")).toMatchObject({
        source: "prompt",
        owner: "user",
        argumentHint: "[focus]",
        execution: "surface",
      });
      // Only effective, enabled skills are offered.
      expect(bySource("skill")).toEqual(["skill:tdd"]);
    } finally {
      fx.close();
    }
  });

  it("filters by surface: TUI-only surface commands are not offered to the web", async () => {
    const fx = await host();
    try {
      const web = new CommandCatalog(fx.host).list("web").map((c) => c.name);
      for (const tuiOnly of ["copy", "exit", "settings", "connect"])
        expect(web).not.toContain(tuiOnly);
      expect(web).toEqual(
        expect.arrayContaining(["compact", "model", "sessions", "wayfinder:explore"]),
      );
      // Phase 2 of the analysis runtime: `/artifacts` opens the web artifact panel too.
      expect(web).toEqual(expect.arrayContaining(["artifacts", "permissions"]));
      const tui = new CommandCatalog(fx.host).list("tui").map((c) => c.name);
      expect(tui).toEqual(expect.arrayContaining(["copy", "exit", "settings", "connect"]));
    } finally {
      fx.close();
    }
  });

  it("resolves names and aliases; built-ins win name collisions", async () => {
    const fx = await host();
    try {
      const catalog = new CommandCatalog(fx.host);
      expect(catalog.resolve("quit")?.name).toBe("exit");
      expect(catalog.resolve("NEW")?.name).toBe("clear");
      expect(catalog.resolve("models")?.name).toBe("model");
      expect(catalog.resolve("help")).toMatchObject({ source: "builtin" });
      expect(catalog.list().filter((c) => c.name === "help")).toHaveLength(1);
      expect(catalog.resolve("wayfinder:explore")?.source).toBe("plugin");
      expect(catalog.resolve("review")?.source).toBe("prompt");
      expect(catalog.resolve("skill:tdd")?.source).toBe("skill");
      expect(catalog.resolve("skill:off")).toBeUndefined();
      expect(catalog.resolve("nope")).toBeUndefined();
      // Without a host the catalog knows the built-ins only.
      expect(new CommandCatalog().list().every((c) => c.source === "builtin")).toBe(true);
    } finally {
      fx.close();
    }
  });

  it("marks core execution for the core handlers and surface for the rest", () => {
    const execution = Object.fromEntries(BUILTIN_COMMANDS.map((c) => [c.name, c.execution]));
    for (const name of [
      "compact",
      "model",
      "effort",
      "clear",
      "sessions",
      "resume",
      "stats",
      "tools",
      "skills",
      "plugins",
      "mcps",
      "agents",
      "btw",
    ])
      expect(execution[name], name).toBe("core");
    for (const name of ["copy", "exit", "settings", "connect", "help", "ask"])
      expect(execution[name], name).toBe("surface");
  });

  it("executes core commands against the host", async () => {
    const fx = await host();
    try {
      const catalog = new CommandCatalog(fx.host);
      const session = fx.store.create(fx.root, "test", "m").id;
      const ctx = { sessionId: session };
      expect((await catalog.execute("tools", "", ctx)).text).toContain(
        "| `read_it` | read | enabled |",
      );
      expect(await catalog.execute("wayfinder:explore", "north", ctx)).toEqual({
        text: `explored north in ${session}`,
      });
      const created = await catalog.execute("new", "", ctx);
      expect(created.sessionId).not.toBe(session);
      expect(fx.store.get(created.sessionId ?? "").model).toBe("m");
      const resumed = await catalog.execute("resume", session.slice(0, 8), ctx);
      expect(resumed.sessionId).toBe(session);
      await expect(catalog.execute("resume", "zzzz", ctx)).rejects.toThrow(
        /No session in this workspace matches zzzz/,
      );
      await catalog.execute("model", "other-model", ctx);
      expect(fx.store.get(session).model).toBe("other-model");
      await expect(catalog.execute("model", "", ctx)).rejects.toThrow(/Usage/);
      expect((await catalog.execute("skills", "", ctx)).text).toContain("tdd");
      expect((await catalog.execute("agents", "", ctx)).text).toContain("build");
      await fx.runner.run(session, "hi");
      const stats = await catalog.execute("stats", "", ctx);
      expect(stats.text).toContain(session);
      expect(stats.text).toMatch(/Runs: 1/);
      await expect(catalog.execute("copy", "", ctx)).rejects.toThrow(/surface/);
      await expect(catalog.execute("nope", "", ctx)).rejects.toThrow(/Unknown command \/nope/);
    } finally {
      fx.close();
    }
  });

  it("persists the effort level through the host", async () => {
    const written: Array<[string, unknown]> = [];
    const fx = await host({
      config: { agents: { active: "build" } },
      updateSetting: async (key, value) => {
        written.push([key, value]);
        return "config.json";
      },
    });
    try {
      const catalog = new CommandCatalog(fx.host);
      const session = fx.store.create(fx.root, "test", "m").id;
      await catalog.execute("effort", "high", { sessionId: session });
      expect(written).toEqual([["agents.effort", "high"]]);
    } finally {
      fx.close();
    }
  });
});
