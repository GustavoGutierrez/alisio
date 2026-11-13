/**
 * MCP install routes (specs/030 phase 3): plans, install jobs, cancellation, the consent step,
 * uninstall by scope and the connection test of one integration. Every route resolves its
 * workspace from a SERVER-KNOWN workspace (an opaque id, or the path of a registered one): the
 * client never names a configuration file, and a directory the server does not know is a 404.
 * Answers carry no command, argument, URL, path or secret: only what `McpInstallPlan`,
 * `McpInstallJob` and `McpServerWire` declare.
 */
import { isAbsolute } from "node:path";
import {
  type InstallJobView,
  type JobHooks,
  McpConfigError,
  McpInstallError,
  type McpInstaller,
  mcpConfigFile,
} from "@alisio/core";
import type { McpInstallJob, McpInstallPlan, McpUninstallResult } from "@alisio/sdk";
import type { OpenWorkspace } from "../host/workspace-host.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";
import type { ManagementContext, WorkspaceRecycler } from "./management.ts";
import { mcpWire } from "./management.ts";

export interface McpInstallContext {
  installer: McpInstaller;
  management: ManagementContext;
  recycler: WorkspaceRecycler;
  readOnly?: boolean;
}

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Hand-checked answers object: string values only, bounded count and size. */
const inputsCheck = (v: unknown): boolean =>
  record(v) &&
  Object.keys(v).length <= 64 &&
  Object.entries(v).every(([k, x]) => k.length <= 200 && typeof x === "string" && x.length <= 8192);

const consentCheck = (v: unknown): boolean =>
  record(v) &&
  v.confirmed === true &&
  (v.remember === undefined || typeof v.remember === "boolean") &&
  Object.keys(v).every((k) => k === "confirmed" || k === "remember");

/** An installer refusal as the API error the SDK documents. */
function toHttp(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof McpInstallError) {
    const details = {
      ...(error.extra.reason ? { reason: error.extra.reason } : {}),
      ...(error.extra.fields ? { fields: error.extra.fields } : {}),
      ...(error.extra.choices ? { choices: error.extra.choices } : {}),
    };
    throw new HttpError(
      error.code === "mcp_install_failed" ? "internal" : error.code,
      error.message,
      Object.keys(details).length ? details : undefined,
    );
  }
  if (error instanceof McpConfigError)
    throw new HttpError(
      error.code === "mcp_config_invalid" ? "validation_failed" : error.code,
      error.message,
    );
  throw error;
}

