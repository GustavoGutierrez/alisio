import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { isMain } from "./http.ts";
import { makeServer } from "./mcp-server.ts";

// An MCP stdio server that refuses both fast-path exits: it ignores stdin `end` (the normal
// close signal) and SIGTERM, so the client-side close() must walk its full ladder
// (stdin end → 2s → SIGTERM → 2s → SIGKILL, ~4s). Used to prove `McpConnector.close()` is
// bounded. The fixture self-exits after 30s as a hard cleanup guarantee even if SIGKILL never
// arrives (e.g. a crashed test runner).
if (isMain(import.meta.url)) {
  const server = makeServer();
  await server.connect(new StdioServerTransport()).catch(() => {});
  process.on("uncaughtException", () => {});
  process.on("unhandledRejection", () => {});
  process.stdin.on("end", () => {});
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  setTimeout(() => process.exit(0), 30_000);
}
