import { describe, expect, it } from "vitest";
import { runMcpTest } from "../fixtures/mcp-test.ts";

for (const mode of ["stdio", "http", "http-bearer"])
  it(`MCP ${mode}: tools, resources, prompts and cleanup (Node)`, async () => {
    expect(await runMcpTest(mode)).toEqual({ mode, ok: true });
  }, 20_000);

describe("secret references (D17, schema only)", () => {
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
        /protected secrets/,
      );
      expect(connector.info(name).status).toBe("failed");
    }
    expect(() =>
      configSchema.parse({
        mcp: { servers: { x: { url: "https://e.invalid", headers: { A: "literal-secret" } } } },
      }),
    ).toThrow();
  });
});
