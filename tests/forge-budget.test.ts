/**
 * The per-execution budget ledger (spec §5.4, §6.5): total and concurrent nested calls, the
 * credits the host grants the guest, and the retained output bytes. The host is the authority
 * even when the guest prelude checks the same numbers.
 */
import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../packages/core/src/forge/budget.ts";
import type { ForgeError } from "../packages/core/src/forge/errors.ts";

const limits = { maxToolCalls: 5, maxConcurrency: 2, maxRetainedOutputBytes: 100 };

function codeOf(action: () => void): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as ForgeError).code;
  }
  return undefined;
}

describe("forge budget ledger", () => {
  it("grants concurrency-sized call credits and the output allowance up front", () => {
    expect(new BudgetLedger(limits).grant()).toEqual({ calls: 2, bytes: 100 });
    expect(new BudgetLedger({ ...limits, maxToolCalls: 1 }).grant().calls).toBe(1);
  });

  it("refuses a call without a credit", () => {
    const ledger = new BudgetLedger(limits);
    expect(codeOf(() => ledger.startCall())).toBe("BUDGET_EXCEEDED");
    ledger.grant();
    expect(codeOf(() => ledger.startCall())).toBeUndefined();
  });

  it("refuses a call past the concurrency limit and frees the slot when one finishes", () => {
    const ledger = new BudgetLedger(limits);
    ledger.grant();
    ledger.startCall();
    ledger.startCall();
    expect(ledger.grant().calls).toBe(0);
    expect(codeOf(() => ledger.startCall())).toBe("BUDGET_EXCEEDED");
    ledger.finishCall();
    expect(ledger.grant().calls).toBe(1);
    expect(codeOf(() => ledger.startCall())).toBeUndefined();
    expect(ledger.stats.active).toBe(2);
  });

  it("stops granting and starting calls once the total is spent", () => {
    const ledger = new BudgetLedger(limits);
    for (let i = 0; i < 5; i++) {
      ledger.grant();
      ledger.startCall();
      ledger.finishCall();
    }
    expect(ledger.stats.started).toBe(5);
    expect(ledger.grant().calls).toBe(0);
    expect(codeOf(() => ledger.startCall())).toBe("BUDGET_EXCEEDED");
  });

  it("does not change state when a call is refused", () => {
    const ledger = new BudgetLedger(limits);
    expect(codeOf(() => ledger.startCall())).toBe("BUDGET_EXCEEDED");
    expect(ledger.stats).toEqual({ started: 0, active: 0, outputBytes: 0 });
  });

  it("rejects finishing a call that never started", () => {
    expect(() => new BudgetLedger(limits).finishCall()).toThrow();
  });

  it("accepts output up to the retained limit and fails past it with OUTPUT_LIMIT", () => {
    const ledger = new BudgetLedger(limits);
    ledger.recordOutput(60);
    ledger.recordOutput(40);
    expect(ledger.stats.outputBytes).toBe(100);
    expect(codeOf(() => ledger.recordOutput(1))).toBe("OUTPUT_LIMIT");
    expect(ledger.stats.outputBytes).toBe(100);
  });

  it("rejects a single output larger than what is left, without partial accounting", () => {
    const ledger = new BudgetLedger(limits);
    ledger.recordOutput(30);
    expect(codeOf(() => ledger.recordOutput(71))).toBe("OUTPUT_LIMIT");
    expect(ledger.stats.outputBytes).toBe(30);
    expect(ledger.grant().bytes).toBe(70);
  });
});
