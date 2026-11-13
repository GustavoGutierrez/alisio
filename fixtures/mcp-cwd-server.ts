import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { isMain } from "./http.ts";

// A stdio MCP fixture that reports the working directory it was started in, so tests can prove a
// global MCP entry runs with a separate cwd per workspace.
if (isMain(import.meta.url)) {
  const server = new McpServer({ name: "alisio-cwd", version: "1.0.0" });
  server.registerTool(
    "cwd",
    { description: "Report cwd", inputSchema: z.object({}) },
    async () => ({
      content: [{ type: "text", text: process.cwd() }],
    }),
  );
  await server.connect(new StdioServerTransport());
}
