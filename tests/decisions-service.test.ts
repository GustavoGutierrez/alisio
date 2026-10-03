import { type DecisionProviderErrorCode, DecisionRequestError } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DecisionError,
  DecisionMetrics,
  DecisionRegistry,
  DecisionService,
  type DecisionsConfig,
} from "../packages/core/src/decisions/index.ts";
import { fakeProvider, sampleRequest } from "./fixtures/decision-provider.ts";

function setup(config: Partial<DecisionsConfig> = {}) {
  const registry = new DecisionRegistry();
  const cfg: DecisionsConfig = {
    enabled: true,
    provider: "fake",
    timeoutMs: 1500,
    minConfidence: 0.6,
    telemetry: true,
    ...config,
  };
  const metrics = new DecisionMetrics();
  const service = new DecisionService({ registry, config: () => cfg, metrics });
  const provider = fakeProvider();
  registry.register("test", provider);
  return { registry, cfg, metrics, service, provider };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("DecisionService: activation", () => {
  it("is a silent null object without a configured provider", async () => {
    const { service, provider, metrics } = setup({ provider: null });
    expect(service.available()).toBe(false);
    expect(service.activeProvider()).toBeNull();
    expect(await service.tryDecide(sampleRequest())).toBeNull();
    expect(provider.decideCalls).toHaveLength(0);
    expect(metrics.snapshot().requests).toBe(0);
  });

  it("is a silent null object when disabled, even with a registered provider", async () => {
    const { service, provider, metrics } = setup({ enabled: false });
    expect(service.available()).toBe(false);
    expect(await service.tryDecide(sampleRequest())).toBeNull();
    expect(provider.decideCalls).toHaveLength(0);
    expect(metrics.snapshot().requests).toBe(0);
  });

  it("registering does not activate: an unconfigured provider is never called", async () => {
    const { service, registry, cfg } = setup({ provider: null });
    const other = fakeProvider({ id: "other" });
    registry.register("test", other);
    expect(await service.tryDecide(sampleRequest())).toBeNull();
    expect(other.decideCalls).toHaveLength(0);
    cfg.provider = "other";
    expect(service.available()).toBe(true);
    expect(await service.tryDecide(sampleRequest())).not.toBeNull();
    expect(other.decideCalls).toHaveLength(1);
  });

  it("an unknown configured id means unavailable, never an error", async () => {
    const { service, metrics } = setup({ provider: "ghost" });
    expect(service.available()).toBe(false);
    expect(await service.tryDecide(sampleRequest())).toBeNull();
    expect(metrics.snapshot().requests).toBe(0);
  });

  it("uses only the single configured provider among several registered", async () => {
    const { service, registry, provider } = setup();
    const other = fakeProvider({ id: "other" });
    registry.register("test", other);
    await service.tryDecide(sampleRequest());
    expect(provider.decideCalls).toHaveLength(1);
    expect(other.decideCalls).toHaveLength(0);
    expect(service.activeProvider()).toEqual({ id: "fake", name: "Fake provider" });
  });

  it("follows live configuration changes on the next call", async () => {
    const { service, cfg, provider } = setup();
    cfg.enabled = false;
    expect(await service.tryDecide(sampleRequest())).toBeNull();
    cfg.enabled = true;
    expect(await service.tryDecide(sampleRequest())).not.toBeNull();
    expect(provider.decideCalls).toHaveLength(1);
  });

  it("reflects an unregistered provider immediately", async () => {
    const { service, registry } = setup({ provider: "late" });
    expect(service.available()).toBe(false);
    const unregister = registry.register("test", fakeProvider({ id: "late" }));
    expect(service.available()).toBe(true);
    unregister();
    expect(service.available()).toBe(false);
    expect(await service.tryDecide(sampleRequest())).toBeNull();
  });
});

describe("DecisionService: results", () => {
  it("returns validated answers with provider, latency and usage", async () => {
    const { service, metrics } = setup();
    const response = await service.tryDecide(sampleRequest());
    expect(response?.provider).toBe("fake");
    expect(Object.keys(response?.decisions ?? {})).toEqual(["kind", "stacked", "density"]);
    expect(response?.rejected).toEqual({});
    expect(response?.usage).toEqual({ inputUnits: 3, outputUnits: 1 });
    expect(metrics.snapshot()).toMatchObject({ requests: 1, completed: 1, fallbacks: 0 });
  });

  it("rejects per decision and keeps the usable ones (partial result)", async () => {
    const { service, provider } = setup();
    provider.mode = "partial";
    const response = await service.tryDecide(sampleRequest());
    expect(Object.keys(response?.decisions ?? {})).toEqual(["kind"]);
    expect(response?.rejected).toEqual({ stacked: "missing", density: "missing" });
  });

  it("does not send decisions the provider cannot take and reports them as unsupported", async () => {
    const registry = new DecisionRegistry();
    const provider = fakeProvider({ capabilities: { boolean: false } });
    registry.register("test", provider);
    const service = new DecisionService({
      registry,
      config: () => ({
        enabled: true,
        provider: "fake",
        timeoutMs: 1500,
        minConfidence: 0.6,
        telemetry: true,
      }),
      metrics: new DecisionMetrics(),
    });
    const response = await service.tryDecide(sampleRequest());
    expect(Object.keys(provider.decideCalls[0]?.decisions ?? {})).toEqual(["kind", "density"]);
    expect(response?.rejected).toEqual({ stacked: "unsupported" });
    expect(Object.keys(response?.decisions ?? {})).toEqual(["kind", "density"]);
  });

  it("falls back with 'unsupported' without calling the provider when nothing is supported", async () => {
    const registry = new DecisionRegistry();
    const provider = fakeProvider({
      capabilities: { select: false, boolean: false, ordinal: false },
    });
    registry.register("test", provider);
    const metrics = new DecisionMetrics();
    const service = new DecisionService({
      registry,
      config: () => ({
        enabled: true,
        provider: "fake",
        timeoutMs: 1500,
        minConfidence: 0.6,
        telemetry: true,
      }),
      metrics,
    });
    const attempt = await service.attempt(sampleRequest());
    expect(attempt.response).toBeNull();
    expect(attempt.outcome).toMatchObject({ status: "fallback", reason: "unsupported" });
    expect(provider.decideCalls).toHaveLength(0);
    expect(metrics.snapshot().fallbacks).toBe(1);
  });

  it("returns null with 'all_rejected' when every answer is rejected", async () => {
    const { service, provider } = setup();
    provider.mode = "lowConfidence";
    const attempt = await service.attempt(sampleRequest());
    expect(attempt.response).toBeNull();
    expect(attempt.outcome).toMatchObject({ status: "fallback", reason: "all_rejected" });
    provider.mode = "invalidAnswers";
    expect((await service.attempt(sampleRequest())).outcome).toMatchObject({
      reason: "all_rejected",
    });
  });

  it("honors per-call minConfidence over the configuration", async () => {
    const { service, provider } = setup();
    provider.confidence = 0.7;
    expect(await service.tryDecide(sampleRequest(), { minConfidence: 0.8 })).toBeNull();
    expect(await service.tryDecide(sampleRequest(), { minConfidence: 0.7 })).not.toBeNull();
  });

  it("reports a completed outcome with metadata only", async () => {
    const { service, provider } = setup();
    provider.mode = "partial";
    provider.confidence = 0.9;
    const attempt = await service.attempt(
      sampleRequest({ pack: { id: "pack-a", version: 2 } }),
      {},
      { sessionId: "s1" },
    );
    expect(attempt.outcome).toEqual({
      status: "completed",
      decisionId: "test-site-v1",
      pack: { id: "pack-a", version: 2 },
      provider: "fake",
      latencyMs: 0,
      decisionCount: 1,
      rejectedCount: 2,
      confidenceMin: 0.9,
    });
  });

  it("decide() throws a typed DecisionError where tryDecide returns null", async () => {
    const { service, provider, cfg } = setup();
    provider.mode = "typedError";
    provider.errorCode = "not_ready";
    await expect(service.decide(sampleRequest())).rejects.toMatchObject({
      name: "DecisionError",
      reason: "not_ready",
    });
    cfg.provider = null;
    await expect(service.decide(sampleRequest())).rejects.toMatchObject({ reason: "no_provider" });
    cfg.enabled = false;
    const error = await service.decide(sampleRequest()).catch((e) => e);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error.reason).toBe("disabled");
  });
});

