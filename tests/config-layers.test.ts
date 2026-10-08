import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configSchema,
  createApplication,
  loadConfig,
  loadConfigWithProvenance,
  McpConnector,
  setConfigValue,
  setGlobalMcpAllow,
  setMcpServerEnabled,
  settableSettings,
  ToolRegistry,
} from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-config-layers-"));
  const global = join(root, "global");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(global, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", global);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  return { root, global, workspace };
}

async function json(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const stdio = (command: string, args: string[] = []) => ({
  transport: "stdio",
  command,
  args,
});

describe("layered configuration", () => {
  it("loads global-only and project-only MCP servers", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), { mcp: { servers: { global: stdio("node") } } });
    expect(Object.keys((await loadConfig(workspace)).mcp.servers)).toEqual(["global"]);

    await json(join(global, "config.json"), {});
    await json(join(workspace, ".alisio", "config.json"), {
      mcpServers: { project: { command: "node" } },
    });
    expect(Object.keys((await loadConfig(workspace, { trustProject: true })).mcp.servers)).toEqual([
      "project",
    ]);
  });

  it("merges servers by name while project and explicit layers replace each other", async () => {
    const { root, global, workspace } = await fixture();
    const explicit = join(root, "explicit", "config.json");
    await json(join(global, "config.json"), {
      mcpServers: {
        shared: { command: "global-command" },
        global: { command: "global-only" },
      },
    });
    await json(join(workspace, ".alisio", "config.json"), {
      mcpServers: {
        shared: { command: "project-command" },
        project: { command: "project-only" },
      },
    });
    await json(explicit, {
      mcpServers: {
        shared: { command: "explicit-command" },
        explicit: { command: "explicit-only" },
      },
    });

    const project = await loadConfig(workspace, { trustProject: true });
    expect(project.mcp.servers.shared).toMatchObject({ command: "project-command" });
    expect(project.mcpSources.shared).toMatchObject({ kind: "project", form: "alias" });
    expect(Object.keys(project.mcp.servers).sort()).toEqual(["global", "project", "shared"]);

    const selected = await loadConfig(workspace, { file: explicit, trustProject: true });
    expect(selected.mcp.servers.shared).toMatchObject({ command: "explicit-command" });
    expect(selected.mcpSources.shared).toMatchObject({ kind: "explicit", file: explicit });
    expect(Object.keys(selected.mcp.servers).sort()).toEqual(["explicit", "global", "shared"]);
  });

  it("adds project plugin and skill entries to the global lists, keeping global order first", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      plugins: ["./global-plugin.mjs"],
      skills: ["./global-skills"],
      provider: { model: "global-model" },
    });
    await json(join(workspace, ".alisio", "config.json"), {
      plugins: ["./project-plugin.mjs"],
      skills: ["./project-skills"],
    });
    const config = await loadConfig(workspace, { trustProject: true });
    expect(config.plugins).toEqual([
      resolve(global, "global-plugin.mjs"),
      resolve(workspace, ".alisio/project-plugin.mjs"),
    ]);
    expect(config.skills).toEqual([
      resolve(global, "global-skills"),
      resolve(workspace, ".alisio/project-skills"),
    ]);
    // Non-additive keys still replace their global counterpart.
    expect(config.provider.model).toBe("global-model");
  });

  it("never reads an untrusted project config and resolves each server against its source", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      mcpServers: { global: { command: "./bin/global", args: ["./data/global.json"] } },
    });
    await writeFile(join(workspace, ".alisio", "config.json"), "not valid json");
    const untrusted = await loadConfig(workspace);
    expect(untrusted.mcp.servers.global).toMatchObject({
      command: resolve(global, "bin/global"),
      args: [resolve(global, "data/global.json")],
    });

    await json(join(workspace, ".alisio", "config.json"), {
      mcpServers: { project: { command: "./bin/project", args: ["../shared.json"] } },
    });
    const trusted = await loadConfig(workspace, { trustProject: true });
    expect(trusted.mcp.servers.global).toMatchObject({ command: resolve(global, "bin/global") });
    expect(trusted.mcp.servers.project).toMatchObject({
      command: resolve(workspace, ".alisio/bin/project"),
      args: [resolve(workspace, "shared.json")],
    });
  });
});

