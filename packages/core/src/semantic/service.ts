import {
  type CollectionInfo,
  type EmbeddingKind,
  type EmbeddingProvider,
  SemanticError,
  type SemanticHealth,
  type SemanticSearchOptions,
  type ToolSemantic,
  type VectorMatch,
  type VectorStoreProvider,
} from "@alisio/sdk";
import { composeCollection, decomposeCollection, namespacePrefix } from "./namespace.ts";
import type { RegisteredSemantic, SemanticRegistry } from "./registry.ts";
import {
  isValidDimensions,
  SEMANTIC_LIMITS,
  validateCollection,
  validateDocuments,
  validateFilter,
  validateIds,
  validateKind,
  validateMinScore,
  validateQuery,
  validateTexts,
  validateTopK,
} from "./validate.ts";

export interface SemanticConfig {
  enabled: boolean;
  embedding: string | null;
  store: string | null;
  embedTimeoutMs: number;
  queryTimeoutMs: number;
}

export const DEFAULT_SEMANTIC_CONFIG: SemanticConfig = {
  enabled: true,
  embedding: null,
  store: null,
  embedTimeoutMs: 60_000,
  queryTimeoutMs: 5_000,
};

/** `/semantic` asks each provider's health with its own short limit. */
export const HEALTH_TIMEOUT_MS = 1000;

export interface SemanticServiceDeps {
  registry: SemanticRegistry;
  /** Read per call, so live setting changes apply without rebuilding the service. */
  config: () => SemanticConfig;
}

export interface SemanticStatus {
  enabled: boolean;
  configured: { embedding: string | null; store: string | null };
  registered: {
    embeddings: Array<{ id: string; name: string; owner: string }>;
    stores: Array<{ id: string; name: string; owner: string }>;
  };
  active: {
    embedding: { id: string; name: string; modelId: string; dimensions: number } | null;
    store: { id: string; name: string } | null;
  };
  health: { embedding?: SemanticHealth; store?: SemanticHealth };
}

interface Active {
  embedding: RegisteredSemantic<EmbeddingProvider>;
  store: RegisteredSemantic<VectorStoreProvider>;
}
interface Identity {
  modelId: string;
  dimensions: number;
}

const callerAbort = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");

/** Provider details (paths, user text) never leave this boundary: the cause is dropped. */
const providerError = (label: string): SemanticError =>
  new SemanticError("provider_error", `The semantic provider failed (${label})`);

/**
 * One provider call with its own AbortSignal and the host time limit. A caller abort propagates
 * as the caller's own abort (never as `timeout`); anything the provider throws becomes a
 * path-free `provider_error`.
 */
async function guarded<T>(
  label: string,
  timeoutMs: number,
  caller: AbortSignal | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (caller?.aborted) throw callerAbort(caller);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException("Semantic call timed out", "TimeoutError"));
        reject(new SemanticError("timeout", `The semantic provider timed out (${label})`));
      }, timeoutMs);
      if (caller) {
        onAbort = () => {
          controller.abort(caller.reason);
          reject(callerAbort(caller));
        };
        caller.addEventListener("abort", onAbort, { once: true });
      }
      let pending: Promise<T>;
      try {
        pending = Promise.resolve(call(controller.signal));
      } catch {
        pending = Promise.reject(new Error("provider threw"));
      }
      pending.then(resolve, () => reject(providerError(label)));
    });
  } finally {
    clearTimeout(timer);
    if (caller && onAbort) caller.removeEventListener("abort", onAbort);
  }
}

const isInfo = (value: unknown): value is CollectionInfo =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CollectionInfo).name === "string" &&
  typeof (value as CollectionInfo).modelId === "string" &&
  isValidDimensions((value as CollectionInfo).dimensions) &&
  Number.isInteger((value as CollectionInfo).count);

const isMatch = (value: unknown): value is VectorMatch =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as VectorMatch).id === "string" &&
  Number.isFinite((value as VectorMatch).score) &&
  ((value as VectorMatch).text === undefined || typeof (value as VectorMatch).text === "string");

/**
 * Composes the two semantic ports for consumers (spec 029): namespacing (D4), model
 * compatibility (D5), limits (D9/D10), timeouts (D8) and degradation (D7).
 */
export class SemanticService {
  constructor(private deps: SemanticServiceDeps) {}

  private active(): Active | null {
    const config = this.deps.config();
    if (!config.enabled || !config.embedding || !config.store) return null;
    const embedding = this.deps.registry.getEmbedding(config.embedding);
    const store = this.deps.registry.getStore(config.store);
    return embedding && store ? { embedding, store } : null;
  }

  available(): boolean {
    return this.active() !== null;
  }

  private require(): Active {
    const active = this.active();
    if (!active) throw new SemanticError("unavailable", "Semantic search is not available");
    return active;
  }

