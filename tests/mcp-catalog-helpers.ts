/**
 * Shared fixtures for the MCP catalog tests (specs/030 phase 2): a neutral dataset description,
 * an in-memory `CatalogSource`, and a stub `fetch` that serves the same dataset in the official
 * registry's wire format (three schema revisions). Nothing here touches the network.
 */
import { createHash } from "node:crypto";
import {
  type CatalogEntry,
  type CatalogSource,
  CatalogSourceError,
  type CatalogSourcePage,
  type ListPageRequest,
  type RejectedEntry,
} from "../packages/core/src/mcp/catalog/source.ts";

export interface DatasetRecord {
  name: string;
  version: string;
  status: "active" | "deprecated" | "deleted";
  isLatest: boolean;
  updatedAt: string;
  description: string;
  title?: string;
  kind: "npm" | "remote" | "pypi" | "sse";
  /** `unknown` makes the provider write the record against a schema revision nobody supports. */
  schema: "known" | "unknown";
  hints?: { categories?: string[] };
}

export const T0 = Date.parse("2026-01-01T00:00:00Z");
export const iso = (offsetMinutes: number) => new Date(T0 + offsetMinutes * 60_000).toISOString();

const KINDS: DatasetRecord["kind"][] = ["npm", "remote", "pypi"];

/** 150 active latest servers, one deprecated, one deleted and one in an unsupported schema. */
export function contractDataset(): DatasetRecord[] {
  const records: DatasetRecord[] = [];
  for (let i = 0; i < 150; i++) {
    const n = String(i).padStart(3, "0");
    records.push({
      name: `io.example/server-${n}`,
      version: "1.0.0",
      status: "active",
      isLatest: true,
      updatedAt: iso(i),
      description: `Example server number ${n}`,
      kind: KINDS[i % 3] ?? "npm",
      schema: "known",
    });
  }
  records.push({
    name: "io.example/old-tool",
    version: "0.9.0",
    status: "deprecated",
    isLatest: true,
    updatedAt: iso(200),
    description: "A tool nobody maintains",
    kind: "npm",
    schema: "known",
  });
  records.push({
    name: "io.example/gone",
    version: "1.0.0",
    status: "deleted",
    isLatest: true,
    updatedAt: iso(201),
    description: "Removed by its publisher",
    kind: "npm",
    schema: "known",
  });
  records.push({
    name: "io.example/future",
    version: "1.0.0",
    status: "active",
    isLatest: true,
    updatedAt: iso(202),
    description: "Written against a schema Alisio does not know",
    kind: "npm",
    schema: "unknown",
  });
  return records;
}

export function record(over: Partial<DatasetRecord> & { name: string }): DatasetRecord {
  return {
    version: "1.0.0",
    status: "active",
    isLatest: true,
    updatedAt: iso(0),
    description: `Description of ${over.name}`,
    kind: "npm",
    schema: "known",
    ...over,
  };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function entryFor(sourceId: string, r: DatasetRecord): CatalogEntry {
  const rawJson = JSON.stringify(r);
  const npm = r.kind === "npm";
  return {
    sourceId,
    name: r.name,
    ...(r.title ? { title: r.title } : {}),
    description: r.description,
    version: r.version,
    status: r.status === "deleted" ? "deleted" : r.status,
    isLatest: r.isLatest,
    updatedAt: r.updatedAt,
    packages:
      r.kind === "npm" || r.kind === "pypi"
        ? [
            {
              method: npm ? "npm" : "pypi",
              identifier: `pkg-${r.name}`,
              version: r.version,
              transport: "stdio",
              inputs: [],
              args: [],
            },
          ]
        : [],
    remotes:
      r.kind === "remote" || r.kind === "sse"
        ? [
            {
              transport: r.kind === "sse" ? "sse" : "streamable-http",
              url: `https://mcp.example.com/${r.name}`,
              inputs: [],
            },
          ]
        : [],
    ...(r.hints?.categories
      ? { publisherHints: { categories: r.hints.categories, keywords: [] } }
      : {}),
    provenance: { sourceId, schemaVersion: "fake-1", rawDigest: sha(rawJson), rawJson },
  };
}

export interface FakeSourceOptions {
  sourceId?: string;
  records?: DatasetRecord[];
  /** Throws on the n-th listPage call (1-based) with this error. */
  failOnCall?: { call: number; error?: Error };
  /** Pages are cut at this size even when the caller asks for more. */
  maxLimit?: number;
}

/** An in-memory adapter that implements the port; the reference every other adapter is held to. */
export class FakeCatalogSource implements CatalogSource {
  readonly sourceId: string;
  readonly capabilities = {
    supportsIncremental: true,
    supportsSearch: false,
    supportsCategories: false,
    schemaVersions: ["fake-1"],
  } as const;
  records: DatasetRecord[];
  listCalls: ListPageRequest[] = [];
  private failOnCall: FakeSourceOptions["failOnCall"];
  constructor(private options: FakeSourceOptions = {}) {
    this.sourceId = options.sourceId ?? "fake";
    this.records = options.records ?? [];
    this.failOnCall = options.failOnCall;
  }
  failAt(call: number | undefined, error?: Error) {
    this.failOnCall = call === undefined ? undefined : { call, ...(error ? { error } : {}) };
  }
  async listPage(request: ListPageRequest): Promise<CatalogSourcePage> {
    this.listCalls.push(request);
    if (request.signal?.aborted) throw new CatalogSourceError("aborted", "aborted");
    if (this.failOnCall && this.listCalls.length === this.failOnCall.call)
      throw this.failOnCall.error ?? new CatalogSourceError("network", "connection reset");
    const since = request.updatedSince ? Date.parse(request.updatedSince) : undefined;
    const visible = this.records
      .filter((r) =>
        since === undefined
          ? r.isLatest && r.status !== "deleted"
          : Date.parse(r.updatedAt) > since,
      )
      .sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));
    const limit = Math.min(request.limit, this.options.maxLimit ?? 100);
    const start = request.cursor ? Number(request.cursor) : 0;
    const slice = visible.slice(start, start + limit);
    const entries: CatalogEntry[] = [];
    const rejected: RejectedEntry[] = [];
    for (const r of slice) {
      if (r.schema === "unknown")
        rejected.push({
          name: r.name,
          version: r.version,
          reason: "schema_unsupported",
          schemaVersion: "2099-01-01",
        });
      else entries.push(entryFor(this.sourceId, r));
    }
    const next = start + limit < visible.length ? String(start + limit) : undefined;
    return { entries, rejected, ...(next ? { nextCursor: next } : {}) };
  }
  async get(name: string, version?: string): Promise<CatalogEntry | undefined> {
    const found = this.records.find(
      (r) =>
        r.name === name && (version ? r.version === version : r.isLatest) && r.schema === "known",
    );
    return found ? entryFor(this.sourceId, found) : undefined;
  }
}

