/**
 * Plugin catalog routes: browse the published catalog (cached, revalidated on demand), proxy its
 * covers, install a catalog plugin, uninstall a globally installed npm plugin and list the
 * installed packages. Installing runs npm with the user's privileges and executes third-party
 * code when the plugin loads: it needs an explicit `confirmed: true`, only catalog packages are
 * accepted, and it is refused under `--read-only`. Types are local: the SDK contract is untouched.
 */
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  catalogPluginState,
  comparePluginVersions,
  configHome,
  type InstallRunner,
  inspectPluginTarball,
  installedGlobalPlugins,
  installLocalPluginTarball,
  installPluginResolvingPeers,
  installPluginsTogether,
  MAX_TARBALL_BYTES,
  NPM_NOT_FOUND_MESSAGE,
  NpmInstallError,
  type PluginCatalogEntry,
  parsePluginSpec,
  pluginCodeImportedFrom,
  pluginDependencySpec,
  satisfiesRange,
  uninstallPlugin,
} from "@alisio/core";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import type { CatalogPlugin } from "../plugins/catalog-schema.ts";
import {
  type CatalogResult,
  type CatalogService,
  CatalogUnavailableError,
} from "../plugins/catalog-service.ts";
import { InstallJobs, type JobView } from "../plugins/jobs.ts";
import {
  createStaging,
  isStagingId,
  removeStaging,
  stagingFile,
  sweepStaging,
} from "../plugins/staging.ts";
import { is, validate } from "../schemas.ts";
import type { ManagementContext, WorkspaceRecycler } from "./management.ts";
import { workspaceApp } from "./management.ts";

export interface PluginCatalogRouteOptions {
  service: CatalogService;
  /** Version of the installed `@alisio/sdk` (compatibility checks); unknown = all compatible. */
  sdkVersion?: string;
  /** Injected npm for tests; defaults to the real (or bundled) npm. */
  installRunner?: InstallRunner;
  /** Upload cap of a local plugin tarball (default 50 MB); tests lower it. */
  maxUploadBytes?: number;
  /** How long a finished install job stays readable (default 10 minutes). */
  jobTtlMs?: number;
}

/** `POST /api/plugins/local/inspect`: what the uploaded tarball is, before anything is installed. */
export interface LocalInspectResponse {
  /** Present only when the tarball can be installed; pass it to `local/install`. */
  stagingId?: string;
  package?: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  sdkRange?: string;
  /** A warning, not a block: private plugins may lag behind the installed SDK. */
  compatible: boolean;
  isAlisioPlugin: boolean;
  reasons: string[];
  lifecycleScripts: string[];
  installed?: { version: string; relation: "update" | "same" | "downgrade" };
  size: number;
}

export type LocalInstallJobResponse = { jobId: string };
export type { JobView };

/** A catalog plugin as the browser sees it: no remote URLs for the cover, plus its install state. */
export interface CatalogPluginWire extends Omit<CatalogPlugin, "coverSource"> {
  /** Same-origin cover URL, absent when the catalog has none. */
  cover?: string;
  installedVersion?: string;
  updateAvailable: boolean;
  compatible: boolean;
}

export interface PluginCatalogResponse {
  catalog: {
    generatedAt?: string;
    categories: Array<{ id: string; count: number }>;
    plugins: CatalogPluginWire[];
  };
  meta: CatalogResult["meta"];
  installed: Array<{ package: string; version: string }>;
  sdkVersion?: string;
}

export interface PluginInstallResponse {
  package: string;
  installedVersion: string;
  alreadyInstalled: boolean;
  /** Replaced an installed version (update, reinstall or downgrade). */
  updated: boolean;
  previousVersion?: string;
  /** The plugin loads when the workspace's current runs finish. */
  restartPending: boolean;
  /**
   * The package's code was already imported in this process, and Node keeps it for the process's
   * lifetime: the new version only runs after Alisio restarts.
   */
  restartRequired: boolean;
  /**
   * Other installed plugins that were updated in the same npm call because updating this one alone
   * conflicted with them on the `@alisio/sdk` peer range.
   */
  alsoUpdated?: Array<{ package: string; installedVersion: string; previousVersion?: string }>;
}

