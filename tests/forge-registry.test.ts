/**
 * The engine registry (spec §4.2, D17): an engine is registered for execution only when its
 * self-description says it is ready; anything else becomes an UnavailableEngine that explains why
 * and never runs code (fail closed).
 */
import type { EngineDescriptor, EngineId } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import type { ForgeError } from "../packages/core/src/forge/errors.ts";
import { DEFAULT_FORGE_LIMITS } from "../packages/core/src/forge/limits.ts";
import type { ExecutionEngine, PreparedExecution } from "../packages/core/src/forge/ports.ts";
import { EngineRegistry } from "../packages/core/src/forge/registry.ts";

const descriptor = (overrides: Partial<EngineDescriptor> = {}): EngineDescriptor => ({
  id: "javascript-quickjs",
  language: "javascript",
  version: "quickjs-wasi@3.6.2",
  isolation: "wasm-isolate",
  ready: true,
  capabilities: {
    cooperativeInterrupt: true,
    hardTermination: true,
    hardMemoryLimit: true,
    networkDeniedByOS: false,
    toolCalls: true,
  },
  ...overrides,
});

function fakeEngine(
  describe: () => Promise<EngineDescriptor>,
  id: EngineId = "javascript-quickjs",
): ExecutionEngine & { ran: number } {
  const engine = {
    id,
    ran: 0,
    describe,
    async prepare(): Promise<PreparedExecution> {
      return { executionId: "e1", engine: id, limits: DEFAULT_FORGE_LIMITS };
    },
    async run() {
      engine.ran++;
      return { kind: "completed" as const };
    },
    async terminate() {
      return { confirmed: true, method: "terminate" as const, elapsedMs: 1 };
    },
    async dispose() {},
  };
  return engine;
}

const prepared: PreparedExecution = {
  executionId: "e1",
  engine: "javascript-quickjs",
  limits: DEFAULT_FORGE_LIMITS,
};
const channel = {
  receive: async () => undefined,
  bind() {},
  signal: new AbortController().signal,
};

async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return (error as ForgeError).code;
  }
  return undefined;
}

describe("forge engine registry", () => {
  it("keeps a ready engine and exposes its descriptor", async () => {
    const registry = new EngineRegistry();
    const engine = fakeEngine(async () => descriptor());
    expect((await registry.register(engine)).ready).toBe(true);
    expect(registry.get("javascript-quickjs")).toBe(engine);
    expect(registry.descriptors()["javascript-quickjs"]?.version).toBe("quickjs-wasi@3.6.2");
  });

  it("replaces a not-ready engine with one that explains why and never runs", async () => {
    const registry = new EngineRegistry();
    const engine = fakeEngine(async () =>
      descriptor({ ready: false, reason: "wasm hash mismatch" }),
    );
    const returned = await registry.register(engine);
    expect(returned).toMatchObject({ ready: false, reason: "wasm hash mismatch" });

    const slot = registry.get("javascript-quickjs");
    expect(slot).not.toBe(engine);
    expect((await slot.describe()).reason).toBe("wasm hash mismatch");
    expect(
      await codeOf(() => slot.prepare({ language: "javascript", source: "1" }, {} as never)),
    ).toBe("ENGINE_UNAVAILABLE");
    expect(await codeOf(() => slot.run(prepared, channel))).toBe("ENGINE_UNAVAILABLE");
    expect(engine.ran).toBe(0);
    expect(registry.descriptors()["javascript-quickjs"]?.ready).toBe(false);
  });

  it("gives a not-ready engine without a reason a non-empty one", async () => {
    const registry = new EngineRegistry();
    await registry.register(fakeEngine(async () => descriptor({ ready: false })));
    const reason = (await registry.get("javascript-quickjs").describe()).reason;
    expect(reason).toMatch(/not ready/i);
  });

  it("fails closed when the self-check throws", async () => {
    const registry = new EngineRegistry();
    const engine = fakeEngine(async () => {
      throw new Error("wasm failed to compile");
    });
    const returned = await registry.register(engine);
    expect(returned.ready).toBe(false);
    expect(returned.reason).toContain("wasm failed to compile");
    expect(await codeOf(() => registry.get("javascript-quickjs").run(prepared, channel))).toBe(
      "ENGINE_UNAVAILABLE",
    );
    expect(engine.ran).toBe(0);
  });

  it("fails closed when the descriptor describes a different engine", async () => {
    const registry = new EngineRegistry();
    const engine = fakeEngine(async () => descriptor({ id: "python-wasm", language: "python" }));
    expect((await registry.register(engine)).ready).toBe(false);
    expect(registry.get("javascript-quickjs")).not.toBe(engine);
  });

  it("answers for an engine that was never registered with an unavailable one", async () => {
    const registry = new EngineRegistry();
    const slot = registry.get("python-oci");
    const described = await slot.describe();
    expect(described).toMatchObject({ id: "python-oci", language: "python", ready: false });
    expect(described.reason).toMatch(/not registered/i);
    expect(await codeOf(() => slot.run({ ...prepared, engine: "python-oci" }, channel))).toBe(
      "ENGINE_UNAVAILABLE",
    );
    expect(registry.descriptors()).toEqual({});
  });

  it("lets a later registration replace the earlier one", async () => {
    const registry = new EngineRegistry();
    await registry.register(fakeEngine(async () => descriptor({ ready: false, reason: "old" })));
    const fresh = fakeEngine(async () => descriptor());
    await registry.register(fresh);
    expect(registry.get("javascript-quickjs")).toBe(fresh);
  });
});
