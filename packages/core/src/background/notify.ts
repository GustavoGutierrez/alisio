/**
 * The notification that wakes the owner agent when background tasks finish.
 *
 * One message per BATCH of finished tasks, never one per task and never a reminder per turn:
 *
 *  - batching: the first finished task opens a window (`batchMs`); every task that finishes inside
 *    it joins the same message;
 *  - rate limit: at most one wake-up per session every `minIntervalMs`, and at most `burstMax` per
 *    `burstWindowMs`. What does not fit stays pending and joins the next batch: nothing is dropped;
 *  - busy session: when the host reports `busy` (a run, an approval, another process holds the
 *    session) the batch waits and is retried every `retryMs`, and again as soon as the host calls
 *    `poke(session)` because the session became idle;
 *  - dedupe: delivery is claimed in the database (`delivered_at`, compare-and-set) BEFORE the
 *    wake-up and released if the wake-up did not start, so a task is announced at most once even
 *    with several processes on the same database; a task whose output the model already read after
 *    it finished is claimed by that read and is never announced.
 *
 * Eligibility (decided by the caller, `BackgroundTasks`): only tasks of ROOT sessions that ended on
 * their own (success, failure or watchdog timeout). A task the user or the model stopped, one that
 * died with the process, and a task of a child session never notify.
 *
 * Starting the run is the host's job (`TaskWake`): `runner.enqueue` does not wake an idle session,
 * so the TUI starts a run through its normal prompt path and the server through its run scheduler.
 */
import type { BackgroundTaskStatus } from "@alisio/sdk";
import type { BackgroundTaskStore, TaskRow } from "./store.ts";

export type WakeOutcome =
  /** A run that carries the notification has started. */
  | "started"
  /** The session cannot take a run right now (a run, an approval, another surface): retry. */
  | "busy"
  /** The session can never take it (missing, archived, finished): give up without delivering. */
  | "skip";

export interface TaskWakeRequest {
  /** The ROOT session to wake. */
  sessionId: string;
  /** The message the run starts from (persisted as the user message of the run). */
  text: string;
  /** What the UIs show instead of `text`. */
  display: string;
  /** Idempotency key of the batch (the host uses it as the run's request id). */
  requestId: string;
  taskIds: string[];
}
export type TaskWake = (request: TaskWakeRequest) => WakeOutcome | Promise<WakeOutcome>;

export interface NotifierTiming {
  batchMs: number;
  minIntervalMs: number;
  retryMs: number;
  burstMax: number;
  burstWindowMs: number;
}
export const DEFAULT_NOTIFIER_TIMING: NotifierTiming = {
  batchMs: 2_000,
  minIntervalMs: 10_000,
  retryMs: 2_000,
  burstMax: 6,
  burstWindowMs: 10 * 60_000,
};

