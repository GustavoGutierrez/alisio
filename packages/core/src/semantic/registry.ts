import type { EmbeddingProvider, VectorStoreProvider } from "@alisio/sdk";

const PROVIDER_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export interface RegisteredSemantic<T> {
  owner: string;
  provider: T;
}

/**
 * Two catalogs, one per port. Registering never activates: `semantic.embedding` and
 * `semantic.store` in the global configuration pick the active providers.
 */
export class SemanticRegistry {
  private embeddings = new Map<string, RegisteredSemantic<EmbeddingProvider>>();
  private stores = new Map<string, RegisteredSemantic<VectorStoreProvider>>();
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot break registration. */
      }
    }
  }

  private add<T extends { id: string; name: string }>(
    kind: string,
    map: Map<string, RegisteredSemantic<T>>,
    owner: string,
    provider: T,
    methods: string[],
  ): () => void {
    if (!provider || typeof provider !== "object") throw new TypeError(`Invalid ${kind} provider`);
    if (typeof provider.id !== "string" || !PROVIDER_ID.test(provider.id))
      throw new TypeError(`Invalid ${kind} provider id: ${String(provider.id)}`);
    if (typeof provider.name !== "string" || !provider.name.trim())
      throw new TypeError(`${kind} provider ${provider.id} needs a name`);
    for (const method of methods)
      if (typeof (provider as unknown as Record<string, unknown>)[method] !== "function")
        throw new TypeError(`${kind} provider ${provider.id} needs a ${method} function`);
    if (map.has(provider.id)) throw new TypeError(`Duplicate ${kind} provider: ${provider.id}`);
    const entry = { owner, provider };
    map.set(provider.id, entry);
    this.changed();
    return () => {
      if (map.get(provider.id) !== entry) return;
      map.delete(provider.id);
      this.changed();
    };
  }

  /** Returns the function that removes this registration (a no-op once it was replaced). */
  registerEmbedding(owner: string, provider: EmbeddingProvider): () => void {
    return this.add("embedding", this.embeddings, owner, provider, [
      "modelId",
      "dimensions",
      "embed",
    ]);
  }

  registerStore(owner: string, provider: VectorStoreProvider): () => void {
    return this.add("store", this.stores, owner, provider, [
      "ensureCollection",
      "getCollection",
      "listCollections",
      "dropCollection",
      "upsert",
      "delete",
      "query",
    ]);
  }

  getEmbedding(id: string) {
    return this.embeddings.get(id);
  }

  getStore(id: string) {
    return this.stores.get(id);
  }

  listEmbeddings(): Array<{ id: string; name: string; owner: string }> {
    return summarize(this.embeddings);
  }

  listStores(): Array<{ id: string; name: string; owner: string }> {
    return summarize(this.stores);
  }
}

function summarize<T extends { id: string; name: string }>(
  map: Map<string, RegisteredSemantic<T>>,
) {
  return [...map.values()]
    .map(({ owner, provider }) => ({ id: provider.id, name: provider.name, owner }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
