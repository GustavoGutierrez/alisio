import { createHash } from "node:crypto";
import { textResult } from "@alisio/sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerSource, ServerConfig } from "../config.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { objectSchema } from "../tools/standard.ts";
import { loadVersion } from "../version.ts";

export type McpStatus =
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed"
  | "needs-authentication"
  | "restart-required";
export interface McpToolInfo {
  name: string;
  effectiveName: string;
  title?: string;
  description?: string;
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
}
export interface McpServerInfo {
  name: string;
  displayName: string;
  source: McpServerSource;
  status: McpStatus;
  enabled: boolean;
  runtimePermission: "granted" | "not-granted" | "read-only";
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  capabilities: string[];
  counts: { tools: number; resources: number; prompts: number };
  diagnostic?: string;
}
type Connected = {
  client: Client;
  undo: Array<() => void>;
  generation: symbol;
  registeredNames: string[];
};

const TOOL_NAME_LIMIT = 64;
const semanticSegment = (value: string, fallback: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
const shortHash = (server: string, tool: string) =>
  createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
const withHash = (base: string, server: string, tool: string) => {
  const suffix = `_${shortHash(server, tool)}`;
  const stem = base.slice(0, TOOL_NAME_LIMIT - suffix.length).replace(/_+$/g, "");
  return `${stem || "mcp_tool"}${suffix}`;
};

/** Deterministic provider-safe names while retaining the exact source mapping in the connector. */
export function semanticMcpToolNames(
  server: string,
  tools: string[],
  configuredServers: string[],
  unavailable: ReadonlySet<string> = new Set(),
): string[] {
  if (new Set(tools).size !== tools.length)
    throw new Error(`MCP server "${server}" returned duplicate tool names`);
  const serverPart = semanticSegment(server, "server");
  const serverCollision =
    configuredServers.filter((candidate) => semanticSegment(candidate, "server") === serverPart)
      .length > 1;
  const toolParts = tools.map((tool) => semanticSegment(tool, "tool"));
  const collisions = new Set(toolParts.filter((part, index) => toolParts.indexOf(part) !== index));
  return tools.map((tool, index) => {
    const base = `mcp_${serverPart}_${toolParts[index]}`;
    const needsHash =
      base.length > TOOL_NAME_LIMIT ||
      serverCollision ||
      collisions.has(toolParts[index] as string) ||
      unavailable.has(base);
    const result = needsHash ? withHash(base, server, tool) : base;
    if (unavailable.has(result))
      throw new Error(`MCP tool name collision could not be resolved for ${server}/${tool}`);
    return result;
  });
}

const readable = (value: string, limit = 160) =>
  value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

const safeFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timeout") || message.includes("timed out")) return "Connection timed out";
  if (message.includes("abort")) return "Connection cancelled";
  if (message.includes("auth") || message.includes("token") || message.includes("401"))
    return "Authentication is required or was rejected";
  if (message.includes("enoent")) return "Server command could not be started";
  return "Connection failed; inspect the server separately for details";
};