describe("additive plugin and skill layers", () => {
  it("leaves the global plugin and skill lists intact when the project lists are empty", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      plugins: ["./global-plugin-a.mjs", "./global-plugin-b.mjs"],
      skills: ["./global-skill-basic"],
      pluginOverrides: { global: { enabled: true } },
      builtinPlugins: { memory: { enabled: false }, notes: { customOption: "global" } },
    });
    await json(join(workspace, ".alisio", "config.json"), {
      plugins: [],
      skills: [],
      pluginOverrides: {},
      builtinPlugins: {},
    });
    const config = await loadConfig(workspace, { trustProject: true });
    expect(config.plugins).toEqual([
      resolve(global, "global-plugin-a.mjs"),
      resolve(global, "global-plugin-b.mjs"),
    ]);
    expect(config.skills).toEqual([resolve(global, "global-skill-basic")]);
    expect(config.pluginOverrides).toEqual({ global: { enabled: true } });
    expect(config.builtinPlugins).toEqual({
      memory: { enabled: false },
      notes: { customOption: "global" },
    });
  });

  it("adds additionalDirectories additively and never lets an empty project list clear the global one", async () => {
    const { global, workspace } = await fixture();
    await mkdir(join(global, "data"), { recursive: true });
    await mkdir(join(workspace, ".alisio", "extra"), { recursive: true });
    const globalData = await realpath(join(global, "data"));
    const projectExtra = await realpath(join(workspace, ".alisio", "extra"));
    await json(join(global, "config.json"), { additionalDirectories: ["./data"] });
    await json(join(workspace, ".alisio", "config.json"), { additionalDirectories: [] });
    const kept = await loadConfig(workspace, { trustProject: true });
    expect(kept.additionalDirectories).toEqual([globalData]);

    await json(join(workspace, ".alisio", "config.json"), {
      additionalDirectories: ["./extra", globalData],
    });
    const merged = await loadConfig(workspace, { trustProject: true });
    // Global first, project addition appended, the already-present global entry deduplicated.
    expect(merged.additionalDirectories).toEqual([globalData, projectExtra]);
  });

  it("appends project plugin and skill entries after the global ones, dropping exact duplicates", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      plugins: ["alisio-plugin-a", "alisio-plugin-b"],
      skills: ["./skill-a", "./skill-b"],
    });
    await json(join(workspace, ".alisio", "config.json"), {
      plugins: ["alisio-plugin-c", "alisio-plugin-b"],
      skills: ["./skill-c", "./skill-a"],
    });
    const config = await loadConfig(workspace, { trustProject: true });
    expect(config.plugins).toEqual(["alisio-plugin-a", "alisio-plugin-b", "alisio-plugin-c"]);
    // Path entries stay resolved per layer; a project "./skill-a" resolves elsewhere, so the
    // exact resolved strings differ and both are kept.
    expect(config.skills).toEqual([
      resolve(global, "skill-a"),
      resolve(global, "skill-b"),
      resolve(workspace, ".alisio/skill-c"),
      resolve(workspace, ".alisio/skill-a"),
    ]);
  });

  it("merges override records by id with the selected layer winning per id", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      pluginOverrides: { "global-only": { enabled: true }, both: { enabled: true } },
      skillOverrides: { "global-skill": { enabled: false } },
    });
    await json(join(workspace, ".alisio", "config.json"), {
      pluginOverrides: { "project-only": { enabled: false }, both: { enabled: false } },
      // Skill activation is project-local: the global entry never carries over, and the
      // selected entry applies.
      skillOverrides: { "project-skill": { enabled: true } },
    });
    const config = await loadConfig(workspace, { trustProject: true });
    expect(config.pluginOverrides).toEqual({
      "global-only": { enabled: true },
      both: { enabled: false },
      "project-only": { enabled: false },
    });
    expect(config.skillOverrides).toEqual({ "project-skill": { enabled: true } });
  });

  it("merges builtinPlugins by id, letting a project disable one built-in while keeping others", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      builtinPlugins: {
        memory: { enabled: true, injectBudgetTokens: 2000 },
        notes: { customOption: "global" },
      },
    });
    await json(join(workspace, ".alisio", "config.json"), {
      builtinPlugins: { memory: { enabled: false } },
    });
    const config = await loadConfig(workspace, { trustProject: true });
    expect(config.builtinPlugins).toEqual({
      memory: { enabled: false },
      notes: { customOption: "global" },
    });
  });

  it("keeps global MCP servers when the project layer declares an empty mcp/mcpServers map", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      mcp: {
        servers: { shared: { command: "global-command" }, global: { command: "global-only" } },
      },
    });
    // Empty canonical map in the project layer must not clear global servers.
    await json(join(workspace, ".alisio", "config.json"), {
      mcp: { servers: {} },
    });
    const canonical = await loadConfig(workspace, { trustProject: true });
    expect(Object.keys(canonical.mcp.servers).sort()).toEqual(["global", "shared"]);
    // Empty compatibility-alias map behaves the same.
    await json(join(workspace, ".alisio", "config.json"), { mcpServers: {} });
    const alias = await loadConfig(workspace, { trustProject: true });
    expect(Object.keys(alias.mcp.servers).sort()).toEqual(["global", "shared"]);
  });

  it("applies the same additive semantics to an explicit --config layer", async () => {
    const { root, global, workspace } = await fixture();
    const explicitDir = join(root, "explicit");
    const explicit = join(explicitDir, "config.json");
    await json(join(global, "config.json"), {
      plugins: ["alisio-plugin-global"],
      skills: ["./global-skills"],
      pluginOverrides: { global: { enabled: true } },
      builtinPlugins: { memory: { enabled: true } },
    });
    await json(explicit, {
      plugins: ["alisio-plugin-explicit", "alisio-plugin-global"],
      skills: ["./explicit-skills"],
      pluginOverrides: { explicit: { enabled: false }, global: { enabled: false } },
      builtinPlugins: { subagents: { enabled: false } },
    });
    const config = await loadConfig(workspace, { file: explicit });
    expect(config.plugins).toEqual(["alisio-plugin-global", "alisio-plugin-explicit"]);
    expect(config.skills).toEqual([
      resolve(global, "global-skills"),
      resolve(explicitDir, "explicit-skills"),
    ]);
    expect(config.pluginOverrides).toEqual({
      global: { enabled: false },
      explicit: { enabled: false },
    });
    expect(config.builtinPlugins).toEqual({
      memory: { enabled: true },
      subagents: { enabled: false },
    });
    expect(config.mcpSources).toEqual({});
  });
});

