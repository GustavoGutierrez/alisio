/**
 * Retention of background tasks: finished tasks (and their logs) older than `retentionDays` are
 * deleted. The pattern is the analysis janitor's: a sweep launched in the background shortly after
 * the start with an unreferenced timer (it never delays the start nor keeps a process alive) and
 * then once a day; `0` disables the deletion. Live tasks are never touched (the query only
 * returns terminal rows), and each deletion is best effort and independent of the others.
 */
import { readdir, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { removeLog, resolveLogPath } from "./output.ts";
import type { BackgroundTaskStore } from "./store.ts";

const DAY = 86_400_000;

export interface TaskSweepReport {
  deleted: number;
  errors: number;
}

export class TaskJanitor {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private options: {
      store: BackgroundTaskStore;
      stateRoot: string;
      /** Read at every sweep, so a changed setting applies without a restart. */
      retentionDays: () => number;
      now?: () => number;
      initialDelayMs?: number;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.arm(this.options.initialDelayMs ?? 30_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sweep()
        .catch(() => undefined)
        .finally(() => this.arm(DAY));
    }, delay);
    this.timer.unref?.();
  }

  async sweep(): Promise<TaskSweepReport> {
    const report: TaskSweepReport = { deleted: 0, errors: 0 };
    const days = this.options.retentionDays();
    if (days <= 0) return report;
    const cutoff = (this.options.now ?? Date.now)() - days * DAY;
    for (const row of this.options.store.endedBefore(cutoff)) {
      try {
        const log = resolveLogPath(this.options.stateRoot, row.logPath);
        await removeLog(log);
        this.options.store.delete(row.id);
        report.deleted++;
        // Drop the session folder once its last log is gone (it fails harmlessly when not empty).
        const folder = dirname(log);
        if (!(await readdir(folder).catch(() => ["."])).length) await rmdir(folder).catch(() => {});
      } catch {
        report.errors++;
      }
    }
    return report;
  }
}
