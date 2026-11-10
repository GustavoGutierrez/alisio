import { describe, expect, it } from "vitest";
import { SemanticRegistry } from "../packages/core/src/semantic/index.ts";
import { memoryEmbedding, memoryStore } from "./fixtures/memory-semantic.ts";

describe("SemanticRegistry", () => {
  it("rejects a duplicate id with TypeError and keeps the previous registration (SE-AC-03)", () => {
    const registry = new SemanticRegistry();
    const first = memoryEmbedding();
    registry.registerEmbedding("a", first);
    expect(() => registry.registerEmbedding("b", memoryEmbedding())).toThrow(TypeError);
    expect(registry.getEmbedding("mem-embed")?.provider).toBe(first);
    expect(registry.getEmbedding("mem-embed")?.owner).toBe("a");
    registry.registerStore("a", memoryStore());
    expect(() => registry.registerStore("b", memoryStore())).toThrow(TypeError);
  });

  it("rejects invalid ids and malformed providers with TypeError (SE-AC-03)", () => {
    const registry = new SemanticRegistry();
    for (const id of ["", "Upper", "-x", "a/b", "x".repeat(65)])
      expect(() => registry.registerEmbedding("a", { ...memoryEmbedding(), id })).toThrow(
        TypeError,
      );
    expect(() =>
      registry.registerStore("a", { ...memoryStore(), query: undefined } as never),
    ).toThrow(TypeError);
    expect(registry.listEmbeddings()).toEqual([]);
  });

  it("the unregister function removes only its own registration and notifies", () => {
    const registry = new SemanticRegistry();
    let changes = 0;
    registry.onChange(() => changes++);
    const off = registry.registerStore("a", memoryStore());
    off();
    off();
    expect(registry.getStore("mem-store")).toBeUndefined();
    expect(changes).toBe(2);
  });
});
