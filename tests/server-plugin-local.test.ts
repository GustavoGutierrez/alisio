import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type BuiltinPlugin, type InstallRunner, inspectPluginTarball } from "@alisio/core";
import { definePlugin, type PluginAppInfo, type PluginInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView } from "../packages/server/src/plugins/jobs.ts";
import type {
  InstalledPluginPackage,
  LocalInspectResponse,
} from "../packages/server/src/routes/plugin-catalog.ts";
import {
  deferred,
  gatedProvider,
  newSession,
  openStream,
  raw,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";
import { pluginTarball } from "./tarball-helpers.ts";

const demo: BuiltinPlugin = {
  id: "demo",
  description: "Demo",
  create: () => definePlugin({ id: "demo", version: "1.0.0", apiVersion: 1, setup() {} }),
};

interface NpmState {
  calls: string[][];
  gate?: Promise<void>;
  fail?: boolean;
  /** The installed plugin also registers a plugin app. */
  withApp?: boolean;
}

/** A fake npm that "installs" a tarball by writing a loadable plugin and the file: spec. */
function fakeNpm(state: NpmState): InstallRunner {
  return async (_c, args) => {
    state.calls.push(args);
    await state.gate;
    const prefix = args[args.indexOf("--prefix") + 1] as string;
    const target = args.at(-1) as string;
    const manifestPath = join(prefix, "package.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8").catch(() => '{"dependencies":{}}'),
    );
    manifest.dependencies ??= {};
    if (args[0] === "uninstall") {
      await rm(join(prefix, "node_modules", target), { recursive: true, force: true });
      delete manifest.dependencies[target];
      await writeFile(manifestPath, JSON.stringify(manifest));
      return { stdout: "", stderr: "", exitCode: 0, truncated: false };
    }
    if (state.fail)
      return { stdout: "", stderr: "npm ERR! E404 not found", exitCode: 1, truncated: false };
    const info = await inspectPluginTarball(target);
    const name = info.name as string;
    const dir = join(prefix, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        version: info.version,
        type: "module",
        main: "index.js",
        keywords: ["alisio-plugin"],
      }),
    );
    await writeFile(
      join(dir, "index.js"),
      `export default { id: "fake-ica", name: "Fake ICA", version: ${JSON.stringify(info.version)}, apiVersion: 1, setup(api) { ${state.withApp ? 'api.apps.register({ id: "ledger", label: { en: "Ledger", es: "Libro" }, html: () => "<p>ok</p>" });' : ""} } };\n`,
    );
    manifest.dependencies[name] = `file:${relative(prefix, target).split("\\").join("/")}`;
    await writeFile(manifestPath, JSON.stringify(manifest));
    return { stdout: "added 1 package", stderr: "", exitCode: 0, truncated: false };
  };
}

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(
  options: {
    npm?: NpmState;
    readOnly?: boolean;
    maxUploadBytes?: number;
    jobTtlMs?: number;
    provider?: ReturnType<typeof gatedProvider>;
  } = {},
) {
  const npm = options.npm ?? { calls: [] };
  t = await startTestServer({
    ...(options.provider ? { provider: options.provider.provider } : {}),
    app: { builtins: [demo], trustProject: true, ...(options.readOnly ? { readOnly: true } : {}) },
    pluginCatalog: {
      url: "http://127.0.0.1:9/catalog.json",
      installRunner: fakeNpm(npm),
      sdkVersion: "0.9.0",
      ...(options.maxUploadBytes ? { maxUploadBytes: options.maxUploadBytes } : {}),
      ...(options.jobTtlMs ? { jobTtlMs: options.jobTtlMs } : {}),
    },
  });
  const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  // The workspace is open (the settings page loaded it).
  await t.api.get(`/api/plugins?workspace=${wid}`);
  return { t, wid, npm };
}

