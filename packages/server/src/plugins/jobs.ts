/**
 * In-memory install jobs: a local-file install runs in the background and the browser polls its
 * phase list. Jobs expire 10 minutes after they finish (or start, if they never do).
 */
import { randomUUID } from "node:crypto";

export type PhaseId =
  | "uploading"
  | "validating"
  | "copying"
  | "installing"
  | "registering"
  | "reloading"
  | "cleanup";

export const INSTALL_PHASES: readonly PhaseId[] = [
  "uploading",
  "validating",
  "copying",
  "installing",
  "registering",
  "reloading",
  "cleanup",
];

export type PhaseStatus = "pending" | "running" | "done" | "failed";

/** `GET /api/plugins/jobs/:jobId`. */
export interface JobView {
  phase?: PhaseId;
  phases: Array<{ id: PhaseId; status: PhaseStatus }>;
  done: boolean;
  error?: string;
  result?: unknown;
  logTail?: string;
}

export const JOB_TTL_MS = 10 * 60 * 1000;

export class InstallJob {
  private status = new Map<PhaseId, PhaseStatus>(INSTALL_PHASES.map((id) => [id, "pending"]));
  private current: PhaseId | undefined;
  private finished = false;
  private failure: { error: string; logTail?: string } | undefined;
  private outcome: unknown;
  touched: number;

  constructor(
    readonly id: string,
    now: number,
  ) {
    this.touched = now;
  }

  /** Marks the running phase done and `phase` running. */
  start(phase: PhaseId, now = Date.now()): void {
    if (this.current && this.status.get(this.current) === "running")
      this.status.set(this.current, "done");
    // Phases skipped over (the core does not report "uploading") count as done.
    for (const id of INSTALL_PHASES) {
      if (id === phase) break;
      if (this.status.get(id) === "pending") this.status.set(id, "done");
    }
    this.status.set(phase, "running");
    this.current = phase;
    this.touched = now;
  }

  succeed(result: unknown, now = Date.now()): void {
    for (const id of INSTALL_PHASES) this.status.set(id, "done");
    this.finished = true;
    this.outcome = result;
    this.touched = now;
  }

  /** `detail` (optional) is kept as the failed job's `result` (e.g. `activationError`). */
  fail(error: string, logTail?: string, now = Date.now(), detail?: unknown): void {
    if (this.current) this.status.set(this.current, "failed");
    this.finished = true;
    this.failure = { error, ...(logTail ? { logTail } : {}) };
    if (detail !== undefined) this.outcome = detail;
    this.touched = now;
  }

  get done(): boolean {
    return this.finished;
  }

  view(): JobView {
    return {
      ...(this.current ? { phase: this.current } : {}),
      phases: INSTALL_PHASES.map((id) => ({ id, status: this.status.get(id) ?? "pending" })),
      done: this.finished,
      ...(this.failure ? this.failure : {}),
      ...(this.finished && this.outcome !== undefined ? { result: this.outcome } : {}),
    };
  }
}

export class InstallJobs {
  private jobs = new Map<string, InstallJob>();
  constructor(
    private ttlMs = JOB_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  create(): InstallJob {
    this.sweep();
    const job = new InstallJob(randomUUID(), this.now());
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): InstallJob | undefined {
    this.sweep();
    return this.jobs.get(id);
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, job] of this.jobs) if (job.done && job.touched < cutoff) this.jobs.delete(id);
  }
}
