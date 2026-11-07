import { describe, expect, it } from "vitest";
import { engineChildEnv } from "../packages/core/src/analysis/data/engine-client.ts";
import { isolateEnv } from "../packages/core/src/forge/javascript/hosts/process-host.ts";
import { childEnv } from "../packages/core/src/forge/python/wasm-node.ts";

describe("worker environments under an Electron host", () => {
  it("forwards ELECTRON_RUN_AS_NODE to the data engine child only when the parent has it", () => {
    expect(engineChildEnv({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", SECRET: "x" })).toEqual({
      PATH: "/bin",
      ELECTRON_RUN_AS_NODE: "1",
      BUN_BE_BUN: "1",
    });
    expect(engineChildEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin", BUN_BE_BUN: "1" });
  });

  it("makes the Forja isolate start as plain Node when hosted by Electron", () => {
    expect(isolateEnv("linux", { SECRET: "x" }, true)).toEqual({
      ALISIO_FORGE_ISOLATE: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(isolateEnv("linux", { SECRET: "x" }, false)).toEqual({ ALISIO_FORGE_ISOLATE: "1" });
  });

  it("makes the Pyodide child start as plain Node when hosted by Electron", () => {
    expect(childEnv({ ALISIO_X: "1", OTHER: "no" }, "linux", true)).toEqual({
      ALISIO_X: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(childEnv({ ALISIO_X: "1" }, "linux", false)).toEqual({ ALISIO_X: "1" });
  });
});