const upload = (tt: TestServer, body: Buffer | string, type = "application/gzip", headers = {}) =>
  raw(tt.server.port, "/api/plugins/local/inspect", {
    method: "POST",
    body,
    headers: {
      Cookie: tt.cookie,
      Origin: `http://127.0.0.1:${tt.server.port}`,
      "Content-Type": type,
      ...headers,
    },
  });

const inspect = async (tt: TestServer, over: Record<string, unknown> = {}) =>
  (await upload(tt, pluginTarball(over))).json<LocalInspectResponse>();

const stagingEntries = async (tt: TestServer) =>
  readdir(join(tt.root, "state", "tmp", "plugin-uploads")).catch(() => [] as string[]);

async function runJob(tt: TestServer, stagingId: string): Promise<JobView> {
  const started = await tt.api.post("/api/plugins/local/install", { stagingId, confirmed: true });
  expect(started.status).toBe(202);
  const { jobId } = started.json<{ jobId: string }>();
  return until(async () => {
    const view = (await tt.api.get(`/api/plugins/jobs/${jobId}`)).json<JobView>();
    return view.done ? view : undefined;
  }) as Promise<JobView>;
}

describe("POST /api/plugins/local/inspect", () => {
  it("validates an ica-like tarball and stages it", async () => {
    const { t } = await start();
    const body = pluginTarball();
    const res = await upload(t, body);
    expect(res.status).toBe(200);
    const info = res.json<LocalInspectResponse>();
    expect(info).toMatchObject({
      package: "@alisio/plugin-ica",
      version: "0.1.0",
      description: "Private demo plugin",
      author: "Alisio",
      license: "MIT",
      sdkRange: "^0.5.1",
      isAlisioPlugin: true,
      reasons: [],
      lifecycleScripts: [],
      size: body.length,
    });
    expect(info.stagingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stagingEntries(t)).toEqual([info.stagingId]);
  });

  it("reports an SDK range mismatch as a warning, not a block", async () => {
    const { t } = await start();
    const info = await inspect(t);
    expect(info.compatible).toBe(false);
    expect(info.stagingId).toBeDefined();
    const ok = await inspect(t, { peerDependencies: { "@alisio/sdk": "^0.9.0" } });
    expect(ok.compatible).toBe(true);
  });

  it("rejects a package that is not an Alisio plugin and keeps nothing on disk", async () => {
    const { t } = await start();
    const info = await inspect(t, { keywords: ["something-else"] });
    expect(info.isAlisioPlugin).toBe(false);
    expect(info.stagingId).toBeUndefined();
    expect(info.reasons.join(" ")).toMatch(/alisio-plugin/);
    expect(await stagingEntries(t)).toEqual([]);
    const junk = (await upload(t, "not a tarball at all")).json<LocalInspectResponse>();
    expect(junk.isAlisioPlugin).toBe(false);
    expect(await stagingEntries(t)).toEqual([]);
  });

  it("lists lifecycle scripts and an existing install", async () => {
    const { t } = await start();
    const warned = await inspect(t, { scripts: { postinstall: "node setup.js" } });
    expect(warned.lifecycleScripts).toEqual(["postinstall"]);
    expect(warned.isAlisioPlugin).toBe(true);
    const done = await runJob(t, warned.stagingId as string);
    expect(done.error).toBeUndefined();
    const again = await inspect(t, { version: "0.2.0" });
    expect(again.installed).toEqual({ version: "0.1.0", relation: "update" });
    expect((await inspect(t)).installed?.relation).toBe("same");
    expect((await inspect(t, { version: "0.0.9" })).installed?.relation).toBe("downgrade");
  });

  it("caps the upload while streaming", async () => {
    const { t } = await start({ maxUploadBytes: 200 });
    const res = await upload(t, pluginTarball());
    expect(res.status).toBe(400);
    expect(res.json<{ error: { code: string; message: string } }>().error.code).toBe(
      "validation_failed",
    );
    expect(await stagingEntries(t)).toEqual([]);
    const declared = await upload(t, pluginTarball(), "application/gzip", {
      "Content-Length": String(pluginTarball().length),
    });
    expect(declared.status).toBe(400);
  });

  it("wants the raw tarball: JSON and other types are refused", async () => {
    const { t } = await start();
    expect((await upload(t, "{}", "application/json")).status).toBe(415);
    expect((await upload(t, "x", "text/plain")).status).toBe(415);
    expect((await upload(t, pluginTarball(), "application/octet-stream")).status).toBe(200);
  });

  it("sweeps staging directories older than an hour before an upload", async () => {
    const { t } = await start();
    const root = join(t.root, "state", "tmp", "plugin-uploads");
    const stale = join(root, "00000000-0000-4000-8000-000000000000");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "plugin.tgz"), "old");
    const old = new Date(Date.now() - 2 * 3_600_000);
    await utimes(stale, old, old);
    const fresh = await inspect(t);
    expect(await readdir(root)).toEqual([fresh.stagingId]);
  });

  it("is refused under --read-only and without a matching Origin", async () => {
    const { t } = await start({ readOnly: true });
    const ro = await upload(t, pluginTarball());
    expect(ro.status).toBe(403);
    expect(ro.json<{ error: { code: string } }>().error.code).toBe("capability_ceiling");
    await t.close();
    const second = await start();
    const bad = await upload(second.t, pluginTarball(), "application/gzip", {
      Origin: "http://evil.example",
    });
    expect(bad.status).toBe(403);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe("forbidden_origin");
  });
});

