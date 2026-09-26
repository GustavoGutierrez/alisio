import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configSchema,
  createApplication,
  loadConfig,
  McpConnector,
  setMcpServerEnabled,
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

  it("does not concatenate executable lists with undefined cross-layer semantics", async () => {
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
    expect(config.plugins).toEqual([resolve(workspace, ".alisio/project-plugin.mjs")]);
    expect(config.skills).toEqual([resolve(workspace, ".alisio/project-skills")]);
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
    expect(parsed.limits.maxOutputTokens).toBe(4096);
    expect(parsed.limits.maxTurns).toBe(20);
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
  });
});