/** `POST /api/plugins/update-all`: every outdated npm plugin updated in ONE npm install. */
export interface PluginUpdateAllResponse {
  updated: Array<{
    package: string;
    installedVersion: string;
    previousVersion?: string;
    /** The package's code was already imported: the new version runs after a restart. */
    restartRequired: boolean;
  }>;
  /** The plugins load when the workspace's current runs finish. */
  restartPending: boolean;
}

export interface PluginUninstallResponse {
  package: string;
  removed: boolean;
  restartPending: boolean;
}

export interface InstalledPluginPackage {
  package: string;
  version: string;
  /** Ids of the plugins this package provides in the workspace (empty when it did not load). */
  pluginIds: string[];
  removable: boolean;
  /** Updated on disk, but this process still runs the old code. */
  restartRequired: boolean;
  /** Installed from a local `.tgz`: it has no remote source to check for updates. */
  local: boolean;
  /** The catalog's version, for a catalog plugin that is not a local package. */
  latestVersion?: string;
  updateAvailable: boolean;
  /** False when the newer version needs a newer `@alisio/sdk` than this Alisio has. */
  updateCompatible: boolean;
}

const COVER_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** npm's answer for a version the registry does not have. */
const NOT_PUBLISHED = /\bETARGET\b|No matching version found/;
const PEER_CONFLICT = /ERESOLVE|Conflicting peer|require an older/;
const MAX_ERROR_CHARS = 1500;

/** How the uploaded version relates to the installed one. */
function relationOf(
  uploaded: string | undefined,
  installed: string,
): "update" | "same" | "downgrade" {
  const order = uploaded ? comparePluginVersions(uploaded, installed) : undefined;
  return order === undefined || order === 0 ? "same" : order > 0 ? "update" : "downgrade";
}

