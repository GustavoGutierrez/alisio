/**
 * Retention of analysis data (spec §19): `AnalysisJanitor.sweep()` runs at most once every 24 hours
 * (the mark is `<state>/analysis/.last-sweep`), launched in the background shortly after startup
 * with an unreferenced timer, so it never delays the start nor keeps a process alive.
 *
 *  - `work/` of a job goes after `intermediateDays`; `logs/` and `staging/` after `jobsDays`.
 *  - `script/`, `input/` and `job.json` stay while any artifact of that execution is `ready`
 *    (a rerun needs them); once none is, the whole job folder goes after `jobsDays`.
 *  - With `artifactsDays > 0`, older artifacts become `expired` (folder deleted, row kept).
 *  - Datasets unused for `jobsDays` are deleted with their uploaded original in `blobs/`; an
 *    upload without a dataset (a failed ingestion) goes after the same time.
 *  - `0` disables the deletion of that class. Running executions are never touched.
 *
 * Deletions are best effort and independent: one that fails is counted and the sweep goes on.
 */
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { SqlDatabase } from "@alisio/sdk";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { BlobStore } from "../runtime/blobs.ts";
import type { DatasetService } from "./data/datasets.ts";

const DAY = 86_400_000;
export const SWEEP_INTERVAL_MS = DAY;
/** A lock older than this belongs to a dead process. */
const STALE_LOCK_MS = 60 * 60_000;
/** A job still `running` after this long was left by a crashed process. */
const STALE_RUNNING_MS = DAY;

export interface RetentionPolicy {
  jobsDays: number;
  intermediateDays: number;
  artifactsDays: number;
}

export interface SweepReport {
  /** Why nothing ran: swept less than 24 h ago, or another process is sweeping. */
  skipped?: "recent" | "locked";
  workDeleted: number;
  jobsTrimmed: number;
  jobsDeleted: number;
  artifactsExpired: number;
  datasetsDeleted: number;
  uploadsDeleted: number;
  bytesFreed: number;
  errors: number;
}

const empty = (): SweepReport => ({
  workDeleted: 0,
  jobsTrimmed: 0,
  jobsDeleted: 0,
  artifactsExpired: 0,
  datasetsDeleted: 0,
  uploadsDeleted: 0,
  bytesFreed: 0,
  errors: 0,
});

