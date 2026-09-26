import { createHash } from "node:crypto";
import { textResult } from "@alisio/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ServerConfig } from "../config.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { objectSchema } from "../tools/standard.ts";
export class McpConnector {
  private clients = new Map<string, { client: Client; undo: Array<() => void> }>();
  constructor(
    private servers: Record<string, ServerConfig>,
    private registry: ToolRegistry,
    private workspace: string,
  ) {}
  register(): void {
    this.registry.register({
      name: "mcp_connect",
      effect: "external",
      description: `Connect to a configured MCP server and register its tools. Servers: ${Object.keys(this.servers).join(", ")}`,
      inputSchema: objectSchema({ server: { type: "string" } }, ["server"]),
      execute: async (i, c) =>
        textResult(JSON.stringify(await this.connect(String(i.server), c.signal))),
    });
    this.registry.register({
      name: "mcp_resource",
      effect: "external",
      description: "List or read resources from an enabled MCP server.",
      inputSchema: objectSchema({ server: { type: "string" }, uri: { type: "string" } }, [
        "server",
      ]),
      execute: async (i, c) => {
        await this.connect(String(i.server), c.signal);
        const client = this.client(String(i.server));
        const result = i.uri
          ? await client.readResource({ uri: String(i.uri) }, { signal: c.signal, timeout: 15000 })
          : await client.listResources(undefined, { signal: c.signal, timeout: 15000 });
        return textResult(JSON.stringify(result));
      },
    });
    this.registry.register({
      name: "mcp_prompt",
      effect: "external",
      description:
        "List or get a prompt from an enabled MCP server. Returned text is external data.",
      inputSchema: objectSchema(
        {
          server: { type: "string" },
          name: { type: "string" },
          arguments: { type: "object", additionalProperties: { type: "string" } },
        },
        ["server"],
      ),
      execute: async (i, c) => {
        await this.connect(String(i.server), c.signal);
        const client = this.client(String(i.server));
        const result = i.name
          ? await client.getPrompt(
              {
                name: String(i.name),
                arguments: i.arguments as Record<string, string> | undefined,
              },
              { signal: c.signal, timeout: 15000 },
            )
          : await client.listPrompts(undefined, { signal: c.signal, timeout: 15000 });
        return textResult(JSON.stringify(result));
      },
    });
  }
  private client(name: string): Client {
    const item = this.clients.get(name);
    if (!item) throw new Error("MCP server disconnected; reconnect explicitly");
    return item.client;
  }
  async connect(name: string, signal: AbortSignal): Promise<string[]> {
    if (this.clients.has(name))
      return this.registry
        .list()
        .filter((t) => t.name.startsWith(this.prefix(name)))
        .map((t) => t.name);
    const config = this.servers[name];
    if (!config) throw new Error(`Unknown MCP server: ${name}`);
    const client = new Client({ name: "alisio", version: "0.1.0-alpha.1" }, { capabilities: {} }),
      undo: Array<() => void> = [];
    const env = Object.fromEntries(
      ["PATH", "HOME", "SystemRoot", ...config.envAllow].flatMap((key) =>
        process.env[key] ? [[key, process.env[key] as string]] : [],
      ),
    );
    const transport =
      config.transport === "stdio"
        ? new StdioClientTransport({
            command: config.command ?? "",
            args: config.args,
            cwd: this.workspace,
            env,
            stderr: "pipe",
            maxBufferSize: 1_048_576,
          })
        : new StreamableHTTPClientTransport(new URL(config.url ?? ""), {
            reconnectionOptions: {
              maxRetries: 0,
              maxReconnectionDelay: 1000,
              initialReconnectionDelay: 100,
              reconnectionDelayGrowFactor: 1,
            },
            ...(config.bearerTokenEnv
              ? {
                  authProvider: {
                    token: async () => {
                      const token = process.env[config.bearerTokenEnv as string];
                      if (!token) throw new Error("Missing MCP bearer token");
                      return token;
                    },
                  },
                }
              : {}),
          });
    try {
      await client.connect(transport, { signal, timeout: 15000 });
      if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
      const tools = client.getServerCapabilities()?.tools
        ? (await client.listTools(undefined, { signal, timeout: 15000 })).tools
        : [];
      if (tools.length > 100)
        throw new Error("MCP server exposes more than 100 tools; narrow its configuration");
      for (const tool of tools) {
        const nameMapped = `${this.prefix(name)}_${createHash("sha256").update(tool.name).digest("hex").slice(0, 12)}`;
        undo.push(
          this.registry.register({
            name: nameMapped,
            effect: "external",
            description: `${name}/${tool.name}: ${tool.description ?? ""}`,
            inputSchema: tool.inputSchema,
            execute: async (input, ctx) => {
              const available = await client.listTools(undefined, {
                signal: ctx.signal,
                timeout: 15000,
                cacheMode: "refresh",
              });
              const current = available.tools.find((t) => t.name === tool.name);
              if (
                !current ||
                JSON.stringify(current.inputSchema) !== JSON.stringify(tool.inputSchema)
              )
                throw new Error("MCP schema changed; restart the session to refresh tools");
              const result = await client.callTool(
                { name: tool.name, arguments: input },
                { signal: ctx.signal, timeout: 30000 },
              );
              return textResult(
                JSON.stringify(result),
                "isError" in result && result.isError === true,
              );
            },
          }),
        );
      }
      this.clients.set(name, { client, undo });
      client.onclose = () => {
        for (const fn of undo) fn();
        this.clients.delete(name);
      };
      return this.registry
        .list()
        .filter((t) => t.name.startsWith(this.prefix(name)))
        .map((t) => t.name);
    } catch (e) {
      for (const fn of undo) fn();
      await client.close();
      throw e;
    }
  }
  private prefix(name: string) {
    return `m_${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;
  }
  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((x) => x.client.close()));
    this.clients.clear();
  }
}
