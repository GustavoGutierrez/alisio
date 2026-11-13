/**
 * MCP-CAT-01..04 (specs/030 phase 2): sync, store, search and categories through the catalog
 * service. Every source is the in-memory fake or the registry stub: no network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { assessEntry } from "../packages/core/src/mcp/catalog/availability.ts";
import { createRuleClassifier } from "../packages/core/src/mcp/catalog/classifier.ts";
import {
  createCatalogService,
  type McpCatalogService,
} from "../packages/core/src/mcp/catalog/service.ts";
import { createSourceFactory } from "../packages/core/src/mcp/catalog/source-factory.ts";
import { OfficialRegistrySource } from "../packages/core/src/mcp/catalog/sources/official-registry.ts";
import { CatalogStore } from "../packages/core/src/mcp/catalog/store.ts";
import { runSync, SYNC_OVERLAP_MS } from "../packages/core/src/mcp/catalog/sync.ts";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import {
  contractDataset,
  type DatasetRecord,
  FakeCatalogSource,
  iso,
  record,
  registryFetch,
  T0,
} from "./mcp-catalog-helpers.ts";

const services: McpCatalogService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
});

function setup(
  source: FakeCatalogSource,
  extra: Partial<Parameters<typeof createCatalogService>[0]> = {},
) {
  let clock = T0 + 24 * 3_600_000;
  const service = createCatalogService({
    dbPath: ":memory:",
    source: { source: source.sourceId },
    factory: createSourceFactory({ [source.sourceId]: () => source }),
    now: () => new Date(clock),
    ...extra,
  });
  services.push(service);
  return {
    service,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
}

describe("MCP-CAT-01: sync", () => {
  it("walks two pages with the same filters and the cursor, deduplicates and persists", async () => {
    const records = contractDataset().filter((r) => r.name.startsWith("io.example/server-"));
    const source = new FakeCatalogSource({ records, maxLimit: 100 });
    const { service } = setup(source, { pageSize: 100 });
    service.sync();
    await service.idle();
    expect(source.listCalls).toHaveLength(2);
    expect(source.listCalls[0]?.cursor).toBeUndefined();
    expect(source.listCalls[1]?.cursor).toBe("100");
    expect(source.listCalls.every((c) => c.updatedSince === undefined)).toBe(true);
    expect(service.status().entryCount).toBe(150);
    expect(service.list({ pageSize: 100 }).total).toBe(150);
  });

  it("is idempotent: re-running a walk over the same data changes nothing", async () => {
    const source = new FakeCatalogSource({ records: contractDataset() });
    const store = new CatalogStore(openDatabase(":memory:"));
    const run = () =>
      runSync({ source, store, classifier: createRuleClassifier(), now: () => new Date(T0) });
    await run();
    const visible = () => store.query("fake", { pageSize: 100, status: "all" }).total;
    expect(visible()).toBe(151);
    await run(); // incremental this time: it also records the deleted entry as a hidden tombstone
    expect(visible()).toBe(151);
    expect(store.rowCount("fake")).toBe(152);
    await run();
    expect(store.rowCount("fake")).toBe(152);
    expect(store.counts("fake").rejected).toBe(1);
  });

  it("serves the official adapter's stub registry through the same pipeline", async () => {
    const stub = registryFetch({ dataset: () => contractDataset() });
    const source = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: stub.fetch,
      sleep: async () => {},
    });
    const store = new CatalogStore(openDatabase(":memory:"));
    const outcome = await runSync({ source, store, classifier: createRuleClassifier() });
    expect(outcome.state).toBe("complete");
    expect(store.counts(source.sourceId)).toEqual({ entries: 151, rejected: 1 });
    expect(store.detail(source.sourceId, "io.example/server-001")?.provenance.rawJson).toContain(
      "server-001",
    );
  });

  it("stops at the page cap and reports it instead of walking forever", async () => {
    const source = new FakeCatalogSource({ records: contractDataset(), maxLimit: 10 });
    const store = new CatalogStore(openDatabase(":memory:"));
    const outcome = await runSync({
      source,
      store,
      classifier: createRuleClassifier(),
      pageSize: 10,
      maxPages: 3,
    });
    expect(outcome).toMatchObject({
      state: "failed",
      partial: true,
      pages: 3,
      error: { code: "page_cap" },
    });
    expect(store.getSource("fake")?.checkpoint).toBeUndefined();
  });

  it("is cancellable through its AbortSignal", async () => {
    const source = new FakeCatalogSource({ records: contractDataset() });
    const store = new CatalogStore(openDatabase(":memory:"));
    const controller = new AbortController();
    controller.abort();
    const outcome = await runSync({
      source,
      store,
      classifier: createRuleClassifier(),
      signal: controller.signal,
    });
    expect(outcome).toMatchObject({ state: "failed", error: { code: "aborted" } });
  });
});

describe("MCP-CAT-02: failure in the middle", () => {
  it("keeps the checkpoint, then applies updates and deletions on retry without losses", async () => {
    const records: DatasetRecord[] = [
      record({ name: "io.example/a", updatedAt: iso(0), description: "first" }),
      record({ name: "io.example/b", updatedAt: iso(1) }),
      record({ name: "io.example/c", updatedAt: iso(2) }),
      record({ name: "io.example/d", updatedAt: iso(3) }),
    ];
    const source = new FakeCatalogSource({ records });
    const store = new CatalogStore(openDatabase(":memory:"));
    const classifier = createRuleClassifier();
    let clock = T0 + 3_600_000;
    const now = () => new Date(clock);
    const run = () => runSync({ source, store, classifier, now, pageSize: 2 });
    expect((await run()).state).toBe("complete");
    const checkpoint = store.getSource("fake")?.checkpoint;
    expect(checkpoint).toBe(new Date(clock).toISOString());

    // upstream changes: a is renamed in description, b is deleted, plus a brand-new e
    clock += 3_600_000;
    source.records = [
      { ...records[0], description: "changed", updatedAt: iso(70) } as DatasetRecord,
      { ...records[1], status: "deleted", updatedAt: iso(71) } as DatasetRecord,
      records[2] as DatasetRecord,
      records[3] as DatasetRecord,
      record({ name: "io.example/e", updatedAt: iso(72) }),
    ];
    source.listCalls = [];
    source.failAt(2);
    const failed = await run();
    expect(failed).toMatchObject({ state: "failed", partial: true });
    expect(store.getSource("fake")?.checkpoint).toBe(checkpoint);
    expect(store.getSource("fake")?.lastError?.code).toBe("network");
    // the incremental window starts at the previous checkpoint minus the overlap
    expect(source.listCalls[0]?.updatedSince).toBe(
      new Date(Date.parse(checkpoint as string) - SYNC_OVERLAP_MS).toISOString(),
    );

    source.failAt(undefined);
    clock += 60_000;
    const retried = await run();
    expect(retried).toMatchObject({ state: "complete", incremental: true });
    expect(store.getSource("fake")?.checkpoint).toBe(new Date(clock).toISOString());
    expect(store.getSource("fake")?.lastError).toBeUndefined();
    const names = store.query("fake", { pageSize: 100 }).items.map((i) => i.name);
    expect(names).toEqual(["io.example/a", "io.example/c", "io.example/d", "io.example/e"]);
    expect(store.query("fake", { q: "changed" }).items.map((i) => i.name)).toEqual([
      "io.example/a",
    ]);
  });

  it("an older record redelivered by the overlap never overwrites a newer stored one", async () => {
    const store = new CatalogStore(openDatabase(":memory:"));
    const classifier = createRuleClassifier();
    const source = new FakeCatalogSource({
      records: [record({ name: "io.example/a", updatedAt: iso(10), description: "new text" })],
    });
    await runSync({ source, store, classifier });
    source.records = [
      record({ name: "io.example/a", updatedAt: iso(5), description: "stale text" }),
    ];
    store.applyPage({
      sourceId: "fake",
      entries: (await source.listPage({ limit: 10 })).entries,
      rejected: [],
      classifier,
      fetchedAt: iso(20),
    });
    expect(store.query("fake", {}).items[0]?.description).toBe("new text");
  });

  it("a new latest version demotes the previous one", async () => {
    const store = new CatalogStore(openDatabase(":memory:"));
    const classifier = createRuleClassifier();
    const source = new FakeCatalogSource({
      records: [record({ name: "io.example/a", version: "1.0.0", updatedAt: iso(1) })],
    });
    const now = () => new Date(T0 + 7_200_000);
    await runSync({ source, store, classifier, now });
    source.records = [
      record({ name: "io.example/a", version: "1.0.0", isLatest: false, updatedAt: iso(1) }),
      record({ name: "io.example/a", version: "1.1.0", updatedAt: iso(130) }),
    ];
    await runSync({ source, store, classifier, now });
    const items = store.query("fake", {}).items;
    expect(items.map((i) => i.version)).toEqual(["1.1.0"]);
  });
});

describe("MCP-CAT-03: offline and empty states", () => {
  it("serves the last index with its date and a stable, gap-free pagination", async () => {
    const source = new FakeCatalogSource({
      records: contractDataset().filter((r) => r.schema === "known" && r.status !== "deleted"),
    });
    const { service, advance } = setup(source);
    service.sync();
    await service.idle();
    const synced = service.status().lastSuccessAt;
    expect(synced).toBeTruthy();

    source.failAt(source.listCalls.length + 1);
    advance(2 * 3_600_000);
    service.sync();
    await service.idle();
    const status = service.status();
    expect(status.lastError?.code).toBe("network");
    expect(status.lastSuccessAt).toBe(synced);
    expect(status.entryCount).toBe(151);

    const seen: string[] = [];
    for (let page = 1; page <= 7; page++) {
      const result = service.list({ page, pageSize: 24, status: "all" });
      expect(result.total).toBe(151);
      seen.push(...result.items.map((i) => i.name));
    }
    expect(new Set(seen).size).toBe(151);
    expect(seen).toEqual([...seen].sort((a, b) => a.localeCompare(b)));
    expect(service.list({ page: 2, pageSize: 24 }).items).toEqual(
      service.list({ page: 2, pageSize: 24 }).items,
    );
  });

  it("with no index at all returns a recoverable empty list, never invented results", async () => {
    const source = new FakeCatalogSource({ records: [], failOnCall: { call: 1 } });
    const { service } = setup(source);
    service.sync();
    await service.idle();
    const page = service.list({});
    expect(page).toMatchObject({ total: 0, items: [] });
    expect(page.syncStatus).toMatchObject({ entryCount: 0, lastError: { code: "network" } });
    expect(page.syncStatus.lastSuccessAt).toBeUndefined();
  });

  it("answers queries from the local index without any upstream request", async () => {
    const source = new FakeCatalogSource({ records: contractDataset() });
    const { service } = setup(source);
    service.sync();
    await service.idle();
    const before = source.listCalls.length;
    for (const q of ["s", "se", "ser", "serv", "serve", "server-00", "server-001"])
      service.list({ q });
    expect(source.listCalls.length).toBe(before);
  });

  it("applies the sync budget: one walk per hour, a short cool-down after a failure", async () => {
    const source = new FakeCatalogSource({ records: contractDataset() });
    const { service, advance } = setup(source);
    expect(service.sync().throttled).toBeUndefined();
    await service.idle();
    const calls = source.listCalls.length;
    advance(10 * 60_000);
    const held = service.sync();
    expect(held.throttled).toBe(true);
    expect(held.nextSyncAllowedAt).toBeTruthy();
    expect(source.listCalls.length).toBe(calls);
    advance(61 * 60_000);
    expect(service.sync().throttled).toBeUndefined();
    await service.idle();
    expect(source.listCalls.length).toBeGreaterThan(calls);

    source.failAt(source.listCalls.length + 1);
    advance(2 * 3_600_000);
    service.sync();
    await service.idle();
    advance(10_000);
    expect(service.sync().throttled).toBe(true);
    advance(61_000);
    source.failAt(undefined);
    expect(service.sync().throttled).toBeUndefined();
    await service.idle();
  });

  it("runs a single walk at a time", async () => {
    const source = new FakeCatalogSource({ records: contractDataset() });
    const { service } = setup(source);
    service.sync();
    service.sync();
    expect(service.status().syncing).toBe(true);
    await service.idle();
    expect(source.listCalls).toHaveLength(2);
  });

  it("ensureFresh starts a background walk only with autoSync and never throws", async () => {
    const source = new FakeCatalogSource({ records: contractDataset() });
    const off = setup(source, { autoSync: false });
    off.service.ensureFresh();
    expect(off.service.status().syncing).toBe(false);
    const on = setup(new FakeCatalogSource({ records: contractDataset() }), { autoSync: true });
    on.service.ensureFresh();
    expect(on.service.status().syncing).toBe(true);
    await on.service.idle();
    expect(on.service.status().entryCount).toBe(151);
  });

  it("reports an unknown source or an insecure base URL as a status error, not an exception", () => {
    const service = createCatalogService({ dbPath: ":memory:", source: { source: "nope" } });
    services.push(service);
    expect(service.status().lastError?.code).toBe("unknown_source");
    const insecure = createCatalogService({
      dbPath: ":memory:",
      source: { baseUrl: "http://registry.example.test" },
    });
    services.push(insecure);
    expect(insecure.status().lastError?.code).toBe("invalid_config");
    expect(insecure.sync().throttled).toBe(true);
  });
});

describe("MCP-CAT-04: categories, filters and totals", () => {
  const fixture = () => {
    const rows: DatasetRecord[] = [
      record({
        name: "io.example/gh",
        description: "Work with GitHub repositories and pull requests",
        kind: "npm",
      }),
      record({
        name: "io.example/web",
        description: "Search the web and read research papers",
        kind: "remote",
      }),
      record({
        name: "io.example/fs",
        description: "Read and write local files and PDF documents",
        kind: "npm",
      }),
      record({
        name: "io.example/mail",
        description: "Enviar correo y mensajes de Slack",
        kind: "remote",
      }),
      record({
        name: "io.example/db",
        description: "Query PostgreSQL databases and spreadsheets",
        kind: "npm",
      }),
      record({
        name: "io.example/img",
        description: "Generate images and edit video",
        kind: "remote",
      }),
      record({
        name: "io.example/cal",
        description: "Manage your calendar, tasks and notes",
        kind: "npm",
      }),
      record({ name: "io.example/misc", description: "Something entirely different", kind: "npm" }),
      record({ name: "io.example/py", description: "Only distributed through pypi", kind: "pypi" }),
      record({
        name: "io.example/old",
        description: "Old GitHub helper",
        status: "deprecated",
        kind: "npm",
      }),
      record({
        name: "io.example/hinted",
        description: "Zzz",
        kind: "npm",
        hints: { categories: ["data"] },
      }),
    ];
    return rows;
  };
  const load = async () => {
    const source = new FakeCatalogSource({ records: fixture() });
    const { service } = setup(source);
    service.sync();
    await service.idle();
    return service;
  };

  it("assigns Alisio's own categories with visible provenance and falls back to other", async () => {
    const service = await load();
    const byName = Object.fromEntries(
      service.list({ pageSize: 100, status: "all" }).items.map((i) => [i.name, i]),
    );
    expect(byName["io.example/gh"]?.category).toMatchObject({ id: "development", method: "rule" });
    expect(byName["io.example/web"]?.category.id).toBe("research");
    expect(byName["io.example/fs"]?.category.id).toBe("files-documents");
    expect(byName["io.example/mail"]?.category.id).toBe("communication");
    expect(byName["io.example/db"]?.category.id).toBe("data");
    expect(byName["io.example/img"]?.category.id).toBe("design-media");
    expect(byName["io.example/cal"]?.category.id).toBe("productivity");
    expect(byName["io.example/misc"]?.category).toMatchObject({ id: "other", confidence: 0 });
    // a publisher hint is a weak, labelled signal
    expect(byName["io.example/hinted"]?.category).toMatchObject({ id: "data", method: "source" });
    expect(byName["io.example/hinted"]?.category.confidence).toBeLessThan(0.5);
  });

  it("prefers a curated mapping over rules", () => {
    const classifier = createRuleClassifier({ curated: { "io.example/gh": "communication" } });
    const entry = new FakeCatalogSource({
      records: [record({ name: "io.example/gh", description: "GitHub" })],
    });
    return entry.listPage({ limit: 5 }).then(({ entries }) => {
      expect(classifier.classify(entries[0] as never)).toEqual({
        categoryId: "communication",
        method: "curated",
        confidence: 1,
      });
    });
  });

  it("combines text, category, execution and ready filters; total, pages and facets agree", async () => {
    const service = await load();
    const all = service.list({ pageSize: 100 });
    expect(all.total).toBe(10); // the deprecated one is hidden by default
    expect(all.facets.categories.reduce((n, c) => n + c.count, 0)).toBe(10);

    const dev = service.list({ category: "development", pageSize: 100 });
    expect(dev.items.map((i) => i.name)).toEqual(["io.example/gh"]);
    // the category facet ignores the category filter itself
    expect(dev.facets.categories.length).toBeGreaterThan(1);

    const remote = service.list({ execution: "remote", pageSize: 100 });
    expect(remote.items.map((i) => i.name).sort()).toEqual([
      "io.example/img",
      "io.example/mail",
      "io.example/web",
    ]);
    expect(remote.facets.execution).toEqual([
      { id: "local", count: 7 },
      { id: "remote", count: 3 },
    ]);

    const ready = service.list({ ready: true, pageSize: 100 });
    expect(ready.items.every((i) => i.ready)).toBe(true);
    expect(ready.total).toBe(9); // the pypi-only entry has no automatic method
    const py = all.items.find((i) => i.name === "io.example/py");
    expect(py).toMatchObject({ ready: false, blocked: { reason: "method_unsupported" } });
    expect(py?.blocked?.detail).toContain("pypi");

    const combined = service.list({
      q: "database",
      execution: "local",
      ready: true,
      pageSize: 100,
    });
    expect(combined.items.map((i) => i.name)).toEqual(["io.example/db"]);
    expect(combined.total).toBe(1);

    // filter before paging: page 2 of a 4-item result with page size 3 has the remaining one
    const natives = service.list({ execution: "local", ready: true, pageSize: 3, page: 2 });
    expect(natives.total).toBe(6);
    expect(natives.items).toHaveLength(3);
    expect(
      service.list({ execution: "local", ready: true, pageSize: 4, page: 2 }).items,
    ).toHaveLength(2);
  });

  it("searches names, descriptions and category labels in both languages, with prefixes and accents", async () => {
    const service = await load();
    expect(service.list({ q: "postgres" }).items.map((i) => i.name)).toEqual(["io.example/db"]);
    expect(service.list({ q: "corre" }).items.map((i) => i.name)).toEqual(["io.example/mail"]);
    expect(service.list({ q: "investigacion" }).items.map((i) => i.name)).toContain(
      "io.example/web",
    );
    expect(service.list({ q: "Investigación" }).queryApplied).toBe(true);
    expect(service.list({ q: "x" }).queryApplied).toBe(false);
    expect(service.list({ q: "x" }).total).toBe(10);
    expect(service.list({ q: '"; DROP TABLE -- *' }).total).toBe(0);
  });

  it("marks a deprecated latest as not installable and shows it only on request", async () => {
    const service = await load();
    expect(service.list({ q: "github" }).items.map((i) => i.name)).toEqual(["io.example/gh"]);
    const shown = service.list({ q: "github", status: "all" }).items;
    const old = shown.find((i) => i.name === "io.example/old");
    expect(old).toMatchObject({
      status: "deprecated",
      ready: false,
      blocked: { reason: "deprecated" },
    });
    expect(
      service
        .list({ status: "all", ready: true, pageSize: 100 })
        .items.some((i) => i.name === "io.example/old"),
    ).toBe(false);
  });

  it("detail exposes parameters and the origin of remotes only, never raw text or secret values", async () => {
    const source = new FakeCatalogSource({
      records: [record({ name: "io.example/r", kind: "remote" })],
    });
    const { service } = setup(source);
    service.sync();
    await service.idle();
    const detail = service.detail("io.example/r");
    expect(detail?.remotes[0]).toEqual({
      transport: "streamable-http",
      origin: "https://mcp.example.com",
      inputs: [],
    });
    expect(JSON.stringify(detail)).not.toContain("rawJson");
    expect(service.detail("io.example/missing")).toBeUndefined();
  });

  it("recomputes stored categories when the taxonomy version changes", async () => {
    const db = openDatabase(":memory:");
    const store = new CatalogStore(db);
    const source = new FakeCatalogSource({
      records: [record({ name: "io.example/gh", description: "GitHub" })],
    });
    const v1 = createRuleClassifier();
    await runSync({ source, store, classifier: v1 });
    expect(store.query("fake", {}).items[0]?.category.id).toBe("development");
    const v2 = {
      taxonomyVersion: 2,
      classify: () => ({ categoryId: "data" as const, method: "curated" as const, confidence: 1 }),
    };
    expect(store.reclassify("fake", v2)).toBe(1);
    expect(store.query("fake", {}).items[0]?.category.id).toBe("data");
    expect(store.query("fake", { q: "datos" }).total).toBe(1);
    expect(store.reclassify("fake", v2)).toBe(0);
  });

  it("assessEntry names why an entry is blocked", async () => {
    const source = new FakeCatalogSource({
      records: [
        record({ name: "io.example/s", kind: "sse" }),
        record({ name: "io.example/n", kind: "npm" }),
      ],
    });
    const { entries } = await source.listPage({ limit: 10 });
    const byName = Object.fromEntries(entries.map((e) => [e.name, assessEntry(e)]));
    expect(byName["io.example/s"]).toMatchObject({
      ready: false,
      blocked: { reason: "method_unsupported" },
    });
    expect(byName["io.example/n"]).toMatchObject({ ready: true, execution: "local" });
  });
});
