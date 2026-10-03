import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../packages/core/src/decisions/index.ts";

describe("CircuitBreaker", () => {
  let clock = 0;
  const make = () => new CircuitBreaker({ now: () => clock });
  beforeEach(() => {
    clock = 1_000;
  });

  it("stays closed below the threshold and opens at the third consecutive failure", () => {
    const breaker = make();
    breaker.failure();
    breaker.failure();
    expect(breaker.allow()).toBe("closed");
    breaker.failure();
    expect(breaker.allow()).toBe("open");
    expect(breaker.state()).toBe("open");
  });

  it("a success resets the consecutive count", () => {
    const breaker = make();
    breaker.failure();
    breaker.failure();
    breaker.success();
    breaker.failure();
    breaker.failure();
    expect(breaker.allow()).toBe("closed");
  });

  it("neutral outcomes neither count nor reset", () => {
    const breaker = make();
    breaker.failure();
    breaker.failure();
    for (let i = 0; i < 10; i++) breaker.neutral();
    expect(breaker.allow()).toBe("closed");
    breaker.failure();
    expect(breaker.allow()).toBe("open");
  });

  it("stays open for 30 s, then lets exactly one probe through", () => {
    const breaker = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    clock += 29_999;
    expect(breaker.allow()).toBe("open");
    clock += 1;
    expect(breaker.state()).toBe("half-open");
    expect(breaker.allow()).toBe("half-open");
    // The probe is in flight: concurrent callers are still refused.
    expect(breaker.allow()).toBe("open");
    expect(breaker.allow()).toBe("open");
  });

  it("a successful probe closes the circuit", () => {
    const breaker = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    clock += 30_000;
    expect(breaker.allow()).toBe("half-open");
    breaker.success();
    expect(breaker.allow()).toBe("closed");
    expect(breaker.state()).toBe("closed");
    // A fresh count is needed to open it again.
    breaker.failure();
    breaker.failure();
    expect(breaker.allow()).toBe("closed");
  });

  it("a failed probe re-opens it for another full 30 s", () => {
    const breaker = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    clock += 30_000;
    expect(breaker.allow()).toBe("half-open");
    breaker.failure();
    expect(breaker.allow()).toBe("open");
    clock += 29_999;
    expect(breaker.allow()).toBe("open");
    clock += 1;
    expect(breaker.allow()).toBe("half-open");
  });

  it("a neutral probe releases the slot for the next caller", () => {
    const breaker = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    clock += 30_000;
    expect(breaker.allow()).toBe("half-open");
    breaker.neutral();
    expect(breaker.allow()).toBe("half-open");
  });

  it("reset closes it immediately", () => {
    const breaker = make();
    for (let i = 0; i < 3; i++) breaker.failure();
    breaker.reset();
    expect(breaker.allow()).toBe("closed");
  });
});

describe("CircuitBreaker with the real clock under fake timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses Date.now by default", () => {
    const breaker = new CircuitBreaker();
    for (let i = 0; i < 3; i++) breaker.failure();
    expect(breaker.allow()).toBe("open");
    vi.advanceTimersByTime(30_000);
    expect(breaker.allow()).toBe("half-open");
  });
});
