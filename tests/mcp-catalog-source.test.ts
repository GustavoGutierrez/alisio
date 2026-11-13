/**
 * MCP-CAT-26 (specs/030 O7, D14): the catalog source is swappable. A second adapter with another
 * `sourceId`, registered only in the factory, walks sync -> store -> `GET /api/mcp/catalog` -> the
 * web view model without any change to those modules; switching the active source resyncs without
 * mixing rows of the previous one.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpCatalogPage } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../packages/core/src/config.ts";
import { readGlobalCatalogConfig } from "../packages/core/src/mcp/catalog/config.ts";
import { createCatalogService } from "../packages/core/src/mcp/catalog/service.ts";
import { createSourceFactory } from "../packages/core/src/mcp/catalog/source-factory.ts";
import {
  DEFAULT_FILTERS,
  exploreView,
} from "../packages/web/src/components/settings/mcp-explore/model.ts";
import { FakeCatalogSource, record } from "./mcp-catalog-helpers.ts";
import { startTestServer, type TestServer } from "./server-helpers.ts";

let started: TestServer | undefined;
afterEach(async () => {
  await started?.close();
  started = undefined;
  vi.unstubAllEnvs();
});

const records = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) =>
    record({
      name: `${prefix}/tool-${String(i).padStart(2, "0")}`,
      description: `${prefix} tool ${i}`,
    }),
  );

describe("MCP-CAT-26: a second source needs only a factory registration", () => {
  it("flows through sync, store, the HTTP route and the web view model unchanged", async () => {
    const acme = new FakeCatalogSource({ sourceId: "acme", records: records("com.acme", 30) });
    // The only registration is this factory entry: no other module knows "acme".
    const service = createCatalogService({
      dbPath: ":memory:",
      source: { source: "acme" },
      factory: createSourceFactory({ acme: () => acme }),
    });
    started = await startTestServer({ mcpCatalog: service });
    service.sync();
    await service.idle();

    const page = (await started.api.get("/api/mcp/catalog")).json<McpCatalogPage>();
    expect(page.total).toBe(30);
    expect(page.items).toHaveLength(24);
    expect(page.items.every((i) => i.sourceId === "acme" && i.name.startsWith("com.acme/"))).toBe(
      true,
    );
    expect(page.syncStatus.sourceId).toBe("acme");

    const view = exploreView({ loading: false, filters: DEFAULT_FILTERS, page });
    expect(view).toEqual({ body: "list" });
    const detail = await started.api.get(
      `/api/mcp/catalog/detail?name=${encodeURIComponent("com.acme/tool-03")}&source=acme`,
    );
    expect(detail.status).toBe(200);
  });

  it("switching the active source resyncs and never mixes the previous source's rows", async () => {
    const one = new FakeCatalogSource({ sourceId: "one", records: records("com.one", 5) });
    const two = new FakeCatalogSource({ sourceId: "two", records: records("com.two", 3) });
    const service = createCatalogService({
      dbPath: ":memory:",
      source: { source: "one" },
      factory: createSourceFactory({ one: () => one, two: () => two }),
    });
    started = await startTestServer({ mcpCatalog: service });
    service.sync();
    await service.idle();
    const names = async () =>
      (await started?.api.get("/api/mcp/catalog?pageSize=100"))
        ?.json<McpCatalogPage>()
        .items.map((i) => i.name) ?? [];
    expect((await names()).every((n) => n.startsWith("com.one/"))).toBe(true);
    expect(await names()).toHaveLength(5);

    service.setSource({ source: "two" });
    // Immediately after the switch the old rows are already hidden, even before the new walk ends.
    expect((await names()).some((n) => n.startsWith("com.one/"))).toBe(false);
    await service.idle();
    const after = await names();
    expect(after).toHaveLength(3);
    expect(after.every((n) => n.startsWith("com.two/"))).toBe(true);
    expect(service.status().sourceId).toBe("two");
    expect(two.listCalls.length).toBeGreaterThan(0);
  });

  it("keeps the previous rows out of view if the new source fails, and purges them after it succeeds", async () => {
    const one = new FakeCatalogSource({ sourceId: "one", records: records("com.one", 4) });
    const two = new FakeCatalogSource({
      sourceId: "two",
      records: records("com.two", 2),
      failOnCall: { call: 1 },
    });
    const service = createCatalogService({
      dbPath: ":memory:",
      source: { source: "one" },
      factory: createSourceFactory({ one: () => one, two: () => two }),
      retryCooldownMs: 0,
    });
    service.sync();
    await service.idle();
    service.setSource({ source: "two" });
    await service.idle();
    expect(service.list({}).total).toBe(0);
    expect(service.status().lastError?.code).toBe("network");
    service.sync();
    await service.idle();
    expect(service.list({}).items.map((i) => i.sourceId)).toEqual(["two", "two"]);
    service.setSource({ source: "one" });
    await service.idle();
    expect(service.list({}).total).toBe(4); // the first source re-synced from scratch
    service.close();
  });

  it("the official adapter is the default and its base URL is configurable", () => {
    const service = createCatalogService({ dbPath: ":memory:" });
    expect(service.sourceId).toBe("official");
    service.close();
    const mirror = createCatalogService({
      dbPath: ":memory:",
      source: { baseUrl: "https://mirror.example.test" },
    });
    expect(mirror.sourceId).toBe("official:https://mirror.example.test");
    mirror.close();
  });
});

describe("catalog source configuration", () => {
  it("reads the global-only preference and ignores a broken or missing file", () => {
    const home = mkdtempSync(join(tmpdir(), "alisio-cat-config-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", home);
    expect(readGlobalCatalogConfig()).toEqual({});
    writeFileSync(join(home, "config.json"), "{ not json");
    expect(readGlobalCatalogConfig()).toEqual({});
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        mcp: { catalog: { source: " official ", baseUrl: "https://mirror.example.test" } },
      }),
    );
    expect(readGlobalCatalogConfig()).toEqual({
      source: "official",
      baseUrl: "https://mirror.example.test",
    });
  });

  it("accepts mcp.catalog in the schema and rejects unknown keys under it", () => {
    expect(
      configSchema.parse({
        mcp: { catalog: { source: "official", baseUrl: "https://r.example.test" } },
      }).mcp.catalog,
    ).toEqual({ source: "official", baseUrl: "https://r.example.test" });
    expect(() => configSchema.parse({ mcp: { catalog: { token: "x" } } })).toThrow();
  });
});