describe("legacy provider provenance", () => {
  it.each([
    ["the alisio setup placeholder", "YOUR_MODEL_ID"],
    ["an empty model", ""],
  ] as const)(
    "flags a selected project layer with %s provider model as not overriding a saved profile",
    async (_label, model) => {
      const { workspace } = await fixture();
      await json(join(workspace, ".alisio", "config.json"), {
        provider: { baseURL: "https://project.example.test/v1", model },
      });
      const { provenance } = await loadConfigWithProvenance(workspace, { trustProject: true });
      expect(provenance.selectedLayer).toMatchObject({ kind: "project", hasLegacyProvider: false });
    },
  );

  it("flags a real selected project provider model as overriding a saved profile", async () => {
    const { workspace } = await fixture();
    await json(join(workspace, ".alisio", "config.json"), {
      provider: { baseURL: "https://project.example.test/v1", model: "project-model" },
    });
    const { provenance } = await loadConfigWithProvenance(workspace, { trustProject: true });
    expect(provenance.selectedLayer).toMatchObject({ kind: "project", hasLegacyProvider: true });
  });

  it("omits the selected layer when only global config applies", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      provider: { baseURL: "https://global.example.test/v1", model: "global-model" },
    });
    const { provenance } = await loadConfigWithProvenance(workspace);
    expect(provenance.selectedLayer).toBeUndefined();
  });
});

