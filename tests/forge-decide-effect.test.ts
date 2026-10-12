/**
 * `decideEffect` (spec D-25): the single effect gate shared by the runner, `availableTools`,
 * `execute` and the Forja nested-call dispatcher.
 */
import { describe, expect, it } from "vitest";
import type { Policy } from "../packages/core/src/core/contracts.ts";
import {
  capabilityFlagAllowed,
  decideEffect,
  effectAllowed,
  effectAskable,
} from "../packages/core/src/permissions/decide.ts";

const off: Policy = { write: false, process: false, external: false };
const on: Policy = { write: true, process: true, external: true };
const ask = { approvals: true, capabilityGranted: false };
const noAsk = { approvals: false, capabilityGranted: false };

describe("decideEffect without a capability", () => {
  it("always allows read and internal, whatever the policy and approvals", () => {
    for (const effect of ["read", "internal"] as const)
      for (const approvals of [true, false])
        expect(decideEffect(off, { effect }, { approvals, capabilityGranted: false })).toEqual({
          kind: "allow",
          via: "effect",
        });
  });

  it("allows write, process and external exactly when the policy has them on", () => {
    for (const effect of ["write", "process", "external"] as const) {
      expect(decideEffect(on, { effect }, noAsk)).toEqual({ kind: "allow", via: "effect" });
      expect(decideEffect({ ...off, [effect]: true }, { effect }, noAsk).kind).toBe("allow");
      // Another effect being on does not open this one.
      const others = { ...on, [effect]: false };
      expect(decideEffect(others, { effect }, noAsk).kind).toBe("deny");
    }
  });

  it("asks for a denied write, process or external only when approvals are possible", () => {
    for (const effect of ["write", "process", "external"] as const) {
      expect(decideEffect(off, { effect }, ask)).toEqual({ kind: "ask" });
      expect(decideEffect(off, { effect }, noAsk)).toEqual({ kind: "deny" });
    }
  });

  it("treats a tool with no declared effect as external", () => {
    expect(decideEffect(off, {}, ask)).toEqual({ kind: "ask" });
    expect(decideEffect(off, {}, noAsk)).toEqual({ kind: "deny" });
    expect(decideEffect({ ...off, external: true }, {}, noAsk).kind).toBe("allow");
    expect(decideEffect({ ...off, write: true, process: true }, {}, noAsk).kind).toBe("deny");
  });

  it("never asks for an effect the gate does not know", () => {
    expect(decideEffect(on, { effect: "mystery" as never }, ask)).toEqual({ kind: "deny" });
  });

  it("does not read a policy flag that is not an effect as if it were one", () => {
    // `analysis` is a key of the policy, but it is not an effect: it must never open a tool.
    const policy = { ...off, analysis: true };
    expect(effectAllowed(policy, "analysis")).toBe(false);
    expect(decideEffect(policy, { effect: "analysis" as never }, noAsk)).toEqual({ kind: "deny" });
  });

  it("ignores a stored grant when the tool has no capability", () => {
    expect(
      decideEffect(off, { effect: "process" }, { approvals: false, capabilityGranted: true }),
    ).toEqual({ kind: "deny" });
  });

  it("reads the policy by reference, so a session widening applies to the next decision", () => {
    const policy: Policy = { ...off };
    const tool = { effect: "write" } as const;
    expect(decideEffect(policy, tool, ask).kind).toBe("ask");
    policy.write = true; // what an "allow for the session" answer does
    expect(decideEffect(policy, tool, ask)).toEqual({ kind: "allow", via: "effect" });
  });
});

describe("decideEffect with the analysis.run capability", () => {
  const tool = { effect: "process", capability: "analysis.run" } as const;

  it("allows on --allow-analysis alone, as a flag decision", () => {
    expect(decideEffect({ ...off, analysis: true }, tool, noAsk)).toEqual({
      kind: "allow",
      via: "flag",
    });
  });

  it("allows on a process policy, as a flag decision too", () => {
    expect(decideEffect({ ...off, process: true }, tool, noAsk)).toEqual({
      kind: "allow",
      via: "flag",
    });
  });

  it("allows on a stored grant when no flag does, as a grant decision", () => {
    expect(decideEffect(off, tool, { approvals: false, capabilityGranted: true })).toEqual({
      kind: "allow",
      via: "grant",
    });
  });

  it("prefers the flag over a grant, so the audit says flag", () => {
    expect(
      decideEffect({ ...off, analysis: true }, tool, { approvals: true, capabilityGranted: true }),
    ).toEqual({ kind: "allow", via: "flag" });
  });

  it("asks without a flag or grant when a person can be asked, otherwise denies", () => {
    expect(decideEffect(off, tool, ask)).toEqual({ kind: "ask" });
    expect(decideEffect(off, tool, noAsk)).toEqual({ kind: "deny" });
  });

  it("--allow-analysis opens no other capability and no ordinary process tool", () => {
    const policy = { ...off, analysis: true };
    expect(decideEffect(policy, { effect: "process" }, noAsk).kind).toBe("deny");
    expect(
      decideEffect(policy, { effect: "process", capability: "analysis.install" }, noAsk).kind,
    ).toBe("deny");
  });
});

describe("gate helpers", () => {
  it("know which effects exist, can run and can be asked", () => {
    expect(effectAllowed(off, "read")).toBe(true);
    expect(effectAllowed(off, "internal")).toBe(true);
    expect(effectAllowed(off, "write")).toBe(false);
    expect(effectAllowed(on, "process")).toBe(true);
    expect(effectAskable("read")).toBe(false);
    expect(effectAskable("internal")).toBe(false);
    expect(effectAskable("external")).toBe(true);
    expect(capabilityFlagAllowed({ ...off, analysis: true }, { capability: "analysis.run" })).toBe(
      true,
    );
    expect(capabilityFlagAllowed({ ...off, analysis: true }, {})).toBe(false);
    expect(capabilityFlagAllowed(off, { capability: "analysis.run" })).toBe(false);
  });
});