export class McpConnector {
  private clients = new Map<string, Connected>();
  private statuses = new Map<string, McpStatus>();
  private diagnostics = new Map<string, string>();
  private catalogs = new Map<string, McpToolInfo[]>();
  private details = new Map<
    string,
    { displayName?: string; capabilities: string[]; resources: number; prompts: number }
  >();
  private bridgeUndo: Array<() => void> = [];
  constructor(
    private servers: Record<string, ServerConfig>,
    private registry: ToolRegistry,
    private workspace: string,
    private availability: "allowed" | "disabled" | "read-only" = "allowed",
    private sources: Record<string, McpServerSource> = {},
  ) {
    for (const [name, server] of Object.entries(servers))
      this.statuses.set(name, server.enabled ? "disconnected" : "disabled");
  }
  register(): void {
    if (this.bridgeUndo.length) return;
    const undo: Array<() => void> = [];
    try {
      undo.push(
        this.registry.register({
          name: "mcp_connect",
          effect: "external",
          description: `Connect to a configured MCP server and register its tools. Servers: ${Object.keys(this.servers).join(", ")}`,
          inputSchema: objectSchema({ server: { type: "string" } }, ["server"]),
          execute: async (i, c) =>
            textResult(JSON.stringify(await this.connect(String(i.server), c.signal))),
        }),
      );
      undo.push(
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
              ? await client.readResource(
                  { uri: String(i.uri) },
                  { signal: c.signal, timeout: 15000 },
                )
              : await client.listResources(undefined, { signal: c.signal, timeout: 15000 });
            return textResult(JSON.stringify(result));
          },
        }),
      );
      undo.push(
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
        }),
      );
      this.bridgeUndo = undo;
    } catch (error) {
      for (const remove of undo.reverse()) remove();
      throw error;
    }
  }
  grantRuntimePermission(): void {
    if (this.availability === "read-only") throw new Error("MCP is unavailable under --read-only");
    this.availability = "allowed";
    this.register();
  }
  /** Drop the runtime grant: disconnect every server and unregister the bridge (used on revoke). */
  async revokeRuntimePermission(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((name) => this.disconnect(name)));
    for (const undo of this.bridgeUndo.splice(0).reverse()) undo();
    this.availability = "disabled";
  }
  runtimePermission(): McpServerInfo["runtimePermission"] {
    return this.availability === "allowed"
      ? "granted"
      : this.availability === "read-only"
        ? "read-only"
        : "not-granted";
  }
  private assertAvailable() {
    if (this.availability === "read-only") throw new Error("MCP is unavailable under --read-only");
    if (this.availability === "disabled")
      throw new Error("MCP is configured but disabled; restart with --allow-mcp");
  }
  private client(name: string): Client {
    const item = this.clients.get(name);
    if (!item) throw new Error("MCP server disconnected; reconnect explicitly");
    return item.client;
  }
  list(): McpServerInfo[] {
    return Object.keys(this.servers)
      .map((name) => this.info(name))
      .sort((a, b) => a.source.kind.localeCompare(b.source.kind) || a.name.localeCompare(b.name));
  }
  info(name: string): McpServerInfo {
    const config = this.servers[name];
    if (!config) throw new Error(`Unknown MCP server: ${name}`);
    const detail = this.details.get(name);
    return {
      name,
      displayName: detail?.displayName ?? name,
      source: this.sources[name] ?? { kind: "builtin", form: "canonical" },
      status: this.statuses.get(name) ?? (config.enabled ? "disconnected" : "disabled"),
      enabled: config.enabled,
      runtimePermission: this.runtimePermission(),
      transport: config.transport,
      ...(config.transport === "stdio"
        ? { command: config.command, args: [...config.args] }
        : { url: config.url }),
      capabilities: [...(detail?.capabilities ?? [])],
      counts: {
        tools: this.catalogs.get(name)?.length ?? 0,
        resources: detail?.resources ?? 0,
        prompts: detail?.prompts ?? 0,
      },
      ...(this.diagnostics.has(name) ? { diagnostic: this.diagnostics.get(name) } : {}),
    };
  }
  tools(name: string): McpToolInfo[] {
    this.info(name);
    return (this.catalogs.get(name) ?? []).map((tool) => ({
      ...tool,
      ...(tool.annotations ? { annotations: { ...tool.annotations } } : {}),
    }));
  }
  async connect(name: string, signal: AbortSignal): Promise<string[]> {
    this.assertAvailable();
    const config = this.servers[name];
    if (!config) throw new Error(`Unknown MCP server: ${name}`);
    if (!config.enabled) throw new Error(`MCP server "${name}" is disabled; enable it in /mcp`);
    if (this.clients.has(name)) return this.registeredNames(name);
    if (
      config.transport === "http" &&
      config.bearerTokenEnv &&
      !process.env[config.bearerTokenEnv]
    ) {
      this.statuses.set(name, "needs-authentication");
      this.diagnostics.set(
        name,
        `Set the ${config.bearerTokenEnv} environment variable, then reconnect`,
      );
      throw new Error(`MCP server "${name}" needs authentication; set ${config.bearerTokenEnv}`);
    }
    this.statuses.set(name, "connecting");
    this.diagnostics.delete(name);
    const client = new Client(
      { name: "alisio", version: loadVersion(import.meta.url) },
      { capabilities: {} },
    );
    const undo: Array<() => void> = [];
    const generation = Symbol(name);
    const transport =
      config.transport === "stdio"
        ? new StdioClientTransport(
            (() => {
              const env = Object.fromEntries(
                ["PATH", "HOME", "SystemRoot", ...config.envAllow].flatMap((key) =>
                  process.env[key] ? [[key, process.env[key] as string]] : [],
                ),
              );
              Object.assign(env, config.env);
              return {
                command: config.command,
                args: config.args,
                cwd: this.workspace,
                env,
                stderr: "pipe" as const,
                maxBufferSize: 1_048_576,
              };
            })(),
          )
        : new StreamableHTTPClientTransport(new URL(config.url), {
            reconnectionOptions: {
              maxRetries: 0,
              maxReconnectionDelay: 1000,
              initialReconnectionDelay: 100,
              reconnectionDelayGrowFactor: 1,
            },
            ...(config.bearerTokenEnv
              ? {
                  authProvider: {
                    token: async () => process.env[config.bearerTokenEnv as string] as string,
                  },
                }
              : {}),
          });
    try {
      await client.connect(transport, { signal, timeout: 15000 });
      if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => {});
      const serverCapabilities = client.getServerCapabilities() ?? {};
      const capabilities = Object.keys(serverCapabilities).sort();
      const tools = serverCapabilities.tools
        ? (await client.listTools(undefined, { signal, timeout: 15000 })).tools
        : [];
      if (tools.length > 100)
        throw new Error("MCP server exposes more than 100 tools; narrow its configuration");
      const resources = serverCapabilities.resources
        ? (await client.listResources(undefined, { signal, timeout: 15000 })).resources.length
        : 0;
      const prompts = serverCapabilities.prompts
        ? (await client.listPrompts(undefined, { signal, timeout: 15000 })).prompts.length
        : 0;
      const existingNames = new Set(this.registry.list().map((registered) => registered.name));
      const mappedNames = semanticMcpToolNames(
        name,
        tools.map((tool) => tool.name),
        Object.keys(this.servers),
        existingNames,
      );
      this.catalogs.set(
        name,
        tools.map((tool, index) => ({
          name: tool.name,
          effectiveName: mappedNames[index] as string,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.annotations
            ? {
                annotations: {
                  ...(tool.annotations.readOnlyHint !== undefined
                    ? { readOnly: tool.annotations.readOnlyHint }
                    : {}),
                  ...(tool.annotations.destructiveHint !== undefined
                    ? { destructive: tool.annotations.destructiveHint }
                    : {}),
                  ...(tool.annotations.openWorldHint !== undefined
                    ? { openWorld: tool.annotations.openWorldHint }
                    : {}),
                },
              }
            : {}),
        })),
      );
      this.details.set(name, {
        displayName: client.getServerVersion()?.title ?? client.getServerVersion()?.name,
        capabilities,
        resources,
        prompts,
      });
      for (const [index, tool] of tools.entries()) {
        const mapped = mappedNames[index] as string;
        const reference = `${readable(name)}/${readable(tool.name)}`;
        const remoteDescription = readable(tool.description ?? "", 500);
        undo.push(
          this.registry.register({
            name: mapped,
            effect: "external",
            description: remoteDescription
              ? `${reference} — Remote MCP description (untrusted data): ${remoteDescription}`
              : `${reference} — Remote MCP tool.`,
            inputSchema: tool.inputSchema,
            execute: async (input, ctx) => {
              const available = await client.listTools(undefined, {
                signal: ctx.signal,
                timeout: 15000,
                cacheMode: "refresh",
              });
              const current = available.tools.find((candidate) => candidate.name === tool.name);
              if (
                !current ||
                JSON.stringify(current.inputSchema) !== JSON.stringify(tool.inputSchema)
              )
                throw new Error("MCP schema changed; reconnect the server to refresh tools");
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
      this.clients.set(name, { client, undo, generation, registeredNames: mappedNames });
      this.statuses.set(name, "connected");
      client.onclose = () => {
        if (this.clients.get(name)?.generation !== generation) return;
        for (const fn of undo) fn();
        this.clients.delete(name);
        this.catalogs.delete(name);
        this.details.delete(name);
        this.statuses.set(name, config.enabled ? "disconnected" : "disabled");
      };
      return this.registeredNames(name);
    } catch (error) {
      for (const fn of undo) fn();
      await client.close().catch(() => {});
      this.catalogs.delete(name);
      this.details.delete(name);
      if (this.statuses.get(name) !== "needs-authentication") this.statuses.set(name, "failed");
      this.diagnostics.set(name, safeFailure(error));
      throw new Error(`MCP server "${name}" failed to connect: ${safeFailure(error)}`);
    }
  }
  async disconnect(name: string): Promise<void> {
    const connected = this.clients.get(name);
    if (connected) {
      this.clients.delete(name);
      for (const fn of connected.undo) fn();
      await connected.client.close().catch(() => {});
    }
    this.catalogs.delete(name);
    this.details.delete(name);
    this.diagnostics.delete(name);
    const server = this.servers[name];
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    this.statuses.set(name, server.enabled ? "disconnected" : "disabled");
  }
  async reconnect(name: string, signal: AbortSignal): Promise<string[]> {
    this.assertAvailable();
    await this.disconnect(name);
    return this.connect(name, signal);
  }
  async setEnabled(name: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
    const server = this.servers[name];
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    server.enabled = enabled;
    if (!enabled) return this.disconnect(name);
    this.statuses.set(name, "disconnected");
    if (signal) await this.connect(name, signal);
  }
  private registeredNames(name: string) {
    return [...(this.clients.get(name)?.registeredNames ?? [])];
  }
  async close(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((name) => this.disconnect(name)));
    for (const undo of this.bridgeUndo.splice(0).reverse()) undo();
  }
}
