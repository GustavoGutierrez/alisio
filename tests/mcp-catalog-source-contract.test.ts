/**
 * MCP-CAT-27: one contract suite every `CatalogSource` adapter must pass. The official registry
 * adapter runs against a stub `fetch` that speaks the registry's wire format (three schema
 * revisions); the in-memory fake runs the very same cases.
 */
import { describe, expect, it } from "vitest";
import type { CatalogSource } from "../packages/core/src/mcp/catalog/source.ts";
import { OfficialRegistrySource } from "../packages/core/src/mcp/catalog/sources/official-registry.ts";
import {
  contractDataset,
  type DatasetRecord,
  FakeCatalogSource,
  iso,
  record,
  registryFetch,
} from "./mcp-catalog-helpers.ts";

interface Harness {
  source: CatalogSource;
  apply(records: DatasetRecord[]): void;
}

function official(): Harness {
  let data: DatasetRecord[] = [];
  const { fetch } = registryFetch({ dataset: () => data });
  return {
    source: new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch,
      sleep: async () => {},
    }),
    apply: (records) => {
      data = records;
    },
  };
}
function fake(): Harness {
  const source = new FakeCatalogSource();
  return {
    source,
    apply: (records) => {
      source.records = records;
    },
  };
}

async function walk(source: CatalogSource, extra: { updatedSince?: string; limit?: number } = {}) {
  const entries = [];
  const rejected = [];
  const sizes: number[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await source.listPage({
      limit: extra.limit ?? 100,
      ...(cursor ? { cursor } : {}),
      ...(extra.updatedSince ? { updatedSince: extra.updatedSince } : {}),
    });
    entries.push(...page.entries);
    rejected.push(...page.rejected);
    sizes.push(page.entries.length + page.rejected.length);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { entries, rejected, sizes };
}

describe.each([
  ["official registry adapter (stub fetch)", official],
  ["in-memory fake source", fake],
])("CatalogSource contract: %s", (_label, make) => {
  it("walks every page by cursor, never exceeding the limit, with no duplicates", async () => {
    const h = make();
    h.apply(contractDataset());
    const { entries, sizes } = await walk(h.source, { limit: 40 });
    expect(sizes.every((n) => n <= 40)).toBe(true);
    expect(sizes.length).toBeGreaterThan(3);
    const names = entries.map((e) => `${e.name}@${e.version}`);
    expect(new Set(names).size).toBe(names.length);
    // 150 active + 1 deprecated; deleted is hidden from a full walk; the unknown schema is rejected.
    expect(entries).toHaveLength(151);
    expect(entries.every((e) => e.sourceId === h.source.sourceId)).toBe(true);
    expect(entries.every((e) => e.provenance.rawDigest.length === 64)).toBe(true);
  });

  it("returns an entry's domain fields without provider types", async () => {
    const h = make();
    h.apply([record({ name: "io.example/alpha", title: "Alpha", kind: "npm" })]);
    const { entries } = await walk(h.source);
    const entry = entries[0];
    expect(entry).toMatchObject({
      name: "io.example/alpha",
      version: "1.0.0",
      status: "active",
      isLatest: true,
    });
    expect(entry?.packages[0]).toMatchObject({
      method: "npm",
      version: "1.0.0",
      transport: "stdio",
    });
    expect(entry?.remotes).toEqual([]);
  });

  it("incremental mode returns only newer records, including deleted and deprecated ones", async () => {
    const h = make();
    h.apply(contractDataset());
    const { entries } = await walk(h.source, { updatedSince: iso(199) });
    expect(entries.map((e) => [e.name, e.status]).sort()).toEqual([
      ["io.example/gone", "deleted"],
      ["io.example/old-tool", "deprecated"],
    ]);
  });

  it("flags an unsupported schema as rejected, with a reason, instead of a usable entry", async () => {
    const h = make();
    h.apply(contractDataset());
    const { entries, rejected } = await walk(h.source);
    expect(entries.find((e) => e.name === "io.example/future")).toBeUndefined();
    expect(rejected).toEqual([
      expect.objectContaining({ name: "io.example/future", reason: "schema_unsupported" }),
    ]);
  });

  it("stops with an aborted error when the signal is already aborted", async () => {
    const h = make();
    h.apply(contractDataset());
    const controller = new AbortController();
    controller.abort();
    await expect(h.source.listPage({ limit: 10, signal: controller.signal })).rejects.toMatchObject(
      {
        code: "aborted",
      },
    );
  });

  it("gets one version, or undefined when the provider has none", async () => {
    const h = make();
    h.apply([record({ name: "io.example/alpha" })]);
    expect((await h.source.get("io.example/alpha"))?.name).toBe("io.example/alpha");
    expect((await h.source.get("io.example/alpha", "1.0.0"))?.version).toBe("1.0.0");
    expect(await h.source.get("io.example/missing")).toBeUndefined();
  });

  it("declares what it supports", () => {
    const { source } = make();
    expect(source.capabilities.supportsIncremental).toBe(true);
    expect(source.capabilities.schemaVersions.length).toBeGreaterThan(0);
    expect(source.sourceId.length).toBeGreaterThan(0);
  });
});

describe("OfficialRegistrySource specifics", () => {
  it("maps the three schema revisions to the same domain shape", async () => {
    const h = official();
    h.apply([
      record({ name: "io.example/a", kind: "npm" }), // index 0 -> 2025-07-09 (snake_case)
      record({ name: "io.example/b", kind: "npm" }), // 2025-09-29
      record({ name: "io.example/c", kind: "npm" }), // 2025-12-11
    ]);
    const { entries } = await walk(h.source);
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.packages[0]?.inputs).toEqual([
        expect.objectContaining({ name: "API_KEY", kind: "env", isRequired: true, isSecret: true }),
      ]);
    }
    expect(entries.map((e) => e.provenance.schemaVersion).sort()).toEqual([
      "2025-07-09",
      "2025-09-29",
      "2025-12-11",
    ]);
  });

  it("keeps the remote transports and publisher hints", async () => {
    const h = official();
    h.apply([
      record({ name: "io.example/r", kind: "remote", hints: { categories: ["data"] } }),
      record({ name: "io.example/s", kind: "sse" }),
    ]);
    const { entries } = await walk(h.source);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["io.example/r"]?.remotes[0]).toMatchObject({ transport: "streamable-http" });
    expect(byName["io.example/r"]?.publisherHints?.categories).toEqual(["data"]);
    expect(byName["io.example/s"]?.remotes[0]).toMatchObject({ transport: "sse" });
  });

  it("uses the /v0.1 endpoints, keeps filters on every cursor page and clamps the limit to 100", async () => {
    let data = contractDataset();
    const stub = registryFetch({ dataset: () => data });
    const source = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: stub.fetch,
      sleep: async () => {},
    });
    await walk(source, { limit: 500 });
    expect(stub.calls.every((c) => c.startsWith("/v0.1/servers?"))).toBe(true);
    expect(stub.calls[0]).toContain("limit=100");
    expect(stub.calls[0]).toContain("version=latest");
    expect(stub.calls[1]).toContain("cursor=");
    expect(stub.calls[1]).toContain("version=latest");
    stub.calls.length = 0;
    await walk(source, { updatedSince: iso(10) });
    expect(stub.calls[0]).toContain("updated_since=");
    expect(stub.calls[0]).not.toContain("version=latest");
    data = [];
  });

  it("retries transient failures, honouring Retry-After, and gives up after two retries", async () => {
    const waits: number[] = [];
    const stub = registryFetch({
      dataset: () => [record({ name: "io.example/a" })],
      scripted: [{ status: 503, headers: { "retry-after": "2" } }, "network"],
    });
    const source = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: stub.fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const page = await source.listPage({ limit: 10 });
    expect(page.entries).toHaveLength(1);
    expect(waits[0]).toBe(2000);
    expect(stub.calls).toHaveLength(3);

    const failing = registryFetch({
      dataset: () => [],
      scripted: [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }],
    });
    const hopeless = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: failing.fetch,
      sleep: async () => {},
    });
    await expect(hopeless.listPage({ limit: 10 })).rejects.toMatchObject({
      code: "http",
      status: 503,
    });
    expect(failing.calls).toHaveLength(3);
  });

  it("does not retry a client error and reports it with its status", async () => {
    const stub = registryFetch({ dataset: () => [], scripted: [{ status: 422 }] });
    const source = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: stub.fetch,
      sleep: async () => {},
    });
    await expect(source.listPage({ limit: 10 })).rejects.toMatchObject({
      code: "http",
      status: 422,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it("rejects an oversized record and an invalid one without losing the valid ones", async () => {
    const huge = "x".repeat(200 * 1024);
    const body = JSON.stringify({
      servers: [
        {
          server: {
            $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
            name: "io.example/huge",
            description: huge,
            version: "1.0.0",
          },
          _meta: {},
        },
        { server: { name: 42 }, _meta: {} },
        {
          server: {
            $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
            name: "io.example/ok",
            description: "fine",
            version: "1.0.0",
            remotes: [{ type: "streamable-http", url: "https://mcp.example.com/x" }],
          },
          _meta: {
            "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true },
          },
        },
      ],
      metadata: { count: 3 },
    });
    const stub = registryFetch({ dataset: () => [], scripted: [{ status: 200, body }] });
    const source = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: stub.fetch,
      sleep: async () => {},
    });
    const page = await source.listPage({ limit: 10 });
    expect(page.entries.map((e) => e.name)).toEqual(["io.example/ok"]);
    expect(page.rejected.map((r) => r.reason).sort()).toEqual(["invalid", "too_large"]);
  });

  it("rejects a response over the byte budget and a non-JSON body", async () => {
    const big = registryFetch({
      dataset: () => [],
      scripted: [{ status: 200, body: "x".repeat(6 * 1024 * 1024) }],
    });
    const source = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: big.fetch,
      sleep: async () => {},
    });
    await expect(source.listPage({ limit: 10 })).rejects.toMatchObject({ code: "too_large" });
    const bad = registryFetch({ dataset: () => [], scripted: [{ status: 200, body: "<html>" }] });
    const other = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: bad.fetch,
      sleep: async () => {},
    });
    await expect(other.listPage({ limit: 10 })).rejects.toMatchObject({ code: "bad_response" });
  });

  it("refuses an insecure or credentialed base URL but allows loopback http for local mirrors", () => {
    const make = (baseUrl: string) =>
      new OfficialRegistrySource({ baseUrl, fetch: fetch as never });
    expect(() => make("http://registry.example.test")).toThrow(/https/i);
    expect(() => make("https://user:pass@registry.example.test")).toThrow(/credentials/i);
    expect(() => make("http://127.0.0.1:9999")).not.toThrow();
    expect(make("https://registry.modelcontextprotocol.io/").sourceId).toBe("official");
    expect(make("https://mirror.example.test").sourceId).toBe(
      "official:https://mirror.example.test",
    );
  });

  it("times out a request that never answers and follows the caller's abort", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const source = new OfficialRegistrySource({
      baseUrl: "https://registry.example.test",
      fetch: hang,
      sleep: async () => {},
      requestTimeoutMs: 20,
      maxRetries: 0,
    });
    await expect(source.listPage({ limit: 10 })).rejects.toMatchObject({ code: "timeout" });
    const controller = new AbortController();
    const pending = source.listPage({ limit: 10, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});
