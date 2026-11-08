import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { BuiltinPlugin, InstallRunner } from "@alisio/core";
import { definePlugin, type PluginInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeCatalog } from "../packages/server/src/plugins/catalog-schema.ts";
import type {
  InstalledPluginPackage,
  PluginCatalogResponse,
  PluginInstallResponse,
  PluginUninstallResponse,
  PluginUpdateAllResponse,
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

// ---- A fake catalog origin -------------------------------------------------------------------

interface FakeCatalog {
  url: string;
  origin: string;
  hits: { catalog: number; conditional: number; covers: number };
  setPlugins(plugins: Array<Record<string, unknown>>, etag?: string): void;
  offline: boolean;
  /** Extra cover files by name (`pic.webp`); the rest are the default SVG. */
  covers: Record<string, Buffer>;
  close(): Promise<void>;
}

const COVER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

function plugin(origin: string, slug: string, extra: Record<string, unknown> = {}) {
  return {
    id: slug,
    slug,
    name: slug.toUpperCase(),
    package: `@alisio/plugin-${slug}`,
    version: "0.5.0",
    description: `The ${slug} plugin`,
    categories: ["tools"],
    tags: [slug, "demo"],
    cover: `${origin}/covers/${slug}.svg`,
    icon: null,
    sdk: "^0.9.0",
    author: "Alisio",
    license: "MIT",
    homepage: "https://example.test/home",
    npmUrl: "https://www.npmjs.com/package/x",
    repository: "https://example.test/repo",
    publishedAt: "2026-10-15T01:57:00.102Z",
    featured: false,
    source: "local",
    ...extra,
  };
}

async function startCatalog(
  build: (origin: string) => Array<Record<string, unknown>>,
): Promise<FakeCatalog> {
  let etag = '"v1"';
  let plugins: Array<Record<string, unknown>> = [];
  const state: FakeCatalog = {
    url: "",
    origin: "",
    hits: { catalog: 0, conditional: 0, covers: 0 },
    setPlugins(next, nextEtag) {
      plugins = next;
      if (nextEtag) etag = nextEtag;
    },
    offline: false,
    covers: {},
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    if (state.offline) {
      req.socket.destroy();
      return;
    }
    if (req.url === "/catalog.json") {
      state.hits.catalog++;
      if (req.headers["if-none-match"]) state.hits.conditional++;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag });
      res.end(JSON.stringify({ schemaVersion: 1, generatedAt: "2026-10-15T00:00:00Z", plugins }));
      return;
    }
    if (req.url?.startsWith("/covers/")) {
      state.hits.covers++;
      const custom = state.covers[req.url.slice("/covers/".length)];
      res.writeHead(200, { "content-type": custom ? "application/octet-stream" : "image/svg+xml" });
      res.end(custom ?? COVER);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.url = `${state.origin}/catalog.json`;
  plugins = build(state.origin);
  return state;
}

// ---- A fake npm ------------------------------------------------------------------------------

interface NpmState {
  calls: string[][];
  gate?: Promise<void>;
  /** What `@latest` resolves to. */
  latest: string;
  /** A version npm answers ETARGET for (listed in the catalog, not published yet). */
  unpublished?: string;
  /** Answers ERESOLVE for an install of these targets (a peer conflict with other plugins). */
  conflict?: (targets: string[]) => boolean;
  /** Fails every install with this npm output (a generic failure, not a peer conflict). */
  fail?: string;
}

/** Writes (install) or deletes (uninstall) a real, loadable plugin package under the prefix. */
function fakeNpm(state: NpmState): InstallRunner {
  return async (_command, args) => {
    state.calls.push(args);
    await state.gate;
    const prefix = args[args.indexOf("--prefix") + 1] as string;
    const targets = args.slice(args.indexOf("--prefix") + 2);
    if (state.fail !== undefined)
      return { stdout: "", stderr: state.fail, exitCode: 1, truncated: false };
    if (state.conflict?.(targets))
      return {
        stdout: "",
        stderr:
          'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error peer @alisio/sdk@">=0.9.0 <0.12.0" from @alisio/plugin-beta@0.5.0',
        exitCode: 1,
        truncated: false,
      };
    for (const target of targets) {
      const at = target.lastIndexOf("@");
      const name = at > 0 ? target.slice(0, at) : target;
      const asked = at > 0 ? target.slice(at + 1) : "latest";
      const dir = join(prefix, "node_modules", name);
      if (args[0] === "uninstall") {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      if (state.unpublished && asked === state.unpublished)
        return {
          stdout: "",
          stderr: `npm error code ETARGET\nnpm error notarget No matching version found for ${name}@${asked}.`,
          exitCode: 1,
          truncated: false,
        };
      const version = asked === "latest" ? state.latest : asked;
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name,
          version,
          type: "module",
          main: "index.js",
          keywords: ["alisio-plugin"],
        }),
      );
      const id = name.replace(/^@alisio\/plugin-/, "fake-");
      await writeFile(
        join(dir, "index.js"),
        `export default { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, version: ${JSON.stringify(version)}, apiVersion: 1, setup() {} };\n`,
      );
    }
    return {
      stdout: args[0] === "uninstall" ? "removed" : "added 1 package",
      stderr: "",
      exitCode: 0,
      truncated: false,
    };
  };
}

// ---- Harness ---------------------------------------------------------------------------------

const demo: BuiltinPlugin = {
  id: "demo",
  description: "Demo",
  create: () => definePlugin({ id: "demo", version: "1.0.0", apiVersion: 1, setup() {} }),
};

let t: TestServer | undefined;
let catalog: FakeCatalog | undefined;
afterEach(async () => {
  await t?.close();
  await catalog?.close();
  t = undefined;
  catalog = undefined;
  vi.unstubAllEnvs();
});

