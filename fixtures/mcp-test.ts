import assert from "node:assert/strict";
import { resolve } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { configSchema } from "../src/config.ts";
import { ToolRegistry } from "../src/core/registry.ts";
import { McpConnector } from "../src/mcp/connector.ts";
import { makeServer } from "./mcp-server.ts";

const mode = process.argv[2] ?? "stdio",
  registry = new ToolRegistry();
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});
const server = makeServer();
let http: ReturnType<typeof Bun.serve> | undefined;
if (mode === "http") {
  await server.connect(transport);
  http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => transport.handleRequest(req),
  });
}
const servers = configSchema.parse({
  mcp: {
    servers: {
      test:
        mode === "stdio"
          ? {
              transport: "stdio",
              command: process.execPath,
              args: [resolve("fixtures/mcp-server.ts")],
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
  console.log(JSON.stringify({ mode, ok: true }));
} finally {
  await connector.close();
  await server.close();
  if (http) await http.stop(true);
}