describe("run time limits", () => {
  it("allows 10 minutes per run, cuts a silent model request after 90 s and retries it once", () => {
    const { limits } = configSchema.parse({});
    expect(limits.timeoutMs).toBe(600_000);
    expect(limits.firstTokenTimeoutMs).toBe(90_000);
    expect(limits.firstTokenRetries).toBe(1);
  });

  it("recovers a response cut off by the output limit twice by default, 0 to 5 allowed", () => {
    expect(configSchema.parse({}).limits.truncationRecoveries).toBe(2);
    const parse = (n: number) => configSchema.safeParse({ limits: { truncationRecoveries: n } });
    expect(parse(0).success).toBe(true);
    expect(parse(5).success).toBe(true);
    expect(parse(6).success).toBe(false);
    expect(parse(-1).success).toBe(false);
    expect(parse(1.5).success).toBe(false);
  });

  it("accepts 0 to 3 silent-request retries and rejects more", () => {
    const parse = (n: number) => configSchema.safeParse({ limits: { firstTokenRetries: n } });
    expect(parse(0).success).toBe(true);
    expect(parse(3).success).toBe(true);
    expect(parse(4).success).toBe(false);
    expect(parse(-1).success).toBe(false);
  });

  it("lets the first-token limit be switched off with 0", () => {
    expect(
      configSchema.parse({ limits: { firstTokenTimeoutMs: 0 } }).limits.firstTokenTimeoutMs,
    ).toBe(0);
  });
});

describe("active agent and effort configuration", () => {
  it("defaults agents.active to build and keeps effort optional", () => {
    const parsed = configSchema.parse({});
    expect(parsed.agents).toEqual({ active: "build" });
    expect(configSchema.parse({ agents: { effort: "max" } }).agents).toEqual({
      active: "build",
      effort: "max",
    });
    expect(configSchema.parse({ agents: { active: "plan" } }).agents.active).toBe("plan");
  });

  it("rejects unknown agents keys and malformed agent ids", () => {
    expect(() => configSchema.parse({ agents: { active: "build", extra: true } })).toThrow();
    expect(() => configSchema.parse({ agents: { active: "two words" } })).toThrow();
    expect(() => configSchema.parse({ agents: { effort: "" } })).toThrow();
  });
});

describe("websearch provider enum", () => {
  it("accepts duckduckgo-html as a websearch.provider value", () => {
    const parsed = configSchema.parse({ websearch: { provider: "duckduckgo-html" } });
    expect(parsed.websearch.provider).toBe("duckduckgo-html");
  });

  it("rejects unknown websearch.provider values", () => {
    expect(() => configSchema.parse({ websearch: { provider: "yahoo" } })).toThrow();
  });
});

