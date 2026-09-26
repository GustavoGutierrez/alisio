import assert from "node:assert/strict";
import { resolve } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { configSchema } from "../packages/core/src/config.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { McpConnector } from "../packages/core/src/mcp/connector.ts";
import { isMain, serve, type TestServer } from "./http.ts";
import { makeServer } from "./mcp-server.ts";

export async function runMcpTest(mode: string): Promise<{ mode: string; ok: boolean }> {
  const registry = new ToolRegistry();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const server = makeServer();
  let http: TestServer | undefined;
  if (mode === "http") {
    await server.connect(transport);
    http = await serve((req) => transport.handleRequest(req));
  }
  const servers = configSchema.parse({
    mcp: {
      servers: {
        test:
          mode === "stdio"
            ? {
                transport: "stdio",
                // Runs the TypeScript fixture server under the current runtime (Node or Bun).
                command: process.execPath,
                args: [
                  ...(process.versions.bun
                    ? []
                    : ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]),
                  resolve("fixtures/mcp-server.ts"),
                ],
              }
            : { transport: "http", url: `http://127.0.0.1:${http?.port}/mcp` },
      },
    },
  }).mcp.servers;
  const connector = new McpConnector(servers, registry, process.cwd());
  connector.register();
  const context = { signal: AbortSignal.timeout(10000), workspace: process.cwd(), emit: () => {} };
  try {
    const names = await connector.connect("test", context.signal);
    assert.equal(names.length, 1);
    const result = await registry.get(names[0] as string).execute({ text: "hello" }, context);
    assert.match(JSON.stringify(result), /hello/);
    const resources = await registry.get("mcp_resource").execute({ server: "test" }, context);
    assert.match(JSON.stringify(resources), /test:\/\/example/);
    const resource = await registry
      .get("mcp_resource")
      .execute({ server: "test", uri: "test://example" }, context);
    assert.match(JSON.stringify(resource), /resource content/);
    const prompts = await registry.get("mcp_prompt").execute({ server: "test" }, context);
    assert.match(JSON.stringify(prompts), /review/);
    const prompt = await registry
      .get("mcp_prompt")
      .execute({ server: "test", name: "review", arguments: { subject: "code" } }, context);
    assert.match(JSON.stringify(prompt), /Review code/);
    await connector.close();
    assert.equal(registry.list().filter((t) => t.name.startsWith("m_")).length, 0);
    return { mode, ok: true };
  } finally {
    await connector.close();
    await server.close();
    if (http) await http.close();
  }
}
if (isMain(import.meta.url))
  console.log(JSON.stringify(await runMcpTest(process.argv[2] ?? "stdio")));
