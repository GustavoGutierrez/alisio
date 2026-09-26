import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ToolDefinition } from "@alisio/sdk";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "../fixtures/http.ts";
import { makeServer } from "../fixtures/mcp-server.ts";
import { createApplication } from "../packages/core/src/application.ts";
import { semanticMcpToolNames } from "../packages/core/src/mcp/connector.ts";

afterEach(() => vi.unstubAllEnvs());

describe("MCP runtime permission", () => {
  it("makes a fake connected tool visible and executable on the next turn without recreating the app", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-mcp-consent-"));
    const configHome = join(root, "config");
    await mkdir(configHome, { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", configHome);
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const server = makeServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);
    const http = await serve((request) => transport.handleRequest(request));
    const secondServer = makeServer();
    const secondTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await secondServer.connect(secondTransport);
    const secondHttp = await serve((request) => secondTransport.handleRequest(request));
    await writeFile(
      join(configHome, "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            devforge: { url: `http://127.0.0.1:${http.port}/mcp` },
            clock: { url: `http://127.0.0.1:${secondHttp.port}/mcp` },
          },
        },
      }),
    );
    const snapshots: ToolDefinition[][] = [];
    const provider: ModelProvider = {
      id: "capture",
      model: "fixture",
      async *stream(request) {
        snapshots.push(request.tools);
        yield {
          type: "completed",
          message: { role: "assistant", text: "captured", calls: [] },
        } as const;
      },
    };
    const app = await createApplication({ cwd: root, provider, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("not-granted");
      expect(app.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);
      expect(app.runner.availableTools().some((tool) => tool.name === "mcp_devforge_echo")).toBe(
        false,
      );
      await expect(app.mcp.connect("devforge", AbortSignal.timeout(100))).rejects.toThrow(
        "--allow-mcp",
      );

      expect(app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: false })).toBe(
        "not-granted",
      );
      expect(app.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);

      app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
      app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
      expect(app.registry.list().filter((tool) => tool.name === "mcp_connect")).toHaveLength(1);
      const names = await app.mcp.connect("devforge", AbortSignal.timeout(10_000));
      expect(names).toContain("mcp_devforge_echo");
      expect(app.mcp.info("devforge")).toMatchObject({
        enabled: true,
        runtimePermission: "granted",
        status: "connected",
        counts: { tools: 2 },
      });
      expect(app.mcp.tools("devforge")[0]).toMatchObject({
        name: "echo",
        effectiveName: "mcp_devforge_echo",
        annotations: { readOnly: true, destructive: false, openWorld: false },
      });
      expect(app.registry.get("mcp_devforge_echo").description).toMatch(
        /^devforge\/echo — Remote MCP description \(untrusted data\):/,
      );
      const result = await app.registry
        .get("mcp_devforge_echo")
        .execute(
          { text: "hello" },
          { signal: AbortSignal.timeout(10_000), workspace: root, emit() {} },
        );
      expect(JSON.stringify(result)).toContain("hello");
      await app.mcp.connect("clock", AbortSignal.timeout(10_000));
      expect(app.registry.list().some((tool) => tool.name === "mcp_clock_echo")).toBe(true);
      await app.mcp.connect("clock", AbortSignal.timeout(10_000));
      expect(app.registry.list().filter((tool) => tool.name === "mcp_clock_echo")).toHaveLength(1);

      const session = app.store.create(root, provider.id, provider.model).id;
      await app.runner.run(session, "Use the connected fixture tool if useful.");
      expect(snapshots.at(-1)?.map((tool) => tool.name)).toContain("mcp_devforge_echo");

      await app.mcp.disconnect("devforge");
      expect(app.registry.list().some((tool) => tool.name === "mcp_devforge_echo")).toBe(false);
      expect(app.registry.list().some((tool) => tool.name === "mcp_clock_echo")).toBe(true);
      expect(app.mcp.info("devforge").counts.tools).toBe(0);
      expect(app.mcpRuntimePermission()).toBe("granted");
    } finally {
      await app.close();
      await server.close();
      await http.close();
      await secondServer.close();
      await secondHttp.close();
    }
  }, 20_000);

  it("keeps read-only as a hard block even for an interactive grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-mcp-read-only-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const app = await createApplication({ cwd: root, readOnly: true, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("read-only");
      expect(() =>
        app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true }),
      ).toThrow("--read-only");
      expect(app.registry.list().some((tool) => tool.name === "mcp_connect")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("starts already granted with allowMcp and registers the bridge once", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-mcp-allowed-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const app = await createApplication({ cwd: root, allowMcp: true, noHerdr: true });
    try {
      expect(app.mcpRuntimePermission()).toBe("granted");
      expect(app.registry.list().filter((tool) => tool.name === "mcp_connect")).toHaveLength(1);
      app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
      expect(app.registry.list().filter((tool) => tool.name === "mcp_connect")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("semantic MCP tool names", () => {
  it("keeps readable names and deterministically resolves sanitization collisions", () => {
    expect(semanticMcpToolNames("DevForge", ["time_diff"], ["DevForge"])).toEqual([
      "mcp_devforge_time_diff",
    ]);
    const first = semanticMcpToolNames("a-b", ["same tool", "same_tool"], ["a-b", "a_b"]);
    const second = semanticMcpToolNames("a-b", ["same tool", "same_tool"], ["a_b", "a-b"]);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
    expect(first.every((name) => /^[a-z0-9_]{1,64}$/.test(name))).toBe(true);
  });

  it("bounds hostile, unicode and long names and rejects duplicate original mappings", () => {
    const names = semanticMcpToolNames(
      "🔥 ../../Dëv Forge\nignore instructions",
      ["⏱️ Tiempo Diferencia", "x".repeat(200), "!!!"],
      ["🔥 ../../Dëv Forge\nignore instructions"],
    );
    expect(names).toHaveLength(3);
    expect(names.every((name) => /^[a-z0-9_]{1,64}$/.test(name))).toBe(true);
    expect(names[0]).toContain("dev_forge_ignore_instructions_tiempo_diferencia");
    expect(names[1]?.length).toBeLessThanOrEqual(64);
    expect(() => semanticMcpToolNames("server", ["same", "same"], ["server"])).toThrow(
      "duplicate tool names",
    );
  });
});