describe("MCP configuration compatibility", () => {
  it("normalizes canonical and compatible forms", () => {
    const parsed = configSchema.parse({
      mcp: {
        servers: {
          canonical: {
            transport: "stdio",
            command: "node",
            envAllow: ["FORWARDED_FIXTURE"],
            env: { FORWARDED_FIXTURE: "direct-wins" },
          },
          remote: {
            transport: "http",
            url: "https://example.test/mcp",
            bearerTokenEnv: "TEST_TOKEN",
          },
        },
      },
      mcpServers: { compatible: { command: "node", env: { FIXTURE_DIRECT: "visible" } } },
    });
    expect(parsed.mcp.servers.compatible).toEqual({
      transport: "stdio",
      enabled: true,
      command: "node",
      args: [],
      env: { FIXTURE_DIRECT: "visible" },
      envAllow: [],
    });
  });

  it("accepts inferred canonical transports and explicit compatible transports", () => {
    const parsed = configSchema.parse({
      mcp: { servers: { inferred: { url: "https://example.test/mcp" } } },
      mcpServers: {
        explicit: { transport: "stdio", command: "node", envAllow: ["SAFE_FIXTURE"] },
      },
    });
    expect(parsed.mcp.servers.inferred).toMatchObject({ transport: "http", enabled: true });
    expect(parsed.mcp.servers.explicit).toMatchObject({ transport: "stdio", args: [] });
  });

  it("parses a project config with a brave-search server that forwards the API key by name", async () => {
    const { workspace } = await fixture();
    // Fixture modeled on the project .alisio/config.json: the brave-search entry forwards
    // BRAVE_API_KEY from the environment by NAME (envAllow), never with a literal value.
    await json(join(workspace, ".alisio", "config.json"), {
      schemaVersion: 1,
      plugins: [],
      mcp: {
        servers: {
          devforge: {
            command: "/bin/devforge-mcp",
            args: [],
            env: { DEV_FORGE_CONFIG: "/fixture/devforge/config.json" },
          },
          "brave-search": {
            transport: "stdio",
            command: "npx",
            args: ["-y", "@brave/brave-search-mcp-server"],
            envAllow: ["BRAVE_API_KEY"],
          },
        },
      },
      skillOverrides: { "skill-improver": { enabled: true } },
    });
    const config = await loadConfig(workspace, { trustProject: true });
    expect(config.mcp.servers["brave-search"]).toEqual({
      transport: "stdio",
      enabled: true,
      command: "npx",
      args: ["-y", "@brave/brave-search-mcp-server"],
      envAllow: ["BRAVE_API_KEY"],
      env: {},
    });
    expect(config.mcp.servers.devforge).toMatchObject({ command: "/bin/devforge-mcp" });
    // Safe forwarding only: no literal secret is stored or reachable through the parsed config.
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("=sk-");
    expect(serialized).not.toMatch(/sk-\w{16,}/);
  });

  it("atomically toggles the defining form without rewriting unrelated JSON", async () => {
    const { global, workspace } = await fixture();
    const file = join(global, "config.json");
    await json(file, {
      skills: ["./keep"],
      mcpServers: { local: { command: "node", env: { PRIVATE_FIXTURE: "unchanged" } } },
    });
    const loaded = await loadConfig(workspace);
    await setMcpServerEnabled({ source: loaded.mcpSources.local!, name: "local", enabled: false });
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.skills).toEqual(["./keep"]);
    expect(raw.mcp).toBeUndefined();
    expect(raw.mcpServers.local).toEqual({
      command: "node",
      env: { PRIVATE_FIXTURE: "unchanged" },
      enabled: false,
    });
  });

  it("sets and clears the global mcp.allow preference atomically, preserving unrelated fields", async () => {
    const { global } = await fixture();
    const file = join(global, "config.json");
    await json(file, {
      skills: ["./keep"],
      mcp: { servers: { s: { command: "node" } }, allow: false },
    });
    await setGlobalMcpAllow({ allow: true });
    const granted = JSON.parse(await readFile(file, "utf8"));
    expect(granted.skills).toEqual(["./keep"]);
    expect(granted.mcp.allow).toBe(true);
    expect(granted.mcp.servers.s.command).toBe("node");
    await setGlobalMcpAllow({ allow: false });
    const cleared = JSON.parse(await readFile(file, "utf8"));
    expect(cleared.mcp.allow).toBeUndefined();
    expect(cleared.mcp.servers.s.command).toBe("node");
    expect(cleared.skills).toEqual(["./keep"]);
    // Clearing an mcp object that only held `allow` removes the whole key.
    await writeFile(file, JSON.stringify({ mcp: { allow: true } }));
    await setGlobalMcpAllow({ allow: false });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ schemaVersion: 1 });
  });

  it("accepts mcp.allow as a boolean and rejects non-boolean values", () => {
    expect(configSchema.parse({ mcp: { allow: true } }).mcp.allow).toBe(true);
    expect(configSchema.parse({ mcp: { allow: false } }).mcp.allow).toBe(false);
    expect(configSchema.parse({ mcp: {} }).mcp.allow).toBeUndefined();
    expect(() => configSchema.parse({ mcp: { allow: 1 } })).toThrow();
  });

  it("keeps the global mcp.allow while a selected project layer value is ignored", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      mcp: { allow: true, servers: { remote: { url: "https://example.invalid/mcp" } } },
    });
    await json(join(workspace, ".alisio", "config.json"), {
      mcp: { allow: false, servers: { local: { command: "node" } } },
    });
    const config = await loadConfig(workspace, { trustProject: true });
    expect(config.mcp.allow).toBe(true);
    expect(Object.keys(config.mcp.servers).sort()).toEqual(["local", "remote"]);
    // Without a global allow, a project-only allow:true never grants consent.
    await json(join(global, "config.json"), {});
    await json(join(workspace, ".alisio", "config.json"), { mcp: { allow: true } });
    const projectOnly = await loadConfig(workspace, { trustProject: true });
    expect(projectOnly.mcp.allow).toBeUndefined();
  });

  it.each([
    [{ mcpServers: { duplicate: { command: "node", url: "https://example.test" } } }],
    [{ mcpServers: { invalid: { command: " " } } }],
    [{ mcpServers: { invalid: { command: "node", env: { SECRET: 1 } } } }],
    [{ mcpServers: { "bad name": { command: "node" } } }],
    [{ mcpServers: { invalid: { url: "file:///tmp/socket" } } }],
    [{ mcp: { servers: { same: stdio("node") } }, mcpServers: { same: { command: "node" } } }],
  ])("rejects invalid or ambiguous MCP configuration without echoing values", (input) => {
    expect(() => configSchema.parse(input)).toThrow();
    try {
      configSchema.parse(input);
    } catch (error) {
      expect(String(error)).not.toContain("direct-secret-fixture");
    }
  });

  it("redacts invalid environment values from validation errors", () => {
    const input = {
      mcpServers: {
        invalid: { command: "node", env: { TOKEN: { value: "direct-secret-fixture" } } },
      },
    };
    let diagnostic = "";
    try {
      configSchema.parse(input);
    } catch (error) {
      diagnostic = String(error);
    }
    expect(diagnostic).not.toContain("direct-secret-fixture");
  });

  it("connects a DevForge-style alias and exposes direct env only to the child", async () => {
    const { global, workspace } = await fixture();
    vi.stubEnv("HOST_ONLY_FIXTURE", "must-not-leak");
    const args = [
      ...(process.versions.bun
        ? []
        : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]),
      resolve("fixtures/mcp-server.ts"),
    ];
    await json(join(global, "config.json"), {
      mcpServers: {
        devforge: {
          command: process.execPath,
          args,
          env: { DEV_FORGE_CONFIG: "/fixture/devforge/config.json" },
        },
      },
    });
    const config = await loadConfig(workspace);
    const registry = new ToolRegistry();
    const connector = new McpConnector(config.mcp.servers, registry, workspace);
    try {
      const tools = await connector.connect("devforge", AbortSignal.timeout(10_000));
      const environmentTool = tools
        .map((name) => registry.get(name))
        .find((tool) => tool.description.includes("environment"));
      const result = await environmentTool?.execute(
        { names: ["DEV_FORGE_CONFIG", "HOST_ONLY_FIXTURE"] },
        { workspace, signal: AbortSignal.timeout(10_000), emit() {} },
      );
      expect(JSON.stringify(result)).toContain("/fixture/devforge/config.json");
      expect(JSON.stringify(result)).not.toContain("must-not-leak");
    } finally {
      await connector.close();
    }
    expect(registry.list().filter((tool) => tool.name.startsWith("m_")).length).toBe(0);
  });

  it("keeps MCP lazy and enforces --allow-mcp and --read-only", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), {
      mcpServers: { configured: { command: "fake-mcp" } },
    });
    const disabled = await createApplication({ cwd: workspace, noHerdr: true });
    try {
      expect(disabled.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);
      await expect(disabled.mcp.connect("configured", AbortSignal.timeout(100))).rejects.toThrow(
        "--allow-mcp",
      );
    } finally {
      await disabled.close();
    }
    const readOnly = await createApplication({
      cwd: workspace,
      allowMcp: true,
      readOnly: true,
      noHerdr: true,
    });
    try {
      await expect(readOnly.mcp.connect("configured", AbortSignal.timeout(100))).rejects.toThrow(
        "--read-only",
      );
    } finally {
      await readOnly.close();
    }
  });

  it("reports missing bearer authentication without contacting the network", async () => {
    const registry = new ToolRegistry();
    const connector = new McpConnector(
      configSchema.parse({
        mcp: {
          servers: {
            remote: {
              url: "https://example.invalid/mcp",
              bearerTokenEnv: "MISSING_MCP_TOKEN_FIXTURE",
            },
          },
        },
      }).mcp.servers,
      registry,
      ".",
    );
    vi.stubEnv("MISSING_MCP_TOKEN_FIXTURE", "");
    await expect(connector.connect("remote", AbortSignal.timeout(100))).rejects.toThrow(
      "needs authentication",
    );
    expect(connector.info("remote")).toMatchObject({
      status: "needs-authentication",
      diagnostic: "Set the MISSING_MCP_TOKEN_FIXTURE environment variable, then reconnect",
    });
  });

  it("retains a failed status while sanitizing process diagnostics", async () => {
    const registry = new ToolRegistry();
    const secretPath = "/private/fixture/credential-bearing-command";
    const connector = new McpConnector(
      configSchema.parse({ mcpServers: { broken: { command: secretPath } } }).mcp.servers,
      registry,
      ".",
    );
    let diagnostic = "";
    try {
      await connector.connect("broken", AbortSignal.timeout(2_000));
    } catch (error) {
      diagnostic = String(error);
    }
    expect(connector.info("broken").status).toBe("failed");
    expect(diagnostic).toContain("Server command could not be started");
    expect(diagnostic).not.toContain(secretPath);
  });
});

