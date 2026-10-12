/**
 * Progress coalescing (spec §5.4, D14): at most 4 progress events per second reach the UI, but a
 * terminal event (a finished call, the end of a phase) is never dropped. Non-terminal events that
 * arrive too soon are replaced by the newest one of their category (script progress, a call
 * starting, anything else) and delivered when that category's window reopens, so a burst of
 * calls never hides the script's own progress. Pure but for the injected clock and timer.
 */
import type { ForgeProgress } from "@alisio/sdk";

export const PROGRESS_INTERVAL_MS = 250;

export interface ProgressClock {
  now(): number;
  /** Schedules `run` after `ms` and returns how to cancel it. */
  schedule(run: () => void, ms: number): () => void;
}

const realClock: ProgressClock = {
  now: () => Date.now(),
  schedule(run, ms) {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

type Category = "progress" | "call" | "other";

const categoryOf = (progress: ForgeProgress): Category =>
  progress.phase === "call"
    ? "call"
    : progress.message !== undefined ||
        progress.completed !== undefined ||
        progress.total !== undefined
      ? "progress"
      : "other";

interface Lane {
  lastAt: number;
  pending?: { progress: ForgeProgress; order: number };
  cancel?: () => void;
}

export class ProgressCoalescer {
  readonly #sink: (progress: ForgeProgress) => void;
  readonly #clock: ProgressClock;
  readonly #lanes = new Map<Category, Lane>();
  #order = 0;

  constructor(sink: (progress: ForgeProgress) => void, clock: ProgressClock = realClock) {
    this.#sink = sink;
    this.#clock = clock;
  }

  /** A progress event that may be replaced by a newer one of its category. */
  update(progress: ForgeProgress): void {
    const category = categoryOf(progress);
    let lane = this.#lanes.get(category);
    if (!lane) {
      lane = { lastAt: Number.NEGATIVE_INFINITY };
      this.#lanes.set(category, lane);
    }
    const wait = lane.lastAt + PROGRESS_INTERVAL_MS - this.#clock.now();
    if (wait <= 0 && lane.pending === undefined) return this.#deliver(lane, progress);
    lane.pending = { progress, order: this.#order++ };
    const owner = lane;
    lane.cancel ??= this.#clock.schedule(
      () => {
        owner.cancel = undefined;
        this.#flushLane(owner);
      },
      Math.max(wait, 0),
    );
  }

  /** An event that must reach the UI: delivered now, after anything still waiting. */
  terminal(progress: ForgeProgress): void {
    this.#flush();
    this.#sink(progress);
  }

  /** Delivers what is waiting and stops the timers. */
  close(): void {
    this.#flush();
  }

  /** Everything waiting, in arrival order. */
  #flush(): void {
    const waiting: Array<{ lane: Lane; progress: ForgeProgress; order: number }> = [];
    for (const lane of this.#lanes.values()) {
      lane.cancel?.();
      lane.cancel = undefined;
      if (lane.pending) waiting.push({ lane, ...lane.pending });
      lane.pending = undefined;
    }
    for (const item of waiting.sort((a, b) => a.order - b.order))
      this.#deliver(item.lane, item.progress);
  }

  #flushLane(lane: Lane): void {
    const pending = lane.pending;
    lane.pending = undefined;
    if (pending) this.#deliver(lane, pending.progress);
  }

  #deliver(lane: Lane, progress: ForgeProgress): void {
    lane.lastAt = this.#clock.now();
    this.#sink(progress);
  }
}