  private identity(embedding: EmbeddingProvider): Identity {
    try {
      const modelId = embedding.modelId();
      const dimensions = embedding.dimensions();
      if (typeof modelId === "string" && modelId.length > 0 && isValidDimensions(dimensions))
        return { modelId, dimensions };
    } catch {
      /* falls through to the typed error */
    }
    throw providerError("identity");
  }

  private async embedChecked(
    active: Active,
    identity: Identity,
    texts: string[],
    kind: EmbeddingKind,
    signal: AbortSignal | undefined,
  ): Promise<Float32Array[]> {
    const vectors = await guarded("embed", this.deps.config().embedTimeoutMs, signal, (inner) =>
      active.embedding.provider.embed(texts, { kind, signal: inner }),
    );
    if (!Array.isArray(vectors) || vectors.length !== texts.length) throw providerError("embed");
    for (const vector of vectors) {
      if (!(vector instanceof Float32Array)) throw providerError("embed");
      if (vector.length !== identity.dimensions)
        throw new SemanticError(
          "dimension_mismatch",
          "The provider returned a vector of the wrong size",
        );
      for (const value of vector) if (!Number.isFinite(value)) throw providerError("embed");
    }
    return vectors;
  }

  private checkCompatible(info: CollectionInfo, identity: Identity) {
    if (info.modelId !== identity.modelId)
      throw new SemanticError(
        "model_mismatch",
        "The collection was built with another model; reindex it",
      );
    if (info.dimensions !== identity.dimensions)
      throw new SemanticError(
        "dimension_mismatch",
        "The collection was built with another vector size; reindex it",
      );
  }

  private async getInfo(
    active: Active,
    stored: string,
    signal: AbortSignal | undefined,
  ): Promise<CollectionInfo | null> {
    const info = await guarded(
      "getCollection",
      this.deps.config().queryTimeoutMs,
      signal,
      (inner) => active.store.provider.getCollection(stored, inner),
    );
    if (info === null) return null;
    if (!isInfo(info)) throw providerError("getCollection");
    return info;
  }

