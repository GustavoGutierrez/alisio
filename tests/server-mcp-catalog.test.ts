/** `/api/mcp/catalog*` routes (specs/030 phase 2): browse, filter, page, sync status. No network. */
import type { McpCatalogDetail, McpCatalogPage, McpCatalogSyncStatus } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogService } from "../packages/core/src/mcp/catalog/service.ts";
import { createSourceFactory } from "../packages/core/src/mcp/catalog/source-factory.ts";
import { contractDataset, FakeCatalogSource, record } from "./mcp-catalog-helpers.ts";
import { raw, startTestServer, type TestServer, until } from "./server-helpers.ts";

let started: TestServer | undefined;
afterEach(async () => {
  await started?.close();
  started = undefined;
  vi.unstubAllEnvs();
});

async function boot(
  records = contractDataset(),
  options: { autoSync?: boolean; readOnly?: boolean } = {},
) {
  const source = new FakeCatalogSource({ records });
  const service = createCatalogService({
    dbPath: ":memory:",
    source: { source: "fake" },
    factory: createSourceFactory({ fake: () => source }),
    autoSync: options.autoSync ?? false,
  });
  started = await startTestServer({
    mcpCatalog: service,
    ...(options.readOnly ? { app: { readOnly: true } } : {}),
  });
  return { source, service, ...started };
}

describe("GET /api/mcp/catalog", () => {
  it("needs the launch cookie like every API route", async () => {
    const { server } = await boot();
    expect((await raw(server.port, "/api/mcp/catalog")).status).toBe(401);
  });

  it("returns an empty, recoverable page before the first sync", async () => {
    const { api } = await boot();
    const res = await api.get("/api/mcp/catalog");
    expect(res.status).toBe(200);
    const page = res.json<McpCatalogPage>();
    expect(page).toMatchObject({ total: 0, items: [], page: 1, pageSize: 24 });
    expect(page.syncStatus).toMatchObject({ sourceId: "fake", entryCount: 0, syncing: false });
  });

  it("pages 24 at a time with the total of the whole query, after filters", async () => {
    const { api, service } = await boot();
    service.sync();
    await service.idle();
    const first = (await api.get("/api/mcp/catalog")).json<McpCatalogPage>();
    expect(first.total).toBe(150); // the deprecated entry is hidden unless asked for
    expect(first.items).toHaveLength(24);
    expect(first.syncStatus.entryCount).toBe(151);
    const last = (
      await api.get("/api/mcp/catalog?page=7&pageSize=24&status=all")
    ).json<McpCatalogPage>();
    expect(last.items).toHaveLength(151 - 6 * 24);
    const remote = (
      await api.get("/api/mcp/catalog?execution=remote&pageSize=100")
    ).json<McpCatalogPage>();
    expect(remote.total).toBe(50);
    expect(remote.items.every((i) => i.execution === "remote")).toBe(true);
    const text = (await api.get("/api/mcp/catalog?q=server-01")).json<McpCatalogPage>();
    expect(text.queryApplied).toBe(true);
    expect(text.total).toBe(10);
  });

  it("answers every query from the local index without asking the source", async () => {
    const { api, service, source } = await boot();
    service.sync();
    await service.idle();
    const calls = source.listCalls.length;
    for (const q of ["s", "se", "ser", "serv", "server"]) await api.get(`/api/mcp/catalog?q=${q}`);
    expect(source.listCalls.length).toBe(calls);
  });

  it("rejects malformed parameters with field names only", async () => {
    const { api } = await boot();
    for (const [query, field] of [
      ["page=0", "page"],
      ["page=abc", "page"],
      ["pageSize=101", "pageSize"],
      ["category=nope", "category"],
      ["execution=cloud", "execution"],
      ["ready=maybe", "ready"],
      ["status=everything", "status"],
      [`q=${"x".repeat(201)}`, "q"],
    ] as const) {
      const res = await api.get(`/api/mcp/catalog?${query}`);
      expect(res.status, query).toBe(400);
      expect(
        res.json<{ error: { code: string; details: { fields: string[] } } }>().error,
      ).toMatchObject({
        code: "validation_failed",
        details: { fields: [field] },
      });
    }
  });

  it("starts a background sync on first browse when autoSync is on, without blocking the answer", async () => {
    const { api, source } = await boot(contractDataset(), { autoSync: true });
    const first = (await api.get("/api/mcp/catalog")).json<McpCatalogPage>();
    expect(first.total).toBe(0);
    expect(first.syncStatus.syncing).toBe(true);
    await until(
      async () => (await api.get("/api/mcp/catalog")).json<McpCatalogPage>().total === 150,
    );
    expect(source.listCalls.length).toBe(2);
  });
});

describe("POST /api/mcp/catalog/sync", () => {
  it("starts one walk, answers with the state and holds a second request back", async () => {
    const { api, service } = await boot();
    const started1 = await api.post("/api/mcp/catalog/sync");
    expect(started1.status).toBe(200);
    expect(started1.json<McpCatalogSyncStatus>().syncing).toBe(true);
    await service.idle();
    const again = (await api.post("/api/mcp/catalog/sync")).json<McpCatalogSyncStatus>();
    expect(again).toMatchObject({ throttled: true, entryCount: 151 });
    expect(again.nextSyncAllowedAt).toBeTruthy();
  });

  it("reports a failed walk without leaking the cause", async () => {
    const { api, service, source } = await boot();
    source.failAt(1, new Error("connect ECONNREFUSED 10.1.2.3:443 secret=abc"));
    await api.post("/api/mcp/catalog/sync");
    await service.idle();
    const res = await api.get("/api/mcp/catalog");
    const status = res.json<McpCatalogPage>().syncStatus;
    expect(status.lastError?.code).toBe("internal");
    expect(res.text).not.toContain("10.1.2.3");
    expect(res.text).not.toContain("secret=abc");
  });

  it("is refused under --read-only (it writes the index and reaches the network)", async () => {
    const { api } = await boot(contractDataset(), { readOnly: true });
    const res = await api.post("/api/mcp/catalog/sync");
    expect(res.status).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("mcp_not_permitted");
    // browsing the saved index still works
    expect((await api.get("/api/mcp/catalog")).status).toBe(200);
  });

  it("requires a matching Origin like every effectful request", async () => {
    const { server, cookie } = await boot();
    const res = await raw(server.port, "/api/mcp/catalog/sync", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: "http://evil.example",
      },
      body: {},
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/mcp/catalog/detail", () => {
  it("returns the public card of a version and 404 for an unknown one", async () => {
    const { api, service } = await boot([record({ name: "io.example/a/b", kind: "remote" })]);
    service.sync();
    await service.idle();
    const ok = await api.get(
      `/api/mcp/catalog/detail?name=${encodeURIComponent("io.example/a/b")}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.json<McpCatalogDetail>()).toMatchObject({
      name: "io.example/a/b",
      remotes: [{ origin: "https://mcp.example.com" }],
    });
    expect(ok.text).not.toContain("rawJson");
    expect((await api.get("/api/mcp/catalog/detail?name=io.example/missing")).status).toBe(404);
    expect((await api.get("/api/mcp/catalog/detail")).status).toBe(400);
    // a source other than the active one is not served
    expect(
      (
        await api.get(
          `/api/mcp/catalog/detail?name=${encodeURIComponent("io.example/a/b")}&source=other`,
        )
      ).status,
    ).toBe(404);
  });
});