/** Size in bytes of a file or folder (0 when it does not exist). */
async function sizeOf(path: string): Promise<number> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  for (const entry of await readdir(path).catch(() => [] as string[]))
    total += await sizeOf(join(path, entry));
  return total;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class AnalysisJanitor {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private options: {
      /** State root (`stateHome()` or the folder of `--db`). */
      root: string;
      db: SqlDatabase;
      artifacts: ArtifactStore;
      datasets?: DatasetService;
      blobs?: BlobStore;
      /** Read at every sweep, so a changed setting applies without a restart. */
      retention: () => RetentionPolicy;
      /** The clock (injected in tests). */
      now?: () => number;
      /** Delay before the first background sweep after `start()` (default 30 s). */
      initialDelayMs?: number;
    },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get dir(): string {
    return join(this.options.root, "analysis");
  }

  /** When the last sweep started (epoch ms), if there was one. */
  async lastSweep(): Promise<number | undefined> {
    try {
      const value = Number((await readFile(join(this.dir, ".last-sweep"), "utf8")).trim());
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Launches the sweep in the background; never delays the caller and never keeps Node alive. */
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
        .finally(() => this.arm(SWEEP_INTERVAL_MS));
    }, delay);
    this.timer.unref();
  }

  /** One sweep (see the module comment). `force` ignores the 24 h mark. */
  async sweep(options: { force?: boolean } = {}): Promise<SweepReport> {
    const report = empty();
    const now = this.now();
    const last = await this.lastSweep();
    if (!options.force && last !== undefined && now - last < SWEEP_INTERVAL_MS)
      return { ...report, skipped: "recent" };
    const release = await this.lock();
    if (!release) return { ...report, skipped: "locked" };
    try {
      // The mark is written first: a crash mid-sweep does not make every start retry at once.
      await writeFile(join(this.dir, ".last-sweep"), `${now}\n`);
      const policy = this.options.retention();
      await this.expireArtifacts(policy, now, report);
      await this.trimJobs(policy, now, report);
      await this.dropDatasets(policy, now, report);
    } finally {
      await release();
    }
    return report;
  }

  /** Exclusive lock between processes sharing the state folder; undefined when someone holds it. */
  private async lock(): Promise<(() => Promise<void>) | undefined> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, ".sweep.lock");
    for (let attempt = 0; attempt < 2; attempt++)
      try {
        await writeFile(file, `${process.pid}\n`, { flag: "wx" });
        return () => rm(file, { force: true });
      } catch {
        const info = await stat(file).catch(() => undefined);
        // Real time on purpose: the lock belongs to a live process, not to the injected clock.
        if (info && Date.now() - info.mtimeMs < STALE_LOCK_MS) return undefined;
        await rm(file, { force: true });
      }
    return undefined;
  }

  private async expireArtifacts(policy: RetentionPolicy, now: number, report: SweepReport) {
    if (policy.artifactsDays <= 0) return;
    for (const record of this.options.artifacts.readyBefore(now - policy.artifactsDays * DAY))
      try {
        const bytes = await sizeOf(this.options.artifacts.folder(record));
        if (await this.options.artifacts.markExpired(record.id)) {
          report.artifactsExpired++;
          report.bytesFreed += bytes;
        }
      } catch {
        report.errors++;
      }
  }

  private async trimJobs(policy: RetentionPolicy, now: number, report: SweepReport) {
    if (policy.jobsDays <= 0 && policy.intermediateDays <= 0) return;
    const rows = this.options.db
      .prepare("SELECT id, status, rel_dir, created_at, ended_at FROM analysis_executions")
      .all() as Array<{
      id: string;
      status: string;
      rel_dir: string;
      created_at: number;
      ended_at: number | null;
    }>;
    const ready = this.options.db.prepare(
      "SELECT count(*) AS n FROM artifacts WHERE execution_id=? AND status='ready'",
    );
    for (const row of rows) {
      const stamp = row.ended_at ?? row.created_at;
      if (row.status === "running" && now - row.created_at < STALE_RUNNING_MS) continue;
      const age = now - stamp;
      const folder = join(this.options.root, row.rel_dir);
      // Only folders under analysis/jobs are ever deleted, whatever a row says.
      const inside = relative(join(this.options.root, "analysis", "jobs"), folder);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue;
      if (!(await exists(folder))) continue;
      try {
        if (policy.intermediateDays > 0 && age > policy.intermediateDays * DAY) {
          const target = join(folder, "work");
          if (await exists(target)) {
            report.bytesFreed += await sizeOf(target);
            await rm(target, { recursive: true, force: true });
            report.workDeleted++;
          }
        }
        if (policy.jobsDays > 0 && age > policy.jobsDays * DAY) {
          for (const name of ["logs", "staging"]) {
            const target = join(folder, name);
            if (await exists(target)) {
              report.bytesFreed += await sizeOf(target);
              await rm(target, { recursive: true, force: true });
            }
          }
          const { n } = ready.get(row.id) as { n: number };
          if (n === 0) {
            report.bytesFreed += await sizeOf(folder);
            await rm(folder, { recursive: true, force: true });
            report.jobsDeleted++;
            await this.pruneEmptyParents(folder);
          } else report.jobsTrimmed++;
        }
      } catch {
        report.errors++;
      }
    }
  }

  /** Removes the empty session and workspace folders a deleted job leaves behind. */
  private async pruneEmptyParents(folder: string): Promise<void> {
    const stop = join(this.options.root, "analysis", "jobs");
    let dir = dirname(folder);
    while (dir.startsWith(stop) && dir !== stop)
      try {
        await rmdir(dir);
        dir = dirname(dir);
      } catch {
        return; // not empty (or gone): done
      }
  }

  private async dropDatasets(policy: RetentionPolicy, now: number, report: SweepReport) {
    if (policy.jobsDays <= 0) return;
    const { datasets, blobs } = this.options;
    const cutoff = now - policy.jobsDays * DAY;
    if (datasets)
      for (const record of datasets.all())
        try {
          const info = await stat(datasets.file(record)).catch(() => undefined);
          // The file's modification time moves when the dataset is used (DatasetService.touch).
          const lastUse = info ? Math.max(record.createdAt, info.mtimeMs) : record.createdAt;
          if (lastUse >= cutoff) continue;
          const bytes = info?.size ?? 0;
          await datasets.remove(record);
          report.datasetsDeleted++;
          report.bytesFreed += bytes;
        } catch {
          report.errors++;
        }
    if (!blobs) return;
    // Uploaded originals: those no dataset refers to any more (and failed ingestions) go too.
    const referenced = new Set(
      (
        this.options.db
          .prepare("SELECT blob_hash FROM datasets WHERE blob_hash IS NOT NULL")
          .all() as Array<{ blob_hash: string }>
      ).map((r) => r.blob_hash),
    );
    for (const hash of blobs.uploadsBefore(cutoff))
      try {
        if (referenced.has(hash)) continue;
        const freed = blobs.removeUpload(hash);
        report.uploadsDeleted++;
        report.bytesFreed += freed;
      } catch {
        report.errors++;
      }
  }
}
