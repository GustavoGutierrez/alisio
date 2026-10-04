/**
 * Management routes (RF-14, §8.2): plugins, skills, MCP servers, agent presets and settings of
 * one workspace application. Responses are path- and credential-safe: MCP commands, arguments
 * and URLs are never sent, skills carry no file paths. Changes that alter the slash-command
 * catalog broadcast `catalog_changed` so every open palette refreshes.
 */
import { isAbsolute, join } from "node:path";
import {
  agentCatalogFromState,
  analysisStatus,
  CommandCatalog,
  configFile,
  configHome,
  cycleableAgents,
  hashProjectConfig,
  isSettableSettingKey,
  type McpServerInfo,
  type PluginCatalogEntry,
  pluginPrefix,
  resolveActiveAgent,
  setTrust,
  settableSettings,
} from "@alisio/core";
import type {
  AgentInfo,
  AnalysisStatus,
  McpOverview,
  McpServerWire,
  PluginInfo,
  ReloadReport,
  ServerFrame,
  SettingInfo,
  SettingsOverview,
  SkillInfo,
} from "@alisio/sdk";
import type { RunScheduler } from "../host/run-scheduler.ts";
import type { OpenWorkspace, ServerAppOptions, WorkspaceHost } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";

type CatalogScope = Extract<ServerFrame, { t: "catalog_changed" }>["scope"];

export interface ManagementContext {
  workspaces: WorkspaceHost;
  scheduler: RunScheduler;
  /** Whether a workspace has live background tasks (closing its application would kill them). */
  tasksLive?: (workspaceId: string) => boolean;
  base: ServerAppOptions;
  broadcast: (frame: ServerFrame) => void;
}

/** Resolves `?workspace=` / `{workspace}` (an opaque id or an absolute path) to its open app. */
export async function workspaceApp(
  workspaces: WorkspaceHost,
  reference: string | null | undefined,
): Promise<OpenWorkspace> {
  if (!reference)
    throw new HttpError("validation_failed", "workspace is required", { fields: ["workspace"] });
  const path = isAbsolute(reference)
    ? await workspaces.canonical(reference)
    : await workspaces.pathOf(reference);
  if (!path) throw new HttpError("not_found", "Workspace not found");
  return workspaces.openPath(path);
}

const UNTRUSTED =
  "Trust this workspace (sidebar workspace menu, or run alisio in it) to manage its plugins here";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Plugin and skill toggles persist a project override; the running app reflects plugin changes
 * only after a restart. The server recycles the workspace app as soon as it has no runs (now,
 * or when its last run finishes), so the change applies without restarting `alisio serve`.
 */
export class WorkspaceRecycler {
  private pending = new Set<string>();
  constructor(private ctx: ManagementContext) {}

  /** Runs or live background tasks (the application's close would kill them). */
  private busy(id: string): boolean {
    return this.ctx.scheduler.busyWorkspace(id) || !!this.ctx.tasksLive?.(id);
  }

  /** Recycles now when idle; otherwise once the workspace's runs and tasks finish. */
  async request(id: string): Promise<OpenWorkspace | undefined> {
    if (this.busy(id)) {
      this.pending.add(id);
      return undefined;
    }
    this.pending.delete(id);
    const reopened = await this.ctx.workspaces.recycle(id);
    this.announce(id, ["plugins", "commands", "skills", "agents", "mcp"]);
    return reopened;
  }

  /** Called when a run finishes: applies a deferred recycle once nothing runs. */
  idle(id: string): void {
    if (!this.pending.has(id) || this.busy(id)) return;
    void this.request(id).catch(() => {});
  }

  announce(workspaceId: string, scopes: CatalogScope[]): void {
    for (const scope of scopes) this.ctx.broadcast({ t: "catalog_changed", workspaceId, scope });
  }

