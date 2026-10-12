/**
 * Per-execution budget: total and concurrent nested calls, the credits granted to the guest
 * (backpressure, spec §5.4) and retained output bytes. The host enforces these numbers even when
 * the guest prelude checks them too. Pure: no I/O.
 */
import { ForgeError } from "./errors.ts";

export interface BudgetLimits {
  maxToolCalls: number;
  maxConcurrency: number;
  maxRetainedOutputBytes: number;
}

export class BudgetLedger {
  readonly #limits: BudgetLimits;
  #started = 0;
  #active = 0;
  #outputBytes = 0;
  #callCredits = 0;
  #byteCredits = 0;

  constructor(limits: BudgetLimits) {
    this.#limits = limits;
  }

  get stats(): { started: number; active: number; outputBytes: number } {
    return { started: this.#started, active: this.#active, outputBytes: this.#outputBytes };
  }

  /**
   * Tops the guest's credits up to what it may still use and returns the increment to send in a
   * `grant` message. Call credits never exceed the free concurrency slots or the remaining total.
   */
  grant(): { calls: number; bytes: number } {
    const callTarget = Math.max(
      0,
      Math.min(
        this.#limits.maxConcurrency - this.#active,
        this.#limits.maxToolCalls - this.#started,
      ),
    );
    const calls = Math.max(0, callTarget - this.#callCredits);
    this.#callCredits += calls;
    const bytes = this.#limits.maxRetainedOutputBytes - this.#outputBytes - this.#byteCredits;
    this.#byteCredits += bytes;
    return { calls, bytes };
  }

  /** Spends a credit for a new nested call or throws `BUDGET_EXCEEDED` without changing state. */
  startCall(): void {
    if (this.#started >= this.#limits.maxToolCalls) {
      throw new ForgeError(
        "BUDGET_EXCEEDED",
        `Tool call limit reached (${this.#limits.maxToolCalls})`,
      );
    }
    if (this.#active >= this.#limits.maxConcurrency) {
      throw new ForgeError(
        "BUDGET_EXCEEDED",
        `Concurrent tool call limit reached (${this.#limits.maxConcurrency})`,
      );
    }
    if (this.#callCredits <= 0) {
      throw new ForgeError("BUDGET_EXCEEDED", "Tool call without a granted credit");
    }
    this.#callCredits--;
    this.#started++;
    this.#active++;
  }

  finishCall(): void {
    if (this.#active <= 0) throw new Error("finishCall without an active call");
    this.#active--;
  }

  /** Accounts output bytes, or throws `OUTPUT_LIMIT` without partial accounting. */
  recordOutput(bytes: number): void {
    if (this.#outputBytes + bytes > this.#limits.maxRetainedOutputBytes) {
      throw new ForgeError(
        "OUTPUT_LIMIT",
        `Retained output limit reached (${this.#limits.maxRetainedOutputBytes} bytes)`,
      );
    }
    this.#outputBytes += bytes;
    this.#byteCredits = Math.max(0, this.#byteCredits - bytes);
  }
}
