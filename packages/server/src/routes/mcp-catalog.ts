/**
 * MCP catalog routes (specs/030 phase 2): browse, search, filter and page the local index, read
 * one entry's public card and start/inspect the background sync. The routes depend only on the
 * `McpCatalogService` port of core: whichever source feeds it, nothing here changes. Nothing is
 * executed and no upstream request happens per query; `--read-only` blocks the sync only.
 */
import { CATEGORY_IDS, type CatalogQuery, type McpCatalogService } from "@alisio/core";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";

export interface McpCatalogContext {
  catalog: McpCatalogService;
  readOnly?: boolean;
  /** The host declared the browser runs on the same computer as the server (desktop). */
  localBrowser?: boolean;
}

const invalid = (field: string, message: string) =>
  new HttpError("validation_failed", message, { fields: [field] });

function integer(
  value: string | null,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < min || n > max)
    throw invalid(field, `${field} must be an integer from ${min} to ${max}`);
  return n;
}

/** Hand-validated query string: unknown keys are ignored, bad values name their field only. */
export function parseCatalogQuery(params: URLSearchParams): CatalogQuery {
  const query: CatalogQuery = {};
  const q = params.get("q");
  if (q !== null) {
    if (q.length > 200) throw invalid("q", "q is too long");
    if (q.trim()) query.q = q;
  }
  const category = params.get("category");
  if (category) {
    if (!(CATEGORY_IDS as readonly string[]).includes(category))
      throw invalid("category", "Unknown category");
    query.category = category;
  }
  const execution = params.get("execution");
  if (execution) {
    if (execution !== "local" && execution !== "remote")
      throw invalid("execution", "execution must be local or remote");
    query.execution = execution;
  }
  const method = params.get("method");
  if (method) {
    if (!/^[a-z0-9-]{1,32}$/.test(method)) throw invalid("method", "Invalid method");
    query.method = method;
  }
  const ready = params.get("ready");
  if (ready !== null && ready !== "") {
    if (ready !== "true" && ready !== "false")
      throw invalid("ready", "ready must be true or false");
    if (ready === "true") query.ready = true;
  }
  const status = params.get("status");
  if (status) {
    if (status !== "active" && status !== "all")
      throw invalid("status", "status must be active or all");
    query.status = status;
  }
  const page = integer(params.get("page"), "page", 1, 100_000);
  if (page) query.page = page;
  const pageSize = integer(params.get("pageSize"), "pageSize", 1, 100);
  if (pageSize) query.pageSize = pageSize;
  return query;
}

export function registerMcpCatalogRoutes(router: Router, ctx: McpCatalogContext): void {
  const guarded = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // The index could not be opened or read; the cause (a path, a driver message) stays server-side.
      throw new HttpError("mcp_catalog_unavailable", "The MCP catalog is unavailable");
    }
  };

  router.get("/api/mcp/catalog", ({ url }) => {
    const query = parseCatalogQuery(url.searchParams);
    return guarded(() => {
      const page = ctx.catalog.list(query);
      // Keeps the index fresh without blocking this answer; a no-op under --read-only.
      ctx.catalog.ensureFresh();
      return {
        body: {
          ...page,
          syncStatus: ctx.catalog.status(),
          ...(ctx.localBrowser ? { localBrowser: true } : {}),
        },
      };
    });
  });

  router.get("/api/mcp/catalog/detail", ({ url }) => {
    const name = url.searchParams.get("name");
    if (!name || name.length > 300) throw invalid("name", "name is required");
    const version = url.searchParams.get("version") ?? undefined;
    if (version && version.length > 128) throw invalid("version", "version is too long");
    const source = url.searchParams.get("source");
    return guarded(() => {
      if (source && source !== ctx.catalog.sourceId) throw new HttpError("not_found", "Not found");
      const detail = ctx.catalog.detail(name, version);
      if (!detail) throw new HttpError("not_found", "MCP catalog entry not found");
      return { body: { ...detail, ...(ctx.localBrowser ? { localBrowser: true } : {}) } };
    });
  });

  router.post("/api/mcp/catalog/sync", () => {
    if (ctx.readOnly)
      throw new HttpError("mcp_not_permitted", "The catalog cannot be updated under --read-only");
    return guarded(() => ({ body: ctx.catalog.sync() }));
  });
}