  /**
   * `/reload`: refused while the workspace has runs (409 `runs_active`); otherwise validates the
   * configuration, builds the new app next to the current one and swaps (a broken configuration
   * leaves the workspace untouched). Every catalog is announced so open palettes refresh.
   */
  async reload(id: string): Promise<ReloadReport> {
    const { workspaces, scheduler } = this.ctx;
    if (!(await workspaces.pathOf(id))) throw new HttpError("not_found", "Workspace not found");
    const busy = () =>
      scheduler.busyWorkspace(id)
        ? "Reload is only available between turns: wait for the current turn to finish."
        : this.ctx.tasksLive?.(id)
          ? "Reload would stop the running background tasks: stop them or wait for them to finish, then reload."
          : undefined;
    const reason = busy();
    if (reason) throw new HttpError("runs_active", reason);
    this.pending.delete(id);
    if (!workspaces.get(id)) {
      // Nothing is loaded for this workspace yet: opening it reads the current configuration.
      const path = (await workspaces.pathOf(id)) as string;
      await workspaces.openPath(path);
      this.announce(id, RELOAD_SCOPES);
      return {
        refreshed: [],
        restartRequired: [],
        warnings: ["The workspace was not open: it was opened with the current configuration."],
      };
    }
    const report = await workspaces.reload(id, { busy });
    this.announce(id, RELOAD_SCOPES);
    return report;
  }
}

const RELOAD_SCOPES: CatalogScope[] = ["commands", "plugins", "skills", "agents", "mcp", "models"];

function pluginInfo(opened: OpenWorkspace, entry: PluginCatalogEntry): PluginInfo {
  const prefix = pluginPrefix(entry.id);
  const tools = opened.app.plugins
    .toolsOf(entry.id)
    .map((name) => (name.startsWith(`${prefix}_`) ? name.slice(prefix.length + 1) : name))
    .sort();
  const commands = new CommandCatalog(opened.app as ConstructorParameters<typeof CommandCatalog>[0])
    .list()
    .filter((c) => c.source === "plugin" && c.owner === entry.id)
    .map((c) => c.name)
    .sort();
  const untrusted = !opened.trusted && entry.manageable;
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    ...(entry.version ? { version: entry.version } : {}),
    categories: [...entry.categories],
    builtin: entry.builtin,
    source: entry.source,
    status: entry.status,
    enabled: entry.enabled,
    manageable: entry.manageable && !untrusted,
    ...(untrusted
      ? { diagnostic: UNTRUSTED }
      : entry.diagnostic
        ? { diagnostic: entry.diagnostic }
        : {}),
    tools,
    commands,
    toolPrefix: prefix,
  };
}

function skillInfo(skill: ReturnType<OpenWorkspace["app"]["skillCatalog"]>[number]): SkillInfo {
  return {
    id: skill.id,
    name: skill.name,
    displayId: skill.displayId,
    description: skill.description,
    scope: skill.scope,
    source: skill.source,
    ...(skill.owner ? { owner: { id: skill.owner.id, name: skill.owner.name } } : {}),
    manageable: skill.manageable,
    locked: skill.locked,
    enabled: skill.enabled,
    effective: skill.effective,
    ...(skill.shadowedBy ? { shadowedBy: skill.shadowedBy } : {}),
    approximateTokens: skill.approximateTokens,
  };
}

/** MCP server status without the command line, arguments or URL (they may carry tokens). */
function mcpWire(info: McpServerInfo): McpServerWire {
  return {
    name: info.name,
    displayName: info.displayName,
    source: info.source.kind,
    status: info.status,
    enabled: info.enabled,
    transport: info.transport,
    capabilities: [...info.capabilities],
    counts: { ...info.counts },
    ...(info.diagnostic ? { diagnostic: info.diagnostic } : {}),
  };
}

function mcpOverview(opened: OpenWorkspace): McpOverview {
  return {
    permission: opened.app.mcpRuntimePermission(),
    persisted: opened.app.mcpAllowPersisted(),
    servers: opened.app.mcp.list().map(mcpWire),
  };
}

