/**
 * Builds the active `CatalogSource` from configuration (D14). The registry maps a source id to an
 * adapter constructor; the official registry is the default and only built-in. Adding another
 * provider means registering one adapter here: nothing downstream changes.
 */

import { type CatalogSource, CatalogSourceError } from "./source.ts";
import { OFFICIAL_SOURCE_ID, OfficialRegistrySource } from "./sources/official-registry.ts";

export interface CatalogSourceConfig {
  /** Adapter id; default `official`. */
  source?: string;
  /** Base URL of the provider; adapters validate it (HTTPS by default). */
  baseUrl?: string;
}

export interface SourceDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type SourceBuilder = (config: CatalogSourceConfig, deps: SourceDeps) => CatalogSource;

export interface SourceFactory {
  create(config: CatalogSourceConfig, deps?: SourceDeps): CatalogSource;
  ids(): string[];
}

export function createSourceFactory(extra: Record<string, SourceBuilder> = {}): SourceFactory {
  const builders: Record<string, SourceBuilder> = {
    [OFFICIAL_SOURCE_ID]: (config, deps) =>
      new OfficialRegistrySource({
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      }),
    ...extra,
  };
  return {
    create(config, deps = {}) {
      const id = config.source ?? OFFICIAL_SOURCE_ID;
      const build = Object.hasOwn(builders, id) ? builders[id] : undefined;
      if (!build) throw new CatalogSourceError("unknown_source", `Unknown catalog source "${id}"`);
      return build(config, deps);
    },
    ids: () => Object.keys(builders),
  };
}
