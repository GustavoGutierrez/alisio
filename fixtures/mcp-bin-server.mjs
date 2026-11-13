// A plain-JavaScript MCP stdio server used as the "program" of fake npm packages in the installer
// tests: `node <this file>` must work without any TypeScript flag, exactly like an npm MCP package.
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({ name: "alisio-bin-fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo", inputSchema: z.object({ text: z.string() }) },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);
server.registerTool(
  "environment",
  { description: "Read named variables", inputSchema: z.object({ names: z.array(z.string()) }) },
  async ({ names }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n]]))),
      },
    ],
  }),
);
server.registerResource("example", "test://example", { mimeType: "text/plain" }, async (uri) => ({
  contents: [{ uri: uri.href, text: "resource content" }],
}));
await server.connect(new StdioServerTransport());