describe("local install job", () => {
  it("lists the new plugin's app in the open workspace right after the install, without a restart", async () => {
    const { t, wid } = await start({ npm: { calls: [], withApp: true } });
    const stream = openStream(t.server.port, t.cookie);
    expect((await t.api.get(`/api/workspaces/${wid}/apps`)).json<PluginAppInfo[]>()).toEqual([]);
    const view = await runJob(t, (await inspect(t)).stagingId as string);
    expect(view.error).toBeUndefined();
    expect((await t.api.get(`/api/workspaces/${wid}/apps`)).json<PluginAppInfo[]>()).toEqual([
      { plugin: "fake-ica", id: "ledger", label: { en: "Ledger", es: "Libro" } },
    ]);
    // Open web clients hear about it (the sidebar Apps list refreshes on this frame).
    await stream.next(
      ({ frame }) =>
        frame.t === "catalog_changed" && frame.scope === "plugins" && frame.workspaceId === wid,
    );
    stream.close();
  });

  it("installs from a stable copy, progresses through every phase and cleans up", async () => {
    const { t, wid, npm } = await start();
    const info = await inspect(t);
    const view = await runJob(t, info.stagingId as string);
    expect(view.error).toBeUndefined();
    expect(view.phases.map((p) => [p.id, p.status])).toEqual([
      ["uploading", "done"],
      ["validating", "done"],
      ["copying", "done"],
      ["installing", "done"],
      ["registering", "done"],
      ["reloading", "done"],
      ["cleanup", "done"],
    ]);
    expect(view.result).toEqual({
      package: "@alisio/plugin-ica",
      installedVersion: "0.1.0",
      alreadyInstalled: false,
      updated: false,
      restartPending: false,
      restartRequired: false,
    });
    const plugins = join(t.root, "config", "plugins");
    const stored = join(plugins, "local-packages", "alisio-plugin-ica-0.1.0.tgz");
    expect(npm.calls[0]).toEqual(["install", "--prefix", plugins, stored]);
    const deps = JSON.parse(await readFile(join(plugins, "package.json"), "utf8")).dependencies;
    expect(deps["@alisio/plugin-ica"]).toBe("file:local-packages/alisio-plugin-ica-0.1.0.tgz");
    expect(await stagingEntries(t)).toEqual([]);
    const list = (await t.api.get(`/api/plugins?workspace=${wid}`)).json<PluginInfo[]>();
    expect(list.find((p) => p.id === "fake-ica")).toMatchObject({ status: "active" });
    const packages = (await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<
      InstalledPluginPackage[]
    >();
    expect(packages[0]).toMatchObject({ package: "@alisio/plugin-ica", pluginIds: ["fake-ica"] });
  });

  it("reports the running phase while npm works", async () => {
    const gate = deferred();
    const { t, npm } = await start({ npm: { calls: [], gate: gate.promise } });
    const info = await inspect(t);
    const { jobId } = (
      await t.api.post("/api/plugins/local/install", { stagingId: info.stagingId, confirmed: true })
    ).json<{ jobId: string }>();
    await until(() => npm.calls.length > 0);
    const mid = (await t.api.get(`/api/plugins/jobs/${jobId}`)).json<JobView>();
    expect(mid.done).toBe(false);
    expect(mid.phase).toBe("installing");
    expect(mid.phases.map((p) => p.status)).toEqual([
      "done",
      "done",
      "done",
      "running",
      "pending",
      "pending",
      "pending",
    ]);
    gate.resolve();
    await until(async () => (await t.api.get(`/api/plugins/jobs/${jobId}`)).json<JobView>().done);
  });

  it("serializes with other installs: a concurrent one gets 409 runs_active", async () => {
    const gate = deferred();
    const { t, npm } = await start({ npm: { calls: [], gate: gate.promise } });
    const info = await inspect(t);
    const second = await inspect(t, { version: "0.2.0" });
    await t.api.post("/api/plugins/local/install", { stagingId: info.stagingId, confirmed: true });
    await until(() => npm.calls.length > 0);
    const res = await t.api.post("/api/plugins/local/install", {
      stagingId: second.stagingId,
      confirmed: true,
    });
    expect(res.status).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("runs_active");
    const uninstall = await t.api.delete(
      `/api/plugins/package/${encodeURIComponent("@alisio/plugin-ica")}`,
    );
    expect([404, 409]).toContain(uninstall.status);
    gate.resolve();
  });

  it("fails with the npm output tail and a full rollback", async () => {
    const { t } = await start({ npm: { calls: [], fail: true } });
    const info = await inspect(t);
    const view = await runJob(t, info.stagingId as string);
    expect(view.error).toMatch(/npm install failed/);
    expect(view.logTail).toMatch(/E404/);
    expect(view.phases.find((p) => p.status === "failed")?.id).toBe("installing");
    expect(view.result).toBeUndefined();
    const plugins = join(t.root, "config", "plugins");
    expect(await readdir(join(plugins, "local-packages"))).toEqual([]);
    expect(await stagingEntries(t)).toEqual([]);
    await expect(stat(join(t.root, "config", "config.json"))).rejects.toThrow();
    // The mutex is free again.
    const retry = await inspect(t);
    expect(retry.stagingId).toBeDefined();
  });

  it("requires confirmed and a known, well-formed upload", async () => {
    const { t } = await start();
    const info = await inspect(t);
    expect(
      (await t.api.post("/api/plugins/local/install", { stagingId: info.stagingId })).status,
    ).toBe(400);
    expect(
      (await t.api.post("/api/plugins/local/install", { stagingId: "../etc", confirmed: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await t.api.post("/api/plugins/local/install", {
          stagingId: "00000000-0000-4000-8000-000000000000",
          confirmed: true,
        })
      ).status,
    ).toBe(404);
    expect((await t.api.get("/api/plugins/jobs/unknown")).status).toBe(404);
  });

  it("cancelling removes the staged upload", async () => {
    const { t } = await start();
    const info = await inspect(t);
    expect((await t.api.delete(`/api/plugins/local/staged/${info.stagingId}`)).status).toBe(200);
    expect(await stagingEntries(t)).toEqual([]);
    expect((await t.api.delete("/api/plugins/local/staged/nope")).status).toBe(400);
  });

  it("is refused under --read-only and without a matching Origin", async () => {
    const { t } = await start();
    const info = await inspect(t);
    const bad = await raw(t.server.port, "/api/plugins/local/install", {
      method: "POST",
      body: { stagingId: info.stagingId, confirmed: true },
      headers: {
        Cookie: t.cookie,
        "Content-Type": "application/json",
        Origin: "http://evil.example",
      },
    });
    expect(bad.status).toBe(403);
    await t.close();
    const ro = await start({ readOnly: true });
    const res = await ro.t.api.post("/api/plugins/local/install", {
      stagingId: "00000000-0000-4000-8000-000000000000",
      confirmed: true,
    });
    expect(res.status).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("capability_ceiling");
  });

  it("jobs expire", async () => {
    const { t } = await start({ jobTtlMs: 30 });
    const info = await inspect(t);
    const { jobId } = (
      await t.api.post("/api/plugins/local/install", { stagingId: info.stagingId, confirmed: true })
    ).json<{ jobId: string }>();
    await until(async () => (await t.api.get(`/api/plugins/jobs/${jobId}`)).json<JobView>().done);
    await new Promise((r) => setTimeout(r, 80));
    expect((await t.api.get(`/api/plugins/jobs/${jobId}`)).status).toBe(404);
  });

  it("defers the reload while a run is active", async () => {
    const gated = gatedProvider();
    const { t } = await start({ provider: gated });
    const session = await newSession(t);
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" });
    await gated.started;
    const info = await inspect(t);
    const view = await runJob(t, info.stagingId as string);
    expect((view.result as { restartPending: boolean }).restartPending).toBe(true);
    gated.release();
  });
});

describe("updating a local plugin in place", () => {
  it("replaces the stored tarball, keeps one config entry and asks for a restart once loaded", async () => {
    const { t, wid } = await start();
    const first = await runJob(t, (await inspect(t)).stagingId as string);
    expect(first.result).toMatchObject({ restartRequired: false });
    const next = await runJob(t, (await inspect(t, { version: "0.2.0" })).stagingId as string);
    expect(next.result).toMatchObject({
      updated: true,
      previousVersion: "0.1.0",
      installedVersion: "0.2.0",
      restartRequired: true,
    });
    const plugins = join(t.root, "config", "plugins");
    expect(await readdir(join(plugins, "local-packages"))).toEqual(["alisio-plugin-ica-0.2.0.tgz"]);
    const config = JSON.parse(await readFile(join(t.root, "config", "config.json"), "utf8"));
    expect(config.plugins).toEqual(["@alisio/plugin-ica"]);
    const packages = (await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<
      InstalledPluginPackage[]
    >();
    expect(packages[0]).toMatchObject({
      version: "0.2.0",
      restartRequired: true,
      local: true,
      updateAvailable: false,
    });
    expect(packages[0]?.latestVersion).toBeUndefined();
  });
});

describe("uninstalling a local plugin", () => {
  it("removes the package, the stored tarball and the config entry", async () => {
    const { t, wid } = await start();
    const info = await inspect(t);
    await runJob(t, info.stagingId as string);
    const res = await t.api.delete(
      `/api/plugins/package/${encodeURIComponent("@alisio/plugin-ica")}`,
    );
    expect(res.status).toBe(200);
    const plugins = join(t.root, "config", "plugins");
    expect(await readdir(join(plugins, "local-packages"))).toEqual([]);
    const config = JSON.parse(await readFile(join(t.root, "config", "config.json"), "utf8"));
    expect(config.plugins).toEqual([]);
    const list = (await t.api.get(`/api/plugins?workspace=${wid}`)).json<PluginInfo[]>();
    expect(list.some((p) => p.id === "fake-ica")).toBe(false);
  });
});
