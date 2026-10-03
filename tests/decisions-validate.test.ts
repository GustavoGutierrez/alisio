import { DecisionProviderError, type DecisionRequest, DecisionRequestError } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  DECISION_LIMITS,
  splitSupported,
  validateAnswers,
  validateRequest,
} from "../packages/core/src/decisions/index.ts";
import { sampleRequest } from "./fixtures/decision-provider.ts";

const all = { capabilities: { select: true, boolean: true, ordinal: true } };
const rejects = (req: unknown) => {
  try {
    validateRequest(req);
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionRequestError);
    expect(error).toBeInstanceOf(TypeError);
    return (error as Error).message;
  }
  throw new Error("expected validateRequest to throw");
};
const withDecisions = (decisions: Record<string, unknown>) =>
  sampleRequest({ decisions: decisions as DecisionRequest["decisions"] });
const select = (options: Record<string, string>) => ({
  type: "select",
  instruction: "pick",
  options,
});

describe("validateRequest", () => {
  it("accepts a well-formed request", () => {
    expect(() => validateRequest(sampleRequest())).not.toThrow();
    expect(() => validateRequest(sampleRequest({ language: "es-CO" }))).not.toThrow();
    expect(() =>
      validateRequest(sampleRequest({ pack: { id: "smart-dashboard-v1", version: 1 } })),
    ).not.toThrow();
  });

  it("rejects non-objects, unknown versions and unsafe ids", () => {
    rejects(null);
    rejects("x");
    rejects({ ...sampleRequest(), version: 2 });
    rejects({ ...sampleRequest(), id: "Has Spaces" });
    rejects({ ...sampleRequest(), id: "" });
    rejects({ ...sampleRequest(), pack: { id: "ok", version: 1.5 } });
  });

  it("rejects a language that is not a BCP 47 tag", () => {
    rejects(sampleRequest({ language: "not a tag" }));
    rejects(sampleRequest({ language: "e" }));
  });

  it("requires a decisions record of 1..16 keys with safe names", () => {
    rejects({ ...sampleRequest(), decisions: {} });
    rejects({ ...sampleRequest(), decisions: undefined });
    rejects({ ...sampleRequest(), decisions: [] });
    const many = Object.fromEntries(
      Array.from({ length: DECISION_LIMITS.maxDecisions + 1 }, (_, i) => [
        `d${i}`,
        { type: "boolean", instruction: "q" },
      ]),
    );
    rejects(withDecisions(many));
    const exact = Object.fromEntries(
      Array.from({ length: DECISION_LIMITS.maxDecisions }, (_, i) => [
        `d${i}`,
        { type: "boolean", instruction: "q" },
      ]),
    );
    expect(() => validateRequest(withDecisions(exact))).not.toThrow();
    rejects(withDecisions({ "1bad": { type: "boolean", instruction: "q" } }));
    rejects(withDecisions({ "bad-key": { type: "boolean", instruction: "q" } }));
    rejects(withDecisions({ [`a${"x".repeat(64)}`]: { type: "boolean", instruction: "q" } }));
  });

  it("limits select options to 2..20 non-empty keys with non-empty descriptions", () => {
    rejects(withDecisions({ d: select({ only: "one" }) }));
    const twentyOne = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`o${i}`, "x"]));
    rejects(withDecisions({ d: select(twentyOne) }));
    const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`o${i}`, "x"]));
    expect(() => validateRequest(withDecisions({ d: select(twenty) }))).not.toThrow();
    rejects(withDecisions({ d: select({ "": "empty key", b: "b" }) }));
    rejects(withDecisions({ d: select({ a: "  ", b: "b" }) }));
    rejects(withDecisions({ d: select(JSON.parse('{"__proto__":"x","b":"b"}')) }));
  });

  it("limits ordinal levels to 2..12 non-empty unique values", () => {
    const ordinal = (levels: unknown) => ({ type: "ordinal", instruction: "q", levels });
    rejects(withDecisions({ d: ordinal(["one"]) }));
    rejects(withDecisions({ d: ordinal(Array.from({ length: 13 }, (_, i) => `l${i}`)) }));
    rejects(withDecisions({ d: ordinal(["a", ""]) }));
    rejects(withDecisions({ d: ordinal(["a", "a"]) }));
    expect(() =>
      validateRequest(withDecisions({ d: ordinal(Array.from({ length: 12 }, (_, i) => `l${i}`)) })),
    ).not.toThrow();
  });

  it("requires an instruction and a known type on every decision", () => {
    rejects(withDecisions({ d: { type: "boolean", instruction: "" } }));
    rejects(withDecisions({ d: { type: "boolean" } }));
    rejects(withDecisions({ d: { type: "free-text", instruction: "q" } }));
    rejects(withDecisions({ d: { type: "boolean", instruction: "q", trueMeaning: "" } }));
  });

  it("limits the state to 16 KB of UTF-8 and the whole request to 32 KB", () => {
    expect(() =>
      validateRequest(sampleRequest({ state: { text: "x".repeat(16 * 1024 - 20) } })),
    ).not.toThrow();
    rejects(sampleRequest({ state: { text: "x".repeat(16 * 1024) } }));
    // Multi-byte characters count as bytes, not as characters.
    rejects(sampleRequest({ state: { text: "ñ".repeat(9000) } }));
    // Small state, but instructions push the whole request over 32 KB.
    const instructions = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        `d${i}`,
        { type: "boolean", instruction: "i".repeat(2100) },
      ]),
    );
    rejects(withDecisions(instructions));
  });

  it("rejects a state that cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    rejects(sampleRequest({ state: cyclic as never }));
    rejects({ ...sampleRequest(), state: undefined });
  });
});

