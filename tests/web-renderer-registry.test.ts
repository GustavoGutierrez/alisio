import { UI_BLOCK_KINDS } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  LAZY_KINDS,
  RENDERER_KINDS,
  rendererFor,
  SYNC_KINDS,
} from "../packages/web/src/renderers/kinds.ts";
import { createResolver } from "../packages/web/src/renderers/resolve.ts";

// T-17: the renderer registry.
describe("renderer registry", () => {
  it("covers every SDK UiBlock kind with exactly one eager or lazy view", () => {
    expect([...RENDERER_KINDS].sort()).toEqual([...UI_BLOCK_KINDS].sort());
    const covered = [...SYNC_KINDS.filter((k) => k !== "fallback"), ...LAZY_KINDS];
    expect(covered.sort()).toEqual([...UI_BLOCK_KINDS].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("routes unknown kinds (and prototype keys) to the fallback", () => {
    expect(rendererFor("hologram")).toBe("fallback");
    expect(rendererFor("constructor")).toBe("fallback");
    expect(rendererFor("diff")).toBe("diff");
  });

  const fallback = "FALLBACK";
  it("returns eager views synchronously and loads lazy ones once", async () => {
    let loads = 0;
    const resolve = createResolver<string>({
      sync: { code: "CODE" },
      loaders: {
        diff: async () => {
          loads++;
          return "DIFF";
        },
      },
      fallback,
    });
    expect(resolve("code")).toBe("CODE");
    expect(resolve("mystery")).toBe(fallback);
    const first = resolve("diff");
    expect(first).toBeInstanceOf(Promise);
    expect(await first).toBe("DIFF");
    expect(await resolve("diff")).toBe("DIFF");
    expect(loads).toBe(1);
  });

  it("falls back when a lazy view fails to load or has no loader", async () => {
    const resolve = createResolver<string>({
      sync: {},
      loaders: { json: () => Promise.reject(new Error("chunk failed")) },
      fallback,
    });
    expect(await resolve("json")).toBe(fallback);
    expect(resolve("terminal")).toBe(fallback);
  });
});