describe("token budgets in configuration", () => {
  it("defaults compaction.maxOutputTokens independently of limits.maxOutputTokens", () => {
    const parsed = configSchema.parse({});
    expect(parsed.compaction.maxOutputTokens).toBe(16_000);
    // Unset on purpose (it used to default to 16384 in the schema): the budget of each request is
    // the model catalog's declared limit, else 16384, resolved where it is consumed.
    expect(parsed.limits.maxOutputTokens).toBeUndefined();
    expect(parsed.limits.maxTurns).toBe(100);
  });

  it("keeps an explicit limits.maxOutputTokens from any layer, and none when no layer sets it", async () => {
    const { global, workspace } = await fixture();
    expect((await loadConfig(workspace)).limits.maxOutputTokens).toBeUndefined();
    await json(join(global, "config.json"), { limits: { maxOutputTokens: 20_000 } });
    expect((await loadConfig(workspace)).limits.maxOutputTokens).toBe(20_000);
    await json(join(workspace, ".alisio", "config.json"), { limits: { maxOutputTokens: 9_000 } });
    expect((await loadConfig(workspace, { trustProject: true })).limits.maxOutputTokens).toBe(
      9_000,
    );
  });

  it("round-trips limits.maxOutputTokens through the settings writer, and clearing it unsets it", async () => {
    const { workspace } = await fixture();
    expect(settableSettings().find((s) => s.key === "limits.maxOutputTokens")).toEqual({
      key: "limits.maxOutputTokens",
      kind: "number",
    });
    await setConfigValue({ key: "limits.maxOutputTokens", value: 32_768 });
    expect((await loadConfig(workspace)).limits.maxOutputTokens).toBe(32_768);
    await expect(setConfigValue({ key: "limits.maxOutputTokens", value: 0 })).rejects.toThrow();
    await setConfigValue({ key: "limits.maxOutputTokens", value: undefined });
    expect((await loadConfig(workspace)).limits.maxOutputTokens).toBeUndefined();
  });

  it("accepts explicit values and rejects non-positive budgets", () => {
    const parsed = configSchema.parse({
      compaction: { maxOutputTokens: 20_000 },
      limits: { maxOutputTokens: 8192, maxTurns: 10 },
    });
    expect(parsed.compaction.maxOutputTokens).toBe(20_000);
    expect(parsed.limits.maxOutputTokens).toBe(8192);
    expect(parsed.limits.maxTurns).toBe(10);
    expect(() => configSchema.parse({ compaction: { maxOutputTokens: 0 } })).toThrow();
    // The turn cap stays bounded: 0 is rejected and unset resolves to the default — never unlimited.
    expect(() => configSchema.parse({ limits: { maxTurns: 0 } })).toThrow();
    expect(configSchema.parse({}).limits.maxTurns).toBe(100);
  });
});

