import type {
  CollectionInfo,
  EmbeddingKind,
  EmbeddingProvider,
  SemanticHealth,
  SemanticMetadata,
  VectorMatch,
  VectorRecord,
  VectorStoreProvider,
} from "@alisio/sdk";

export type EmbeddingMode =
  | "ok"
  /** Never settles (the abort signal is recorded but ignored). */
  | "hang"
  /** Throws an error that leaks a path. */
  | "throw"
  /** Returns vectors one element short. */
  | "shortVector"
  /** Returns one vector fewer than texts. */
  | "fewVectors"
  /** Returns a NaN inside a vector. */
  | "nan";

export interface MemoryEmbedding extends EmbeddingProvider {
  mode: EmbeddingMode;
  calls: Array<{ texts: string[]; kind: EmbeddingKind }>;
  signals: AbortSignal[];
  healthMode: "ready" | "hang";
}

/** Deterministic bag-of-words embedding: each word hashes into one of `dimensions` buckets. */
export function memoryEmbedding(
  options: { id?: string; modelId?: string; dimensions?: number; mode?: EmbeddingMode } = {},
): MemoryEmbedding {
  const dims = options.dimensions ?? 16;
  const vectorOf = (text: string): Float32Array => {
    const v = new Float32Array(dims);
    for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 0;
      for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % dims;
      v[h] = (v[h] ?? 0) + 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  const provider: MemoryEmbedding = {
    id: options.id ?? "mem-embed",
    name: "Memory embedding",
    mode: options.mode ?? "ok",
    calls: [],
    signals: [],
    healthMode: "ready",
    modelId: () => options.modelId ?? "mem/model@1",
    dimensions: () => dims,
    async embed(texts, { kind, signal }) {
      provider.calls.push({ texts: [...texts], kind });
      provider.signals.push(signal);
      switch (provider.mode) {
        case "hang":
          return new Promise<Float32Array[]>(() => {});
        case "throw":
          throw new Error("/home/u/x.lance: corrupt");
        case "shortVector":
          return texts.map((t) => vectorOf(t).slice(1));
        case "fewVectors":
          return texts.slice(1).map(vectorOf);
        case "nan":
          return texts.map((t) => {
            const v = vectorOf(t);
            v[0] = Number.NaN;
            return v;
          });
        default:
          return texts.map(vectorOf);
      }
    },
    async health(signal): Promise<SemanticHealth> {
      if (provider.healthMode === "hang")
        return new Promise<SemanticHealth>((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason)),
        );
      return { status: "ready" };
    },
  };
  return provider;
}

export interface MemoryStore extends VectorStoreProvider {
  collectionsByName: Map<string, { modelId: string; dimensions: number; records: VectorRecord[] }>;
  calls: Array<{ method: string; name?: string }>;
  count(method: string): number;
}

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** In-memory `VectorStoreProvider` with brute-force cosine similarity. */
export function memoryStore(options: { id?: string } = {}): MemoryStore {
  const collectionsByName: MemoryStore["collectionsByName"] = new Map();
  const info = (name: string): CollectionInfo | null => {
    const c = collectionsByName.get(name);
    return c
      ? { name, modelId: c.modelId, dimensions: c.dimensions, count: c.records.length }
      : null;
  };
  const store: MemoryStore = {
    id: options.id ?? "mem-store",
    name: "Memory store",
    collectionsByName,
    calls: [],
    count: (method) => store.calls.filter((c) => c.method === method).length,
    async ensureCollection(name, spec) {
      store.calls.push({ method: "ensureCollection", name });
      if (!collectionsByName.has(name)) collectionsByName.set(name, { ...spec, records: [] });
      return info(name) as CollectionInfo;
    },
    async getCollection(name) {
      store.calls.push({ method: "getCollection", name });
      return info(name);
    },
    async listCollections(prefix) {
      store.calls.push({ method: "listCollections", name: prefix });
      return [...collectionsByName.keys()]
        .filter((n) => n.startsWith(prefix))
        .map((n) => info(n) as CollectionInfo);
    },
    async dropCollection(name) {
      store.calls.push({ method: "dropCollection", name });
      collectionsByName.delete(name);
    },
    async upsert(name, records) {
      store.calls.push({ method: "upsert", name });
      const c = collectionsByName.get(name);
      if (!c) throw new Error("no collection");
      for (const r of records) {
        c.records = c.records.filter((x) => x.id !== r.id);
        c.records.push(r);
      }
    },
    async delete(name, ids) {
      store.calls.push({ method: "delete", name });
      const c = collectionsByName.get(name);
      if (c) c.records = c.records.filter((r) => !ids.includes(r.id));
    },
    async query(name, vector, { topK, filter }): Promise<VectorMatch[]> {
      store.calls.push({ method: "query", name });
      const c = collectionsByName.get(name);
      if (!c) return [];
      const matches = (m: SemanticMetadata | undefined) =>
        !filter || Object.entries(filter).every(([k, v]) => m?.[k] === v);
      return c.records
        .filter((r) => matches(r.metadata))
        .map((r) => ({
          id: r.id,
          score: cosine(vector, r.vector),
          ...(r.text !== undefined ? { text: r.text } : {}),
          ...(r.metadata ? { metadata: r.metadata } : {}),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
    async health() {
      return { status: "ready" as const };
    },
  };
  return store;
}