async function start(
  options: {
    plugins?: (origin: string) => Array<Record<string, unknown>>;
    now?: () => number;
    npm?: Partial<NpmState>;
    readOnly?: boolean;
    sdkVersion?: string;
    provider?: ReturnType<typeof gatedProvider>;
  } = {},
) {
  catalog = await startCatalog(
    options.plugins ?? ((origin) => [plugin(origin, "alpha"), plugin(origin, "beta")]),
  );
  const npm: NpmState = { calls: [], latest: "0.5.0", ...options.npm };
  t = await startTestServer({
    ...(options.provider ? { provider: options.provider.provider } : {}),
    app: { builtins: [demo], trustProject: true, ...(options.readOnly ? { readOnly: true } : {}) },
    pluginCatalog: {
      url: catalog.url,
      installRunner: fakeNpm(npm),
      sdkVersion: options.sdkVersion ?? "0.9.0",
      ...(options.now ? { now: options.now } : {}),
    },
  });
  const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  return { t, wid, catalog, npm };
}

const getCatalog = async (tt: TestServer, query = "") => tt.api.get(`/api/plugin-catalog${query}`);

describe("GET /api/plugin-catalog caching", () => {
  it("downloads once, then serves the cache without touching the network", async () => {
    const { t, catalog } = await start();
    const first = await getCatalog(t);
    expect(first.status).toBe(200);
    const body = first.json<PluginCatalogResponse>();
    expect(body.meta).toMatchObject({ fromCache: false, stale: false, offline: false });
    expect(body.catalog.plugins.map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(body.catalog.categories).toEqual([{ id: "tools", count: 2 }]);
    expect(body.sdkVersion).toBe("0.9.0");
    expect(body.installed).toEqual([]);
    expect(catalog.hits.catalog).toBe(1);
    const second = (await getCatalog(t)).json<PluginCatalogResponse>();
    expect(second.meta).toMatchObject({ fromCache: true, stale: false, offline: false });
    expect(second.meta.fetchedAt).toBe(body.meta.fetchedAt);
    expect(catalog.hits.catalog).toBe(1);
    // The cache lives under the state home.
    const cached = JSON.parse(
      await readFile(join(t.root, "state", "cache", "plugin-catalog.json"), "utf8"),
    );
    expect(cached.meta.etag).toBe('"v1"');
  });

  it("revalidates with If-None-Match on refresh=1 and keeps the cache on a 304", async () => {
    let clock = 1_000_000;
    const { t, catalog } = await start({ now: () => clock });
    const first = (await getCatalog(t)).json<PluginCatalogResponse>();
    clock += 60_000;
    const again = (await getCatalog(t, "?refresh=1")).json<PluginCatalogResponse>();
    expect(catalog.hits).toMatchObject({ catalog: 2, conditional: 1 });
    expect(again.meta).toMatchObject({ fromCache: true, offline: false });
    expect(again.meta.checkedAt).toBe(first.meta.checkedAt + 60_000);
    expect(again.meta.fetchedAt).toBe(first.meta.fetchedAt);
  });

  it("downloads the new catalog when it changed", async () => {
    const { t, catalog } = await start();
    await getCatalog(t);
    catalog.setPlugins([plugin(catalog.origin, "gamma")], '"v2"');
    const body = (await getCatalog(t, "?refresh=1")).json<PluginCatalogResponse>();
    expect(body.meta.fromCache).toBe(false);
    expect(body.catalog.plugins.map((p) => p.slug)).toEqual(["gamma"]);
  });

  it("does not re-check before 24 hours, then revalidates", async () => {
    let clock = 5_000_000;
    const { t, catalog } = await start({ now: () => clock });
    await getCatalog(t);
    clock += 23 * 3_600_000;
    await getCatalog(t);
    expect(catalog.hits.catalog).toBe(1);
    clock += 2 * 3_600_000;
    const body = (await getCatalog(t)).json<PluginCatalogResponse>();
    expect(catalog.hits.catalog).toBe(2);
    expect(body.meta.fromCache).toBe(true);
    expect(body.meta.stale).toBe(false);
  });

  it("serves the cache with an offline notice when the origin is unreachable", async () => {
    const { t, catalog } = await start();
    await getCatalog(t);
    catalog.offline = true;
    const res = await getCatalog(t, "?refresh=1");
    expect(res.status).toBe(200);
    const body = res.json<PluginCatalogResponse>();
    expect(body.meta).toMatchObject({ fromCache: true, offline: true });
    expect(body.meta.error).toEqual(expect.any(String));
    expect(body.catalog.plugins).toHaveLength(2);
  });

  it("marks an expired cache as stale while offline", async () => {
    let clock = 1_000;
    const { t, catalog } = await start({ now: () => clock });
    await getCatalog(t);
    catalog.offline = true;
    clock += 30 * 3_600_000;
    const body = (await getCatalog(t)).json<PluginCatalogResponse>();
    expect(body.meta).toMatchObject({ offline: true, stale: true, fromCache: true });
  });

  it("fails with a clear error when offline and nothing is cached", async () => {
    const { t, catalog } = await start();
    catalog.offline = true;
    const res = await getCatalog(t);
    expect(res.status).toBe(502);
    expect(res.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "provider_unavailable",
      message: expect.stringContaining("no cached copy"),
    });
    // And recovers once the origin is back.
    catalog.offline = false;
    expect((await getCatalog(t, "?refresh=1")).status).toBe(200);
  });

  it("rejects a malformed refresh value and honours ALISIO_PLUGIN_CATALOG_URL", async () => {
    const fake = await startCatalog((origin) => [plugin(origin, "envy")]);
    vi.stubEnv("ALISIO_PLUGIN_CATALOG_URL", fake.url);
    t = await startTestServer({ app: { builtins: [demo], trustProject: true } });
    catalog = fake;
    expect((await getCatalog(t, "?refresh=maybe")).status).toBe(400);
    const body = (await getCatalog(t)).json<PluginCatalogResponse>();
    expect(body.catalog.plugins.map((p) => p.slug)).toEqual(["envy"]);
  });

  it("requires authentication", async () => {
    const { t } = await start();
    expect((await raw(t.server.port, "/api/plugin-catalog")).status).toBe(401);
  });
});