export function registerMcpInstallRoutes(router: Router, ctx: McpInstallContext): void {
  const { installer, management, recycler } = ctx;
  const { workspaces } = management;

  const refuseReadOnly = () => {
    if (ctx.readOnly || management.base.readOnly)
      throw new HttpError("mcp_not_permitted", "MCP changes are unavailable under --read-only");
  };

  /** A workspace the server itself knows (never an arbitrary directory), opened. */
  async function known(reference: string): Promise<OpenWorkspace> {
    let path: string | undefined;
    if (isAbsolute(reference)) {
      const canonical = await workspaces.canonical(reference);
      path = (await workspaces.list()).some((w) => w.path === canonical) ? canonical : undefined;
    } else path = await workspaces.pathOf(reference);
    if (!path) throw new HttpError("not_found", "Workspace not found");
    return workspaces.openPath(path);
  }

  const live = (opened: OpenWorkspace) => workspaces.get(opened.id)?.app ?? opened.app;

  /** What a job does to this workspace's live application. */
  function hooksFor(opened: OpenWorkspace): JobHooks {
    return {
      runtimePermission: () => live(opened).mcpRuntimePermission(),
      async attach(name, entry, context) {
        await live(opened).mcpAttach(name, entry, {
          kind: context.scope,
          file: mcpConfigFile(
            context.scope === "global"
              ? { scope: "global" }
              : { scope: "project", workspace: context.workspacePath ?? opened.path },
          ),
          form: "canonical",
        });
      },
      detach: (name) => live(opened).mcpDetach(name),
      async connect(name, signal) {
        const app = live(opened);
        await app.mcp.connect(name, signal).catch(() => undefined);
        const info = app.mcp.info(name);
        return {
          status:
            info.status === "connected"
              ? "connected"
              : info.status === "needs-authentication"
                ? "needs-authentication"
                : "failed",
          ...(info.diagnostic ? { diagnostic: info.diagnostic } : {}),
          capabilities: info.capabilities,
          counts: info.counts,
        };
      },
      done(job: InstallJobView) {
        if (job.state === "completed" && job.scope === "global")
          void recycler.requestOthers(opened.id);
        recycler.announce(opened.id, ["mcp"]);
      },
    };
  }

  /** Consent is granted through the app's own methods, never preselected as permanent. */
  async function grant(
    opened: OpenWorkspace,
    consent: { confirmed: true; remember?: boolean } | undefined,
  ): Promise<void> {
    if (!consent) return;
    const app = live(opened);
    try {
      if (consent.remember) await app.rememberGlobalMcpConsent("interactive-web");
      else app.grantMcpRuntimePermission({ source: "interactive-web", confirmed: true });
    } catch (error) {
      throw new HttpError(
        "mcp_not_permitted",
        error instanceof Error ? error.message : "MCP access could not be granted",
      );
    }
  }

  router.post("/api/mcp/install/plans", async ({ req }) => {
    const input = validate<{
      workspace: string;
      name: string;
      version?: string;
      scope: "global" | "project";
      alias?: string;
      method?: "npm" | "remote";
      bin?: string;
    }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096), required: true },
      name: { check: is.nonEmpty(300), required: true },
      version: { check: is.nonEmpty(128) },
      scope: { check: (v) => v === "global" || v === "project", required: true },
      alias: { check: (v) => typeof v === "string" && ALIAS.test(v) },
      method: { check: (v) => v === "npm" || v === "remote" },
      bin: { check: is.nonEmpty(128) },
    });
    refuseReadOnly();
    const opened = await known(input.workspace);
    const app = live(opened);
    try {
      const plan: McpInstallPlan = await installer.plan({
        name: input.name,
        ...(input.version ? { version: input.version } : {}),
        scope: input.scope,
        ...(input.scope === "project"
          ? {
              workspace: {
                path: opened.path,
                ...(app.mcpWriteContext().sessionTrusted ? { sessionTrusted: true } : {}),
              },
            }
          : {}),
        ...(input.alias ? { alias: input.alias } : {}),
        ...(input.method ? { method: input.method } : {}),
        ...(input.bin ? { bin: input.bin } : {}),
        runtimePermission: app.mcpRuntimePermission(),
      });
      return { body: plan };
    } catch (error) {
      return toHttp(error);
    }
  });

  router.post("/api/mcp/bindings/:id/update-plan", async ({ req, params }) => {
    const input = validate<{ workspace: string; version?: string }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096), required: true },
      version: { check: is.nonEmpty(128) },
    });
    refuseReadOnly();
    const opened = await known(input.workspace);
    const app = live(opened);
    try {
      const plan: McpInstallPlan = await installer.planUpdate(params.id ?? "", {
        workspace: { path: opened.path, sessionTrusted: app.mcpWriteContext().sessionTrusted },
        ...(input.version ? { version: input.version } : {}),
        runtimePermission: app.mcpRuntimePermission(),
      });
      return { body: plan };
    } catch (error) {
      return toHttp(error);
    }
  });

  router.post("/api/mcp/install/jobs", async ({ req }) => {
    const input = validate<{
      workspace: string;
      planId: string;
      digest: string;
      idempotencyKey: string;
      inputs?: Record<string, string>;
      consent?: { confirmed: true; remember?: boolean };
    }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096), required: true },
      planId: { check: is.nonEmpty(100), required: true },
      digest: { check: is.nonEmpty(128), required: true },
      idempotencyKey: { check: is.nonEmpty(128), required: true },
      inputs: { check: inputsCheck },
      consent: { check: consentCheck },
    });
    refuseReadOnly();
    const opened = await known(input.workspace);
    try {
      await grant(opened, input.consent);
      const job: McpInstallJob = await installer.start({
        planId: input.planId,
        digest: input.digest,
        idempotencyKey: input.idempotencyKey,
        inputs: input.inputs ?? {},
        hooks: hooksFor(opened),
      });
      return { status: 202, body: job };
    } catch (error) {
      return toHttp(error);
    }
  });

  router.get("/api/mcp/install/jobs/:id", ({ params }) => {
    const job: McpInstallJob | undefined = installer.job(params.id ?? "");
    if (!job) throw new HttpError("not_found", "Install job not found");
    return { body: job };
  });

  router.post("/api/mcp/install/jobs/:id/consent", async ({ req, params }) => {
    const input = validate<{ workspace: string; confirmed: boolean; remember?: boolean }>(
      await readJson(req),
      {
        workspace: { check: is.nonEmpty(4096), required: true },
        confirmed: { check: (v) => v === true, required: true },
        remember: { check: is.boolean() },
      },
    );
    refuseReadOnly();
    const opened = await known(input.workspace);
    try {
      await grant(opened, {
        confirmed: true,
        ...(input.remember ? { remember: true } : {}),
      });
      return { body: installer.provideConsent(params.id ?? "") satisfies McpInstallJob };
    } catch (error) {
      return toHttp(error);
    }
  });

  router.post("/api/mcp/install/jobs/:id/cancel", async ({ req, params }) => {
    validate(await readJson(req), { workspace: { check: is.nonEmpty(4096) } });
    refuseReadOnly();
    const job = await installer.cancel(params.id ?? "");
    if (!job) throw new HttpError("not_found", "Install job not found");
    return { body: job satisfies McpInstallJob };
  });

  router.delete("/api/mcp/bindings/:id", async ({ url, params }) => {
    refuseReadOnly();
    const workspace = url.searchParams.get("workspace");
    const scope = url.searchParams.get("scope");
    const removeSecrets = url.searchParams.get("removeSecrets");
    const revision = url.searchParams.get("revision");
    const invalid: string[] = [];
    if (!workspace || workspace.length > 4096) invalid.push("workspace");
    if (scope !== "global" && scope !== "project") invalid.push("scope");
    if (removeSecrets !== null && removeSecrets !== "true" && removeSecrets !== "false")
      invalid.push("removeSecrets");
    if (revision !== null && !/^[0-9a-f]{64}$|^absent$/.test(revision)) invalid.push("revision");
    if (invalid.length)
      throw new HttpError("validation_failed", "Invalid query", { fields: invalid });
    const opened = await known(workspace as string);
    const app = live(opened);
    try {
      const result: McpUninstallResult = await installer.uninstall({
        bindingId: params.id ?? "",
        scope: scope as "global" | "project",
        workspacePath: opened.path,
        sessionTrusted: app.mcpWriteContext().sessionTrusted,
        removeSecrets: removeSecrets === "true",
        ...(revision ? { expectedRevision: revision } : {}),
        hooks: { detach: (name) => live(opened).mcpDetach(name) },
      });
      if (scope === "global") await recycler.requestOthers(opened.id);
      recycler.announce(opened.id, ["mcp"]);
      return { body: result };
    } catch (error) {
      return toHttp(error);
    }
  });

  router.post("/api/mcp/bindings/:id/test", async ({ req, params }) => {
    const input = validate<{ workspace: string }>(await readJson(req), {
      workspace: { check: is.nonEmpty(4096), required: true },
    });
    refuseReadOnly();
    const opened = await known(input.workspace);
    const app = live(opened);
    const binding = installer.binding(params.id ?? "");
    if (
      !binding ||
      (binding.scope === "project" && binding.workspacePath !== opened.path) ||
      !app.config.mcpSources[binding.alias]
    )
      throw new HttpError("not_found", "MCP binding not found");
    if (app.mcpRuntimePermission() !== "granted")
      throw new HttpError(
        "mcp_not_permitted",
        "Grant MCP access for this workspace first (MCP servers run with your user privileges)",
      );
    const before = app.mcp.info(binding.alias);
    // A test never switches a disabled server on and never drops a connection that works.
    if (before.enabled && before.status !== "connected")
      await app.mcp.connect(binding.alias, AbortSignal.timeout(30_000)).catch(() => undefined);
    const info = app.mcp.info(binding.alias);
    installer.recordTest(binding.id, {
      status:
        info.status === "connected"
          ? "passed"
          : info.status === "needs-authentication"
            ? "needs-authentication"
            : "failed",
      at: new Date().toISOString(),
      ...(!info.enabled
        ? { diagnostic: "Turn the integration on to test it" }
        : info.diagnostic
          ? { diagnostic: info.diagnostic }
          : {}),
      counts: info.counts,
      capabilities: info.capabilities,
    });
    recycler.announce(opened.id, ["mcp"]);
    return {
      body: mcpWire(
        info,
        app.config.mcpShadowed?.[binding.alias],
        installer.bindings(),
        opened.path,
      ),
    };
  });
}
