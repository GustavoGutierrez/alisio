import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type InstallRunner, inspectPluginTarball } from "@alisio/core";
import type {
  PluginCreatorBuildResponse,
  PluginCreatorFile,
  PluginCreatorFileList,
  PluginCreatorProjectEntry,
  PluginCreatorSessionResponse,
  PluginCreatorStatus,
  SessionDetail,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { JobView } from "../packages/server/src/plugins/jobs.ts";
import { raw, startTestServer, type TestServer, until } from "./server-helpers.ts";

interface NpmState {
  calls: string[][];
}

/** A fake npm: "installs" a tarball by writing its manifest and a loadable plugin. */
function fakeNpm(state: NpmState): InstallRunner {
  return async (_c, args) => {
    state.calls.push(args);
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
    const info = await inspectPluginTarball(target);
    const name = info.name as string;
    const dir = join(prefix, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name, version: info.version, type: "module", main: "index.js" }),
    );
    await writeFile(
      join(dir, "index.js"),
      `export default { id: "fake-created", version: ${JSON.stringify(info.version)}, apiVersion: 1, setup() {} };\n`,
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

async function start(options: { readOnly?: boolean } = {}) {
  const npm: NpmState = { calls: [] };
  t = await startTestServer({
    app: { ...(options.readOnly ? { readOnly: true } : {}) },
    pluginCatalog: {
      url: "http://127.0.0.1:9/catalog.json",
      installRunner: fakeNpm(npm),
      sdkVersion: "0.11.7",
    },
  });
  return { t, npm };
}

const BASE = "/api/plugin-creator/projects";

async function create(tt: TestServer, body: Record<string, unknown> = { request: "Count words" }) {
  const res = await tt.api.post(BASE, body);
  expect(res.status).toBe(201);
  return res.json<PluginCreatorProjectEntry>().project;
}

const errorCode = (res: { json<T>(): T }) => res.json<{ error: { code: string } }>().error.code;

describe("plugin creator routes: projects", () => {
  it("creates, lists and reads projects with their install status", async () => {
    const { t } = await start();
    const project = await create(t, { request: "Count words in a text", displayName: "Words" });
    expect(project).toMatchObject({ displayName: "Words", version: "1.0.0" });
    const list = (await t.api.get(BASE)).json<{ projects: PluginCreatorProjectEntry[] }>();
    expect(list.projects.map((p) => p.project.id)).toEqual([project.id]);
    expect(list.projects[0]?.status).toMatchObject({ installed: false, updateAvailable: false });
    const one = (await t.api.get(`${BASE}/${project.id}`)).json<PluginCreatorProjectEntry>();
    expect(one.project.id).toBe(project.id);
    const pkg = JSON.parse(
      (
        await readFile(
          join(t.root, "config", "plugin-creator", "projects", project.id, "package.json"),
          "utf8",
        )
      ).toString(),
    );
    expect(pkg.peerDependencies).toEqual({ "@alisio/sdk": "^0.11.0" });
  });

  it("validates input and answers stable codes for unknown projects", async () => {
    const { t } = await start();
    expect((await t.api.post(BASE, {})).status).toBe(400);
    expect((await t.api.post(BASE, { request: "x", extra: 1 })).status).toBe(400);
    const missing = await t.api.get(`${BASE}/aaaaaaaaaaaa`);
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe("plugin_project_not_found");
    expect(errorCode(await t.api.get(`${BASE}/nope`))).toBe("plugin_project_not_found");
  });

  it("rejects a model that is not configured", async () => {
    const { t } = await start();
    const res = await t.api.post(BASE, { request: "Count words", model: "nobody/nothing" });
    expect(res.status).toBe(400);
    expect(res.json<{ error: { details: { fields: string[] } } }>().error.details.fields).toEqual([
      "model",
    ]);
    expect((await t.api.get(BASE)).json<{ projects: unknown[] }>().projects).toEqual([]);
  });

  it("refuses mutations under --read-only", async () => {
    const { t } = await start({ readOnly: true });
    const res = await t.api.post(BASE, { request: "Count words" });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe("capability_ceiling");
  });
});

describe("plugin creator routes: session", () => {
  it("creates the creator session once, then resumes it and records new requests", async () => {
    const { t } = await start();
    const project = await create(t);
    const first = await t.api.post(`${BASE}/${project.id}/session`, {});
    expect(first.status).toBe(201);
    const session = first.json<PluginCreatorSessionResponse>();
    expect(session.created).toBe(true);
    const detail = (await t.api.get(`/api/sessions/${session.sessionId}`)).json<SessionDetail>();
    expect(detail).toMatchObject({ agent: "plugin-creator", preset: "ask" });
    expect(detail.workspace.endsWith(project.id)).toBe(true);

    const again = await t.api.post(`${BASE}/${project.id}/session`, {
      request: "Also count lines",
    });
    expect(again.status).toBe(200);
    expect(again.json<PluginCreatorSessionResponse>()).toMatchObject({
      sessionId: session.sessionId,
      created: false,
    });
    const got = (await t.api.get(`${BASE}/${project.id}`)).json<PluginCreatorProjectEntry>();
    expect(got.project.requests.map((r) => r.kind)).toEqual(["create", "modify"]);
    expect(got.project.sessionId).toBe(session.sessionId);
    const bad = await t.api.post(`${BASE}/${project.id}/session`, { model: "nobody/nothing" });
    expect(bad.status).toBe(400);
  });

  it("keeps creator projects out of the workspace list and the default session list", async () => {
    const { t } = await start();
    const project = await create(t);
    const { sessionId } = (
      await t.api.post(`${BASE}/${project.id}/session`, {})
    ).json<PluginCreatorSessionResponse>();
    const workspaces = (await t.api.get("/api/workspaces")).json<Array<{ path: string }>>();
    expect(workspaces.some((w) => w.path.includes("plugin-creator"))).toBe(false);
    const sessions = (await t.api.get("/api/sessions")).json<{ items: Array<{ id: string }> }>();
    expect(sessions.items.some((s) => s.id === sessionId)).toBe(false);
    const mine = (await t.api.get("/api/sessions?agent=plugin-creator")).json<{
      items: Array<{ id: string }>;
    }>();
    expect(mine.items.map((s) => s.id)).toContain(sessionId);
  });
});

describe("plugin creator routes: files, build, package, install, delete", () => {
  it("lists and reads files inside the project only", async () => {
    const { t } = await start();
    const project = await create(t);
    const list = (await t.api.get(`${BASE}/${project.id}/files`)).json<PluginCreatorFileList>();
    expect(list.files.map((f) => f.path)).toContain("src/index.js");
    const file = (
      await t.api.get(`${BASE}/${project.id}/files/src/index.js`)
    ).json<PluginCreatorFile>();
    expect(file).toMatchObject({ path: "src/index.js", binary: false });
    expect(file.text).toContain("apiVersion: 1");
    const escape = await t.api.get(`${BASE}/${project.id}/files/..%2F..%2Frecords`);
    expect([403, 404]).toContain(escape.status);
    expect((await t.api.get(`${BASE}/${project.id}/files/nope.js`)).status).toBe(404);
  });

  it("builds, downloads, installs, detects an update and deletes with uninstall", async () => {
    const { t, npm } = await start();
    const project = await create(t);
    const notBuilt = await t.api.get(`${BASE}/${project.id}/package`);
    expect(notBuilt.status).toBe(409);
    expect(errorCode(notBuilt)).toBe("plugin_not_built");

    const build = await t.api.post(`${BASE}/${project.id}/build`, {});
    expect(build.status).toBe(200);
    const built = build.json<PluginCreatorBuildResponse>();
    expect(built).toMatchObject({ ok: true, status: { packageReady: true } });
    expect(built.build.testsPassed).toBeGreaterThan(0);

    const download = await raw(t.server.port, `${BASE}/${project.id}/package`, {
      headers: { Cookie: t.cookie },
    });
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/gzip");
    expect(String(download.headers["content-disposition"])).toContain(".tgz");
    expect(Number(download.headers["content-length"])).toBeGreaterThan(0);

    expect((await t.api.post(`${BASE}/${project.id}/install`, {})).status).toBe(400);
    const install = await t.api.post(`${BASE}/${project.id}/install`, { confirmed: true });
    expect(install.status).toBe(202);
    const { jobId } = install.json<{ jobId: string }>();
    const job = await until(async () => {
      const view = (await t?.api.get(`/api/plugins/jobs/${jobId}`))?.json<JobView>();
      return view?.done ? view : undefined;
    }, 15_000);
    expect(job?.error).toBeUndefined();
    expect(job?.result).toMatchObject({
      package: project.packageName,
      installedVersion: "1.0.0",
      projectId: project.id,
    });
    expect(
      (await t.api.get(`${BASE}/${project.id}/status`)).json<PluginCreatorStatus>(),
    ).toMatchObject({ installed: true, installedVersion: "1.0.0", local: true });

    const pkgFile = join(
      t.root,
      "config",
      "plugin-creator",
      "projects",
      project.id,
      "package.json",
    );
    const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
    await writeFile(pkgFile, JSON.stringify({ ...pkg, version: "1.0.1" }));
    expect(
      (await t.api.get(`${BASE}/${project.id}/status`)).json<PluginCreatorStatus>(),
    ).toMatchObject({ updateAvailable: true, projectVersion: "1.0.1", packageReady: false });

    const deleted = await t.api.delete(`${BASE}/${project.id}`, {});
    expect(deleted.status).toBe(400); // body {uninstall} is required to say what to do
    const removed = await raw(t.server.port, `${BASE}/${project.id}`, {
      method: "DELETE",
      body: { uninstall: true },
      headers: {
        Cookie: t.cookie,
        Origin: `http://127.0.0.1:${t.server.port}`,
        "Content-Type": "application/json",
      },
    });
    expect(removed.status).toBe(200);
    expect(removed.json<{ deleted: boolean; uninstalled: boolean }>()).toMatchObject({
      deleted: true,
      uninstalled: true,
    });
    expect(npm.calls.some((args) => args[0] === "uninstall")).toBe(true);
    expect((await t.api.get(`${BASE}/${project.id}`)).status).toBe(404);
  });

  it("re-checks compatibility with the installed SDK right before installing", async () => {
    const { t, npm } = await start();
    const project = await create(t);
    expect((await t.api.post(`${BASE}/${project.id}/build`, {})).status).toBe(200);
    const pkgFile = join(
      t.root,
      "config",
      "plugin-creator",
      "projects",
      project.id,
      "package.json",
    );
    const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
    await writeFile(
      pkgFile,
      JSON.stringify({ ...pkg, peerDependencies: { "@alisio/sdk": "^0.12.0" } }),
    );
    const res = await t.api.post(`${BASE}/${project.id}/install`, { confirmed: true });
    expect(res.status).toBe(422);
    const body = res.json<{ error: { code: string; details: PluginCreatorBuildResponse } }>();
    expect(body.error.code).toBe("plugin_project_invalid");
    expect(body.error.details.issues.map((i) => i.code)).toContain("sdk_incompatible");
    expect(npm.calls).toEqual([]);
  });

  it("answers 422 plugin_tests_failed with the build details when tests fail", async () => {
    const { t } = await start();
    const project = await create(t);
    await writeFile(
      join(t.root, "config", "plugin-creator", "projects", project.id, "test", "x.test.js"),
      'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("no", () => assert.equal(1, 2));\n',
    );
    const res = await t.api.post(`${BASE}/${project.id}/build`, {});
    expect(res.status).toBe(422);
    const body = res.json<{ error: { code: string; details: PluginCreatorBuildResponse } }>();
    expect(body.error.code).toBe("plugin_tests_failed");
    expect(body.error.details.build.testsFailed).toBe(1);
    expect((await t.api.post(`${BASE}/${project.id}/install`, { confirmed: true })).status).toBe(
      422,
    );
  });
});

describe("plugin creator routes: icon", () => {
  it("serves the project icon with a locked-down content type and 404 without one", async () => {
    const { t } = await start();
    const project = await create(t);
    const icon = await raw(t.server.port, `${BASE}/${project.id}/icon`, {
      headers: { Cookie: t.cookie },
    });
    expect(icon.status).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/svg+xml");
    expect(icon.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(icon.headers["content-security-policy"])).toContain("default-src 'none'");
    const pkgFile = join(
      t.root,
      "config",
      "plugin-creator",
      "projects",
      project.id,
      "package.json",
    );
    const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
    delete pkg.alisio.icon;
    await writeFile(pkgFile, JSON.stringify(pkg));
    const none = await t.api.get(`${BASE}/${project.id}/icon`);
    expect(none.status).toBe(404);
    const entry = (await t.api.get(`${BASE}/${project.id}`)).json<PluginCreatorProjectEntry>();
    expect(entry.project.icon).toBeUndefined();
    expect(entry.project.dir).toContain(project.id);
  });
});
