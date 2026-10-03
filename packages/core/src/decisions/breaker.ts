export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive counted failures that open the circuit. */
  threshold?: number;
  /** How long the circuit stays open before a single probe is allowed. */
  openMs?: number;
  now?: () => number;
}

/**
 * Circuit breaker with an injected clock. The caller reports only the failures that count (the
 * service maps provider errors to `failure()`, `success()` or `neutral()`):
 * - `closed`: calls flow; `threshold` consecutive failures open it.
 * - `open`: `allow()` answers "open" until `openMs` pass, then the next caller is the single probe.
 * - `half-open`: one probe in flight; concurrent callers get "open". The probe's `success()`
 *   closes the circuit and its `failure()` re-opens it for another `openMs`.
 * `neutral()` ends a call that says nothing about the provider's health (a fast `not_ready`, a
 * caller abort): it releases the probe without counting or resetting anything.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private failures = 0;
  private openedAt: number | undefined;
  private probing = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.openMs = options.openMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Asks to run one call. "half-open" means the caller IS the single probe. */
  allow(): CircuitState {
    if (this.openedAt === undefined) return "closed";
    if (this.probing) return "open";
    if (this.now() - this.openedAt < this.openMs) return "open";
    this.probing = true;
    return "half-open";
  }

  success(): void {
    this.reset();
  }

  failure(): void {
    this.probing = false;
    if (this.openedAt !== undefined) {
      this.openedAt = this.now();
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  neutral(): void {
    this.probing = false;
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  /** Read-only view for diagnostics; it never consumes the probe. */
  state(): CircuitState {
    if (this.openedAt === undefined) return "closed";
    return this.probing || this.now() - this.openedAt >= this.openMs ? "half-open" : "open";
  }
}