describe("analysis.smartDashboard across layers", () => {
  it("defaults to true", async () => {
    const { workspace } = await fixture();
    expect((await loadConfig(workspace)).analysis.smartDashboard).toBe(true);
    expect(configSchema.parse({}).analysis.smartDashboard).toBe(true);
  });

  it("a project analysis block that does not name the key never undoes a global false", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), { analysis: { smartDashboard: false } });
    await json(join(workspace, ".alisio", "config.json"), {
      analysis: { limits: { timeoutMs: 5000 } },
    });
    const config = await loadConfig(workspace, { trustProject: true });
    expect(config.analysis.smartDashboard).toBe(false);
    // the rest of the project block still applies
    expect(config.analysis.limits.timeoutMs).toBe(5000);
  });

  it("a project can turn it off, and an explicit project true wins over a global false", async () => {
    const { global, workspace } = await fixture();
    await json(join(workspace, ".alisio", "config.json"), { analysis: { smartDashboard: false } });
    expect((await loadConfig(workspace, { trustProject: true })).analysis.smartDashboard).toBe(
      false,
    );
    await json(join(global, "config.json"), { analysis: { smartDashboard: false } });
    await json(join(workspace, ".alisio", "config.json"), { analysis: { smartDashboard: true } });
    expect((await loadConfig(workspace, { trustProject: true })).analysis.smartDashboard).toBe(
      true,
    );
  });

  it("an untrusted project layer is not read at all", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), { analysis: { smartDashboard: false } });
    await json(join(workspace, ".alisio", "config.json"), { analysis: { smartDashboard: true } });
    expect((await loadConfig(workspace)).analysis.smartDashboard).toBe(false);
  });

  it("is a settable boolean key, written next to its siblings", async () => {
    const { global, workspace } = await fixture();
    expect(settableSettings().find((s) => s.key === "analysis.smartDashboard")).toEqual({
      key: "analysis.smartDashboard",
      kind: "boolean",
    });
    await json(join(global, "config.json"), { analysis: { enabled: true } });
    await setConfigValue({ key: "analysis.smartDashboard", value: false });
    expect(JSON.parse(await readFile(join(global, "config.json"), "utf8")).analysis).toEqual({
      enabled: true,
      smartDashboard: false,
    });
    expect((await loadConfig(workspace)).analysis.smartDashboard).toBe(false);
    await expect(setConfigValue({ key: "analysis.smartDashboard", value: "no" })).rejects.toThrow();
  });
});

describe("web.iconTheme across layers", () => {
  it("is global-only: a project layer cannot pick the theme, and the ignored key is reported", async () => {
    const { global, workspace } = await fixture();
    await json(join(global, "config.json"), { web: { iconTheme: "material" } });
    await json(join(workspace, ".alisio", "config.json"), { web: { iconTheme: "untrusted" } });
    const { config, provenance } = await loadConfigWithProvenance(workspace, {
      trustProject: true,
    });
    expect(config.web.iconTheme).toBe("material");
    expect(provenance.ignored).toContain("web.iconTheme");
    // Without a global value, a project-only theme never applies: the default keeps inline icons.
    await json(join(global, "config.json"), {});
    expect((await loadConfig(workspace, { trustProject: true })).web.iconTheme).toBe("none");
  });
});
