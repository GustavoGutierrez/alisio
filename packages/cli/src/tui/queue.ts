/**
 * Single serialized queue for every cross-session interactive prompt the TUI can show: write/
 * process approvals, `/model`'s plugin-facing `select`, and `ask_user_question`/`/ask`'s question
 * panel. At most one of these is ever on screen, regardless of how many sessions (root or nested
 * subagents) are asking. Ordering is plain FIFO by arrival: simple, fair, and starvation-free —
 * there is no root-over-subagent (or vice versa) priority. Generic and session-agnostic: it only
 * ever sees an opaque `sessionId`/`label` pair, never anything subagent-specific.
 *
 * A job whose `signal` aborts before its turn is withdrawn without ever running: `onWithdrawn` is
 * called once, in its place, and it never blocks the jobs behind it. A job that is already running
 * when its own signal aborts is `run`'s own responsibility to unwind (mirroring the existing
 * `approve`/`request.signal` abort-while-displayed pattern in app.ts) — the queue does not
 * interrupt a job mid-flight, it only prevents queued jobs from ever starting once withdrawn.
 */

export interface QueueAsker {
  sessionId?: string;
  label?: string;
}

export interface QueueJob<T> extends QueueAsker {
  signal?: AbortSignal;
  run: () => Promise<T>;
  /** Called exactly once, instead of `run`, when withdrawn (aborted) before its turn arrives. */
  onWithdrawn: () => T;
}

interface Entry {
  asker: QueueAsker;
  start: () => void;
}

export class InteractiveQueue {
  private queue: Entry[] = [];
  private active: QueueAsker | undefined;

  submit<T>(job: QueueJob<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const asker: QueueAsker = { sessionId: job.sessionId, label: job.label };
      const entry: Entry = {
        asker,
        start: () => {
          settled = true;
          this.active = asker;
          // Clear `active` and advance BEFORE settling the caller's promise, so a caller awaiting
          // this job never observes a stale `current()`/`isWaiting()` in the same microtask.
          job.run().then(
            (value) => {
              this.active = undefined;
              this.advance();
              resolve(value);
            },
            (error) => {
              this.active = undefined;
              this.advance();
              reject(error);
            },
          );
        },
      };
      const withdraw = () => {
        if (settled) return;
        settled = true;
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(job.onWithdrawn());
      };
      if (job.signal) {
        if (job.signal.aborted) {
          withdraw();
          return;
        }
        job.signal.addEventListener("abort", withdraw, { once: true });
      }
      this.queue.push(entry);
      this.advance();
    });
  }

  private advance(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    next.start();
  }

  /** The currently running job's asker, if any. */
  current(): QueueAsker | undefined {
    return this.active ? { ...this.active } : undefined;
  }

  isQueued(sessionId: string): boolean {
    return this.queue.some((e) => e.asker.sessionId === sessionId);
  }

  /** Currently displayed OR waiting behind another prompt — both count as "waiting on the user". */
  isWaiting(sessionId: string): boolean {
    return this.active?.sessionId === sessionId || this.isQueued(sessionId);
  }
}
