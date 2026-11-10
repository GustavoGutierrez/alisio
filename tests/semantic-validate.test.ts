import { describe, expect, it } from "vitest";
import { setupSemantic } from "./semantic-helpers.ts";

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code,
  );

describe("semantic limits are enforced before any provider call (SE-AC-07)", () => {
  const doc = (over: Record<string, unknown> = {}) => ({ id: "d1", text: "hello", ...over });

  it("rejects out-of-limit input with invalid_request and calls no provider", async () => {
    const { api, embedding, store } = setupSemantic();
    const many = Array.from({ length: 257 }, () => "x");
    const cases: Array<Promise<unknown>> = [
      api.embed(many, { kind: "document" }),
      api.embed([], { kind: "document" }),
      api.embed(["x".repeat(32_769)], { kind: "query" }),
      api.index("notes", [doc({ text: "x".repeat(32_769) })]),
      api.index("notes", [doc({ id: "has space" })]),
      api.index("notes", [doc({ metadata: { blob: "x".repeat(9 * 1024) } })]),
      api.index("notes", [doc({ metadata: { nested: { a: 1 } } as never })]),
      api.index(
        "notes",
        Array.from({ length: 1001 }, (_, i) => doc({ id: `d${i}` })),
      ),
      api.index("Bad Name", [doc()]),
      api.index("notes", []),
      api.search("notes", "q", { topK: 0 }),
      api.search("notes", "q", { topK: 101 }),
      api.search("notes", "q", { topK: 1.5 }),
      api.search("notes", "q", { filter: { a: { b: 1 } } as never }),
      api.search("notes", "q", {
        filter: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 1])),
      }),
      api.search("notes", "", {}),
      api.search("notes", "q", { minScore: Number.NaN }),
      api.remove("notes", ["bad id"]),
      api.drop("UPPER"),
    ];
    for (const result of await Promise.all(cases.map(code))) expect(result).toBe("invalid_request");
    expect(embedding.calls).toHaveLength(0);
    expect(store.calls).toHaveLength(0);
  });

  it("accepts values at the limits", async () => {
    const { api } = setupSemantic();
    await api.embed(
      Array.from({ length: 256 }, () => "x"),
      { kind: "document" },
    );
    await api.index("a".repeat(64), [doc({ id: "A.b_c:d-1" })]);
    await expect(api.search("notes", "q", { topK: 100 })).resolves.toEqual([]);
  });

  it("trySearch still throws invalid_request", async () => {
    const { api } = setupSemantic({ enabled: false });
    expect(await code(api.trySearch("notes", "q", { topK: 0 }))).toBe("invalid_request");
  });
});
