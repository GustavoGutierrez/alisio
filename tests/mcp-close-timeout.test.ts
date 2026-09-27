import { resolve } from "node:path";
import { expect, it } from "vitest";
import { configSchema } from "../packages/core/src/config.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { McpConnector } from "../packages/core/src/mcp/connector.ts";

it("close() is bounded when a server ignores stdin end and SIGTERM", async () => {
  const registry = new ToolRegistry();
  const servers = configSchema.parse({
    mcp: {
      servers: {
        test: {
          transport: "stdio",
          command: process.execPath,
          args: [
            ...(process.versions.bun
              ? []
              : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]),
            resolve("fixtures/mcp-slow-server.ts"),
          ],
        },
      },
    },
  }).mcp.servers;
  const connector = new McpConnector(servers, registry, process.cwd());
  connector.register();
  const names = await connector.connect("test", AbortSignal.timeout(10_000));
  expect(names).toHaveLength(2);
  const start = Date.now();
  await connector.close();
  const elapsed = Date.now() - start;
  // The MCP SDK's own stdio close ladder would take ~4s for this server; the connector caps
  // each server close at 800ms (and the whole close at 1500ms), so close must return far
  // earlier.
  expect(elapsed).toBeLessThan(3_000);
  // Registry cleanup is synchronous inside disconnect, so it is complete even though the
  // abandoned client close keeps running in the background.
  expect(registry.list().filter((tool) => tool.name.startsWith("mcp_test_"))).toHaveLength(0);
  expect(connector.info("test").status).toBe("disconnected");
}, 15_000);
