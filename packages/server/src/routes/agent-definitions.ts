/**
 * User agent definitions (the web Agents window): CRUD over the `.agents/agents` Markdown files of
 * a workspace (project scope) and of the user (`~/.agents/agents`, global scope), the shared
 * templates, the configured models with their capabilities, and drafts written by the active
 * model. Every write hot-reloads the agent registry of each open workspace application and
 * broadcasts `catalog_changed` (`agents`) so open clients refresh; the answer's `live` says
 * whether the running server already uses the change.
 */
import { homedir } from "node:os";
import {
  AGENT_DRAFT_MAX_DESCRIPTION,
  AGENT_TEMPLATES,
  AgentDefinitionService,
  AgentNotFoundError,
  agentAuthoringGuidance,
  agentModelCapabilities,
  agentModelLabels,
  agentModelOptions,
  generateAgentDraft,
  resolveTrust,
  validateAgentDefinitionInput,
} from "@alisio/core";
import type {
  AgentDefinitionsOverview,
  AgentModelOption,
  AgentSaveResult,
  AgentScope,
} from "@alisio/sdk";
import type { OpenWorkspace } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";
import { type ManagementContext, type WorkspaceRecycler, workspaceApp } from "./management.ts";

const SCOPES: AgentScope[] = ["project", "global"];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerAgentDefinitionRoutes(
  router: Router,
  ctx: ManagementContext,
  recycler: WorkspaceRecycler,
): void {
  /** The workspace application named by `reference`, or undefined (global scope only). */
  const target = async (reference: string | null | undefined) =>
    reference ? workspaceApp(ctx.workspaces, reference) : undefined;
  const serviceOf = (opened: OpenWorkspace | undefined) =>
    opened?.app.agentDefinitions ?? new AgentDefinitionService({ home: homedir() });
  const scopeOf = (value: unknown, service: AgentDefinitionService): AgentScope => {
    if (value === undefined || value === null || value === "") return service.defaultScope;
    if (!SCOPES.includes(value as AgentScope))
      throw new HttpError("validation_failed", "scope must be project or global", {
        fields: ["scope"],
      });
    if (!service.scopes.includes(value as AgentScope))
      throw new HttpError("validation_failed", "The project scope needs a workspace", {
        fields: ["scope", "workspace"],
      });
    return value as AgentScope;
  };
  const writable = () => {
    if (ctx.base.readOnly)
      throw new HttpError("capability_ceiling", "Agent changes are unavailable under --read-only");
  };
  const definition = (raw: unknown) => {
    const result = validateAgentDefinitionInput(raw);
    if (!result.ok)
      throw new HttpError("validation_failed", result.errors.map((e) => e.message).join("; "), {
        fields: result.errors.map((e) => e.field),
      });
    return result.value;
  };
  /**
   * After a write: every other open application rediscovers its agents, then the writing one
   * again (the registry's published state is shared, so the writer's view is restored last), and
   * every client hears `catalog_changed`. Without a writing application (no workspace named),
   * the change is live when any open application loaded `path`.
   */
  const propagate = async (
    writer: OpenWorkspace | undefined,
    path: string,
    expectLoaded: boolean,
  ) => {
    const others = ctx.workspaces.entries().filter((entry) => entry !== writer);
    let loadedElsewhere = false;
    for (const other of others) {
      const reloaded = await other.app.agentDefinitions.reload();
      if (reloaded && other.app.agentDefinitions.isLoaded(path) === expectLoaded)
        loadedElsewhere = true;
    }
    if (writer) await writer.app.agentDefinitions.reload();
    for (const entry of ctx.workspaces.entries())
      ctx.broadcast({ t: "catalog_changed", workspaceId: entry.id, scope: "agents" });
    return loadedElsewhere;
  };
  /**
   * A workspace opened untrusted only because it had no project resources yet becomes trusted
   * once its first project agent exists (when the user trusted it before): reopen it so the
   * registry loads the file. Busy workspaces are reopened when their runs finish.
   */
  const refreshTrust = async (opened: OpenWorkspace | undefined, scope: AgentScope) => {
    if (!opened || opened.trusted || scope !== "project") return opened;
    const trust = await resolveTrust(opened.path).catch(() => undefined);
    if (!trust?.trusted) {
      // It now has project resources waiting for a trust decision (the sidebar shows it).
      opened.untrustedResources = true;
      return opened;
    }
    return (await recycler.request(opened.id)) ?? opened;
  };
  /** `live` on the (possibly reopened) writer: reload, then check the file is loaded. */
  const liveOn = async (writer: OpenWorkspace | undefined, path: string, loaded: boolean) => {
    if (!writer) return false;
    return (
      (await writer.app.agentDefinitions.reload()) &&
      writer.app.agentDefinitions.isLoaded(path) === loaded
    );
  };
  const notFound = (error: unknown): never => {
    if (error instanceof AgentNotFoundError) throw new HttpError("not_found", "Agent not found");
    throw error;
  };

  router.get("/api/agents/templates", () => ({ body: AGENT_TEMPLATES }));

  router.get("/api/agents/definitions", async ({ url }) => {
    const opened = await target(url.searchParams.get("workspace"));
    const service = serviceOf(opened);
    // Opening the list also picks up files edited outside Alisio (no file watcher).
    await service.reload();
    const body: AgentDefinitionsOverview = {
      agents: await service.list(),
      scopes: service.scopes,
      defaultScope: service.defaultScope,
      dirs: Object.fromEntries(service.scopes.map((scope) => [scope, service.dir(scope)])),
      trusted: opened?.trusted ?? false,
    };
    return { body };
  });

  router.get("/api/agents/models", async ({ url }) => {
    const opened = await workspaceApp(ctx.workspaces, url.searchParams.get("workspace"));
    const app = opened.app;
    const active = {
      ...(app.providerInfo?.profileName ? { profile: app.providerInfo.profileName } : {}),
      ...(app.providerInfo?.id ? { provider: app.providerInfo.id } : {}),
      model: app.provider.model,
    };
    let options: AgentModelOption[] = [];
    try {
      options = agentModelOptions(
        await app.listAvailableModels(AbortSignal.timeout(15_000)),
        active,
      );
    } catch {
      /* configured catalogs unavailable: offer the running model only */
    }
    if (!options.some((option) => option.active) && app.provider.model) {
      let info: Parameters<typeof agentModelCapabilities>[0] = { id: app.provider.model };
      try {
        info =
          (await app.loadModels(AbortSignal.timeout(10_000))).find(
            (m) => m.id === app.provider.model,
          ) ?? info;
      } catch {
        /* the active provider cannot list models */
      }
      const capabilities = agentModelCapabilities(info);
      options.unshift({
        reference: app.provider.model,
        provider: app.provider.id,
        profile: app.providerInfo?.profileName ?? "",
        providerName: app.providers.get(app.providerInfo?.id ?? "")?.name ?? app.provider.id,
        id: app.provider.model,
        ...(info.name ? { name: info.name } : {}),
        active: true,
        capabilities,
        labels: agentModelLabels(capabilities),
      });
    }
    return { body: options };
  });

  router.post("/api/agents/draft", async ({ req, res }) => {
    const input = validate<{
      workspace: string;
      description?: string;
      base?: { name?: string; description?: string; instructions?: string };
    }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096), required: true },
      description: { check: is.string(AGENT_DRAFT_MAX_DESCRIPTION) },
      base: {
        check: (v) =>
          is.object()(v) &&
          ["name", "description", "instructions"].every(
            (key) =>
              (v as Record<string, unknown>)[key] === undefined ||
              (typeof (v as Record<string, unknown>)[key] === "string" &&
                ((v as Record<string, string>)[key] ?? "").length <= 24_000),
          ),
      },
    });
    if (!input.description?.trim() && !input.base?.instructions?.trim())
      throw new HttpError("validation_failed", "Describe the agent you want first", {
        fields: ["description"],
      });
    const opened = await workspaceApp(ctx.workspaces, input.workspace);
    // The client's Cancel closes the request: abort the model call with it.
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) controller.abort(new Error("Cancelled"));
    });
    try {
      return {
        body: await generateAgentDraft(opened.app.provider, input.description ?? "", {
          signal: controller.signal,
          guidance: await agentAuthoringGuidance(opened.app.skills),
          ...(input.base ? { base: input.base } : {}),
        }),
      };
    } catch (error) {
      throw new HttpError("provider_unavailable", `Draft failed: ${message(error)}`);
    }
  });

  router.post("/api/agents", async ({ req }) => {
    writable();
    const raw = (await readJson(req)) as Record<string, unknown>;
    const opened = await target(typeof raw?.workspace === "string" ? raw.workspace : undefined);
    const service = serviceOf(opened);
    const scope = scopeOf(raw?.scope, service);
    const saved = await service.create(scope, definition(raw));
    const writer = await refreshTrust(opened, scope);
    const reopened = writer !== opened && (await liveOn(writer, saved.result.path, true));
    const elsewhere = await propagate(writer, saved.result.path, true);
    const body: AgentSaveResult = {
      agent: saved.result,
      live: saved.live || reopened || elsewhere,
    };
    return { status: 201, body };
  });

  router.get("/api/agents/:id", async ({ url, params }) => {
    const service = serviceOf(await target(url.searchParams.get("workspace")));
    const scope = scopeOf(url.searchParams.get("scope"), service);
    const found = await service.get(scope, params.id ?? "");
    if (!found) throw new HttpError("not_found", "Agent not found");
    return { body: found };
  });

  router.put("/api/agents/:id", async ({ req, params }) => {
    writable();
    const raw = (await readJson(req)) as Record<string, unknown>;
    const opened = await target(typeof raw?.workspace === "string" ? raw.workspace : undefined);
    const service = serviceOf(opened);
    const scope = scopeOf(raw?.scope, service);
    const saved = await service.update(scope, params.id ?? "", definition(raw)).catch(notFound);
    const writer = await refreshTrust(opened, scope);
    const reopened = writer !== opened && (await liveOn(writer, saved.result.path, true));
    const elsewhere = await propagate(writer, saved.result.path, true);
    const body: AgentSaveResult = {
      agent: saved.result,
      live: saved.live || reopened || elsewhere,
    };
    return { body };
  });

  router.delete("/api/agents/:id", async ({ url, params }) => {
    writable();
    const opened = await target(url.searchParams.get("workspace"));
    const service = serviceOf(opened);
    const scope = scopeOf(url.searchParams.get("scope"), service);
    const existing = await service.get(scope, params.id ?? "");
    if (!existing) throw new HttpError("not_found", "Agent not found");
    const removed = await service.delete(scope, existing.id).catch(notFound);
    const elsewhere = await propagate(opened, existing.path, false);
    return { body: { deleted: removed.result, live: removed.live || elsewhere } };
  });
}
