/**
 * Plugin creator routes (`/api/plugin-creator/*`): projects built by the creator agent from a
 * plain-language request, their files, the build (validate + tests + package), the package
 * download and the install, which reuses the local-file install job and lock of the plugin
 * catalog. Installing needs an explicit `confirmed: true`. Every mutation is refused under
 * `--read-only`. Building runs the project's code with the user's privileges (not a sandbox).
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  PLUGIN_CREATOR_AGENT_ID,
  PLUGIN_CREATOR_LIMITS,
  PluginCreatorError,
  PluginCreatorProjects,
  type SQLiteStore,
  sdkRangeFor,
} from "@alisio/core";
import type {
  PluginCreatorBuildResponse,
  PluginCreatorProjectEntry,
  PluginCreatorSessionResponse,
  PluginCreatorStatus,
} from "@alisio/sdk";
import type { SessionService } from "../host/sessions.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";
import type { ManagementContext, WorkspaceRecycler } from "./management.ts";
import { workspaceApp } from "./management.ts";
import type { PluginInstallService } from "./plugin-catalog.ts";

export interface PluginCreatorRouteOptions {
  sessions: SessionService;
  catalog: SQLiteStore;
  install: PluginInstallService;
  /** Version of the installed `@alisio/sdk`; new projects peer on its minor (`^0.11.0`). */
  sdkVersion?: string;
}

const BASE = "/api/plugin-creator/projects";
const ICON_TYPES = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  jpeg: "image/jpeg",
} as const;

/** Maps a core creator failure to its HTTP error (same code names). */
function toHttp(error: unknown): unknown {
  if (error instanceof PluginCreatorError)
    return new HttpError(error.code, error.message, error.details);
  return error;
}

async function guard<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw toHttp(error);
  }
}

