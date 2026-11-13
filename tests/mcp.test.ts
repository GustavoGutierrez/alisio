import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runMcpTest } from "../fixtures/mcp-test.ts";

for (const mode of ["stdio", "http", "http-bearer"])
  it(`MCP ${mode}: tools, resources, prompts and cleanup (Node)`, async () => {
    expect(await runMcpTest(mode)).toEqual({ mode, ok: true });
  }, 20_000);

describe("secret references (D17)", () => {
  it("parses secret headers and environment references and never connects without resolving them", async () => {
    const { configSchema } = await import("../packages/core/src/config.ts");
    const { McpConnector } = await import("../packages/core/src/mcp/connector.ts");
    const { ToolRegistry } = await import("../packages/core/src/core/registry.ts");
    const servers = configSchema.parse({
      mcp: {
        servers: {
          remote: {
            url: "https://example.invalid/mcp",
            headers: { Authorization: { secret: "mcp/remote/auth" } },
          },
          local: { command: "node", secretEnv: { API_KEY: { env: "MY_KEY" } } },
        },
      },
    }).mcp.servers;
    const connector = new McpConnector(servers, new ToolRegistry(), process.cwd());
    for (const name of ["remote", "local"]) {
      await expect(connector.connect(name, AbortSignal.timeout(2_000))).rejects.toThrow(
        /saved key is missing/,
      );
      expect(connector.info(name).status).toBe("needs-authentication");
    }
    expect(() =>
      configSchema.parse({
        mcp: { servers: { x: { url: "https://e.invalid", headers: { A: "literal-secret" } } } },
      }),
    ).toThrow();
  });
});

describe("MCP-CAT-10: a managed `node <program>` server connects and disconnects cleanly", () => {
  it("resolves node to a runtime when connecting, never persisting it, and keeps tools, resources and disconnect", async () => {
    const { configSchema } = await import("../packages/core/src/config.ts");
    const { McpConnector } = await import("../packages/core/src/mcp/connector.ts");
    const { ToolRegistry } = await import("../packages/core/src/core/registry.ts");
    const servers = configSchema.parse({
      mcp: {
        servers: {
          managed: {
            transport: "stdio",
            command: "node",
            args: [resolve("fixtures/mcp-bin-server.mjs")],
          },
        },
      },
    }).mcp.servers;
    expect(servers.managed).toMatchObject({ command: "node" });
    const registry = new ToolRegistry();
    const connector = new McpConnector(servers, registry, process.cwd());
    connector.register();
    try {
      const names = await connector.connect("managed", AbortSignal.timeout(15_000));
      expect(names).toHaveLength(2);
      expect(connector.info("managed")).toMatchObject({
        status: "connected",
        counts: { tools: 2, resources: 1, prompts: 0 },
      });
      expect(registry.list().some((tool) => tool.name === names[0])).toBe(true);
      // The configuration still says `node`: the real executable is chosen at connect time.
      expect(servers.managed).toMatchObject({ command: "node" });
      await connector.disconnect("managed");
      expect(connector.info("managed").status).toBe("disconnected");
      expect(registry.list().some((tool) => tool.name === names[0])).toBe(false);
    } finally {
      await connector.close();
    }
  });

  it("adds and removes a server on a live connector without a restart", async () => {
    const { parseMcpServerEntry } = await import("../packages/core/src/config.ts");
    const { McpConnector } = await import("../packages/core/src/mcp/connector.ts");
    const { ToolRegistry } = await import("../packages/core/src/core/registry.ts");
    const servers: Record<string, ReturnType<typeof parseMcpServerEntry>> = {};
    const sources: Record<string, { kind: "global"; form: "canonical" }> = {};
    const connector = new McpConnector(
      servers,
      new ToolRegistry(),
      process.cwd(),
      "allowed",
      sources,
    );
    connector.register();
    try {
      await connector.addServer(
        "late",
        parseMcpServerEntry({
          transport: "stdio",
          command: "node",
          args: [resolve("fixtures/mcp-bin-server.mjs")],
        }),
        { kind: "global", form: "canonical" },
      );
      expect(connector.list().map((s) => s.name)).toEqual(["late"]);
      expect(connector.info("late")).toMatchObject({ status: "disconnected", enabled: true });
      await connector.connect("late", AbortSignal.timeout(15_000));
      expect(connector.info("late").status).toBe("connected");
      await connector.removeServer("late");
      expect(connector.list()).toEqual([]);
      expect(servers.late).toBeUndefined();
      expect(() => connector.info("late")).toThrow(/Unknown MCP server/);
    } finally {
      await connector.close();
    }
  });
});

describe("a service that refuses the credentials", () => {
  it("needs attention instead of simply failing, without leaking the credential", async () => {
    const { serve } = await import("../fixtures/http.ts");
    const { configSchema } = await import("../packages/core/src/config.ts");
    const { McpConnector } = await import("../packages/core/src/mcp/connector.ts");
    const { ToolRegistry } = await import("../packages/core/src/core/registry.ts");
    const http = await serve(() => new Response("no", { status: 401 }));
    try {
      const servers = configSchema.parse({
        mcp: { servers: { guarded: { url: `http://127.0.0.1:${http.port}/mcp` } } },
      }).mcp.servers;
      const connector = new McpConnector(servers, new ToolRegistry(), process.cwd());
      await expect(connector.connect("guarded", AbortSignal.timeout(10_000))).rejects.toThrow();
      expect(connector.info("guarded").status).toBe("needs-authentication");
    } finally {
      await http.close();
    }
  });
});
