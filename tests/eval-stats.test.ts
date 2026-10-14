/** Pure statistics of the reliability lab (specs/010 D6, D17). No I/O. */
import { describe, expect, it } from "vitest";
import {
  median,
  passAtK,
  passPowK,
  sampleVariance,
  wilsonInterval,
} from "../packages/core/src/eval/stats.ts";

describe("wilsonInterval (z = 1.96)", () => {
  // Reference values by hand. z^2 = 3.8416, n = 5, denom = 1 + z^2/n = 1.76832,
  // centre = (p + z^2/2n) / denom, half = z * sqrt(p(1-p)/n + z^2/4n^2) / denom.
  it("0/5: lower bound is exactly 0, upper is 0.4345", () => {
    // p = 0: centre = 0.38416 / 1.76832 = 0.217247; half = 1.96 * sqrt(0.038416) / 1.76832
    //   = 1.96 * 0.196 / 1.76832 = 0.217247 -> [0, 0.434494]
    const ci = wilsonInterval(0, 5);
    expect(ci.low).toBe(0);
    expect(ci.high).toBeCloseTo(0.4345, 4);
  });

  it("5/5: upper bound is exactly 1, lower is 0.5655", () => {
    // p = 1: centre = (1 + 0.38416) / 1.76832 = 0.782753; half = 0.217247 -> [0.565506, 1]
    const ci = wilsonInterval(5, 5);
    expect(ci.high).toBe(1);
    expect(ci.low).toBeCloseTo(0.5655, 4);
  });

  it("3/5: [0.2307, 0.8824]", () => {
    // p = 0.6: centre = (0.6 + 0.38416) / 1.76832 = 0.556569
    // half = 1.96 * sqrt(0.6*0.4/5 + 3.8416/100) / 1.76832 = 1.96 * sqrt(0.086416) / 1.76832
    //   = 1.96 * 0.293966 / 1.76832 = 0.325827 -> [0.230742, 0.882396]
    const ci = wilsonInterval(3, 5);
    expect(ci.low).toBeCloseTo(0.2307, 4);
    expect(ci.high).toBeCloseTo(0.8824, 4);
  });

  it("n = 0 carries no information: [0, 1]", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("rejects impossible counts", () => {
    expect(() => wilsonInterval(6, 5)).toThrow(/successes/);
    expect(() => wilsonInterval(-1, 5)).toThrow(/successes/);
    expect(() => wilsonInterval(1.5, 5)).toThrow(/successes/);
  });
});

describe("sampleVariance and median", () => {
  it("uses the n - 1 convention and is null below two samples", () => {
    // mean 5; squared deviations 9+1+1+1+0+0+4+16 = 32; 32 / 7
    expect(sampleVariance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7, 10);
    expect(sampleVariance([3])).toBeNull();
    expect(sampleVariance([])).toBeNull();
  });

  it("median of odd, even and empty sets", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("does not mutate its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("passAtK and passPowK", () => {
  it("pass@k: at least one success; pass^k: every repetition succeeds", () => {
    expect(passAtK([false, true, false])).toBe(true);
    expect(passPowK([false, true, false])).toBe(false);
    expect(passAtK([true, true])).toBe(true);
    expect(passPowK([true, true])).toBe(true);
    expect(passAtK([false, false])).toBe(false);
    expect(passPowK([false, false])).toBe(false);
  });

  it("no repetitions is never a pass", () => {
    expect(passAtK([])).toBe(false);
    expect(passPowK([])).toBe(false);
  });
});