describe("DecisionService: malformed requests and cancellation", () => {
  it("throws DecisionRequestError for a malformed request, even without a provider", async () => {
    const { service } = setup({ provider: null });
    await expect(service.tryDecide({ ...sampleRequest(), decisions: {} })).rejects.toBeInstanceOf(
      DecisionRequestError,
    );
    await expect(
      service.tryDecide({ ...sampleRequest(), version: 2 } as never),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("never calls the provider for a malformed request and does not count it", async () => {
    const { service, provider, metrics } = setup();
    await expect(
      service.tryDecide(sampleRequest({ state: { text: "x".repeat(20_000) } })),
    ).rejects.toBeInstanceOf(DecisionRequestError);
    expect(provider.decideCalls).toHaveLength(0);
    expect(metrics.snapshot().requests).toBe(0);
  });

  it("rejects invalid options as programming errors", async () => {
    const { service } = setup();
    await expect(service.tryDecide(sampleRequest(), { timeoutMs: 0 })).rejects.toBeInstanceOf(
      DecisionRequestError,
    );
    await expect(service.tryDecide(sampleRequest(), { minConfidence: 2 })).rejects.toBeInstanceOf(
      DecisionRequestError,
    );
  });

  it("propagates an abort that was already requested, without calling the provider", async () => {
    const { service, provider, metrics } = setup();
    const controller = new AbortController();
    const reason = new Error("user cancelled");
    controller.abort(reason);
    await expect(service.tryDecide(sampleRequest(), { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(provider.decideCalls).toHaveLength(0);
    expect(metrics.snapshot().requests).toBe(0);
  });

  it("propagates an abort during the call, aborts the provider's signal and records nothing", async () => {
    const { service, provider, metrics } = setup();
    provider.mode = "slow";
    const controller = new AbortController();
    const pending = service.tryDecide(sampleRequest(), { signal: controller.signal });
    const settled = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    const reason = new DOMException("stop", "AbortError");
    controller.abort(reason);
    expect(await settled).toBe(reason);
    expect(provider.signals[0]?.aborted).toBe(true);
    expect(metrics.snapshot().requests).toBe(0);
  });

  it("a caller abort never counts toward the breaker", async () => {
    const { service, provider } = setup();
    provider.mode = "slow";
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const pending = service
        .tryDecide(sampleRequest(), { signal: controller.signal })
        .catch(() => {});
      await vi.advanceTimersByTimeAsync(5);
      controller.abort();
      await pending;
    }
    provider.mode = "ok";
    expect(await service.tryDecide(sampleRequest())).not.toBeNull();
  });

  it("a cancellation by the provider itself resolves null as provider_error", async () => {
    const { service, provider } = setup();
    provider.mode = "providerAbort";
    const attempt = await service.attempt(sampleRequest());
    expect(attempt.response).toBeNull();
    expect(attempt.outcome).toMatchObject({ reason: "provider_error" });
  });
});

describe("DecisionService: time limit", () => {
  it("aborts the provider's signal and falls back with 'timeout'", async () => {
    const { service, provider, metrics } = setup();
    provider.mode = "slow";
    const pending = service.attempt(sampleRequest(), { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const attempt = await pending;
    expect(attempt.response).toBeNull();
    expect(attempt.outcome).toMatchObject({ status: "fallback", reason: "timeout", latencyMs: 50 });
    expect(provider.signals[0]?.aborted).toBe(true);
    expect(metrics.snapshot().lastFallback?.reason).toBe("timeout");
  });

  it("does not wait for a provider that ignores the signal", async () => {
    const { service, provider } = setup();
    provider.mode = "hang";
    let done = false;
    const pending = service.tryDecide(sampleRequest()).then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(done).toBe(true);
  });

  it("passes the effective timeout and honors a per-call override", async () => {
    const { service, provider } = setup();
    provider.mode = "hang";
    const pending = service.tryDecide(sampleRequest(), { timeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBeNull();
    provider.mode = "ok";
    await service.tryDecide(sampleRequest());
    expect(provider.decideCalls).toHaveLength(2);
  });

  it("a late rejection from the abandoned provider call is swallowed", async () => {
    const { service, provider } = setup();
    provider.mode = "slow";
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const pending = service.tryDecide(sampleRequest(), { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      // The provider's own rejection (it honors the signal) lands after the race ended.
      await vi.advanceTimersByTimeAsync(500);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("DecisionService: failures and the circuit breaker", () => {
  const countingCodes: DecisionProviderErrorCode[] = ["timeout", "invalid_response", "internal"];

  it.each(countingCodes)(
    "a typed '%s' error opens the circuit at the third failure",
    async (code) => {
      const { service, provider } = setup();
      provider.mode = "typedError";
      provider.errorCode = code;
      for (let i = 0; i < 3; i++) await service.tryDecide(sampleRequest());
      expect(provider.decideCalls).toHaveLength(3);
      const fourth = await service.attempt(sampleRequest());
      expect(fourth.outcome).toMatchObject({ reason: "circuit_open" });
      expect(provider.decideCalls).toHaveLength(3);
    },
  );

  it("maps typed codes to fallback reasons ('internal' becomes provider_error)", async () => {
    const { service, provider } = setup();
    provider.mode = "typedError";
    const map: Array<[DecisionProviderErrorCode, string]> = [
      ["timeout", "timeout"],
      ["invalid_response", "invalid_response"],
      ["internal", "provider_error"],
      ["not_ready", "not_ready"],
      ["unavailable", "unavailable"],
    ];
    for (const [code, reason] of map) {
      provider.errorCode = code;
      const attempt = await service.attempt(sampleRequest());
      expect(attempt.outcome, code).toMatchObject({ reason });
      // Keep the circuit closed between samples.
      provider.mode = "ok";
      await service.tryDecide(sampleRequest());
      provider.mode = "typedError";
    }
  });

  it("an untyped error, a sync throw and garbage all count and open at the third", async () => {
    for (const mode of ["throw", "garbage", "invalidAnswers"] as const) {
      const { service, provider } = setup();
      provider.mode = mode;
      for (let i = 0; i < 3; i++) await service.tryDecide(sampleRequest());
      const fourth = await service.attempt(sampleRequest());
      if (mode === "invalidAnswers") {
        // Per-decision rejections never count: the provider answered.
        expect(fourth.outcome).toMatchObject({ reason: "all_rejected" });
      } else {
        expect(fourth.outcome, mode).toMatchObject({ reason: "circuit_open" });
      }
    }
  });

  it("timeouts from the core count too", async () => {
    const { service, provider } = setup();
    provider.mode = "hang";
    for (let i = 0; i < 3; i++) {
      const pending = service.tryDecide(sampleRequest());
      await vi.advanceTimersByTimeAsync(1500);
      await pending;
    }
    expect((await service.attempt(sampleRequest())).outcome).toMatchObject({
      reason: "circuit_open",
    });
    expect(provider.decideCalls).toHaveLength(3);
  });

  it.each(["not_ready", "unavailable"] as const)(
    "'%s' is a fast fallback that never opens the circuit (10 repetitions)",
    async (code) => {
      const { service, provider } = setup();
      provider.mode = "typedError";
      provider.errorCode = code;
      for (let i = 0; i < 10; i++) {
        const attempt = await service.attempt(sampleRequest());
        expect(attempt.response).toBeNull();
        expect(attempt.outcome).toMatchObject({ status: "fallback", reason: code });
      }
      expect(provider.decideCalls).toHaveLength(10);
      provider.mode = "ok";
      expect(await service.tryDecide(sampleRequest())).not.toBeNull();
    },
  );

  it("low confidence and per-decision rejections do not count", async () => {
    const { service, provider } = setup();
    provider.mode = "lowConfidence";
    for (let i = 0; i < 6; i++) await service.tryDecide(sampleRequest());
    expect(provider.decideCalls).toHaveLength(6);
  });

  it("goes half-open after 30 s with a single probe; success closes it", async () => {
    const { service, provider } = setup();
    provider.mode = "throw";
    for (let i = 0; i < 3; i++) await service.tryDecide(sampleRequest());
    await vi.advanceTimersByTimeAsync(29_999);
    expect((await service.attempt(sampleRequest())).outcome).toMatchObject({
      reason: "circuit_open",
    });
    await vi.advanceTimersByTimeAsync(1);
    provider.mode = "slow";
    const probe = service.attempt(sampleRequest());
    // While the probe is in flight, concurrent calls short-circuit.
    const concurrent = await service.attempt(sampleRequest());
    expect(concurrent.outcome).toMatchObject({ reason: "circuit_open" });
    await vi.advanceTimersByTimeAsync(100);
    expect((await probe).response).not.toBeNull();
    provider.mode = "ok";
    expect(await service.tryDecide(sampleRequest())).not.toBeNull();
    expect(provider.decideCalls).toHaveLength(5);
  });

  it("a failed probe re-opens the circuit", async () => {
    const { service, provider } = setup();
    provider.mode = "throw";
    for (let i = 0; i < 3; i++) await service.tryDecide(sampleRequest());
    await vi.advanceTimersByTimeAsync(30_000);
    await service.tryDecide(sampleRequest());
    expect(provider.decideCalls).toHaveLength(4);
    expect((await service.attempt(sampleRequest())).outcome).toMatchObject({
      reason: "circuit_open",
    });
  });

  it("changing the active provider resets the breaker", async () => {
    const { service, provider, registry, cfg } = setup();
    provider.mode = "throw";
    for (let i = 0; i < 3; i++) await service.tryDecide(sampleRequest());
    expect((await service.attempt(sampleRequest())).outcome).toMatchObject({
      reason: "circuit_open",
    });
    const other = fakeProvider({ id: "other" });
    registry.register("test", other);
    cfg.provider = "other";
    expect(await service.tryDecide(sampleRequest())).not.toBeNull();
    cfg.provider = "fake";
    // Back on the broken one: the count restarted, so it takes three failures again.
    await service.tryDecide(sampleRequest());
    expect((await service.attempt(sampleRequest())).outcome).toMatchObject({
      reason: "provider_error",
    });
  });
});

describe("DecisionService: health stays off the decide path", () => {
  it("never calls health() while deciding, only from status()", async () => {
    const { service, provider } = setup();
    for (let i = 0; i < 3; i++) await service.tryDecide(sampleRequest());
    provider.mode = "typedError";
    provider.errorCode = "not_ready";
    await service.tryDecide(sampleRequest());
    expect(provider.healthCalls).toBe(0);
    const status = await service.status();
    expect(provider.healthCalls).toBe(1);
    expect(status).toMatchObject({
      enabled: true,
      configured: "fake",
      active: { id: "fake" },
      health: { status: "ready" },
      circuit: "closed",
    });
  });

  it("bounds health() to one second and reports it unavailable", async () => {
    const { service, provider } = setup();
    provider.health = () => new Promise(() => {});
    const pending = service.status();
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const status = await pending;
    expect(status.health).toEqual({ status: "unavailable", detail: "health check timed out" });
  });

  it("shows a failing health() as unavailable with its message", async () => {
    const { service, provider } = setup();
    provider.health = async () => {
      throw new Error("down");
    };
    expect((await service.status()).health).toEqual({ status: "unavailable", detail: "down" });
  });

  it("describes an unknown configured provider and the registered ones", async () => {
    const { service } = setup({ provider: "ghost" });
    const status = await service.status();
    expect(status.active).toBeNull();
    expect(status.configured).toBe("ghost");
    expect(status.health).toBeUndefined();
    expect(status.registered.map((p) => p.id)).toEqual(["fake"]);
  });
});

describe("DecisionService: metrics and attribution", () => {
  it("records per session and per process, never the state", async () => {
    const { service, provider, metrics } = setup();
    await service.attempt(
      sampleRequest({ pack: { id: "pack-a", version: 1 } }),
      {},
      { sessionId: "s1" },
    );
    provider.mode = "throw";
    await service.attempt(sampleRequest(), {}, { sessionId: "s2" });
    expect(metrics.snapshot("s1")).toMatchObject({
      requests: 1,
      completed: 1,
      packs: { "pack-a": 1 },
    });
    expect(metrics.snapshot("s2")).toMatchObject({ requests: 1, fallbacks: 1 });
    expect(metrics.snapshot()).toMatchObject({ requests: 2, completed: 1, fallbacks: 1 });
    expect(metrics.snapshot("none")).toMatchObject({ requests: 0 });
    expect(JSON.stringify(metrics.snapshot())).not.toContain("monthly sales");
  });

  it("DecisionProviderError instances from another copy of the SDK are recognized by name and code", async () => {
    const { service, provider } = setup();
    provider.mode = "ok";
    provider.decide = async () => {
      const foreign = Object.assign(new Error("starting"), {
        name: "DecisionProviderError",
        code: "not_ready",
      });
      throw foreign;
    };
    expect((await service.attempt(sampleRequest())).outcome).toMatchObject({ reason: "not_ready" });
  });
});