const MAX_LISTED = 10;
const oneLine = (text: string, max: number) => {
  const flat = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Statuses a notification can report. */
const ENDED: readonly BackgroundTaskStatus[] = ["succeeded", "failed"];

/** The bounded message of one batch: ids, status and how to read the output, nothing else. */
export function buildTaskNotification(rows: TaskRow[]): { text: string; display: string } {
  const listed = rows.slice(0, MAX_LISTED).map((row) => {
    const detail = [
      `status=${row.status}`,
      ...(row.exitCode !== undefined ? [`exit_code=${row.exitCode}`] : []),
      ...(row.errorCode ? [`error=${row.errorCode}`] : []),
      `output_bytes=${row.bytes}`,
    ].join(" ");
    return `- id=${row.id} label="${oneLine(row.label, 80)}" ${detail}`;
  });
  const more = rows.length - listed.length;
  const text = [
    "<background-task-notification>",
    `${rows.length} background task${rows.length === 1 ? "" : "s"} finished:`,
    ...listed,
    ...(more > 0 ? [`- and ${more} more (use bg_list)`] : []),
    'Read the output with bg_output {"id": "<id>"}; pass next_offset as offset to continue.',
    "This is an automatic notification, not a message from the user.",
    "</background-task-notification>",
  ].join("\n");
  const first = rows[0] as TaskRow;
  const display =
    rows.length === 1
      ? `Background task finished: ${oneLine(first.label, 60)} (${first.status})`
      : `${rows.length} background tasks finished`;
  return { text, display };
}

interface SessionState {
  ids: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  dueAt?: number;
  lastWakeAt?: number;
  wakes: number[];
  attempting: boolean;
}

export class TaskNotifier {
  private sessions = new Map<string, SessionState>();
  private readonly timing: NotifierTiming;
  private disposed = false;

  constructor(
    private options: {
      store: BackgroundTaskStore;
      wake: TaskWake;
      timing?: Partial<NotifierTiming>;
      now?: () => number;
      /** Errors of the wake callback (it never throws into the caller). */
      onError?: (error: unknown) => void;
    },
  ) {
    this.timing = { ...DEFAULT_NOTIFIER_TIMING, ...options.timing };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private state(session: string): SessionState {
    let state = this.sessions.get(session);
    if (!state) {
      state = { ids: new Set(), wakes: [], attempting: false };
      this.sessions.set(session, state);
    }
    return state;
  }

  /** Number of finished tasks of a session waiting to be announced. */
  pending(session: string): number {
    return this.sessions.get(session)?.ids.size ?? 0;
  }

  /** A task ended and may be announced to its root session. */
  note(row: TaskRow): void {
    if (this.disposed || !ENDED.includes(row.status)) return;
    const state = this.state(row.rootSession);
    state.ids.add(row.id);
    this.schedule(row.rootSession, state, this.timing.batchMs);
  }

  /** The host says the session is idle now: try again without waiting for the retry timer. */
  poke(session: string): void {
    const state = this.sessions.get(session);
    if (this.disposed || !state?.ids.size) return;
    this.schedule(session, state, 0);
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.sessions.values()) if (state.timer) clearTimeout(state.timer);
    this.sessions.clear();
  }

  private schedule(session: string, state: SessionState, delay: number): void {
    const due = this.now() + Math.max(0, delay);
    // A sooner timer wins; a later request never postpones an armed one.
    if (state.timer && state.dueAt !== undefined && state.dueAt <= due) return;
    if (state.timer) clearTimeout(state.timer);
    state.dueAt = due;
    state.timer = setTimeout(
      () => {
        state.timer = undefined;
        state.dueAt = undefined;
        void this.attempt(session, state);
      },
      Math.max(0, delay),
    );
    state.timer.unref?.();
  }

  private async attempt(session: string, state: SessionState): Promise<void> {
    if (this.disposed || state.attempting || !state.ids.size) return;
    const now = this.now();
    const { minIntervalMs, burstMax, burstWindowMs, retryMs, batchMs } = this.timing;
    state.wakes = state.wakes.filter((at) => now - at < burstWindowMs);
    const earliest = Math.max(
      state.lastWakeAt !== undefined ? state.lastWakeAt + minIntervalMs : 0,
      state.wakes.length >= burstMax ? (state.wakes[0] as number) + burstWindowMs : 0,
    );
    if (earliest > now) return this.schedule(session, state, earliest - now);
    const { store } = this.options;
    const claimed: TaskRow[] = [];
    for (const id of [...state.ids]) {
      const row = store.get(id);
      state.ids.delete(id);
      // Read after it finished (delivered_at set by `bg_output`) or removed: nothing to announce.
      if (!row || row.deliveredAt !== undefined) continue;
      if (store.claimDelivery(id, now)) claimed.push(row);
    }
    if (!claimed.length) return;
    state.attempting = true;
    const release = () => {
      for (const row of claimed) {
        store.releaseDelivery(row.id, now);
        state.ids.add(row.id);
      }
    };
    try {
      const { text, display } = buildTaskNotification(
        claimed.map((row) => store.get(row.id) ?? row),
      );
      const outcome = await this.options.wake({
        sessionId: session,
        text,
        display,
        requestId: `bg-${claimed[0]?.id}`,
        taskIds: claimed.map((row) => row.id),
      });
      if (outcome === "started") {
        state.lastWakeAt = now;
        state.wakes.push(now);
        if (state.ids.size) this.schedule(session, state, batchMs);
      } else if (outcome === "busy") {
        release();
        this.schedule(session, state, retryMs);
      } else {
        // `skip`: the session cannot be woken at all; stop retrying, deliver nothing.
        for (const row of claimed) store.releaseDelivery(row.id, now);
      }
    } catch (error) {
      this.options.onError?.(error);
      release();
      this.schedule(session, state, retryMs);
    } finally {
      state.attempting = false;
      // Tasks that finished while the wake-up was in flight must not wait for another `note`.
      if (!this.disposed && state.ids.size && !state.timer) this.schedule(session, state, retryMs);
    }
  }
}
