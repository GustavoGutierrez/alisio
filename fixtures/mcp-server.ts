import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { isMain } from "./http.ts";
export function makeServer() {
  const server = new McpServer({ name: "alisio-test", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      title: "Friendly Echo",
      description: "Echo test",
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool(
    "environment",
    {
      description: "Read named fixture variables",
      inputSchema: z.object({ names: z.array(z.string()) }),
    },
    async ({ names }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name]]))),
        },
      ],
    }),
  );
  server.registerResource("example", "test://example", { mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, text: "resource content" }],
  }));
  server.registerPrompt(
    "review",
    { description: "review", argsSchema: z.object({ subject: z.string() }) },
    ({ subject }) => ({
      messages: [{ role: "user", content: { type: "text", text: `Review ${subject}` } }],
    }),
  );
  return server;
}
if (isMain(import.meta.url)) {
  const server = makeServer();
  await server.connect(new StdioServerTransport());
}
