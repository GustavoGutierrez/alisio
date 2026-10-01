import type { Attachment, DatasetRef } from "@alisio/sdk";
import type { Application } from "./workspace-host.ts";

type RunOptions = NonNullable<Parameters<Application["runner"]["run"]>[3]>;

/** One prompt accepted by the server: a `runs` row in `queued` until a slot is free. */
export interface RunJob {
  runId: string;
  sessionId: string;
  workspaceId: string;
  app: Application;
  text: string;
  correlationId: string;
  /** Built when the run starts, so preset and effort changes while queued apply. */
  options: () => Omit<RunOptions, "runId" | "correlationId" | "attachments" | "datasets">;
  attachments?: Attachment[];
  /** Datasets attached to the prompt (chips); their summary is already part of `text`. */
  datasets?: DatasetRef[];
  display?: string;
  /**
   * A tool call started from the UI instead of a prompt (`runToolCall`: no model, same gates),
   * e.g. copying an artifact into the workspace. `text` is ignored for these jobs.
   */
  tool?: { name: string; input: Record<string, unknown> };
}

interface Tracked extends RunJob {
  status: "queued" | "running";
  controller: AbortController;
  done?: Promise<void>;
}

export interface RunSchedulerOptions {
  /** Global semaphore across sessions and workspaces (RF-02, default 4). */
  maxConcurrent?: number;
  /** Called on every job state change (queued, running, finished). */
  onChange?: (job: RunJob, status: "queued" | "running" | "finished") => void;
}

/**
 * FIFO scheduler with a global concurrency limit. A session has at most one job (queued or
 * running); the runner itself enforces one active run per session.
 */
export class RunScheduler {
  private jobs = new Map<string, Tracked>();
  private queue: Tracked[] = [];
  private running = 0;
  private readonly max: number;
  /** Compactions (or other exclusive work) per session, tracked for status and shutdown. */
  private exclusive = new Map<
    string,
    { workspaceId: string; done: Promise<unknown>; abort?: () => void }
  >();

  constructor(private options: RunSchedulerOptions = {}) {
    this.max = Math.max(1, options.maxConcurrent ?? 4);
  }

  /** Accepts a job; it starts now when a slot is free, otherwise it waits in FIFO order. */
  submit(job: RunJob): "queued" | "running" {
    const tracked: Tracked = { ...job, status: "queued", controller: new AbortController() };
    this.jobs.set(job.sessionId, tracked);
    this.queue.push(tracked);
    this.options.onChange?.(job, "queued");
    this.pump();
    return tracked.status;
  }

  private pump() {
    while (this.running < this.max && this.queue.length) {
      const job = this.queue.shift() as Tracked;
      this.start(job);
    }
  }

  private start(job: Tracked) {
    job.status = "running";
    this.running++;
    this.options.onChange?.(job, "running");
    const { runner, store } = job.app;
    let run: Promise<unknown>;
    try {
      run = job.tool
        ? runner.runToolCall(job.sessionId, job.tool.name, job.tool.input, {
            ...job.options(),
            runId: job.runId,
            correlationId: job.correlationId,
            signal: job.controller.signal,
            ...(job.display ? { display: job.display } : {}),
          })
        : runner.run(job.sessionId, job.text, job.controller.signal, {
            ...job.options(),
            runId: job.runId,
            correlationId: job.correlationId,
            ...(job.attachments?.length ? { attachments: job.attachments } : {}),
            ...(job.datasets?.length ? { datasets: job.datasets } : {}),
            ...(job.display ? { display: job.display } : {}),
          });
    } catch (error) {
      run = Promise.reject(error);
    }
    job.done = run.then(
      () => undefined,
      (error: unknown) => {
        // A run that never reached the runner's journal (e.g. the session was claimed) must not
        // stay `queued`; terminal rows are never overwritten.
        store.endRun?.(job.runId, {
          status: job.controller.signal.aborted ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    void job.done.finally(() => {
      this.running--;
      if (this.jobs.get(job.sessionId) === job) this.jobs.delete(job.sessionId);
      this.options.onChange?.(job, "finished");
      this.pump();
    });
  }

  /** The queued or running job of a session. */
  job(sessionId: string): { runId: string; status: "queued" | "running" } | undefined {
    const job = this.jobs.get(sessionId);
    return job ? { runId: job.runId, status: job.status } : undefined;
  }

  /** Whether a session has a job or exclusive work (compaction) in flight. */
  busy(sessionId: string): boolean {
    return this.jobs.has(sessionId) || this.exclusive.has(sessionId);
  }

  compacting(sessionId: string): boolean {
    return this.exclusive.has(sessionId);
  }

  /** Whether any job or exclusive work of a workspace is in flight (blocks eviction). */
  busyWorkspace(workspaceId: string): boolean {
    for (const job of this.jobs.values()) if (job.workspaceId === workspaceId) return true;
    for (const work of this.exclusive.values()) if (work.workspaceId === workspaceId) return true;
    return false;
  }

  /** Tracks exclusive per-session work (e.g. a manual compaction) until it settles. */
  track(
    sessionId: string,
    workspaceId: string,
    work: Promise<unknown>,
    hooks: { abort?: () => void; onDone?: () => void } = {},
  ): void {
    const done = work.catch(() => undefined);
    const onDone = hooks.onDone;
    this.exclusive.set(sessionId, {
      workspaceId,
      done,
      ...(hooks.abort ? { abort: hooks.abort } : {}),
    });
    void done.finally(() => {
      if (this.exclusive.get(sessionId)?.done === done) this.exclusive.delete(sessionId);
      onDone?.();
    });
  }

  /**
   * Cancels the session's job: a queued one is removed and journaled `cancelled`; a running one
   * is aborted (the runner journals it). `runId`, when given, must match.
   */
  cancel(sessionId: string, runId?: string): boolean {
    const job = this.jobs.get(sessionId);
    if (!job || (runId && job.runId !== runId)) return false;
    job.controller.abort(new Error("Cancelled"));
    if (job.status === "queued") {
      this.queue = this.queue.filter((queued) => queued !== job);
      this.jobs.delete(sessionId);
      job.app.store.endRun?.(job.runId, { status: "cancelled", error: "Cancelled" });
      this.options.onChange?.(job, "finished");
    }
    return true;
  }

  counts(): { active: number; queued: number } {
    return { active: this.running + this.exclusive.size, queued: this.queue.length };
  }

  /** Cancels everything and waits (bounded by `ms`) for running work to settle. */
  async shutdown(ms = 3_000): Promise<void> {
    for (const sessionId of [...this.jobs.keys()]) this.cancel(sessionId);
    for (const work of this.exclusive.values()) work.abort?.();
    const pending = [
      ...[...this.jobs.values()].flatMap((job) => (job.done ? [job.done] : [])),
      ...[...this.exclusive.values()].map((work) => work.done),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
