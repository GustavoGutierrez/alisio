/**
 * Forja limit merging (global ∩ project ∩ request): the global layer sets values up to the hard
 * maxima, while project and request layers can only lower them (spec D16, §6.5, §10).
 */
import { describe, expect, it } from "vitest";
import { ForgeError } from "../packages/core/src/forge/errors.ts";
import {
  DEFAULT_FORGE_LIMITS,
  MAX_CALL_INPUT_BYTES,
  MAX_FORGE_LIMITS,
  mergeLimits,
} from "../packages/core/src/forge/limits.ts";
import { MAX_MESSAGE_BYTES } from "../packages/core/src/forge/protocol.ts";

describe("forge limits", () => {
  it("falls back to the documented defaults and keeps them under the global maxima", () => {
    const limits = mergeLimits({});
    expect(limits).toEqual({
      ...DEFAULT_FORGE_LIMITS,
      maxCallInputBytes: MAX_CALL_INPUT_BYTES,
    });
    expect(limits.timeoutMs).toBe(30_000);
    expect(limits.maxToolCalls).toBe(50);
    expect(limits.maxOutputChars).toBe(16_000);
    for (const key of Object.keys(MAX_FORGE_LIMITS) as (keyof typeof limits)[]) {
      expect(DEFAULT_FORGE_LIMITS[key]).toBeLessThanOrEqual(MAX_FORGE_LIMITS[key]);
    }
  });

  it("lets the global layer raise a default but never past the hard maximum", () => {
    expect(mergeLimits({ global: { timeoutMs: 120_000 } }).timeoutMs).toBe(120_000);
    expect(mergeLimits({ global: { timeoutMs: 9_999_999 } }).timeoutMs).toBe(300_000);
    expect(mergeLimits({ global: { memoryBytes: 10 * 1024 ** 3 } }).memoryBytes).toBe(
      128 * 1024 * 1024,
    );
  });

  it("lets the request and the project only lower what the global layer allows", () => {
    const global = { timeoutMs: 60_000, maxToolCalls: 100 };
    expect(mergeLimits({ global, request: { timeoutMs: 5_000 } }).timeoutMs).toBe(5_000);
    expect(mergeLimits({ global, request: { timeoutMs: 200_000 } }).timeoutMs).toBe(60_000);
    expect(mergeLimits({ global, project: { maxToolCalls: 10 } }).maxToolCalls).toBe(10);
    expect(mergeLimits({ global, project: { maxToolCalls: 400 } }).maxToolCalls).toBe(100);
  });

  it("applies the lowest value when project and request both lower the same limit", () => {
    const limits = mergeLimits({
      project: { maxConcurrency: 3 },
      request: { maxConcurrency: 2 },
    });
    expect(limits.maxConcurrency).toBe(2);
    expect(
      mergeLimits({ project: { maxConcurrency: 1 }, request: { maxConcurrency: 2 } })
        .maxConcurrency,
    ).toBe(1);
  });

  it("ignores project overrides of limits only the global config may change", () => {
    const limits = mergeLimits({
      project: { memoryBytes: 1024, stackBytes: 1024, maxSourceBytes: 1 },
    });
    expect(limits.memoryBytes).toBe(DEFAULT_FORGE_LIMITS.memoryBytes);
    expect(limits.stackBytes).toBe(DEFAULT_FORGE_LIMITS.stackBytes);
    expect(limits.maxSourceBytes).toBe(DEFAULT_FORGE_LIMITS.maxSourceBytes);
  });

  it("lets a request lower any limit, including the memory heap", () => {
    expect(mergeLimits({ request: { memoryBytes: 8 * 1024 * 1024 } }).memoryBytes).toBe(
      8 * 1024 * 1024,
    );
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the non-positive-integer limit %s with INVALID_INPUT",
    (bad) => {
      for (const layer of ["global", "project", "request"] as const) {
        const attempt = () => mergeLimits({ [layer]: { timeoutMs: bad } });
        expect(attempt).toThrow(ForgeError);
        try {
          attempt();
        } catch (error) {
          expect((error as ForgeError).code).toBe("INVALID_INPUT");
        }
      }
    },
  );

  it("L3: a call's input can never be larger than what fits in one protocol message", () => {
    expect(MAX_CALL_INPUT_BYTES).toBe(MAX_MESSAGE_BYTES - 4096);
    expect(DEFAULT_FORGE_LIMITS.maxCallInputBytes).toBe(256 * 1024);
    expect(mergeLimits({ global: { maxCallInputBytes: 1024 * 1024 } }).maxCallInputBytes).toBe(
      MAX_CALL_INPUT_BYTES,
    );
    expect(mergeLimits({ request: { maxCallInputBytes: 1000 } }).maxCallInputBytes).toBe(1000);
  });
});