describe("splitSupported", () => {
  it("separates decisions the provider cannot take", () => {
    const split = splitSupported(sampleRequest(), {
      capabilities: { select: true, boolean: false, ordinal: true },
    });
    expect(split).toEqual({ supported: ["kind", "density"], unsupported: ["stacked"] });
  });
});

describe("validateAnswers", () => {
  const req = sampleRequest();
  const good = {
    kind: { type: "select", value: "bar", confidence: 0.9 },
    stacked: { type: "boolean", value: false, confidence: 0.8, probability: 0.2 },
    density: { type: "ordinal", level: "medium", index: 1, confidence: 0.7 },
  };
  const run = (decisions: Record<string, unknown>, min = 0.6, caps = all) =>
    validateAnswers(req, caps, { decisions }, min);

  it("accepts valid answers of each type", () => {
    const { accepted, rejected } = run(good);
    expect(Object.keys(accepted)).toEqual(["kind", "stacked", "density"]);
    expect(rejected).toEqual({});
  });

  it("marks requested keys without an answer as missing and ignores unrequested ones", () => {
    const { accepted, rejected } = run({
      kind: good.kind,
      extra: { type: "boolean", value: true, confidence: 1, probability: 1 },
    });
    expect(Object.keys(accepted)).toEqual(["kind"]);
    expect(rejected).toEqual({ stacked: "missing", density: "missing" });
  });

  it.each([
    ["type differs from the definition", { ...good.kind, type: "boolean" }],
    ["value outside the options", { ...good.kind, value: "donut" }],
    ["value is inherited, not an option", { ...good.kind, value: "toString" }],
    ["confidence is NaN", { ...good.kind, confidence: Number.NaN }],
    ["confidence above 1", { ...good.kind, confidence: 1.2 }],
    ["confidence is a string", { ...good.kind, confidence: "0.9" }],
    ["answer is not an object", "bar"],
    ["answer is null", null],
  ])("rejects a select answer as invalid when %s", (_name, answer) => {
    expect(run({ kind: answer }).rejected.kind).toBe("invalid");
  });

  it("rejects invalid boolean and ordinal answers", () => {
    expect(run({ stacked: { ...good.stacked, probability: 1.5 } }).rejected.stacked).toBe(
      "invalid",
    );
    expect(run({ stacked: { ...good.stacked, value: "yes" } }).rejected.stacked).toBe("invalid");
    expect(run({ density: { ...good.density, level: "extreme" } }).rejected.density).toBe(
      "invalid",
    );
    expect(run({ density: { ...good.density, index: 2 } }).rejected.density).toBe("invalid");
  });

  it("rejects answers below minConfidence as low_confidence, after checking validity", () => {
    const { accepted, rejected } = run(
      { kind: { ...good.kind, confidence: 0.3 }, density: { ...good.density, level: "x" } },
      0.6,
    );
    expect(accepted).toEqual({});
    expect(rejected.kind).toBe("low_confidence");
    expect(rejected.density).toBe("invalid");
    expect(run({ kind: { ...good.kind, confidence: 0.6 } }).accepted.kind).toBeDefined();
  });

  it("drops malformed informative fields but keeps the answer", () => {
    const { accepted } = run({
      kind: { ...good.kind, probabilities: { bar: 0.9, donut: 0.1 } },
      density: { ...good.density, distribution: [0.5, 0.5] },
    });
    expect(accepted.kind).toEqual({ type: "select", value: "bar", confidence: 0.9 });
    expect(accepted.density).toEqual({
      type: "ordinal",
      level: "medium",
      index: 1,
      confidence: 0.7,
    });
  });

  it("keeps well-formed probabilities and distributions", () => {
    const { accepted } = run({
      kind: { ...good.kind, probabilities: { bar: 0.7, line: 0.3 } },
      density: { ...good.density, distribution: [0.1, 0.7, 0.2] },
    });
    expect(accepted.kind).toMatchObject({ probabilities: { bar: 0.7, line: 0.3 } });
    expect(accepted.density).toMatchObject({ distribution: [0.1, 0.7, 0.2] });
  });

  it("rebuilds answers so nothing foreign to the contract survives", () => {
    const { accepted } = run({
      kind: { ...good.kind, secret: "sentinel", note: { deep: 1 } },
    });
    expect(JSON.stringify(accepted)).not.toContain("sentinel");
    expect(Object.keys(accepted.kind as object).sort()).toEqual(["confidence", "type", "value"]);
  });

  it("marks decisions the provider cannot take as unsupported even when answered", () => {
    const { accepted, rejected } = run(good, 0.6, {
      capabilities: { select: true, boolean: false, ordinal: true },
    });
    expect(rejected).toEqual({ stacked: "unsupported" });
    expect(Object.keys(accepted)).toEqual(["kind", "density"]);
  });

  it.each([null, "x", 3, [], {}, { decisions: null }, { decisions: [] }])(
    "throws invalid_response for a result that is not { decisions } (%j)",
    (raw) => {
      try {
        validateAnswers(req, all, raw, 0.6);
      } catch (error) {
        expect(error).toBeInstanceOf(DecisionProviderError);
        expect((error as DecisionProviderError).code).toBe("invalid_response");
        return;
      }
      throw new Error("expected validateAnswers to throw");
    },
  );
});
