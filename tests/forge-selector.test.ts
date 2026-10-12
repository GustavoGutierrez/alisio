/**
 * Engine selection as a chain of responsibility (spec §7.2): ordered deterministic rules, each
 * returning a decision with its reason or passing. The JavaScript chain has three rules.
 */
import type { EngineDescriptor } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import type { ForgeError } from "../packages/core/src/forge/errors.ts";
import {
  createJavaScriptSelector,
  EngineSelector,
  reject,
  type SelectionRule,
  select,
} from "../packages/core/src/forge/selector.ts";

function codeAndMessage(action: () => unknown): { code?: string; message?: string } {
  try {
    action();
  } catch (error) {
    return { code: (error as ForgeError).code, message: (error as Error).message };
  }
  return {};
}

describe("generic engine selector", () => {
  const pass: SelectionRule<number, "a" | "b"> = () => null;

  it("uses the first rule that decides and does not evaluate later ones", () => {
    const seen: string[] = [];
    const selector = new EngineSelector<number, "a" | "b">([
      () => {
        seen.push("r1");
        return null;
      },
      (n) => (n > 1 ? select("b", "big") : null),
      () => {
        seen.push("r3");
        return select("a", "fallback");
      },
    ]);
    expect(selector.select(5)).toEqual({ engine: "b", reason: "big" });
    expect(selector.select(0)).toEqual({ engine: "a", reason: "fallback" });
    expect(seen).toEqual(["r1", "r1", "r3"]);
  });

  it("turns a rejecting rule into ENGINE_UNAVAILABLE with its reason, stopping the chain", () => {
    const selector = new EngineSelector<number, "a">([
      () => reject("disabled by config"),
      () => select("a", "never reached"),
    ]);
    expect(codeAndMessage(() => selector.select(1))).toEqual({
      code: "ENGINE_UNAVAILABLE",
      message: "disabled by config",
    });
  });

  it("lets a rule reject with a specific code", () => {
    const selector = new EngineSelector<number, "a">([() => reject("bad", "INVALID_INPUT")]);
    expect(codeAndMessage(() => selector.select(1)).code).toBe("INVALID_INPUT");
  });

  it("fails closed when no rule decides", () => {
    const selector = new EngineSelector<number, "a" | "b">([pass, pass]);
    expect(codeAndMessage(() => selector.select(1)).code).toBe("ENGINE_UNAVAILABLE");
    expect(codeAndMessage(() => new EngineSelector<number, "a">([]).select(1)).code).toBe(
      "ENGINE_UNAVAILABLE",
    );
  });
});

describe("javascript selection rules", () => {
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
  const selector = createJavaScriptSelector();

  it("selects javascript-quickjs with the language reason when enabled and ready", () => {
    expect(
      selector.select({
        language: "javascript",
        javascriptEnabled: true,
        descriptors: { "javascript-quickjs": descriptor() },
      }),
    ).toEqual({ engine: "javascript-quickjs", reason: "language=javascript" });
  });

  it("rejects first when disabled by config, even if the engine is not ready either", () => {
    const result = codeAndMessage(() =>
      selector.select({
        language: "javascript",
        javascriptEnabled: false,
        descriptors: { "javascript-quickjs": descriptor({ ready: false, reason: "wasm hash" }) },
      }),
    );
    expect(result).toEqual({ code: "ENGINE_UNAVAILABLE", message: "disabled by config" });
  });

  it("rejects an engine that is not ready with the descriptor's reason", () => {
    const result = codeAndMessage(() =>
      selector.select({
        language: "javascript",
        javascriptEnabled: true,
        descriptors: {
          "javascript-quickjs": descriptor({ ready: false, reason: "wasm hash mismatch" }),
        },
      }),
    );
    expect(result).toEqual({ code: "ENGINE_UNAVAILABLE", message: "wasm hash mismatch" });
  });

  it("rejects a missing or reasonless not-ready engine with a non-empty message", () => {
    const missing = codeAndMessage(() =>
      selector.select({ language: "javascript", javascriptEnabled: true, descriptors: {} }),
    );
    expect(missing.code).toBe("ENGINE_UNAVAILABLE");
    expect(missing.message).toMatch(/not (ready|available|registered)/i);
    const silent = codeAndMessage(() =>
      selector.select({
        language: "javascript",
        javascriptEnabled: true,
        descriptors: { "javascript-quickjs": descriptor({ ready: false }) },
      }),
    );
    expect(silent.message).toMatch(/not ready/i);
  });

  it("does not decide for another language (the Python chain is separate)", () => {
    const result = codeAndMessage(() =>
      selector.select({
        language: "python",
        javascriptEnabled: true,
        descriptors: { "javascript-quickjs": descriptor() },
      }),
    );
    expect(result.code).toBe("ENGINE_UNAVAILABLE");
    expect(result.message).toMatch(/python/);
  });
});