export function registerPluginCreatorRoutes(
  router: Router,
  ctx: ManagementContext,
  recycler: WorkspaceRecycler,
  options: PluginCreatorRouteOptions,
): void {
  const projects = new PluginCreatorProjects({
    sdkRange: sdkRangeFor(options.sdkVersion),
    ...(options.sdkVersion ? { sdkVersion: options.sdkVersion } : {}),
  });
  /** Builds, installs and deletes of one project never overlap. */
  const busy = new Set<string>();

  const refuseReadOnly = (what: string) => {
    if (ctx.base.readOnly)
      throw new HttpError("capability_ceiling", `${what} is unavailable under --read-only`);
  };

  const exclusive = async <T>(id: string, task: () => Promise<T>): Promise<T> => {
    if (busy.has(id))
      throw new HttpError(
        "plugin_project_busy",
        "This plugin is being built, installed or deleted: wait for it to finish",
      );
    busy.add(id);
    try {
      return await guard(task);
    } finally {
      busy.delete(id);
    }
  };

  /** Why the installed plugin failed to start in an open workspace, if it did (sanitized). */
  const activationErrorOf = (pluginId: string): string | undefined => {
    for (const opened of ctx.workspaces.entries()) {
      const failed = opened.app
        .pluginCatalog()
        .find((plugin) => plugin.id === pluginId && plugin.status === "failed");
      if (failed) return failed.diagnostic ?? "Activation failed";
    }
    return undefined;
  };

  /** The install state plus the running app's view of it (a failed start is shown, G). */
  const statusOf = async (id: string): Promise<PluginCreatorStatus> => {
    const status = await projects.status(id);
    if (!status.installed) return status;
    const activationError = activationErrorOf((await projects.get(id)).pluginId);
    return activationError ? { ...status, activationError } : status;
  };

  const entry = async (id: string): Promise<PluginCreatorProjectEntry> =>
    guard(async () => ({ project: await projects.get(id), status: await statusOf(id) }));

  /** Resolves a model selector against the configured models; 400 `model` when it is unknown. */
  const resolveModel = async (model: string, projectDir?: string): Promise<string> => {
    const app =
      ctx.workspaces.entries()[0]?.app ??
      (projectDir
        ? (await ctx.workspaces.openPath(await ctx.workspaces.canonical(projectDir))).app
        : undefined);
    if (!app)
      throw new HttpError("validation_failed", "Model is not available", { fields: ["model"] });
    try {
      return (await app.resolveModel(model)).reference;
    } catch (error) {
      throw new HttpError(
        "validation_failed",
        error instanceof Error ? error.message : "Model is not available",
        { fields: ["model"] },
      );
    }
  };

  /** Validate, test and pack; a failure is 422 with the build response as `details`. */
  const build = async (id: string): Promise<PluginCreatorBuildResponse> => {
    const outcome = await projects.build(id);
    const body: PluginCreatorBuildResponse = {
      ok: outcome.ok,
      build: outcome.stats,
      issues: outcome.issues,
      ...(outcome.tests ? { tests: outcome.tests } : {}),
      project: await projects.get(id),
      status: await statusOf(id),
    };
    if (!outcome.ok)
      throw new HttpError(
        outcome.error?.code === "plugin_tests_failed"
          ? "plugin_tests_failed"
          : "plugin_project_invalid",
        outcome.error?.message ?? "The plugin could not be built",
        body,
      );
    return body;
  };

  router.get(BASE, async () =>
    guard(async () => {
      const list: PluginCreatorProjectEntry[] = [];
      for (const project of await projects.list())
        list.push({ project, status: await statusOf(project.id) });
      return { body: { projects: list } };
    }),
  );

  router.post(BASE, async ({ req }) => {
    const input = validate<{ request: string; displayName?: string; model?: string }>(
      await readJson(req),
      {
        request: { check: is.nonEmpty(PLUGIN_CREATOR_LIMITS.requestChars), required: true },
        displayName: { check: is.string(PLUGIN_CREATOR_LIMITS.displayNameChars) },
        model: { check: is.nonEmpty(300) },
      },
    );
    refuseReadOnly("Creating plugins");
    const model = input.model ? await resolveModel(input.model) : undefined;
    const project = await guard(() =>
      projects.create({
        request: input.request,
        ...(input.displayName?.trim() ? { displayName: input.displayName } : {}),
        ...(model ? { model } : {}),
      }),
    );
    return { status: 201, body: await entry(project.id) };
  });

  router.get(`${BASE}/:id`, async ({ params }) => ({ body: await entry(params.id ?? "") }));

  router.get(`${BASE}/:id/status`, async ({ params }) => ({
    body: await guard(() => statusOf(params.id ?? "")),
  }));

  router.delete(`${BASE}/:id`, async ({ req, params }) => {
    const input = validate<{ uninstall: boolean }>(await readJson(req), {
      uninstall: { check: is.boolean(), required: true },
    });
    refuseReadOnly("Deleting plugins");
    const id = params.id ?? "";
    return exclusive(id, async () => {
      const project = await projects.get(id);
      let uninstalled = false;
      let restartPending = false;
      if (input.uninstall && (await projects.status(id)).installed) {
        const removed = await options.install.uninstallPackage(project.packageName);
        uninstalled = removed.removed;
        restartPending = removed.restartPending;
      }
      await projects.delete(id);
      return { body: { deleted: true, uninstalled, restartPending } };
    });
  });

  router.post(`${BASE}/:id/session`, async ({ req, params }) => {
    const input = validate<{ request?: string; model?: string }>(await readJson(req), {
      request: { check: is.nonEmpty(PLUGIN_CREATOR_LIMITS.requestChars) },
      model: { check: is.nonEmpty(300) },
    });
    refuseReadOnly("The plugin creator");
    const id = params.id ?? "";
    let project = await guard(() => projects.get(id));
    const dir = projects.dir(id);
    const explicit = input.model ? await resolveModel(input.model, dir) : undefined;
    if (input.request)
      project = await guard(() => projects.addRequest(id, input.request as string));
    // An explicit model always starts a fresh session on it; otherwise resume the last session.
    if (!explicit && project.sessionId) {
      try {
        const session = options.catalog.get(project.sessionId);
        if (!session.archivedAt && !session.parentId) {
          const body: PluginCreatorSessionResponse = {
            sessionId: session.id,
            created: false,
            ...(project.lastModel ? { model: project.lastModel } : {}),
          };
          return { body };
        }
      } catch {
        /* the session is gone: start a new one */
      }
    }
    const opened = await ctx.workspaces.openPath(await ctx.workspaces.canonical(dir));
    let model = explicit ?? project.lastModel;
    let created: Awaited<ReturnType<typeof opened.app.createSession>>;
    try {
      created = await opened.app.createSession(model);
    } catch (error) {
      if (explicit)
        throw new HttpError(
          "validation_failed",
          error instanceof Error ? error.message : "Model is not available",
          { fields: ["model"] },
        );
      // The remembered model is no longer configured: fall back to the default one.
      model = undefined;
      created = await opened.app.createSession();
    }
    options.catalog.updateSessionMeta(created.id, {
      title: `Plugin: ${project.displayName}`.slice(0, 200),
      options: { agent: PLUGIN_CREATOR_AGENT_ID, preset: "ask" },
    });
    await guard(() => projects.setSession(id, created.id, model));
    options.sessions.notify(created.id);
    const body: PluginCreatorSessionResponse = {
      sessionId: created.id,
      created: true,
      ...(model ? { model } : {}),
    };
    return { status: 201, body };
  });

  router.get(`${BASE}/:id/files`, async ({ params }) => ({
    body: await guard(() => projects.listFiles(params.id ?? "")),
  }));

  router.get(`${BASE}/:id/files/*`, async ({ params }) => ({
    body: await guard(() => projects.readFile(params.id ?? "", params["*"] ?? "")),
  }));

  /** The project icon, sniffed by content (an SVG passed the build's safety check). */
  router.get(`${BASE}/:id/icon`, async ({ params, res }) => {
    const icon = await guard(() => projects.icon(params.id ?? ""));
    if (!icon) throw new HttpError("not_found", "This plugin has no usable icon");
    res.writeHead(200, {
      "Content-Type": ICON_TYPES[icon.type],
      "Content-Length": String(icon.data.length),
      "X-Content-Type-Options": "nosniff",
      // Opened directly, an SVG must never run anything or load anything.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "no-store",
    });
    res.end(icon.data);
    return undefined;
  });

  router.post(`${BASE}/:id/build`, async ({ params }) => {
    refuseReadOnly("Building plugins");
    const id = params.id ?? "";
    return { body: await exclusive(id, () => build(id)) };
  });

  router.get(`${BASE}/:id/package`, async ({ params, res }) => {
    const id = params.id ?? "";
    const file = await guard(() => projects.packagePath(id));
    if (!file)
      throw new HttpError(
        "plugin_not_built",
        "There is no up-to-date package: build the plugin first",
      );
    const size = (await stat(file)).size;
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${basename(file).replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(file);
      stream.on("error", reject);
      stream.on("end", () => resolve());
      stream.pipe(res);
    });
    return undefined;
  });

  router.post(`${BASE}/:id/install`, async ({ req, params }) => {
    const input = validate<{ confirmed: boolean; workspace?: string }>(await readJson(req), {
      confirmed: { check: (v) => v === true, required: true },
      workspace: { check: is.nonEmpty(4096) },
    });
    refuseReadOnly("Installing plugins");
    const id = params.id ?? "";
    if (busy.has(id))
      throw new HttpError(
        "plugin_project_busy",
        "This plugin is being built, installed or deleted: wait for it to finish",
      );
    busy.add(id);
    // The project stays busy until the install job ends (its cleanup hook releases it).
    let started = false;
    const release = async () => {
      busy.delete(id);
    };
    try {
      // Only a build that passed every gate on exactly these sources may be installed (409).
      if (!(await guard(() => projects.packagePath(id))))
        throw new HttpError(
          "plugin_not_built",
          "The plugin has not passed every check for its current files: build it first",
        );
      // Rebuild right before installing or updating: the same gates (including the compatibility
      // with the installed SDK and the real-host check) run on exactly what is on disk.
      await guard(() => build(id));
      const file = await guard(() => projects.packagePath(id));
      if (!file) throw new HttpError("plugin_not_built", "The plugin could not be packaged");
      const project = await guard(() => projects.get(id));
      const jobId = options.install.startLocalInstall(file, project.packageName, {
        cleanup: release,
        // The safety net: the running app must actually start it, or the install is rolled back.
        verify: async () => activationErrorOf((await projects.get(id)).pluginId),
        onSuccess: async (result) => {
          await projects.recordInstall(id, result.installedVersion);
          const extra: Record<string, unknown> = { projectId: id };
          // Not verified before (its old code was still loaded): report what the app sees.
          const activationError = activationErrorOf((await projects.get(id)).pluginId);
          if (activationError) extra.activationError = activationError;
          if (!input.workspace) return extra;
          // "Install & enable": switch it on in the given workspace if it was turned off there.
          try {
            const opened = await workspaceApp(ctx.workspaces, input.workspace);
            const pluginId = (await projects.get(id)).pluginId;
            const loaded = opened.app.pluginCatalog().find((p) => p.id === pluginId);
            if (loaded && !loaded.enabled) {
              const updated = await opened.app.setPluginEnabled(pluginId, true);
              if (updated.status === "restart-required") await recycler.request(opened.id);
              recycler.announce(opened.id, ["plugins", "commands"]);
            }
            extra.enabled = true;
          } catch (error) {
            extra.enabled = false;
            extra.enableError = error instanceof Error ? error.message : "Could not enable it";
          }
          return extra;
        },
      });
      started = true;
      return { status: 202, body: { jobId } };
    } finally {
      if (!started) await release();
    }
  });
}