describe("catalog sanitization", () => {
  const url = "https://catalog.example/plugins/catalog.json";
  const good = {
    slug: "ok",
    name: "Ok",
    package: "@alisio/plugin-ok",
    version: "1.0.0",
    cover: "https://catalog.example/plugins/covers/ok.svg",
  };

  it("drops an off-origin or non-https cover but keeps the entry", () => {
    const result = sanitizeCatalog(
      {
        schemaVersion: 1,
        plugins: [
          { ...good, slug: "a", package: "a-pkg", cover: "https://evil.example/c.svg" },
          { ...good, slug: "b", package: "b-pkg", cover: "http://catalog.example/c.svg" },
          { ...good, slug: "c", package: "c-pkg", cover: "javascript:alert(1)" },
          good,
        ],
      },
      url,
    );
    expect(result.plugins.map((p) => [p.slug, p.coverSource])).toEqual([
      ["a", undefined],
      ["b", undefined],
      ["c", undefined],
      ["ok", good.cover],
    ]);
  });

  it("drops non-https links, entries with an invalid package or version, and duplicates", () => {
    const result = sanitizeCatalog(
      {
        schemaVersion: 1,
        plugins: [
          {
            ...good,
            homepage: "javascript:alert(1)",
            repository: "http://x.example",
            npmUrl: "https://user:pw@x.example",
          },
          { ...good, slug: "bad", package: "../evil" },
          { ...good, slug: "bad2", package: "pkg; rm -rf /" },
          { ...good, slug: "bad3", package: "git:x/y" },
          { ...good, slug: "bad4", package: "@alisio/plugin-v@1.0.0" },
          { ...good, slug: "ver", package: "ver-pkg", version: "latest" },
          { ...good, slug: "dup" },
          { ...good, slug: "ok", package: "other-pkg" },
          "not an object",
        ],
      },
      url,
    );
    expect(result.plugins).toHaveLength(1);
    const [entry] = result.plugins;
    expect(entry).toMatchObject({ slug: "ok", package: "@alisio/plugin-ok" });
    expect(entry?.homepage).toBeUndefined();
    expect(entry?.repository).toBeUndefined();
    expect(entry?.npmUrl).toBeUndefined();
  });

  it("caps field lengths and recomputes the category counts", () => {
    const result = sanitizeCatalog(
      {
        schemaVersion: 1,
        categories: [{ id: "tools", count: 999 }],
        plugins: [
          {
            ...good,
            name: "n".repeat(500),
            package: "long-name",
            slug: "long",
            categories: ["tools", "ui"],
            tags: ["x".repeat(100), "fine"],
          },
          { ...good, slug: "two", package: "two-pkg", categories: ["tools"] },
        ],
      },
      url,
    );
    expect(result.plugins.map((p) => p.slug)).toEqual(["two"]);
    expect(result.categories).toEqual([{ id: "tools", count: 1 }]);
    const tags = sanitizeCatalog(
      { schemaVersion: 1, plugins: [{ ...good, tags: ["x".repeat(100), "fine"] }] },
      url,
    ).plugins[0]?.tags;
    expect(tags).toEqual(["fine"]);
  });

  it("refuses another schema version and a non-object", () => {
    expect(() => sanitizeCatalog({ schemaVersion: 2, plugins: [] }, url)).toThrow(/schema/);
    expect(() => sanitizeCatalog([], url)).toThrow();
  });

  it("serves a sanitized catalog over the route and never exposes remote cover URLs", async () => {
    const { t, catalog } = await start({
      plugins: (origin) => [
        plugin(origin, "alpha"),
        plugin(origin, "offsite", { cover: "https://evil.example/c.svg" }),
        plugin(origin, "bogus", { package: "../x" }),
      ],
    });
    const body = (await getCatalog(t)).json<PluginCatalogResponse>();
    expect(body.catalog.plugins.map((p) => p.slug)).toEqual(["alpha", "offsite"]);
    expect(body.catalog.plugins[0]?.cover).toBe("/api/plugin-catalog/covers/alpha");
    expect(body.catalog.plugins[1]?.cover).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(catalog.origin);
  });
});