// ---- the official registry's wire format, served from a stub fetch --------------------------

const SCHEMA = (v: string) =>
  `https://static.modelcontextprotocol.io/schemas/${v}/server.schema.json`;
const REVISIONS = ["2025-07-09", "2025-09-29", "2025-12-11"] as const;

function rawServer(r: DatasetRecord, index: number) {
  const unknown = r.schema === "unknown";
  const revision = unknown ? "2099-01-01" : (REVISIONS[index % 3] ?? "2025-12-11");
  const legacy = revision === "2025-07-09";
  const server: Record<string, unknown> = {
    $schema: SCHEMA(revision),
    name: r.name,
    description: r.description,
    version: r.version,
    ...(r.title ? { title: r.title } : {}),
  };
  if (r.kind === "npm" || r.kind === "pypi") {
    const type = r.kind;
    const pkg: Record<string, unknown> = legacy
      ? {
          registry_type: type,
          identifier: `pkg-${r.name}`,
          version: r.version,
          transport: { type: "stdio" },
          environment_variables: [{ name: "API_KEY", is_required: true, is_secret: true }],
        }
      : {
          registryType: type,
          identifier: `pkg-${r.name}`,
          version: r.version,
          transport: { type: "stdio" },
          environmentVariables: [{ name: "API_KEY", isRequired: true, isSecret: true }],
        };
    server.packages = [pkg];
  } else {
    server.remotes = [
      {
        type: r.kind === "sse" ? "sse" : "streamable-http",
        url: `https://mcp.example.com/${r.name}`,
      },
    ];
  }
  const official: Record<string, unknown> = {
    status: r.status,
    isLatest: r.isLatest,
    updatedAt: r.updatedAt,
  };
  const meta: Record<string, unknown> = { "io.modelcontextprotocol.registry/official": official };
  if (r.hints?.categories)
    meta["io.modelcontextprotocol.registry/publisher-provided"] = {
      categories: r.hints.categories,
    };
  return { server, _meta: meta };
}

export interface RegistryStubOptions {
  dataset: () => DatasetRecord[];
  /** Responses to emit in order before serving normally (e.g. 503 with Retry-After). */
  scripted?: Array<{ status: number; headers?: Record<string, string>; body?: string } | "network">;
  delayMs?: number;
}

/** A `fetch` that behaves like registry 1.8.x for the endpoints Alisio uses. */
export function registryFetch(options: RegistryStubOptions) {
  const calls: string[] = [];
  const scripted = [...(options.scripted ?? [])];
  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push(`${url.pathname}${url.search}`);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const next = scripted.shift();
    if (next === "network") throw new TypeError("fetch failed");
    if (next)
      return new Response(next.body ?? "{}", { status: next.status, headers: next.headers ?? {} });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const all = options.dataset();
    if (url.pathname === "/v0.1/servers") {
      const limit = Number(url.searchParams.get("limit") ?? "30");
      if (limit > 100 || limit < 1) return json({ error: "limit" }, 422);
      const search = url.searchParams.get("search");
      if (search !== null && search.length < 3) return json({ error: "search" }, 422);
      const since = url.searchParams.get("updated_since");
      const latestOnly = url.searchParams.get("version") === "latest";
      let rows = all.filter((r) => {
        if (since) return Date.parse(r.updatedAt) > Date.parse(since);
        if (r.status === "deleted") return false;
        return latestOnly ? r.isLatest : true;
      });
      rows = rows.sort((a, b) =>
        (a.name + ":" + a.version).localeCompare(b.name + ":" + b.version),
      );
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? rows.findIndex((r) => `${r.name}:${r.version}` === cursor) + 1 : 0;
      const slice = rows.slice(start, start + limit);
      const last = slice[slice.length - 1];
      const hasMore = start + limit < rows.length && last;
      return json({
        servers: slice.map((r) => rawServer(r, all.indexOf(r))),
        metadata: {
          count: slice.length,
          ...(hasMore ? { nextCursor: `${last.name}:${last.version}` } : {}),
        },
      });
    }
    const detail = /^\/v0\.1\/servers\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      const name = decodeURIComponent(detail[1] ?? "");
      const version = decodeURIComponent(detail[2] ?? "");
      const found = all.find(
        (r) => r.name === name && (version === "latest" ? r.isLatest : r.version === version),
      );
      return found ? json(rawServer(found, all.indexOf(found))) : json({ error: "not found" }, 404);
    }
    return json({ error: "unknown" }, 404);
  };
  return { fetch: fetchStub as typeof fetch, calls };
}
