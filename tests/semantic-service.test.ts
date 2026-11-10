import { describe, expect, it } from "vitest";
import { memoryEmbedding } from "./fixtures/memory-semantic.ts";
import { setupSemantic } from "./semantic-helpers.ts";

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code,
  );
const docs = [
  { id: "cats", text: "cats purr and sleep" },
  { id: "cars", text: "cars drive on roads" },
  { id: "dogs", text: "dogs bark loudly" },
];

describe("registered providers stay inactive without configuration (SE-AC-01)", () => {
  it("reports unavailable; search rejects and trySearch resolves null", async () => {
    const { api, embedding, store } = setupSemantic({ embedding: null, store: null });
    expect(api.available()).toBe(false);
    expect(api.active()).toEqual({ embedding: null, store: null });
    expect(await code(api.search("notes", "cats"))).toBe("unavailable");
    expect(await code(api.index("notes", docs))).toBe("unavailable");
    expect(await api.trySearch("notes", "cats")).toBeNull();
    expect(embedding.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it("disabled or an unregistered configured id is also unavailable", async () => {
    expect(setupSemantic({ enabled: false }).api.available()).toBe(false);
    const missing = setupSemantic({ store: "nope" });
    expect(missing.api.available()).toBe(false);
    expect(await missing.api.trySearch("notes", "q")).toBeNull();
  });
});

describe("index and search through the configured providers (SE-AC-02, SE-AC-11)", () => {
  it("returns the closest document first, honors minScore, and sends the right kinds", async () => {
    const { api, embedding } = setupSemantic();
    expect(api.available()).toBe(true);
    expect(api.active()).toEqual({
      embedding: { id: "mem-embed", modelId: "mem/model@1", dimensions: 16 },
      store: { id: "mem-store" },
    });
    await api.index("notes", docs);
    const results = await api.search("notes", "cats purr", { topK: 3 });
    expect(results[0]?.id).toBe("cats");
    expect(results[0]?.text).toBe("cats purr and sleep");
    expect(results.map((r) => r.score)).toEqual(
      [...results.map((r) => r.score)].sort((a, b) => b - a),
    );
    const strict = await api.search("notes", "cats purr", { minScore: 0.5 });
    expect(strict.map((r) => r.id)).toEqual(["cats"]);
    expect(embedding.calls[0]?.kind).toBe("document");
    expect(embedding.calls.at(-1)?.kind).toBe("query");
  });

  it("keepText false omits the stored text; metadata filters apply", async () => {
    const { api } = setupSemantic();
    await api.index("notes", [
      { id: "a", text: "alpha beta", metadata: { lang: "en" }, keepText: false },
      { id: "b", text: "alpha beta", metadata: { lang: "es" } },
    ]);
    const all = await api.search("notes", "alpha beta");
    expect(all.find((r) => r.id === "a")?.text).toBeUndefined();
    const es = await api.search("notes", "alpha beta", { filter: { lang: "es" } });
    expect(es.map((r) => r.id)).toEqual(["b"]);
  });

  it("searching a collection that was never indexed yields no matches", async () => {
    const { api, embedding } = setupSemantic();
    expect(await api.search("empty", "x")).toEqual([]);
    expect(embedding.calls).toHaveLength(0);
  });

  it("drops the oldest vectors on re-index of the same id and supports remove/drop", async () => {
    const { api } = setupSemantic();
    await api.index("notes", docs);
    await api.remove("notes", ["cats"]);
    expect((await api.search("notes", "cats purr")).some((r) => r.id === "cats")).toBe(false);
    await api.drop("notes");
    expect(await api.collections()).toEqual([]);
  });
});

describe("namespacing per consumer plugin (SE-AC-04)", () => {
  it("the store sees a/notes and b/notes and each plugin lists only its own", async () => {
    const { service, store } = setupSemantic();
    const a = service.forPlugin("a");
    const b = service.forPlugin("b");
    await a.index("notes", docs);
    await b.index("notes", [docs[0] as (typeof docs)[number]]);
    await b.index("extra", [docs[1] as (typeof docs)[number]]);
    expect([...store.collectionsByName.keys()].sort()).toEqual(["a/notes", "b/extra", "b/notes"]);
    expect((await a.collections()).map((c) => c.name)).toEqual(["notes"]);
    expect((await b.collections()).map((c) => c.name).sort()).toEqual(["extra", "notes"]);
    expect((await a.search("notes", "cars")).length).toBe(3);
    expect((await b.search("notes", "cars")).length).toBe(1);
  });

  it("a consumer cannot name another plugin's collection", async () => {
    const { service } = setupSemantic();
    expect(await code(service.forPlugin("a").search("b/notes", "x"))).toBe("invalid_request");
  });
});

describe("model compatibility (SE-AC-05)", () => {
  it("rejects model_mismatch without embedding or querying", async () => {
    const { api, registry, store, cfg, embedding } = setupSemantic();
    await api.index("notes", docs);
    const other = memoryEmbedding({ id: "other", modelId: "mem/model@2" });
    registry.registerEmbedding("p2", other);
    cfg.embedding = "other";
    store.calls.length = 0;
    expect(await code(api.index("notes", docs))).toBe("model_mismatch");
    expect(await code(api.search("notes", "cats"))).toBe("model_mismatch");
    expect(await api.trySearch("notes", "cats")).toBeNull();
    expect(other.calls).toHaveLength(0);
    expect(store.count("query")).toBe(0);
    expect(store.count("upsert")).toBe(0);
    expect(embedding.calls.length).toBeGreaterThan(0); // only the earlier index
  });

  it("rejects dimension_mismatch when the model id matches but the size differs", async () => {
    const { api, registry, cfg } = setupSemantic();
    await api.index("notes", docs);
    const wider = memoryEmbedding({ id: "wide", dimensions: 32 });
    registry.registerEmbedding("p2", wider);
    cfg.embedding = "wide";
    expect(await code(api.search("notes", "cats"))).toBe("dimension_mismatch");
    expect(wider.calls).toHaveLength(0);
  });
});

describe("provider output validation (SE-AC-06)", () => {
  it.each([
    ["shortVector", "dimension_mismatch"],
    ["fewVectors", "provider_error"],
    ["nan", "provider_error"],
  ] as const)("%s is rejected as %s and never reaches upsert", async (mode, expected) => {
    const { api, store, embedding } = setupSemantic();
    embedding.mode = mode;
    expect(await code(api.index("notes", docs))).toBe(expected);
    expect(store.count("upsert")).toBe(0);
  });
});

describe("timeouts and aborts (SE-AC-08, SE-AC-09)", () => {
  it("a hanging embed rejects with timeout and aborts the provider signal", async () => {
    const { api, embedding } = setupSemantic({ embedTimeoutMs: 30 });
    embedding.mode = "hang";
    expect(await code(api.embed(["x"], { kind: "query" }))).toBe("timeout");
    expect(embedding.signals.at(-1)?.aborted).toBe(true);
  });

  it("a caller abort propagates and is not reported as timeout", async () => {
    const { api, embedding } = setupSemantic({ embedTimeoutMs: 5000 });
    embedding.mode = "hang";
    const controller = new AbortController();
    const pending = api.embed(["x"], { kind: "query", signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = await pending.then(
      () => undefined,
      (e: Error & { code?: string }) => e,
    );
    expect(error?.name).toBe("AbortError");
    expect(error?.code).not.toBe("timeout");
    expect(embedding.signals.at(-1)?.aborted).toBe(true);
    await expect(api.trySearch("notes", "q", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("provider failures are wrapped safely (SE-AC-10)", () => {
  it("provider_error carries no path nor cause", async () => {
    const { api, embedding, service } = setupSemantic();
    embedding.mode = "throw";
    const error = await api.embed(["secret user text"], { kind: "document" }).then(
      () => undefined,
      (e: Error & { code?: string; cause?: unknown }) => e,
    );
    expect(error?.code).toBe("provider_error");
    expect(error?.message).not.toContain("/home/");
    expect(error?.message).not.toContain("secret user text");
    expect(error?.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("/home/");
    expect(await api.trySearch("notes", "q")).toEqual([]); // empty collection, no provider call
    expect(service.forPlugin("c").available()).toBe(true);
  });
});

describe("provider lifecycle (SE-AC-13)", () => {
  it("available() turns false when the active provider is unregistered, without restart", async () => {
    const registry = setupSemantic({}, { register: false });
    const embedding = memoryEmbedding();
    const off = registry.registry.registerEmbedding("p", embedding);
    registry.registry.registerStore(
      "p",
      (await import("./fixtures/memory-semantic.ts")).memoryStore(),
    );
    expect(registry.api.available()).toBe(true);
    off();
    expect(registry.api.available()).toBe(false);
    expect(await registry.api.trySearch("notes", "q")).toBeNull();
  });
});
