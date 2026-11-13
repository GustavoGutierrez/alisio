/**
 * Scope-aware MCP operations built on the shared writer (SCP-04): a project can switch a global
 * integration off for itself with a minimal override, and removing that override reveals the
 * global entry, which the caller announces first with `previewMcpRemoval`.
 */
import { dirname, resolve } from "node:path";
import { parseMcpServerEntry } from "../config.ts";
import { McpConfigError, mcpConfigFile, readMcpServers, writeMcpServer } from "./config-writer.ts";

export interface McpRemovalPreview {
  scope: "global" | "project";
  name: string;
  /** Removing the entry from this scope makes a global entry of the same name effective again. */
  revealsGlobal: boolean;
  revealed?: { enabled: boolean; transport: "stdio" | "http" };
}

export async function previewMcpRemoval(input: {
  workspace: string;
  name: string;
  scope: "global" | "project";
}): Promise<McpRemovalPreview> {
  const base = { scope: input.scope, name: input.name };
  if (input.scope === "global") return { ...base, revealsGlobal: false };
  const hidden = (await readMcpServers({ scope: "global" }))[input.name];
  if (!hidden) return { ...base, revealsGlobal: false };
  const parsed = parseMcpServerEntry(hidden.raw);
  return {
    ...base,
    revealsGlobal: true,
    revealed: { enabled: parsed.enabled, transport: parsed.transport },
  };
}

const relative = (value: string) => value.startsWith("./") || value.startsWith("../");

/**
 * Switches a global MCP off "in this project only": writes a disabled project entry that carries
 * the global connection settings (command, arguments, URL, secret references) but NEVER the
 * literal `env` values, which may hold secrets. Relative paths are re-anchored to the global file.
 * Refuses to replace an entry the project already defines.
 */
export async function createProjectOverride(input: {
  workspace: string;
  name: string;
  sessionTrusted?: boolean;
}): Promise<void> {
  const entry = (await readMcpServers({ scope: "global" }))[input.name];
  if (!entry)
    throw new McpConfigError("mcp_config_invalid", `No global MCP server named "${input.name}"`);
  const project = { scope: "project" as const, workspace: input.workspace };
  if ((await readMcpServers(project))[input.name])
    throw new McpConfigError(
      "mcp_config_invalid",
      `MCP server "${input.name}" is already defined in this project`,
    );
  const server = parseMcpServerEntry(entry.raw);
  const globalDir = dirname(mcpConfigFile({ scope: "global" }));
  const anchor = (value: string) => (relative(value) ? resolve(globalDir, value) : value);
  const minimal =
    server.transport === "stdio"
      ? {
          transport: "stdio",
          command: anchor(server.command),
          args: server.args.map(anchor),
          envAllow: server.envAllow,
          ...(server.secretEnv ? { secretEnv: server.secretEnv } : {}),
          enabled: false,
        }
      : {
          transport: "http",
          url: server.url,
          ...(server.bearerTokenEnv ? { bearerTokenEnv: server.bearerTokenEnv } : {}),
          ...(server.headers ? { headers: server.headers } : {}),
          enabled: false,
        };
  await writeMcpServer({
    target: { ...project, ...(input.sessionTrusted ? { sessionTrusted: true } : {}) },
    name: input.name,
    server: minimal,
  });
}
