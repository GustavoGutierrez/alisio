import {
  type DecisionAnswer,
  type DecisionFallbackReason,
  type DecisionOptions,
  type DecisionProvider,
  type DecisionRejection,
  type DecisionRequest,
  DecisionRequestError,
  type DecisionResponse,
  type DecisionsApi,
} from "@alisio/sdk";
import { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from "./breaker.ts";
import type { DecisionMetrics } from "./metrics.ts";
import type { DecisionRegistry, RegisteredDecisionProvider } from "./registry.ts";
import { splitSupported, validateAnswers, validateRequest } from "./validate.ts";

/** The slice of the `decisions` configuration block the service reads (live, per call). */
export interface DecisionsConfig {
  enabled: boolean;
  /** Id of the active provider; `null` disables the feature. */
  provider: string | null;
  timeoutMs: number;
  minConfidence: number;
  telemetry: boolean;
}

export const DEFAULT_DECISIONS_CONFIG: DecisionsConfig = {
  enabled: true,
  provider: null,
  timeoutMs: 1500,
  minConfidence: 0.6,
  telemetry: true,
};

/** `/decisions` asks the provider's health with its own short limit. */
export const HEALTH_TIMEOUT_MS = 1000;

type Pack = { id: string; version: number };
export type DecisionOutcome =
  | {
      status: "completed";
      decisionId: string;
      pack?: Pack;
      provider: string;
      latencyMs: number;
      decisionCount: number;
      rejectedCount: number;
      confidenceMin: number;
    }
  | {
      status: "fallback";
      decisionId: string;
      pack?: Pack;
      provider: string;
      latencyMs: number;
      reason: DecisionFallbackReason;
    };

export interface DecisionAttempt {
  response: DecisionResponse | null;
  /** Absent when no attempt happened (disabled or no active provider). */
  outcome?: DecisionOutcome;
}

/** `decide()` failure: the typed counterpart of a `null` from `tryDecide`. */
export class DecisionError extends Error {
  constructor(
    readonly reason: DecisionFallbackReason | "disabled" | "no_provider",
    message?: string,
  ) {
    super(message ?? `Decision unavailable: ${reason}`);
    this.name = "DecisionError";
  }
}

export interface DecisionStatus {
  enabled: boolean;
  /** The configured provider id, whether or not it is registered. */
  configured: string | null;
  active: { id: string; name: string; capabilities: DecisionProvider["capabilities"] } | null;
  registered: ReturnType<DecisionRegistry["list"]>;
  health?: { status: "ready" | "starting" | "unavailable"; detail?: string };
  circuit: CircuitState;
  /** Last `activate`/`deactivate` failure of any provider (cleared by a later successful activate). */
  lastLifecycleError?: {
    provider: string;
    phase: "activate" | "deactivate";
    message: string;
    at: number;
  };
}

export interface DecisionServiceDeps {
  registry: DecisionRegistry;
  /** Read on every call so configuration changes apply to the next decision. */
  config: () => DecisionsConfig;
  metrics: DecisionMetrics;
  now?: () => number;
  breaker?: CircuitBreakerOptions;
  /** Provider lifecycle (ADR-11): the limit of each call and where failures are logged. */
  lifecycle?: { timeoutMs?: () => number; log?: (message: string) => void };
}

const isProviderError = (
  error: unknown,
): error is { name: string; code: string; message: string } =>
  !!error &&
  typeof error === "object" &&
  (error as { name?: unknown }).name === "DecisionProviderError" &&
  typeof (error as { code?: unknown }).code === "string";

const finiteUnits = (usage: unknown): DecisionResponse["usage"] | undefined => {
  if (!usage || typeof usage !== "object") return undefined;
  const out: { inputUnits?: number; outputUnits?: number } = {};
  for (const key of ["inputUnits", "outputUnits"] as const) {
    const value = (usage as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
};

type Settled =
  | { kind: "result"; value: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

/**
 * Decision Intelligence service: one active provider (chosen by configuration), request and answer
 * validation per decision, a core-enforced time limit and a circuit breaker. Without an active
 * provider it is a silent null object: no metrics, no events.
 */
export class DecisionService implements Omit<DecisionsApi, "registerProvider"> {
  private readonly registry: DecisionRegistry;
  private readonly config: () => DecisionsConfig;
  private readonly metrics: DecisionMetrics;
  private readonly now: () => number;
  private readonly breaker: CircuitBreaker;
  /** Registration the breaker state belongs to; a change of provider resets it. */
  private breakerOwner: unknown;
  private readonly lifecycle: NonNullable<DecisionServiceDeps["lifecycle"]>;
  /** The registration `activate` was last requested for (the one that is active, lifecycle-wise). */
  private lifecycleEntry: RegisteredDecisionProvider | undefined;
  private lifecycleOn = false;
  private closed = false;
  /** Per-registration queue: `deactivate` never crosses a still-running `activate`. */
  private queues = new Map<RegisteredDecisionProvider, Promise<void>>();
  private lifecycleError: DecisionStatus["lastLifecycleError"];

  constructor(deps: DecisionServiceDeps) {
    this.registry = deps.registry;
    this.config = deps.config;
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => Date.now());
    this.breaker = new CircuitBreaker({ now: this.now, ...deps.breaker });
    this.lifecycle = deps.lifecycle ?? {};
    // Registrations that happen after the first `syncActive` (late plugins, removals) follow it.
    this.registry.onChange(() => {
      if (this.lifecycleOn) this.syncActive();
    });
  }

  /**
   * Lifecycle (ADR-11): makes `activate`/`deactivate` follow what the configuration and the
   * registry say is the active provider. Idempotent, synchronous and never throws: the hooks run
   * in the background (bounded, serialized per provider, failures recorded). The first call (after
   * the plugins loaded) also arms the follow-up on registry changes.
   */
  syncActive(): void {
    if (this.closed) return;
    this.lifecycleOn = true;
    const config = this.config();
    const wanted =
      config.enabled && config.provider ? this.registry.get(config.provider) : undefined;
    const previous = this.lifecycleEntry;
    if (wanted === previous) return;
    this.lifecycleEntry = wanted;
    if (previous) this.enqueue(previous, "deactivate");
    if (wanted) this.enqueue(wanted, "activate");
  }

  /** Close: deactivates the active provider (bounded by `timeoutMs`) and stops following changes. */
  async shutdown(timeoutMs?: number): Promise<void> {
    this.closed = true;
    this.lifecycleOn = false;
    const previous = this.lifecycleEntry;
    this.lifecycleEntry = undefined;
    if (!previous) return;
    await this.enqueue(previous, "deactivate", timeoutMs);
  }

  private enqueue(
    entry: RegisteredDecisionProvider,
    phase: "activate" | "deactivate",
    timeoutMs?: number,
  ): Promise<void> {
    const next = (this.queues.get(entry) ?? Promise.resolve()).then(() =>
      this.runLifecycle(entry, phase, timeoutMs),
    );
    this.queues.set(entry, next);
    return next;
  }

  /** Runs one hook with a limit; resolves always (a failure is recorded, never propagated). */
  private async runLifecycle(
    entry: RegisteredDecisionProvider,
    phase: "activate" | "deactivate",
    timeoutMs = this.lifecycle.timeoutMs?.() ?? 15_000,
  ): Promise<void> {
    const { provider } = entry;
    const hook = provider[phase];
    if (typeof hook !== "function") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => hook.call(provider)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${phase} timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
      if (phase === "activate" && this.lifecycleError?.provider === provider.id)
        this.lifecycleError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lifecycleError = { provider: provider.id, phase, message, at: this.now() };
      try {
        this.lifecycle.log?.(`decision provider ${provider.id}: ${phase} failed: ${message}`);
      } catch {
        /* A logger cannot break the lifecycle. */
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private active(): { provider: DecisionProvider; config: DecisionsConfig } | undefined {
    const config = this.config();
    if (!config.enabled || !config.provider) return undefined;
    const entry = this.registry.get(config.provider);
    if (!entry) return undefined;
    if (this.breakerOwner !== entry) {
      this.breakerOwner = entry;
      this.breaker.reset();
    }
    return { provider: entry.provider, config };
  }

  available(): boolean {
    return this.active() !== undefined;
  }

  activeProvider(): { id: string; name: string } | null {
    const active = this.active();
    return active ? { id: active.provider.id, name: active.provider.name } : null;
  }

  async tryDecide(req: DecisionRequest, opts?: DecisionOptions): Promise<DecisionResponse | null> {
    return (await this.attempt(req, opts)).response;
  }

  /** Like `tryDecide`, but a missing response throws a typed `DecisionError`. */
  async decide(req: DecisionRequest, opts?: DecisionOptions): Promise<DecisionResponse> {
    const { response, outcome } = await this.attempt(req, opts);
    if (response) return response;
    if (outcome?.status === "fallback") throw new DecisionError(outcome.reason);
    throw new DecisionError(this.config().enabled ? "no_provider" : "disabled");
  }

  /**
   * The full result of one call, with the outcome the run integration turns into an event.
   * Throws `DecisionRequestError` for a malformed request and rethrows the caller's abort.
   */
  async attempt(
    req: DecisionRequest,
    opts: DecisionOptions = {},
    ctx: { sessionId?: string } = {},
  ): Promise<DecisionAttempt> {
    validateRequest(req);
    if (opts.timeoutMs !== undefined && !(Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0))
      throw new DecisionRequestError("timeoutMs must be a positive number");
    if (
      opts.minConfidence !== undefined &&
      !(Number.isFinite(opts.minConfidence) && opts.minConfidence >= 0 && opts.minConfidence <= 1)
    )
      throw new DecisionRequestError("minConfidence must be within [0, 1]");
    opts.signal?.throwIfAborted();

    const active = this.active();
    if (!active) return { response: null };
    const { provider, config } = active;
    const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
    const minConfidence = opts.minConfidence ?? config.minConfidence;

    const base = {
      decisionId: req.id,
      ...(req.pack ? { pack: { ...req.pack } } : {}),
      provider: provider.id,
    };
    const fallback = (reason: DecisionFallbackReason, latencyMs: number): DecisionAttempt => {
      const outcome: DecisionOutcome = { status: "fallback", ...base, latencyMs, reason };
      this.metrics.record(outcome, ctx.sessionId);
      return { response: null, outcome };
    };

    const { supported, unsupported } = splitSupported(req, provider);
    if (supported.length === 0) return fallback("unsupported", 0);

    const mode = this.breaker.allow();
    if (mode === "open") return fallback("circuit_open", 0);

    // From here every path must settle the breaker (probe included).
    let settled = false;
    const settle = (verdict: "success" | "failure" | "neutral") => {
      if (settled) return;
      settled = true;
      this.breaker[verdict]();
    };

    const sent: DecisionRequest =
      unsupported.length === 0
        ? req
        : ({
            ...req,
            decisions: Object.fromEntries(supported.map((key) => [key, req.decisions[key]])),
          } as DecisionRequest);

    const started = this.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const outcome = await new Promise<Settled>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException("Decision timed out", "TimeoutError"));
        resolve({ kind: "timeout" });
      }, timeoutMs);
      if (opts.signal) {
        onAbort = () => {
          controller.abort(opts.signal?.reason);
          resolve({ kind: "aborted" });
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      let call: Promise<unknown>;
      try {
        call = Promise.resolve(provider.decide(sent, { signal: controller.signal, timeoutMs }));
      } catch (error) {
        call = Promise.reject(error);
      }
      // A provider that ignores the signal must not retain or crash anything after the race ends.
      call.then(
        (value) => resolve({ kind: "result", value }),
        (error) => resolve({ kind: "error", error }),
      );
    }).finally(() => {
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    });
    const latencyMs = Math.max(0, this.now() - started);

    try {
      switch (outcome.kind) {
        case "aborted":
          settle("neutral");
          throw opts.signal?.reason ?? new DOMException("Aborted", "AbortError");
        case "timeout":
          settle("failure");
          return fallback("timeout", latencyMs);
        case "error": {
          const error = outcome.error;
          if (isProviderError(error)) {
            switch (error.code) {
              case "not_ready":
              case "unavailable":
                settle("neutral");
                return fallback(error.code, latencyMs);
              case "timeout":
              case "invalid_response":
                settle("failure");
                return fallback(error.code, latencyMs);
              default:
                settle("failure");
                return fallback("provider_error", latencyMs);
            }
          }
          settle("failure");
          return fallback("provider_error", latencyMs);
        }
        case "result": {
          let accepted: Record<string, DecisionAnswer>;
          let rejected: Record<string, DecisionRejection>;
          try {
            ({ accepted, rejected } = validateAnswers(
              sent,
              provider,
              outcome.value,
              minConfidence,
            ));
          } catch {
            settle("failure");
            return fallback("invalid_response", latencyMs);
          }
          settle("success");
          for (const key of unsupported) rejected[key] = "unsupported";
          const confidences = Object.values(accepted).map((a) => a.confidence);
          if (confidences.length === 0) return fallback("all_rejected", latencyMs);
          const usage = finiteUnits((outcome.value as { usage?: unknown }).usage);
          const response: DecisionResponse = {
            provider: provider.id,
            latencyMs,
            decisions: accepted,
            rejected,
            ...(usage ? { usage } : {}),
          };
          const done: DecisionOutcome = {
            status: "completed",
            ...base,
            latencyMs,
            decisionCount: confidences.length,
            rejectedCount: Object.keys(rejected).length,
            confidenceMin: Math.min(...confidences),
          };
          this.metrics.record(done, ctx.sessionId);
          return { response, outcome: done };
        }
      }
    } finally {
      settle("neutral");
    }
  }

  /** For `/decisions` only: the one place `health()` is called, with its own short limit. */
  async status(signal?: AbortSignal): Promise<DecisionStatus> {
    const config = this.config();
    const active = this.active();
    const status: DecisionStatus = {
      enabled: config.enabled,
      configured: config.provider,
      active: active
        ? {
            id: active.provider.id,
            name: active.provider.name,
            capabilities: { ...active.provider.capabilities },
          }
        : null,
      registered: this.registry.list(),
      circuit: this.breaker.state(),
      ...(this.lifecycleError ? { lastLifecycleError: { ...this.lifecycleError } } : {}),
    };
    const health = active?.provider.health;
    if (!active || typeof health !== "function") return status;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      status.health = await new Promise<NonNullable<DecisionStatus["health"]>>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new DOMException("Health check timed out", "TimeoutError"));
          resolve({ status: "unavailable", detail: "health check timed out" });
        }, HEALTH_TIMEOUT_MS);
        let call: Promise<Awaited<ReturnType<NonNullable<DecisionProvider["health"]>>>>;
        try {
          call = Promise.resolve(health.call(active.provider, controller.signal));
        } catch (error) {
          call = Promise.reject(error);
        }
        call.then(
          (value) => {
            const ok =
              value &&
              ["ready", "starting", "unavailable"].includes((value as { status: string }).status);
            resolve(
              ok
                ? {
                    status: value.status,
                    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
                  }
                : { status: "unavailable", detail: "invalid health response" },
            );
          },
          (error) =>
            resolve({
              status: "unavailable",
              detail: error instanceof Error ? error.message : String(error),
            }),
        );
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    return status;
  }
}