describe("GET /api/plugin-catalog/covers/:slug", () => {
  it("proxies the cover with locked-down headers and then serves it from disk", async () => {
    const { t, catalog } = await start();
    const res = await t.api.get("/api/plugin-catalog/covers/alpha");
    expect(res.status).toBe(200);
    expect(res.text).toBe(COVER);
    expect(res.headers["content-type"]).toBe("image/svg+xml");
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["cache-control"])).toMatch(/max-age=\d+/);
    expect(catalog.hits.covers).toBe(1);
    const again = await t.api.get("/api/plugin-catalog/covers/alpha");
    expect(again.status).toBe(200);
    expect(catalog.hits.covers).toBe(1);
    expect((await readdir(join(t.root, "state", "cache", "plugin-covers"))).sort()).toContain(
      "alpha.svg",
    );
    // Conditional request from the browser cache.
    const etag = String(res.headers.etag);
    const conditional = await t.api.get("/api/plugin-catalog/covers/alpha", {
      "If-None-Match": etag,
    });
    expect(conditional.status).toBe(304);
  });

  it("proxies raster covers (WebP, PNG, JPEG) with their real type and refuses non-images", async () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([4, 0, 0, 0]),
      Buffer.from("WEBPVP8 "),
    ]);
    const { t, catalog } = await start({
      plugins: (origin) => [
        plugin(origin, "pic", { cover: `${origin}/covers/pic.webp` }),
        plugin(origin, "html", { cover: `${origin}/covers/html.svg` }),
      ],
    });
    catalog.covers = { "pic.webp": webp, "html.svg": Buffer.from("<html>not an image</html>") };
    const res = await t.api.get("/api/plugin-catalog/covers/pic");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/webp");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect((await t.api.get("/api/plugin-catalog/covers/html")).status).toBe(404);
  });

  it("refetches the cover when the catalog changed and keeps the copy when the origin is down", async () => {
    const { t, catalog } = await start();
    await t.api.get("/api/plugin-catalog/covers/alpha");
    catalog.setPlugins([plugin(catalog.origin, "alpha", { version: "0.6.0" })], '"v2"');
    await getCatalog(t, "?refresh=1");
    await t.api.get("/api/plugin-catalog/covers/alpha");
    expect(catalog.hits.covers).toBe(2);
    catalog.setPlugins([plugin(catalog.origin, "alpha", { version: "0.7.0" })], '"v3"');
    await getCatalog(t, "?refresh=1");
    catalog.offline = true;
    const res = await t.api.get("/api/plugin-catalog/covers/alpha");
    expect(res.status).toBe(200);
    expect(res.text).toBe(COVER);
  });

  it("only serves covers of catalog plugins that have a same-origin cover", async () => {
    const { t, catalog } = await start({
      plugins: (origin) => [
        plugin(origin, "alpha"),
        plugin(origin, "offsite", { cover: "https://evil.example/c.svg" }),
      ],
    });
    expect((await t.api.get("/api/plugin-catalog/covers/offsite")).status).toBe(404);
    expect((await t.api.get("/api/plugin-catalog/covers/unknown")).status).toBe(404);
    expect((await t.api.get("/api/plugin-catalog/covers/..%2Fcatalog")).status).toBe(404);
    expect(catalog.hits.covers).toBe(0);
  });
});

