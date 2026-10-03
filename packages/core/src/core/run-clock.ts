/**
 * The run's time limit (`limits.timeoutMs`) as a PAUSABLE clock.
 *
 * The limit exists to stop runaway work (a stuck model, a looping tool), not to cap how long a
 * person takes to read a plan or answer a question. So the clock counts ACTIVE time only: while at
 * least one human wait is open (an approval, a question, a plan review) it is paused, and it
 * resumes with the remaining time when the last wait ends.
 *
 * Waits nest and overlap (several tools can wait for approvals in parallel), so pausing is
 * counted: the clock runs again only when every pause was released. A pause is released exactly
 * once (the function `pause()` returns is idempotent), and a released or disposed clock ignores
 * late calls, so an aborted run can never leave a timer behind.
 */

/** Time source and timers, replaceable in tests. */
export interface ClockSource {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Longest delay a timer supports; a longer limit re-arms itself. */
const MAX_TIMER_MS = 2_147_483_647;

const realSource: ClockSource = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // Like `AbortSignal.timeout`: the limit alone never keeps the process alive.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RunClock {
  private readonly controller = new AbortController();
  private readonly source: ClockSource;
  private consumed = 0;
  /** Start of the current running stretch (undefined while paused or finished). */
  private since: number | undefined;
  private timer: unknown;
  private pauses = 0;
  private done = false;

  constructor(
    readonly limitMs: number,
    source: ClockSource = realSource,
  ) {
    this.source = source;
    this.since = source.now();
    this.arm();
  }

  /** Aborts with a `TimeoutError` (the same reason `AbortSignal.timeout` uses) at the limit. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether at least one human wait is open. */
  get paused(): boolean {
    return this.pauses > 0;
  }

  /** Time the run was really working: elapsed time minus every paused stretch. */
  activeMs(): number {
    return (
      this.consumed + (this.since === undefined ? 0 : Math.max(0, this.source.now() - this.since))
    );
  }

  remainingMs(): number {
    return Math.max(0, this.limitMs - this.activeMs());
  }

  /**
   * Opens a human wait. Returns the function that closes it (idempotent). Pausing a clock that
   * already ended (limit reached or disposed) does nothing.
   */
  pause(): () => void {
    if (this.done) return () => {};
    if (this.pauses++ === 0) {
      if (this.since !== undefined) this.consumed += Math.max(0, this.source.now() - this.since);
      this.since = undefined;
      this.disarm();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.done) return;
      if (--this.pauses === 0) {
        this.since = this.source.now();
        this.arm();
      }
    };
  }

  /** Stops the clock for good and frees its timer (call when the run ends, whatever the reason). */
  dispose(): void {
    if (this.done) return;
    this.consumed = this.activeMs();
    this.done = true;
    this.since = undefined;
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    this.timer = this.source.setTimeout(
      () => {
        this.timer = undefined;
        if (this.done || this.pauses > 0) return;
        if (this.remainingMs() > 0) return this.arm();
        this.consumed = this.activeMs();
        this.done = true;
        this.since = undefined;
        this.controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
      },
      Math.min(this.remainingMs(), MAX_TIMER_MS),
    );
  }

  private disarm(): void {
    if (this.timer !== undefined) this.source.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