/** The current value of a `section.leaf` or `section.group.leaf` key of the loaded config. */
function settingValue(config: unknown, key: string): SettingInfo["value"] {
  let value: unknown = config;
  for (const part of key.split("."))
    value =
      value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

export function registerManagementRoutes(
  router: Router,
  ctx: ManagementContext,
  recycler: WorkspaceRecycler,
): void {
  const open = (reference: string | null | undefined) => workspaceApp(ctx.workspaces, reference);

  // ---- Plugins ------------------------------------------------------------------------------
  router.get("/api/plugins", async ({ url }) => {
    const opened = await open(url.searchParams.get("workspace"));
    return { body: opened.app.pluginCatalog().map((entry) => pluginInfo(opened, entry)) };
  });

  router.patch("/api/plugins/:id", async ({ req, url, params }) => {
    const input = validate<{ enabled: boolean; workspace?: string }>(await readJson(req), {
      enabled: { check: is.boolean(), required: true },
      workspace: { check: is.nonEmpty(4096) },
    });
    let opened = await open(input.workspace ?? url.searchParams.get("workspace"));
    const id = params.id ?? "";
    const entry = opened.app.pluginCatalog().find((p) => p.id === id);
    if (!entry) throw new HttpError("not_found", "Plugin not found");
    const info = pluginInfo(opened, entry);
    if (!info.manageable)
      throw new HttpError(
        "not_manageable",
        info.diagnostic ?? "This plugin cannot be managed here",
      );
    let updated: PluginCatalogEntry;
    try {
      updated = await opened.app.setPluginEnabled(id, input.enabled);
    } catch (error) {
      throw new HttpError("validation_failed", message(error), { fields: ["enabled"] });
    }
    if (updated.status === "restart-required") {
      const reopened = await recycler.request(opened.id);
      if (reopened) opened = reopened;
    }
    recycler.announce(opened.id, ["plugins", "commands"]);
    const current = opened.app.pluginCatalog().find((p) => p.id === id) ?? updated;
    return { body: pluginInfo(opened, current) };
  });

  // ---- Skills -------------------------------------------------------------------------------
  router.get("/api/skills", async ({ url }) => {
    const opened = await open(url.searchParams.get("workspace"));
    return { body: opened.app.skillCatalog().map(skillInfo) };
  });

  router.patch("/api/skills/:id", async ({ req, url, params }) => {
    const input = validate<{ enabled: boolean; workspace?: string }>(await readJson(req), {
      enabled: { check: is.boolean(), required: true },
      workspace: { check: is.nonEmpty(4096) },
    });
    const opened = await open(input.workspace ?? url.searchParams.get("workspace"));
    const id = params.id ?? "";
    const skill = opened.app.skillCatalog().find((s) => s.id === id && s.effective);
    if (!skill) throw new HttpError("not_found", "Skill not found");
    if (!skill.manageable || skill.locked)
      throw new HttpError("not_manageable", "This skill is locked by its plugin");
    try {
      await opened.app.setSkillEnabled(id, input.enabled);
    } catch (error) {
      const text = message(error);
      if (/trust/i.test(text)) throw new HttpError("not_manageable", text);
      throw new HttpError("validation_failed", text, { fields: ["enabled"] });
    }
    recycler.announce(opened.id, ["skills", "commands"]);
    const current = opened.app.skillCatalog().find((s) => s.id === id && s.effective) ?? skill;
    return { body: skillInfo(current) };
  });

  // ---- MCP ----------------------------------------------------------------------------------
  router.get("/api/mcp", async ({ url }) => {
    const opened = await open(url.searchParams.get("workspace"));
    return { body: mcpOverview(opened) };
  });

  router.patch("/api/mcp/:name", async ({ req, url, params }) => {
    const input = validate<{ enabled: boolean; connect?: boolean; workspace?: string }>(
      await readJson(req),
      {
        enabled: { check: is.boolean(), required: true },
        connect: { check: is.boolean() },
        workspace: { check: is.nonEmpty(4096) },
      },
    );
    const opened = await open(input.workspace ?? url.searchParams.get("workspace"));
    const name = params.name ?? "";
    if (!opened.app.config.mcpSources[name])
      throw new HttpError("not_found", "MCP server not found");
    if (ctx.base.readOnly)
      throw new HttpError("mcp_not_permitted", "MCP changes are unavailable under --read-only");
    const connect = !!input.connect && input.enabled;
    if (connect && opened.app.mcpRuntimePermission() !== "granted")
      throw new HttpError(
        "mcp_not_permitted",
        "Grant MCP access for this workspace first (MCP servers run with your user privileges)",
      );
    try {
      await opened.app.setMcpEnabled(name, input.enabled, connect);
    } catch {
      // A failed connection is reported through the server's status and diagnostic.
    }
    recycler.announce(opened.id, ["mcp"]);
    return { body: mcpWire(opened.app.mcp.info(name)) };
  });

  router.post("/api/mcp/consent", async ({ req }) => {
    const input = validate<{ workspace: string; confirmed: boolean; remember?: boolean }>(
      await readJson(req),
      {
        workspace: { check: is.nonEmpty(4096), required: true },
        // Explicit confirmation is required: the UI shows what MCP access means first.
        confirmed: { check: (v) => v === true, required: true },
        remember: { check: is.boolean() },
      },
    );
    const opened = await open(input.workspace);
    if (ctx.base.readOnly)
      throw new HttpError("mcp_not_permitted", "MCP is unavailable under --read-only");
    try {
      if (input.remember) await opened.app.rememberGlobalMcpConsent("interactive-web");
      else opened.app.grantMcpRuntimePermission({ source: "interactive-web", confirmed: true });
    } catch (error) {
      throw new HttpError("mcp_not_permitted", message(error));
    }
    recycler.announce(opened.id, ["mcp"]);
    return { body: mcpOverview(opened) };
  });

  // ---- Agent presets ------------------------------------------------------------------------
  router.get("/api/agents", async ({ url }) => {
    const opened = await open(url.searchParams.get("workspace"));
    let state: unknown;
    try {
      state = opened.app.plugins.pluginState("subagents", "mainAgents");
    } catch {
      /* contributions are best-effort */
    }
    // Stable order (build, plan, then the rest by name): the web cycles this array.
    const agents = cycleableAgents(agentCatalogFromState(state));
    const fallback = resolveActiveAgent(agents, opened.app.config.agents.active).id;
    return {
      body: agents.map(
        (agent): AgentInfo => ({
          id: agent.id,
          name: agent.name,
          description: agent.description,
          ...(agent.instructions ? { instructions: agent.instructions } : {}),
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.readOnly ? { readOnly: true } : {}),
          source: agent.source,
          default: agent.id === fallback,
        }),
      ),
    };
  });

  // ---- Reload ------------------------------------------------------------------------------
  router.post("/api/workspaces/:wid/reload", async ({ params }) => ({
    body: await recycler.reload(params.wid ?? ""),
  }));

  // ---- Workspace trust ----------------------------------------------------------------------
  /**
   * Grants (or withdraws) project trust from the web: the same persisted, per-directory decision
   * the terminal prompt stores (`trust.json`, bound to the `.alisio/config.json` hash), so a
   * changed config file is never trusted silently. Trust lets the workspace load its project
   * config, plugins (executable code), agents, skills and prompts; the request must carry an
   * explicit confirmation. The workspace application is reopened so the decision applies now.
   */
  router.post("/api/workspaces/:wid/trust", async ({ req, params }) => {
    const input = validate<{ trusted: boolean; confirmed: boolean }>(await readJson(req), {
      trusted: { check: is.boolean(), required: true },
      confirmed: { check: (v) => v === true, required: true },
    });
    if (ctx.base.readOnly)
      throw new HttpError("capability_ceiling", "Trust changes are unavailable under --read-only");
    if (ctx.base.trustProject || ctx.base.config)
      throw new HttpError(
        "not_manageable",
        "Trust is fixed for this server by --trust-project/--config",
      );
    const id = params.wid ?? "";
    const path = await ctx.workspaces.pathOf(id);
    if (!path) throw new HttpError("not_found", "Workspace not found");
    if (ctx.scheduler.busyWorkspace(id))
      throw new HttpError("runs_active", "Wait for the workspace's runs to finish, then retry");
    await setTrust(path, input.trusted, await hashProjectConfig(path));
    if (ctx.workspaces.get(id)) await recycler.request(id);
    else recycler.announce(id, ["plugins", "commands", "skills", "agents", "mcp"]);
    return { body: await ctx.workspaces.info(path) };
  });

  // ---- Settings -----------------------------------------------------------------------------
  router.get("/api/settings", async ({ url }) => {
    const opened = await open(url.searchParams.get("workspace"));
    const base = ctx.base;
    const body: SettingsOverview = {
      configPath: configFile(
        opened.path,
        base.config ? { file: base.config } : { trustProject: opened.trusted },
      ),
      settingsPath: join(configHome(), "config.json"),
      providersPath: opened.app.providerSettings.profilesPath,
      trusted: opened.trusted,
      readOnly: !!base.readOnly,
      settings: settableSettings().map((setting) => {
        const value = settingValue(opened.app.config, setting.key);
        return {
          key: setting.key,
          kind: setting.kind,
          ...(setting.options ? { options: setting.options } : {}),
          ...(value !== undefined ? { value } : {}),
        };
      }),
    };
    return { body };
  });

  // Settings → Data analysis: the runtime state, read only (probes Python once, the container
  // engine only when it is the configured mode).
  router.get("/api/analysis", async ({ url }) => {
    const opened = await open(url.searchParams.get("workspace"));
    const { app } = opened;
    const body: AnalysisStatus = await analysisStatus({
      config: app.config.analysis,
      runtime: app.analysis.runtime,
      oci: () => app.analysis.oci.runtime(),
      janitor: app.analysis.janitor,
      enabled: app.analysis.enabled,
      readOnly: !!ctx.base.readOnly,
    });
    return { body };
  });

  router.patch("/api/settings", async ({ req }) => {
    const input = validate<{ workspace: string; key: string; value: unknown }>(
      await readJson(req),
      {
        workspace: { check: is.nonEmpty(4096), required: true },
        key: { check: (v) => typeof v === "string" && isSettableSettingKey(v), required: true },
        value: {
          check: (v) =>
            v === null ||
            typeof v === "boolean" ||
            (typeof v === "number" && Number.isFinite(v)) ||
            (typeof v === "string" && v.length <= 1_000),
          required: true,
        },
      },
    );
    const opened = await open(input.workspace);
    if (ctx.base.readOnly)
      throw new HttpError(
        "capability_ceiling",
        "Settings changes are unavailable under --read-only",
      );
    const key = input.key as Parameters<typeof opened.app.updateSetting>[0];
    try {
      await opened.app.updateSetting(key, input.value === null ? undefined : input.value);
    } catch (error) {
      throw new HttpError("validation_failed", message(error), { fields: ["value"] });
    }
    if (key.startsWith("agents.")) recycler.announce(opened.id, ["agents"]);
    // Analysis tools are registered when the workspace application starts: rebuild it (after its
    // runs) so `analysis.enabled` applies without restarting the server.
    if (key === "analysis.enabled" || key === "analysis.smartDashboard" || key === "tasks.enabled")
      void recycler.request(opened.id).catch(() => undefined);
    return { body: { message: `Saved ${key}` } };
  });
}