  /** The consumer side of the ports, bound to one plugin (its collections are namespaced). */
  forPlugin(pluginId: string): ToolSemantic {
    const stored = (collection: string) => composeCollection(pluginId, collection);
    const service = this;

    const run = async (
      collection: string,
      query: string,
      options: SemanticSearchOptions | undefined,
    ): Promise<VectorMatch[]> => {
      const name = validateCollection(collection);
      const text = validateQuery(query);
      const topK = validateTopK(options?.topK);
      const filter = validateFilter(options?.filter);
      const minScore = validateMinScore(options?.minScore);
      const signal = options?.signal;
      const active = service.require();
      const identity = service.identity(active.embedding.provider);
      const info = await service.getInfo(active, stored(name), signal);
      if (!info) return [];
      service.checkCompatible(info, identity);
      const [vector] = await service.embedChecked(active, identity, [text], "query", signal);
      const matches = await guarded(
        "query",
        service.deps.config().queryTimeoutMs,
        signal,
        (inner) =>
          active.store.provider.query(stored(name), vector as Float32Array, {
            topK,
            ...(filter ? { filter } : {}),
            signal: inner,
          }),
      );
      if (!Array.isArray(matches) || !matches.every(isMatch)) throw providerError("query");
      return matches
        .filter((m) => minScore === undefined || m.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((m) => ({
          id: m.id,
          score: m.score,
          ...(m.text !== undefined ? { text: m.text } : {}),
          ...(m.metadata ? { metadata: m.metadata } : {}),
        }));
    };

    return {
      available: () => service.available(),
      active() {
        const active = service.active();
        if (!active) return { embedding: null, store: null };
        let embedding: { id: string; modelId: string; dimensions: number } | null = null;
        try {
          embedding = {
            id: active.embedding.provider.id,
            ...service.identity(active.embedding.provider),
          };
        } catch {
          /* a broken provider reports no identity */
        }
        return { embedding, store: { id: active.store.provider.id } };
      },
      async embed(texts, options) {
        const checked = validateTexts(texts);
        const kind = validateKind(options?.kind);
        const active = service.require();
        const identity = service.identity(active.embedding.provider);
        return service.embedChecked(active, identity, checked, kind, options?.signal);
      },
      async index(collection, documents, options) {
        const name = validateCollection(collection);
        const docs = validateDocuments(documents);
        const signal = options?.signal;
        const active = service.require();
        const identity = service.identity(active.embedding.provider);
        const info = await service.getInfo(active, stored(name), signal);
        if (info) service.checkCompatible(info, identity);
        const vectors: Float32Array[] = [];
        for (let i = 0; i < docs.length; i += SEMANTIC_LIMITS.maxTexts)
          vectors.push(
            ...(await service.embedChecked(
              active,
              identity,
              docs.slice(i, i + SEMANTIC_LIMITS.maxTexts).map((d) => d.text),
              "document",
              signal,
            )),
          );
        const ensured = await guarded(
          "ensureCollection",
          service.deps.config().queryTimeoutMs,
          signal,
          (inner) =>
            active.store.provider.ensureCollection(
              stored(name),
              { modelId: identity.modelId, dimensions: identity.dimensions },
              inner,
            ),
        );
        if (!isInfo(ensured)) throw providerError("ensureCollection");
        service.checkCompatible(ensured, identity);
        const records = docs.map((d, i) => ({
          id: d.id,
          vector: vectors[i] as Float32Array,
          ...(d.keepText ? { text: d.text } : {}),
          ...(d.metadata ? { metadata: d.metadata } : {}),
        }));
        // Bulk writes share the indexing budget (`embedTimeoutMs`), not the interactive one.
        await guarded("upsert", service.deps.config().embedTimeoutMs, signal, (inner) =>
          active.store.provider.upsert(stored(name), records, inner),
        );
      },
      search: (collection, query, options) => run(collection, query, options),
      async trySearch(collection, query, options) {
        try {
          return await run(collection, query, options);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          if (error instanceof SemanticError && error.code === "invalid_request") throw error;
          return null;
        }
      },
      async remove(collection, ids, options) {
        const name = validateCollection(collection);
        const checked = validateIds(ids);
        const active = service.require();
        await guarded("delete", service.deps.config().queryTimeoutMs, options?.signal, (inner) =>
          active.store.provider.delete(stored(name), checked, inner),
        );
      },
      async collections(options) {
        const active = service.require();
        const list = await guarded(
          "listCollections",
          service.deps.config().queryTimeoutMs,
          options?.signal,
          (inner) => active.store.provider.listCollections(namespacePrefix(pluginId), inner),
        );
        if (!Array.isArray(list) || !list.every(isInfo)) throw providerError("listCollections");
        return list.flatMap((info) => {
          const name = decomposeCollection(pluginId, info.name);
          return name === null ? [] : [{ ...info, name }];
        });
      },
      async drop(collection, options) {
        const name = validateCollection(collection);
        const active = service.require();
        await guarded(
          "dropCollection",
          service.deps.config().queryTimeoutMs,
          options?.signal,
          (inner) => active.store.provider.dropCollection(stored(name), inner),
        );
      },
    };
  }

  /** For `/semantic` only: the one place `health()` is called, each with its own short limit. */
  async status(signal?: AbortSignal): Promise<SemanticStatus> {
    const config = this.deps.config();
    const embedding = config.embedding
      ? this.deps.registry.getEmbedding(config.embedding)
      : undefined;
    const store = config.store ? this.deps.registry.getStore(config.store) : undefined;
    let embeddingInfo: SemanticStatus["active"]["embedding"] = null;
    if (embedding) {
      try {
        embeddingInfo = {
          id: embedding.provider.id,
          name: embedding.provider.name,
          ...this.identity(embedding.provider),
        };
      } catch {
        embeddingInfo = {
          id: embedding.provider.id,
          name: embedding.provider.name,
          modelId: "unknown",
          dimensions: 0,
        };
      }
    }
    const status: SemanticStatus = {
      enabled: config.enabled,
      configured: { embedding: config.embedding, store: config.store },
      registered: {
        embeddings: this.deps.registry.listEmbeddings(),
        stores: this.deps.registry.listStores(),
      },
      active: {
        embedding: embeddingInfo,
        store: store ? { id: store.provider.id, name: store.provider.name } : null,
      },
      health: {},
    };
    const [embeddingHealth, storeHealth] = await Promise.all([
      embedding ? checkHealth(embedding.provider, signal) : undefined,
      store ? checkHealth(store.provider, signal) : undefined,
    ]);
    if (embeddingHealth) status.health.embedding = embeddingHealth;
    if (storeHealth) status.health.store = storeHealth;
    return status;
  }
}

async function checkHealth(
  provider: { health?: (signal?: AbortSignal) => Promise<SemanticHealth> },
  signal: AbortSignal | undefined,
): Promise<SemanticHealth | undefined> {
  if (typeof provider.health !== "function") return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<SemanticHealth>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException("Health check timed out", "TimeoutError"));
        resolve({ status: "unavailable", detail: "health check timed out" });
      }, HEALTH_TIMEOUT_MS);
      let call: Promise<SemanticHealth>;
      try {
        call = Promise.resolve(provider.health?.(controller.signal) as Promise<SemanticHealth>);
      } catch (error) {
        call = Promise.reject(error);
      }
      call.then(
        (value) =>
          resolve(
            value && ["ready", "starting", "unavailable"].includes(value.status)
              ? {
                  status: value.status,
                  ...(typeof value.detail === "string"
                    ? { detail: value.detail.slice(0, 200) }
                    : {}),
                }
              : { status: "unavailable", detail: "invalid health response" },
          ),
        () => resolve({ status: "unavailable", detail: "health check failed" }),
      );
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