describe("POST /api/plugins/install", () => {
  const body = { package: "@alisio/plugin-alpha", confirmed: true };

  it("requires confirmed: true", async () => {
    const { t, npm } = await start();
    expect((await t.api.post("/api/plugins/install", { package: body.package })).status).toBe(400);
    expect((await t.api.post("/api/plugins/install", { ...body, confirmed: false })).status).toBe(
      400,
    );
    expect(npm.calls).toEqual([]);
  });

  it("only installs packages listed in the catalog, at the catalog version", async () => {
    const { t, npm } = await start();
    const unknown = await t.api.post("/api/plugins/install", {
      package: "left-pad",
      confirmed: true,
    });
    expect(unknown.status).toBe(400);
    expect(
      unknown.json<{ error: { details: { fields: string[] } } }>().error.details.fields,
    ).toEqual(["package"]);
    const wrongVersion = await t.api.post("/api/plugins/install", { ...body, version: "9.9.9" });
    expect(wrongVersion.status).toBe(400);
    expect(npm.calls).toEqual([]);
    const ok = await t.api.post("/api/plugins/install", { ...body, version: "0.5.0" });
    expect(ok.status).toBe(200);
    expect(npm.calls[0]?.at(-1)).toBe("@alisio/plugin-alpha@0.5.0");
  });

  it("installs, lists the plugin immediately and reports the package", async () => {
    const { t, wid, catalog } = await start();
    // The workspace is open (the settings page loaded it) when the install runs.
    await t.api.get(`/api/plugins?workspace=${wid}`);
    const stream = openStream(t.server.port, t.cookie);
    await stream.next((e) => e.frame.t === "hello");
    const res = await t.api.post("/api/plugins/install", body);
    expect(res.status).toBe(200);
    expect(res.json<PluginInstallResponse>()).toEqual({
      package: "@alisio/plugin-alpha",
      installedVersion: "0.5.0",
      alreadyInstalled: false,
      updated: false,
      restartPending: false,
      restartRequired: false,
    });
    await stream.next((e) => e.frame.t === "catalog_changed" && e.frame.scope === "plugins");
    stream.close();
    const list = (await t.api.get(`/api/plugins?workspace=${wid}`)).json<PluginInfo[]>();
    expect(list.find((p) => p.id === "fake-alpha")).toMatchObject({ status: "active" });
    const packages = (await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<
      InstalledPluginPackage[]
    >();
    expect(packages).toMatchObject([
      {
        package: "@alisio/plugin-alpha",
        version: "0.5.0",
        pluginIds: ["fake-alpha"],
        removable: true,
      },
    ]);
    const config = JSON.parse(await readFile(join(t.root, "config", "config.json"), "utf8"));
    expect(config.plugins).toEqual(["@alisio/plugin-alpha"]);
    const cat = (await getCatalog(t)).json<PluginCatalogResponse>();
    expect(cat.installed).toEqual([{ package: "@alisio/plugin-alpha", version: "0.5.0" }]);
    expect(cat.catalog.plugins[0]).toMatchObject({
      installedVersion: "0.5.0",
      updateAvailable: false,
    });
    expect(catalog.hits.catalog).toBe(1);
  });

  it("updates in place: reinstall, update and downgrade replace the package, never duplicate it", async () => {
    const { t, wid, catalog, npm } = await start();
    // The workspace is open, so a plugin that gets installed is imported by this process.
    await t.api.get(`/api/plugins?workspace=${wid}`);
    const first = (await t.api.post("/api/plugins/install", body)).json<PluginInstallResponse>();
    expect(first).toMatchObject({
      alreadyInstalled: false,
      updated: false,
      restartRequired: false,
    });
    // Same version: a reinstall.
    const again = (await t.api.post("/api/plugins/install", body)).json<PluginInstallResponse>();
    expect(again).toMatchObject({
      alreadyInstalled: true,
      updated: true,
      previousVersion: "0.5.0",
      installedVersion: "0.5.0",
      restartRequired: true,
    });
    expect(npm.calls).toHaveLength(2);
    expect(npm.calls[1]?.at(-1)).toBe("@alisio/plugin-alpha@0.5.0");
    // Higher catalog version: an update, pinned to that version.
    catalog.setPlugins([plugin(catalog.origin, "alpha", { version: "0.6.0" })], '"v2"');
    const cat = (await getCatalog(t, "?refresh=1")).json<PluginCatalogResponse>();
    expect(cat.catalog.plugins[0]).toMatchObject({
      installedVersion: "0.5.0",
      updateAvailable: true,
    });
    const updated = (await t.api.post("/api/plugins/install", body)).json<PluginInstallResponse>();
    expect(updated).toMatchObject({
      installedVersion: "0.6.0",
      previousVersion: "0.5.0",
      updated: true,
      restartRequired: true,
    });
    expect(npm.calls[2]?.at(-1)).toBe("@alisio/plugin-alpha@0.6.0");
    // Lower catalog version: a downgrade.
    catalog.setPlugins([plugin(catalog.origin, "alpha", { version: "0.4.0" })], '"v3"');
    await getCatalog(t, "?refresh=1");
    const down = (await t.api.post("/api/plugins/install", body)).json<PluginInstallResponse>();
    expect(down).toMatchObject({
      installedVersion: "0.4.0",
      previousVersion: "0.6.0",
      updated: true,
    });
    const config = JSON.parse(await readFile(join(t.root, "config", "config.json"), "utf8"));
    expect(config.plugins).toEqual(["@alisio/plugin-alpha"]);
    // The packages list says this process still runs the old code.
    const packages = (await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<
      InstalledPluginPackage[]
    >();
    expect(packages[0]).toMatchObject({ version: "0.4.0", restartRequired: true });
    // Uninstalling clears the pending restart.
    await t.api.delete(`/api/plugins/package/${encodeURIComponent("@alisio/plugin-alpha")}`);
    expect((await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<unknown[]>()).toEqual(
      [],
    );
  });

  it("reports update availability per installed package from the cached catalog", async () => {
    const { t, wid, catalog } = await start({
      plugins: (origin) => [
        plugin(origin, "alpha"),
        plugin(origin, "beta", { sdk: "^0.8.0" }),
        plugin(origin, "gamma"),
      ],
    });
    for (const slug of ["alpha", "beta", "gamma"])
      await t.api.post("/api/plugins/install", {
        package: `@alisio/plugin-${slug}`,
        confirmed: true,
      });
    // beta needs an older SDK: its install is refused, so it never shows up as installed.
    const hits = catalog.hits.catalog;
    const list = async () =>
      (await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<InstalledPluginPackage[]>();
    // Equal versions: nothing to update, and no extra network.
    expect((await list()).map((p) => [p.package, p.updateAvailable])).toEqual([
      ["@alisio/plugin-alpha", false],
      ["@alisio/plugin-gamma", false],
    ]);
    expect(catalog.hits.catalog).toBe(hits);
    catalog.setPlugins(
      [
        plugin(catalog.origin, "alpha", { version: "0.6.0" }),
        plugin(catalog.origin, "gamma", { version: "0.4.0" }),
        plugin(catalog.origin, "delta", { version: "9.0.0" }),
      ],
      '"v2"',
    );
    // The cache is not stale: still no network, so still no update.
    expect((await list())[0]?.updateAvailable).toBe(false);
    await getCatalog(t, "?refresh=1");
    const after = await list();
    expect(after[0]).toMatchObject({
      package: "@alisio/plugin-alpha",
      latestVersion: "0.6.0",
      updateAvailable: true,
      updateCompatible: true,
      local: false,
    });
    // Catalog older than installed: not an update.
    expect(after[1]).toMatchObject({ latestVersion: "0.4.0", updateAvailable: false });
  });

  it("blocks an update that needs a newer sdk and reports no update for local or unlisted packages", async () => {
    const { t, wid, catalog } = await start({ sdkVersion: "0.9.0" });
    await t.api.post("/api/plugins/install", body);
    catalog.setPlugins(
      [plugin(catalog.origin, "alpha", { version: "0.6.0", sdk: "^1.0.0" })],
      '"v2"',
    );
    await getCatalog(t, "?refresh=1");
    const [pkg] = (await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<
      InstalledPluginPackage[]
    >();
    expect(pkg).toMatchObject({ updateAvailable: true, updateCompatible: false });
    const refused = await t.api.post("/api/plugins/install", body);
    expect(refused.status).toBe(400);
    // Unlisted package: no catalog info at all.
    catalog.setPlugins([plugin(catalog.origin, "other")], '"v3"');
    await getCatalog(t, "?refresh=1");
    const [unlisted] = (await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<
      InstalledPluginPackage[]
    >();
    expect(unlisted).toMatchObject({ updateAvailable: false, updateCompatible: true });
    expect(unlisted?.latestVersion).toBeUndefined();
  });

  it("falls back to the registry's latest when the catalog version is not published yet", async () => {
    const { t, npm } = await start({ npm: { unpublished: "0.5.0", latest: "0.4.0" } });
    const res = await t.api.post("/api/plugins/install", body);
    expect(res.status).toBe(200);
    expect(res.json<PluginInstallResponse>()).toMatchObject({ installedVersion: "0.4.0" });
    expect(npm.calls.map((call) => call.at(-1))).toEqual([
      "@alisio/plugin-alpha@0.5.0",
      "@alisio/plugin-alpha",
    ]);
  });

  it("a fresh install of a never-imported package does not need a restart", async () => {
    const { t } = await start();
    // No workspace is open: nothing imported the plugin.
    const res = (await t.api.post("/api/plugins/install", body)).json<PluginInstallResponse>();
    expect(res.restartRequired).toBe(false);
  });

  it("refuses a plugin whose sdk range does not match the installed @alisio/sdk", async () => {
    const { t, npm } = await start({
      sdkVersion: "0.9.0",
      plugins: (origin) => [plugin(origin, "alpha", { sdk: "^0.8.0" })],
    });
    const cat = (await getCatalog(t)).json<PluginCatalogResponse>();
    expect(cat.catalog.plugins[0]?.compatible).toBe(false);
    const res = await t.api.post("/api/plugins/install", body);
    expect(res.status).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain("^0.8.0");
    expect(npm.calls).toEqual([]);
  });

  it("is refused under --read-only", async () => {
    const { t, npm } = await start({ readOnly: true });
    const res = await t.api.post("/api/plugins/install", body);
    expect(res.status).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("capability_ceiling");
    expect(npm.calls).toEqual([]);
  });

  it("is refused without a matching Origin", async () => {
    const { t } = await start();
    const res = await raw(t.server.port, "/api/plugins/install", {
      method: "POST",
      body,
      headers: {
        Cookie: t.cookie,
        "Content-Type": "application/json",
        Origin: "http://evil.example",
      },
    });
    expect(res.status).toBe(403);
    const noOrigin = await raw(t.server.port, "/api/plugins/install", {
      method: "POST",
      body,
      headers: { Cookie: t.cookie, "Content-Type": "application/json" },
    });
    expect(noOrigin.status).toBe(403);
  });

  it("serializes mutations: a concurrent install or uninstall gets 409 runs_active", async () => {
    const gate = deferred();
    const { t, npm } = await start({ npm: { gate: gate.promise } });
    const first = t.api.post("/api/plugins/install", body);
    // Wait until the first request is inside npm.
    await until(() => npm.calls.length > 0);
    const second = await t.api.post("/api/plugins/install", {
      package: "@alisio/plugin-beta",
      confirmed: true,
    });
    expect(second.status).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("runs_active");
    gate.resolve();
    expect((await first).status).toBe(200);
    const after = await t.api.post("/api/plugins/install", {
      package: "@alisio/plugin-beta",
      confirmed: true,
    });
    expect(after.status).toBe(200);
  });

  it("defers the reload while a run is active and says so", async () => {
    const gated = gatedProvider();
    const { t } = await start({ provider: gated });
    const session = await newSession(t);
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" });
    await gated.started;
    const res = (await t.api.post("/api/plugins/install", body)).json<PluginInstallResponse>();
    expect(res.restartPending).toBe(true);
    gated.release();
  });

  it("maps a missing npm and peer conflicts to validation_failed", async () => {
    catalog = await startCatalog((origin) => [plugin(origin, "alpha")]);
    const failing =
      (stderr: string): InstallRunner =>
      async () => ({
        stdout: "",
        stderr,
        exitCode: 1,
        truncated: false,
      });
    t = await startTestServer({
      app: { builtins: [demo], trustProject: true },
      pluginCatalog: {
        url: catalog.url,
        sdkVersion: "0.9.0",
        installRunner: failing("npm ERR! ERESOLVE could not resolve"),
      },
    });
    const peer = await t.api.post("/api/plugins/install", body);
    expect(peer.status).toBe(400);
    const missing = (await import("@alisio/core")).NPM_NOT_FOUND_MESSAGE;
    await t.close();
    t = await startTestServer({
      app: { builtins: [demo], trustProject: true },
      pluginCatalog: {
        url: catalog.url,
        sdkVersion: "0.9.0",
        installRunner: async () => {
          throw new Error(missing);
        },
      },
    });
    const noNpm = await t.api.post("/api/plugins/install", body);
    expect(noNpm.status).toBe(400);
    expect(noNpm.json<{ error: { message: string } }>().error.message).toContain(
      "npm was not found",
    );
    // A generic npm failure is an upstream failure, and nothing is configured.
    await t.close();
    t = await startTestServer({
      app: { builtins: [demo], trustProject: true },
      pluginCatalog: {
        url: catalog.url,
        sdkVersion: "0.9.0",
        installRunner: failing("network down"),
      },
    });
    const generic = await t.api.post("/api/plugins/install", body);
    expect(generic.status).toBe(502);
    await expect(stat(join(t.root, "config", "config.json"))).rejects.toThrow();
  });
});

/** Installs alpha, beta, gamma at 0.5.0, then publishes 0.6.0 of all of them in the catalog. */
async function startOutdated(npm: Partial<NpmState> = {}) {
  const { conflict, gate, ...setup } = npm;
  const started = await start({
    plugins: (origin) => ["alpha", "beta", "gamma"].map((slug) => plugin(origin, slug)),
    npm: setup,
  });
  for (const slug of ["alpha", "beta", "gamma"])
    await started.t.api.post("/api/plugins/install", {
      package: `@alisio/plugin-${slug}`,
      confirmed: true,
    });
  started.npm.calls.length = 0;
  // Conflicts and gates only apply to what the test does next, not to the setup installs.
  started.npm.conflict = conflict;
  started.npm.gate = gate;
  return started;
}
const publish = async (
  s: Awaited<ReturnType<typeof startOutdated>>,
  slugs: string[],
  extra: Record<string, unknown> = {},
) => {
  s.catalog.setPlugins(
    ["alpha", "beta", "gamma"].map((slug) =>
      plugin(s.catalog.origin, slug, slugs.includes(slug) ? { version: "0.6.0", ...extra } : {}),
    ),
    `"v${Math.random()}"`,
  );
  await getCatalog(s.t, "?refresh=1");
};

describe("POST /api/plugins/update-all", () => {
  const send = { confirmed: true };

  it("updates every outdated plugin in ONE npm call and reports each result", async () => {
    const s = await startOutdated();
    await s.t.api.get(`/api/plugins?workspace=${s.wid}`);
    await publish(s, ["alpha", "beta"]);
    const res = await s.t.api.post("/api/plugins/update-all", send);
    expect(res.status).toBe(200);
    expect(s.npm.calls).toHaveLength(1);
    expect(s.npm.calls[0]?.slice(3)).toEqual([
      "@alisio/plugin-alpha@0.6.0",
      "@alisio/plugin-beta@0.6.0",
    ]);
    expect(s.npm.calls.flat()).not.toContain("--force");
    expect(s.npm.calls.flat()).not.toContain("--legacy-peer-deps");
    const body = res.json<PluginUpdateAllResponse>();
    expect(body.updated.map((u) => [u.package, u.installedVersion, u.previousVersion])).toEqual([
      ["@alisio/plugin-alpha", "0.6.0", "0.5.0"],
      ["@alisio/plugin-beta", "0.6.0", "0.5.0"],
    ]);
    // The workspace was open, so this process imported the old code.
    expect(body.updated.every((u) => u.restartRequired)).toBe(true);
    const config = JSON.parse(await readFile(join(s.t.root, "config", "config.json"), "utf8"));
    expect(config.plugins).toEqual([
      "@alisio/plugin-alpha",
      "@alisio/plugin-beta",
      "@alisio/plugin-gamma",
    ]);
  });

  it("is a no-op without npm when nothing is outdated and skips local and unlisted packages", async () => {
    const s = await startOutdated();
    const res = await s.t.api.post("/api/plugins/update-all", send);
    expect(res.status).toBe(200);
    expect(res.json<PluginUpdateAllResponse>().updated).toEqual([]);
    expect(s.npm.calls).toEqual([]);
  });

  it("skips plugins whose newer release needs a newer sdk", async () => {
    const s = await startOutdated();
    await publish(s, ["alpha", "beta"]);
    s.catalog.setPlugins(
      ["alpha", "beta", "gamma"].map((slug) =>
        plugin(
          s.catalog.origin,
          slug,
          slug === "alpha"
            ? { version: "0.6.0" }
            : slug === "beta"
              ? { version: "0.6.0", sdk: "^0.10.0" }
              : {},
        ),
      ),
      '"v-compat"',
    );
    await getCatalog(s.t, "?refresh=1");
    await s.t.api.post("/api/plugins/update-all", send);
    expect(s.npm.calls[0]?.slice(3)).toEqual(["@alisio/plugin-alpha@0.6.0"]);
  });

  it("falls back to @latest in the same single call when a catalog version is unpublished", async () => {
    const s = await startOutdated({ unpublished: "0.6.0", latest: "0.5.5" });
    await publish(s, ["alpha", "beta"]);
    const res = await s.t.api.post("/api/plugins/update-all", send);
    expect(res.json<PluginUpdateAllResponse>().updated.map((u) => u.installedVersion)).toEqual([
      "0.5.5",
      "0.5.5",
    ]);
    expect(s.npm.calls.map((c) => c.slice(3))).toEqual([
      ["@alisio/plugin-alpha@0.6.0", "@alisio/plugin-beta@0.6.0"],
      ["@alisio/plugin-alpha@latest", "@alisio/plugin-beta@latest"],
    ]);
  });

  it("requires confirmed: true, authentication, a matching Origin and is refused read-only", async () => {
    const s = await startOutdated();
    expect((await s.t.api.post("/api/plugins/update-all", {})).status).toBe(400);
    const headers = { "Content-Type": "application/json" };
    expect(
      (
        await raw(s.t.server.port, "/api/plugins/update-all", {
          method: "POST",
          body: send,
          headers: { ...headers, Origin: `http://127.0.0.1:${s.t.server.port}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await raw(s.t.server.port, "/api/plugins/update-all", {
          method: "POST",
          body: send,
          headers: { ...headers, Cookie: s.t.cookie, Origin: "http://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(s.npm.calls).toEqual([]);
    await s.t.close();
    const ro = await start({ readOnly: true });
    const res = await ro.t.api.post("/api/plugins/update-all", send);
    expect(res.status).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("capability_ceiling");
    expect(ro.npm.calls).toEqual([]);
  });

  it("maps npm failures like the single install and never retries or forces", async () => {
    const s = await startOutdated({ conflict: () => true });
    await publish(s, ["alpha", "beta"]);
    const peer = await s.t.api.post("/api/plugins/update-all", send);
    expect(peer.status).toBe(400);
    expect(peer.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("ERESOLVE"),
    });
    expect(s.npm.calls).toHaveLength(1);
    s.npm.conflict = undefined;
    s.npm.fail = "network down";
    const generic = await s.t.api.post("/api/plugins/update-all", send);
    expect(generic.status).toBe(502);
  });

  it("serializes with other installs: a concurrent update-all gets 409 runs_active", async () => {
    const gate = deferred();
    const s = await startOutdated({ gate: gate.promise });
    await publish(s, ["alpha"]);
    const first = s.t.api.post("/api/plugins/update-all", send);
    await until(() => s.npm.calls.length > 0);
    const second = await s.t.api.post("/api/plugins/update-all", send);
    expect(second.status).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe("runs_active");
    gate.resolve();
    expect((await first).status).toBe(200);
  });
});

describe("POST /api/plugins/install peer conflicts", () => {
  const alpha = { package: "@alisio/plugin-alpha", confirmed: true };
  const only = (targets: string[]) => targets.length === 1;

  it("retries ONCE as a combined install with the other outdated plugins and reports them", async () => {
    const s = await startOutdated({ conflict: only });
    await publish(s, ["alpha", "beta"]);
    const res = await s.t.api.post("/api/plugins/install", alpha);
    expect(res.status).toBe(200);
    expect(s.npm.calls.map((c) => c.slice(3))).toEqual([
      ["@alisio/plugin-alpha@0.6.0"],
      ["@alisio/plugin-alpha@0.6.0", "@alisio/plugin-beta@0.6.0"],
    ]);
    expect(s.npm.calls.flat()).not.toContain("--force");
    expect(s.npm.calls.flat()).not.toContain("--legacy-peer-deps");
    expect(res.json<PluginInstallResponse>()).toMatchObject({
      installedVersion: "0.6.0",
      previousVersion: "0.5.0",
      updated: true,
      alsoUpdated: [
        { package: "@alisio/plugin-beta", installedVersion: "0.6.0", previousVersion: "0.5.0" },
      ],
    });
    // gamma (up to date) was not touched.
    const versions = (await s.t.api.get(`/api/plugins/packages?workspace=${s.wid}`))
      .json<InstalledPluginPackage[]>()
      .map((p) => [p.package.split("-").pop(), p.version]);
    expect(versions).toEqual([
      ["alpha", "0.6.0"],
      ["beta", "0.6.0"],
      ["gamma", "0.5.0"],
    ]);
  });

  it("does not retry without other outdated plugins and reports the conflict", async () => {
    const s = await startOutdated({ conflict: only });
    await publish(s, ["alpha"]);
    const res = await s.t.api.post("/api/plugins/install", alpha);
    expect(res.status).toBe(400);
    expect(s.npm.calls).toHaveLength(1);
  });

  it("gives up after the single combined retry when the conflict persists", async () => {
    const s = await startOutdated({ conflict: () => true });
    await publish(s, ["alpha", "beta"]);
    const res = await s.t.api.post("/api/plugins/install", alpha);
    expect(res.status).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain(
      "updating them together",
    );
    expect(s.npm.calls).toHaveLength(2);
  });

  it("a plain update without a conflict never co-updates anyone", async () => {
    const s = await startOutdated();
    await publish(s, ["alpha", "beta"]);
    const res = (await s.t.api.post("/api/plugins/install", alpha)).json<PluginInstallResponse>();
    expect(res.alsoUpdated).toBeUndefined();
    expect(s.npm.calls).toHaveLength(1);
  });

  it("does not drag other plugins into a reinstall or a downgrade", async () => {
    const s = await startOutdated({ conflict: only });
    await publish(s, ["beta"]);
    // alpha is at the catalog version: a reinstall, which must not pull beta along.
    const res = await s.t.api.post("/api/plugins/install", alpha);
    expect(res.status).toBe(400);
    expect(s.npm.calls).toHaveLength(1);
  });
});

describe("DELETE /api/plugins/package/:name", () => {
  const encoded = encodeURIComponent("@alisio/plugin-alpha");

  it("uninstalls an installed package, cleans the config and drops the plugin", async () => {
    const { t, wid, npm } = await start();
    await t.api.post("/api/plugins/install", { package: "@alisio/plugin-alpha", confirmed: true });
    const res = await t.api.delete(`/api/plugins/package/${encoded}`);
    expect(res.status).toBe(200);
    expect(res.json<PluginUninstallResponse>()).toEqual({
      package: "@alisio/plugin-alpha",
      removed: true,
      restartPending: false,
    });
    expect(npm.calls.at(-1)?.slice(0, 1)).toEqual(["uninstall"]);
    const list = (await t.api.get(`/api/plugins?workspace=${wid}`)).json<PluginInfo[]>();
    expect(list.some((p) => p.id === "fake-alpha")).toBe(false);
    const config = JSON.parse(await readFile(join(t.root, "config", "config.json"), "utf8"));
    expect(config.plugins).toEqual([]);
    expect((await t.api.get(`/api/plugins/packages?workspace=${wid}`)).json<unknown[]>()).toEqual(
      [],
    );
    expect((await t.api.delete(`/api/plugins/package/${encoded}`)).status).toBe(404);
  });

  it("refuses built-in plugins", async () => {
    const { t, npm } = await start();
    for (const name of ["demo", "@alisio/plugin-demo"]) {
      const res = await t.api.delete(`/api/plugins/package/${encodeURIComponent(name)}`);
      expect(res.status).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("not_manageable");
    }
    expect(npm.calls).toEqual([]);
  });

  it("returns 404 for a package that is not installed and 400 for an invalid name", async () => {
    const { t } = await start();
    expect((await t.api.delete("/api/plugins/package/never-installed")).status).toBe(404);
    expect(
      (await t.api.delete(`/api/plugins/package/${encodeURIComponent("../etc")}`)).status,
    ).toBe(400);
    expect(
      (await t.api.delete(`/api/plugins/package/${encodeURIComponent("pkg@1.0.0")}`)).status,
    ).toBe(400);
  });

  it("is refused under --read-only and without a matching Origin", async () => {
    const { t } = await start({ readOnly: true });
    expect((await t.api.delete(`/api/plugins/package/${encoded}`)).status).toBe(403);
    const res = await raw(t.server.port, `/api/plugins/package/${encoded}`, {
      method: "DELETE",
      headers: {
        Cookie: t.cookie,
        "Content-Type": "application/json",
        Origin: "http://evil.example",
      },
    });
    expect(res.status).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("forbidden_origin");
  });
});
