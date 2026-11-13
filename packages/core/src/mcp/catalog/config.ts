/**
 * Reads the global-only catalog source preference (`mcp.catalog.source` / `mcp.catalog.baseUrl`)
 * from the user's configuration file. Project configuration is never consulted: a repository must
 * not be able to redirect where the catalog comes from. Anything unreadable falls back to the
 * official registry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "../../config.ts";
import type { CatalogSourceConfig } from "./source-factory.ts";

export function readGlobalCatalogConfig(): CatalogSourceConfig {
  try {
    const raw = JSON.parse(readFileSync(join(configHome(), "config.json"), "utf8")) as {
      mcp?: { catalog?: { source?: unknown; baseUrl?: unknown } };
    };
    const catalog = raw.mcp?.catalog;
    return {
      ...(typeof catalog?.source === "string" && catalog.source.trim()
        ? { source: catalog.source.trim() }
        : {}),
      ...(typeof catalog?.baseUrl === "string" && catalog.baseUrl.trim()
        ? { baseUrl: catalog.baseUrl.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}
