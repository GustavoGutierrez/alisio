import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/core/src/config.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { McpConnector } from "../packages/core/src/mcp/connector.ts";
import {
  terminateAllTrackedProcesses,
  trackedProcesses,
} from "../packages/core/src/runtime/process-registry.ts";

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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function stdioFixture(file: string) {
  return configSchema.parse({
    mcp: {
      servers: {
        test: {
          transport: "stdio",
          command: process.execPath,
          args: [
            ...(process.versions.bun
              ? []
              : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]),
            resolve(file),
          ],
        },
      },
    },
  }).mcp.servers;
}

describe("MCP-CAT-30: stdio MCP servers are in the process registry", () => {
  it("registers the child while connected and releases it on disconnect", async () => {
    const before = new Set(trackedProcesses().map((entry) => entry.pid));
    const connector = new McpConnector(
      stdioFixture("fixtures/mcp-cwd-server.ts"),
      new ToolRegistry(),
      process.cwd(),
    );
    connector.register();
    await connector.connect("test", AbortSignal.timeout(15_000));
    const added = trackedProcesses().filter((entry) => !before.has(entry.pid));
    expect(added).toHaveLength(1);
    await connector.disconnect("test");
    expect(trackedProcesses().filter((entry) => !before.has(entry.pid))).toHaveLength(0);
    await connector.close();
  }, 20_000);

  it("a shutdown sweep terminates a connected server even when close() never runs", async () => {
    const before = new Set(trackedProcesses().map((entry) => entry.pid));
    const connector = new McpConnector(
      stdioFixture("fixtures/mcp-cwd-server.ts"),
      new ToolRegistry(),
      process.cwd(),
    );
    connector.register();
    await connector.connect("test", AbortSignal.timeout(15_000));
    const [child] = trackedProcesses().filter((entry) => !before.has(entry.pid));
    expect(child && alive(child.pid)).toBe(true);
    await terminateAllTrackedProcesses({ graceMs: 1_500 });
    await vi.waitFor(() => expect(alive(child?.pid as number)).toBe(false), { timeout: 5_000 });
    await connector.close();
  }, 25_000);
});
