/**
 * Concurrency slots of the JavaScript engine (spec D-29, §6.5): one active execution per SESSION
 * and a few per process. The session (not the root session) is the unit because a subagent's
 * `js_run` must not wait on its parent's. Pure bookkeeping: no I/O, no timers.
 */
import { ForgeError } from "./errors.ts";

export interface SlotLimits {
  perSession: number;
  perProcess: number;
}

export const DEFAULT_SLOT_LIMITS: Readonly<SlotLimits> = { perSession: 1, perProcess: 4 };

export class SlotTable {
  readonly #limits: SlotLimits;
  readonly #perSession = new Map<string, number>();
  #total = 0;

  constructor(limits: SlotLimits = DEFAULT_SLOT_LIMITS) {
    this.#limits = limits;
  }

  get active(): number {
    return this.#total;
  }

  activeIn(session: string): number {
    return this.#perSession.get(session) ?? 0;
  }

  /**
   * Takes a slot or throws `BUDGET_EXCEEDED` with the reason. The returned release is idempotent,
   * so a cleanup path can call it more than once without freeing a slot twice.
   */
  acquire(session: string): () => void {
    if (this.activeIn(session) >= this.#limits.perSession) {
      throw new ForgeError(
        "BUDGET_EXCEEDED",
        "Another js_run is still running in this session; wait for it to finish.",
      );
    }
    if (this.#total >= this.#limits.perProcess) {
      throw new ForgeError(
        "BUDGET_EXCEEDED",
        `Too many js_run executions are active in this process (${this.#limits.perProcess}); try again shortly.`,
      );
    }
    this.#perSession.set(session, this.activeIn(session) + 1);
    this.#total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.activeIn(session) - 1;
      if (next <= 0) this.#perSession.delete(session);
      else this.#perSession.set(session, next);
      this.#total--;
    };
  }
}