const megabytes = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** Streams the request body to `file`, failing as soon as it passes `max` bytes. */
async function receive(
  req: import("node:http").IncomingMessage,
  file: string,
  max: number,
): Promise<void> {
  const out = createWriteStream(file, { mode: 0o600 });
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max)
        throw new HttpError("validation_failed", `The file is larger than ${megabytes(max)} MB`);
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerPluginCatalogRoutes(
  router: Router,
  ctx: ManagementContext,
  recycler: WorkspaceRecycler,
  options: PluginCatalogRouteOptions,
): void {
  const { service } = options;
  let mutating = false;
  const jobs = new InstallJobs(options.jobTtlMs);
  /** Packages updated on disk whose old code this process still runs (cleared by a restart). */
  const pendingRestart = new Set<string>();
  const codeLoaded = (name: string) =>
    pluginCodeImportedFrom(join(configHome(), "plugins", "node_modules", name));
  const maxUpload = options.maxUploadBytes ?? MAX_TARBALL_BYTES;
  void sweepStaging().catch(() => {});

  const loadCatalog = async (refresh: boolean): Promise<CatalogResult> => {
    try {
      return await service.get(refresh);
    } catch (error) {
      if (error instanceof CatalogUnavailableError)
        throw new HttpError(
          "provider_unavailable",
          `The plugin catalog could not be loaded and there is no cached copy: ${error.message}`,
        );
      throw error;
    }
  };

  const refuseReadOnly = (what: string) => {
    if (ctx.base.readOnly)
      throw new HttpError("capability_ceiling", `${what} is unavailable under --read-only`);
  };

  /** Installs and uninstalls never overlap: they share one npm prefix and one config file. */
  const exclusive = async <T>(task: () => Promise<T>): Promise<T> => {
    if (mutating)
      throw new HttpError(
        "runs_active",
        "Another plugin install or uninstall is in progress: wait for it to finish, then retry",
      );
    mutating = true;
    try {
      return await task();
    } finally {
      mutating = false;
    }
  };

  /** Recycles every open workspace so it re-reads the plugin set; true when any was deferred. */
  const applyToWorkspaces = async (): Promise<boolean> => {
    let deferred = false;
    for (const entry of ctx.workspaces.entries()) {
      const reopened = await recycler.request(entry.id);
      if (!reopened) deferred = true;
      recycler.announce(entry.id, ["plugins", "commands"]);
    }
    return deferred;
  };

  const toWire = (plugin: CatalogPlugin, installed: Map<string, string>): CatalogPluginWire => {
    const { coverSource, ...rest } = plugin;
    const state = catalogPluginState({
      catalogVersion: plugin.version,
      ...(installed.has(plugin.package) ? { installedVersion: installed.get(plugin.package) } : {}),
      ...(plugin.sdk ? { sdkRange: plugin.sdk } : {}),
      ...(options.sdkVersion ? { sdkVersion: options.sdkVersion } : {}),
    });
    return {
      ...rest,
      ...(coverSource
        ? { cover: `/api/plugin-catalog/covers/${encodeURIComponent(plugin.slug)}` }
        : {}),
      ...(state.installedVersion ? { installedVersion: state.installedVersion } : {}),
      updateAvailable: state.updateAvailable,
      compatible: state.compatible,
    };
  };

  /** The HTTP error for a failed npm install: validation problems are 400, the rest is upstream. */
  const installFailure = (error: unknown): HttpError => {
    const text = errorText(error).slice(0, MAX_ERROR_CHARS);
    const peer = error instanceof NpmInstallError ? error.peerConflict : PEER_CONFLICT.test(text);
    return text.includes(NPM_NOT_FOUND_MESSAGE) || peer
      ? new HttpError("validation_failed", text)
      : new HttpError("provider_unavailable", text);
  };

  /**
   * Installed npm plugins whose catalog release is newer and compatible with this Alisio's SDK.
   * Local `.tgz` installs have no remote source and are never touched.
   */
  const outdatedPlugins = async (): Promise<
    Array<{ entry: CatalogPlugin; installedVersion: string }>
  > => {
    const { catalog } = await loadCatalog(false);
    const pluginsDir = join(configHome(), "plugins");
    const result: Array<{ entry: CatalogPlugin; installedVersion: string }> = [];
    for (const item of await installedGlobalPlugins(configHome())) {
      const entry = catalog.plugins.find((plugin) => plugin.package === item.name);
      if (!entry) continue;
      if ((await pluginDependencySpec(pluginsDir, item.name))?.startsWith("file:")) continue;
      const state = catalogPluginState({
        catalogVersion: entry.version,
        installedVersion: item.version,
        ...(entry.sdk ? { sdkRange: entry.sdk } : {}),
        ...(options.sdkVersion ? { sdkVersion: options.sdkVersion } : {}),
      });
      if (state.updateAvailable && state.compatible)
        result.push({ entry, installedVersion: item.version });
    }
    return result;
  };

  // ---- Catalog ------------------------------------------------------------------------------
  router.get("/api/plugin-catalog", async ({ url }) => {
    const raw = url.searchParams.get("refresh");
    if (raw !== null && raw !== "0" && raw !== "1" && raw !== "")
      throw new HttpError("validation_failed", "Invalid query parameter", { fields: ["refresh"] });
    const result = await loadCatalog(raw === "1");
    const installed = await installedGlobalPlugins(configHome());
    const versions = new Map(installed.map((item) => [item.name, item.version]));
    const body: PluginCatalogResponse = {
      catalog: {
        ...(result.catalog.generatedAt ? { generatedAt: result.catalog.generatedAt } : {}),
        categories: result.catalog.categories,
        plugins: result.catalog.plugins.map((plugin) => toWire(plugin, versions)),
      },
      meta: result.meta,
      installed: installed.map((item) => ({ package: item.name, version: item.version })),
      ...(options.sdkVersion ? { sdkVersion: options.sdkVersion } : {}),
    };
    return { body };
  });

  router.get("/api/plugin-catalog/covers/:slug", async ({ req, res, params }) => {
    const slug = params.slug ?? "";
    if (!SLUG.test(slug)) throw new HttpError("not_found", "Cover not found");
    const result = await loadCatalog(false);
    const plugin = result.catalog.plugins.find((entry) => entry.slug === slug);
    if (!plugin?.coverSource) throw new HttpError("not_found", "Cover not found");
    const cover = await service.cover(plugin, result.meta.fetchedAt);
    if (!cover) throw new HttpError("not_found", "Cover not found");
    res.setHeader("Content-Security-Policy", COVER_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("ETag", cover.etag);
    if (req.headers["if-none-match"] === cover.etag) {
      res.writeHead(304);
      res.end();
      return undefined;
    }
    res.writeHead(200, {
      "Content-Type": cover.contentType,
      "Content-Length": String(cover.body.length),
    });
    res.end(cover.body);
    return undefined;
  });

  // ---- Installed packages -------------------------------------------------------------------
  router.get("/api/plugins/packages", async ({ url }) => {
    const opened = await workspaceApp(ctx.workspaces, url.searchParams.get("workspace"));
    const loaded = opened.app.pluginCatalog();
    // Update info comes from the cached catalog: no network unless the cache is stale.
    const catalog = await service.get(false).then(
      (result) => result.catalog,
      () => undefined,
    );
    const pluginsDir = join(configHome(), "plugins");
    const body: InstalledPluginPackage[] = [];
    for (const item of await installedGlobalPlugins(configHome())) {
      const local =
        (await pluginDependencySpec(pluginsDir, item.name))?.startsWith("file:") ?? false;
      const entry = local ? undefined : catalog?.plugins.find((p) => p.package === item.name);
      const state = entry
        ? catalogPluginState({
            catalogVersion: entry.version,
            installedVersion: item.version,
            ...(entry.sdk ? { sdkRange: entry.sdk } : {}),
            ...(options.sdkVersion ? { sdkVersion: options.sdkVersion } : {}),
          })
        : undefined;
      body.push({
        package: item.name,
        version: item.version,
        pluginIds: loaded.filter((plugin) => plugin.spec === item.name).map((plugin) => plugin.id),
        removable: !ctx.base.readOnly,
        restartRequired: pendingRestart.has(item.name),
        local,
        ...(entry ? { latestVersion: entry.version } : {}),
        updateAvailable: state?.updateAvailable ?? false,
        updateCompatible: state?.compatible ?? true,
      });
    }
    return { body };
  });

  // ---- Install ------------------------------------------------------------------------------
  router.post("/api/plugins/install", async ({ req }) => {
    const input = validate<{ package: string; version?: string; confirmed: boolean }>(
      await readJson(req),
      {
        package: { check: is.nonEmpty(214), required: true },
        version: { check: is.nonEmpty(64) },
        confirmed: { check: (v) => v === true, required: true },
      },
    );
    refuseReadOnly("Installing plugins");
    const { catalog } = await loadCatalog(false);
    const entry = catalog.plugins.find((plugin) => plugin.package === input.package);
    if (!entry)
      throw new HttpError(
        "validation_failed",
        "Only plugins listed in the catalog can be installed here",
        {
          fields: ["package"],
        },
      );
    if (input.version !== undefined && input.version !== entry.version)
      throw new HttpError(
        "validation_failed",
        `Only the catalog version (${entry.version}) can be installed here`,
        { fields: ["version"] },
      );
    const installed = new Map(
      (await installedGlobalPlugins(configHome())).map((item) => [item.name, item.version]),
    );
    const state = catalogPluginState({
      catalogVersion: entry.version,
      ...(installed.has(entry.package) ? { installedVersion: installed.get(entry.package) } : {}),
      ...(entry.sdk ? { sdkRange: entry.sdk } : {}),
      ...(options.sdkVersion ? { sdkVersion: options.sdkVersion } : {}),
    });
    if (!state.compatible)
      throw new HttpError(
        "validation_failed",
        `${entry.name} needs @alisio/sdk ${entry.sdk}, but this Alisio has ${options.sdkVersion}`,
        { fields: ["package"] },
      );
    // Updating (or installing) may conflict with other plugins that still peer on the old SDK:
    // those with a newer catalog release are the only ones npm may update along with it.
    const alongside =
      !installed.has(entry.package) || state.updateAvailable
        ? (await outdatedPlugins()).filter((item) => item.entry.package !== entry.package)
        : [];
    return exclusive(async () => {
      const loaded = codeLoaded(entry.package);
      const loadedAlongside = new Set(
        alongside
          .filter((item) => codeLoaded(item.entry.package))
          .map((item) => item.entry.package),
      );
      const attempt = (pinned: boolean) =>
        installPluginResolvingPeers({
          target: { name: entry.package, ...(pinned ? { version: entry.version } : {}) },
          companions: alongside.map((item) => ({
            name: item.entry.package,
            ...(pinned ? { version: item.entry.version } : {}),
          })),
          configHome: configHome(),
          ...(options.installRunner ? { runner: options.installRunner } : {}),
        });
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        try {
          result = await attempt(true);
        } catch (error) {
          // The catalog can list a version npm does not serve yet (it is generated before the
          // publish finishes): fall back to the registry's latest rather than fail the install.
          if (!NOT_PUBLISHED.test(errorText(error))) throw error;
          result = await attempt(false);
        }
      } catch (error) {
        throw installFailure(error);
      }
      const restartRequired =
        loaded || result.coUpdated.some((item) => loadedAlongside.has(item.name));
      if (loaded) pendingRestart.add(result.packageName);
      for (const item of result.coUpdated)
        if (loadedAlongside.has(item.name)) pendingRestart.add(item.name);
      const deferred = await applyToWorkspaces();
      const body: PluginInstallResponse = {
        package: result.packageName,
        installedVersion: result.installedVersion,
        alreadyInstalled: result.alreadyInstalled,
        updated: result.updated,
        ...(result.previousVersion ? { previousVersion: result.previousVersion } : {}),
        restartPending: deferred,
        restartRequired,
        ...(result.coUpdated.length
          ? {
              alsoUpdated: result.coUpdated.map((item) => ({
                package: item.name,
                installedVersion: item.version,
                ...(item.previousVersion ? { previousVersion: item.previousVersion } : {}),
              })),
            }
          : {}),
      };
      return { body };
    });
  });

  // ---- Update all ---------------------------------------------------------------------------
  router.post("/api/plugins/update-all", async ({ req }) => {
    validate<{ confirmed: boolean }>(await readJson(req), {
      confirmed: { check: (v) => v === true, required: true },
    });
    refuseReadOnly("Updating plugins");
    const outdated = await outdatedPlugins();
    return exclusive(async () => {
      if (outdated.length === 0) {
        const none: PluginUpdateAllResponse = { updated: [], restartPending: false };
        return { body: none };
      }
      const loaded = new Set(
        outdated.filter((item) => codeLoaded(item.entry.package)).map((item) => item.entry.package),
      );
      // ONE npm call: npm resolves every peer range together, which one-by-one installs cannot.
      const attempt = (pinned: boolean) =>
        installPluginsTogether({
          packages: outdated.map((item) => ({
            name: item.entry.package,
            ...(pinned ? { version: item.entry.version } : {}),
          })),
          configHome: configHome(),
          ...(options.installRunner ? { runner: options.installRunner } : {}),
        });
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        try {
          result = await attempt(true);
        } catch (error) {
          if (!NOT_PUBLISHED.test(errorText(error))) throw error;
          result = await attempt(false);
        }
      } catch (error) {
        throw installFailure(error);
      }
      for (const item of result.packages) if (loaded.has(item.name)) pendingRestart.add(item.name);
      const deferred = await applyToWorkspaces();
      const body: PluginUpdateAllResponse = {
        updated: result.packages.map((item) => ({
          package: item.name,
          installedVersion: item.version,
          ...(item.previousVersion ? { previousVersion: item.previousVersion } : {}),
          restartRequired: loaded.has(item.name),
        })),
        restartPending: deferred,
      };
      return { body };
    });
  });

  // ---- Install from a local file --------------------------------------------------------------
  router.post("/api/plugins/local/inspect", async ({ req }) => {
    refuseReadOnly("Installing plugins");
    const type = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim();
    if (
      !["application/gzip", "application/x-gzip", "application/octet-stream"].includes(type ?? "")
    )
      throw new HttpError(
        "unsupported_media_type",
        "Send the .tgz as the raw body with Content-Type application/gzip",
      );
    const declared = Number(req.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxUpload)
      throw new HttpError(
        "validation_failed",
        `The file is larger than ${megabytes(maxUpload)} MB`,
      );
    await sweepStaging().catch(() => 0);
    const staging = await createStaging();
    try {
      await receive(req, staging.file, maxUpload);
      const info = await inspectPluginTarball(staging.file);
      const installed = info.name
        ? (await installedGlobalPlugins(configHome())).find((item) => item.name === info.name)
        : undefined;
      const compatible =
        !info.sdkRange || !options.sdkVersion
          ? true
          : satisfiesRange(options.sdkVersion, info.sdkRange);
      const body: LocalInspectResponse = {
        ...(info.isAlisioPlugin ? { stagingId: staging.id } : {}),
        ...(info.name ? { package: info.name } : {}),
        ...(info.version ? { version: info.version } : {}),
        ...(info.description ? { description: info.description } : {}),
        ...(info.author ? { author: info.author } : {}),
        ...(info.license ? { license: info.license } : {}),
        ...(info.sdkRange ? { sdkRange: info.sdkRange } : {}),
        compatible,
        isAlisioPlugin: info.isAlisioPlugin,
        reasons: info.reasons,
        lifecycleScripts: info.lifecycleScripts,
        ...(installed
          ? {
              installed: {
                version: installed.version,
                relation: relationOf(info.version, installed.version),
              },
            }
          : {}),
        size: info.size,
      };
      // Nothing to install from an invalid file: it does not stay on disk.
      if (!info.isAlisioPlugin) await removeStaging(staging.id);
      return { body };
    } catch (error) {
      await removeStaging(staging.id);
      throw error;
    }
  });

  router.delete("/api/plugins/local/staged/:stagingId", async ({ params }) => {
    const id = params.stagingId ?? "";
    if (!isStagingId(id))
      throw new HttpError("validation_failed", "Invalid upload id", { fields: ["stagingId"] });
    await removeStaging(id);
    return { body: { removed: true } };
  });

  router.post("/api/plugins/local/install", async ({ req }) => {
    const input = validate<{ stagingId: string; confirmed: boolean }>(await readJson(req), {
      stagingId: { check: is.nonEmpty(64), required: true },
      confirmed: { check: (v) => v === true, required: true },
    });
    refuseReadOnly("Installing plugins");
    if (!isStagingId(input.stagingId))
      throw new HttpError("validation_failed", "Invalid upload id", { fields: ["stagingId"] });
    const file = stagingFile(input.stagingId);
    if (
      !(await stat(file).then(
        () => true,
        () => false,
      ))
    )
      throw new HttpError(
        "not_found",
        "The upload was not found or has expired: select the file again",
      );
    const info = await inspectPluginTarball(file);
    if (!info.isAlisioPlugin) {
      await removeStaging(input.stagingId);
      throw new HttpError(
        "validation_failed",
        `Not a valid Alisio plugin package: ${info.reasons.join("; ")}`,
      );
    }
    if (mutating)
      throw new HttpError(
        "runs_active",
        "Another plugin install or uninstall is in progress: wait for it to finish, then retry",
      );
    mutating = true;
    const job = jobs.create();
    job.start("uploading");
    void (async () => {
      const loaded = info.name ? codeLoaded(info.name) : false;
      try {
        const result = await installLocalPluginTarball({
          tarballPath: file,
          configHome: configHome(),
          ...(options.installRunner ? { runner: options.installRunner } : {}),
          onPhase: (phase) => job.start(phase),
        });
        job.start("reloading");
        if (loaded) pendingRestart.add(result.packageName);
        const deferred = await applyToWorkspaces();
        job.start("cleanup");
        await removeStaging(input.stagingId);
        const body: PluginInstallResponse = {
          package: result.packageName,
          installedVersion: result.installedVersion,
          alreadyInstalled: result.alreadyInstalled,
          updated: result.updated,
          ...(result.previousVersion ? { previousVersion: result.previousVersion } : {}),
          restartPending: deferred,
          restartRequired: loaded,
        };
        job.succeed(body);
      } catch (error) {
        await removeStaging(input.stagingId).catch(() => {});
        const text = errorText(error).slice(0, MAX_ERROR_CHARS);
        const tail = (error as { logTail?: string }).logTail;
        job.fail(text, tail);
      } finally {
        mutating = false;
      }
    })();
    return { status: 202, body: { jobId: job.id } satisfies LocalInstallJobResponse };
  });

  router.get("/api/plugins/jobs/:jobId", ({ params }) => {
    const job = jobs.get(params.jobId ?? "");
    if (!job) throw new HttpError("not_found", "Job not found or expired");
    return { body: job.view() };
  });

  // ---- Uninstall ----------------------------------------------------------------------------
  router.delete("/api/plugins/package/:name", async ({ params }) => {
    const name = params.name ?? "";
    let parsed: ReturnType<typeof parsePluginSpec>;
    try {
      parsed = parsePluginSpec(name);
      if (parsed.version !== undefined || parsed.name !== name) throw new Error("not a bare name");
    } catch {
      throw new HttpError("validation_failed", "Invalid package name", { fields: ["name"] });
    }
    refuseReadOnly("Uninstalling plugins");
    const builtin = (ctx.base.builtins ?? []).some(
      (plugin) => name === plugin.id || name === `@alisio/plugin-${plugin.id}`,
    );
    if (builtin) throw new HttpError("not_manageable", "Built-in plugins cannot be uninstalled");
    const installed = await installedGlobalPlugins(configHome());
    if (!installed.some((item) => item.name === name)) {
      const project = ctx.workspaces
        .entries()
        .some((entry) =>
          entry.app.pluginCatalog().some((plugin: PluginCatalogEntry) => plugin.spec === name),
        );
      if (project)
        throw new HttpError(
          "not_manageable",
          "This plugin is not installed in the global plugins directory: remove it from your project configuration",
        );
      throw new HttpError("not_found", "Plugin package is not installed");
    }
    return exclusive(async () => {
      let removed: Awaited<ReturnType<typeof uninstallPlugin>>;
      try {
        removed = await uninstallPlugin({
          packageName: name,
          configHome: configHome(),
          ...(options.installRunner ? { runner: options.installRunner } : {}),
        });
      } catch (error) {
        const text = errorText(error).slice(0, MAX_ERROR_CHARS);
        throw new HttpError(
          text.includes(NPM_NOT_FOUND_MESSAGE) ? "validation_failed" : "provider_unavailable",
          text,
        );
      }
      pendingRestart.delete(name);
      const deferred = await applyToWorkspaces();
      const body: PluginUninstallResponse = {
        package: removed.packageName,
        removed: removed.removed,
        restartPending: deferred,
      };
      return { body };
    });
  });
}
