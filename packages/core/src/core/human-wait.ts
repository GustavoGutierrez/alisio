/**
 * Human waits: the moments a run is blocked on a PERSON (a tool approval, an external-directory
 * approval, `ask_user_question`, the plan review) and not on work. The run's time limit does not
 * count them (see `RunClock`).
 *
 * One registry per application. Each active run registers its clock under its session; anything
 * that asks a person goes through `track`, which pauses the clocks involved until the answer
 * arrives. A child session (a subagent) pauses its own clock AND its ancestors': a parent that
 * waits for a child is doing real work, but when that child waits for a person nobody works.
 */
import type { RunClock } from "./run-clock.ts";

export class HumanWaits {
  private clocks = new Map<string, RunClock>();

  constructor(
    private readonly parentOf: (session: string) => string | undefined = () => undefined,
  ) {}

  /** A run began: its clock follows the waits of its session. Returns the unregister function. */
  register(session: string, clock: RunClock): () => void {
    this.clocks.set(session, clock);
    return () => {
      if (this.clocks.get(session) === clock) this.clocks.delete(session);
    };
  }

  /**
   * Opens a wait for `session` (the session asking; its ancestors are paused too). Without a
   * session every active run is paused: somebody is being asked and nobody can say who for.
   */
  begin(session?: string): () => void {
    const releases: Array<() => void> = [];
    if (session === undefined)
      for (const clock of this.clocks.values()) releases.push(clock.pause());
    else {
      const seen = new Set<string>();
      for (let id: string | undefined = session; id !== undefined && !seen.has(id); ) {
        seen.add(id);
        const clock = this.clocks.get(id);
        if (clock) releases.push(clock.pause());
        try {
          id = this.parentOf(id);
        } catch {
          id = undefined;
        }
      }
    }
    return () => {
      for (const release of releases) release();
    };
  }

  /** Runs `wait` as a human wait: the clocks are paused until it settles, however it settles. */
  async track<T>(session: string | undefined, wait: () => Promise<T>): Promise<T> {
    const end = this.begin(session);
    try {
      return await wait();
    } finally {
      end();
    }
  }
}
