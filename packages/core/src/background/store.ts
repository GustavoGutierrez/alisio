/**
 * Persistence of background tasks (table `background_tasks`, schema v7). Every state change is a
 * compare-and-set in SQL (`UPDATE … WHERE status IN (…)`), so two actors racing for the same task
 * (the exit of the process, a stop from the user, the watchdog, another Alisio process on the same
 * database) can never move it out of a terminal state or back.
 *
 *   queued ──▶ running ──▶ stopping ──▶ cancelled | failed(timeout)
 *                 └────────▶ succeeded | failed        (the process ended by itself)
 *   queued | running | stopping ──▶ lost                (the owner process is gone: startup only)
 */

import { relative } from "node:path";
import type {
  BackgroundTaskAbortOrigin,
  BackgroundTaskInfo,
  BackgroundTaskKind,
  BackgroundTaskStatus,
  SqlDatabase,
  SqlRow,
} from "@alisio/sdk";
import { inside } from "../runtime/paths.ts";
import { isProcessAlive } from "../runtime/process.ts";

export const LIVE_STATES = [
  "queued",
  "running",
  "stopping",
] as const satisfies readonly BackgroundTaskStatus[];
export const TERMINAL_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "lost",
] as const satisfies readonly BackgroundTaskStatus[];

export const isLive = (status: BackgroundTaskStatus): boolean =>
  (LIVE_STATES as readonly string[]).includes(status);
export const isTerminal = (status: BackgroundTaskStatus): boolean => !isLive(status);

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");

/** One stored task (paths are relative to the state root). */
export interface TaskRow {
  id: string;
  session: string;
  rootSession: string;
  workspace: string;
  kind: BackgroundTaskKind;
  label: string;
  command?: string;
  cwd?: string;
  status: BackgroundTaskStatus;
  exitCode?: number;
  signal?: string;
  errorCode?: string;
  abortOrigin?: BackgroundTaskAbortOrigin;
  pid?: number;
  ownerPid: number;
  timeoutMs?: number;
  logPath: string;
  bytes: number;
  truncated: boolean;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  deliveredAt?: number;
}

export interface NewTask {
  id: string;
  session: string;
  rootSession: string;
  workspace: string;
  label: string;
  command: string;
  cwd: string;
  ownerPid: number;
  timeoutMs: number;
  logPath: string;
  createdAt: number;
}

/** Fields a transition may set together with the new status. */
export interface TransitionPatch {
  exitCode?: number;
  signal?: string;
  errorCode?: string;
  abortOrigin?: BackgroundTaskAbortOrigin;
  startedAt?: number;
  endedAt?: number;
  bytes?: number;
  truncated?: boolean;
}

const num = (value: unknown): number | undefined =>
  value === null || value === undefined ? undefined : Number(value);
const text = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);

export function toRow(r: SqlRow): TaskRow {
  return {
    id: String(r.id),
    session: String(r.session),
    rootSession: String(r.root_session),
    workspace: String(r.workspace),
    kind: r.kind as BackgroundTaskKind,
    label: String(r.label),
    ...(text(r.command) !== undefined ? { command: text(r.command) as string } : {}),
    ...(text(r.cwd) !== undefined ? { cwd: text(r.cwd) as string } : {}),
    status: r.status as BackgroundTaskStatus,
    ...(num(r.exit_code) !== undefined ? { exitCode: num(r.exit_code) as number } : {}),
    ...(text(r.signal) !== undefined ? { signal: text(r.signal) as string } : {}),
    ...(text(r.error_code) !== undefined ? { errorCode: text(r.error_code) as string } : {}),
    ...(text(r.abort_origin) !== undefined
      ? { abortOrigin: r.abort_origin as BackgroundTaskAbortOrigin }
      : {}),
    ...(num(r.pid) !== undefined ? { pid: num(r.pid) as number } : {}),
    ownerPid: Number(r.owner_pid),
    ...(num(r.timeout_ms) !== undefined ? { timeoutMs: num(r.timeout_ms) as number } : {}),
    logPath: String(r.log_path),
    bytes: Number(r.bytes ?? 0),
    truncated: Number(r.truncated ?? 0) === 1,
    createdAt: Number(r.created_at),
    ...(num(r.started_at) !== undefined ? { startedAt: num(r.started_at) as number } : {}),
    ...(num(r.ended_at) !== undefined ? { endedAt: num(r.ended_at) as number } : {}),
    ...(num(r.delivered_at) !== undefined ? { deliveredAt: num(r.delivered_at) as number } : {}),
  };
}

/** The wire view of a row: no log path, the working directory relative to the workspace. */
export function toInfo(
  row: TaskRow,
  live?: { bytes: number; truncated: boolean },
): BackgroundTaskInfo {
  const cwd = row.cwd
    ? inside(row.workspace, row.cwd)
      ? relative(row.workspace, row.cwd) || "."
      : row.cwd
    : undefined;
  const truncated = live?.truncated ?? row.truncated;
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    status: row.status,
    ...(row.command !== undefined ? { command: row.command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
    ...(row.signal !== undefined ? { signal: row.signal } : {}),
    ...(row.errorCode !== undefined ? { errorCode: row.errorCode } : {}),
    ...(row.abortOrigin !== undefined ? { abortOrigin: row.abortOrigin } : {}),
    sessionId: row.session,
    bytes: live?.bytes ?? row.bytes,
    ...(truncated ? { truncated: true } : {}),
    ...(row.pid !== undefined ? { pid: row.pid } : {}),
    ...(row.timeoutMs !== undefined ? { timeoutMs: row.timeoutMs } : {}),
    createdAt: row.createdAt,
    ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
    ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    ...(row.deliveredAt !== undefined ? { delivered: true } : {}),
  };
}

export class BackgroundTaskStore {
  constructor(private db: SqlDatabase) {}

  insert(task: NewTask): TaskRow {
    this.db
      .prepare(
        `INSERT INTO background_tasks(id,session,root_session,workspace,kind,label,command,cwd,status,
           owner_pid,timeout_ms,log_path,bytes,truncated,created_at)
         VALUES(?,?,?,?,'shell',?,?,?,'queued',?,?,?,0,0,?)`,
      )
      .run(
        task.id,
        task.session,
        task.rootSession,
        task.workspace,
        task.label,
        task.command,
        task.cwd,
        task.ownerPid,
        task.timeoutMs,
        task.logPath,
        task.createdAt,
      );
    return this.get(task.id) as TaskRow;
  }

  get(id: string): TaskRow | undefined {
    const row = this.db.prepare("SELECT * FROM background_tasks WHERE id=?").get(id);
    return row ? toRow(row) : undefined;
  }

  /** Newest first. */
  list(
    rootSession: string,
    options: { status?: BackgroundTaskStatus[]; limit?: number } = {},
  ): TaskRow[] {
    const where = options.status?.length ? ` AND status IN (${sqlList(options.status)})` : "";
    return this.db
      .prepare(
        `SELECT * FROM background_tasks WHERE root_session=?${where}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(rootSession, Math.max(1, Math.min(options.limit ?? 100, 500)))
      .map(toRow);
  }

  /**
   * Compare-and-set: moves the task to `to` only while its status is one of `from`. Returns
   * whether this call made the change (a lost race returns false and changes nothing).
   */
  transition(
    id: string,
    from: readonly BackgroundTaskStatus[],
    to: BackgroundTaskStatus,
    patch: TransitionPatch = {},
  ): boolean {
    const sets = ["status=?"];
    const params: Array<string | number | null> = [to];
    const set = (column: string, value: string | number | boolean | undefined) => {
      if (value === undefined) return;
      sets.push(`${column}=?`);
      params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    };
    set("exit_code", patch.exitCode);
    set("signal", patch.signal);
    set("error_code", patch.errorCode);
    set("abort_origin", patch.abortOrigin);
    set("started_at", patch.startedAt);
    set("ended_at", patch.endedAt);
    set("bytes", patch.bytes);
    set("truncated", patch.truncated);
    const result = this.db
      .prepare(
        `UPDATE background_tasks SET ${sets.join(",")} WHERE id=? AND status IN (${sqlList(from)})`,
      )
      .run(...params, id);
    return Number(result.changes) > 0;
  }

  setPid(id: string, pid: number): void {
    this.db.prepare("UPDATE background_tasks SET pid=? WHERE id=?").run(pid, id);
  }

  /** Progress of a live task (bytes written so far); never touches a terminal row's state. */
  setProgress(id: string, bytes: number, truncated: boolean): void {
    this.db
      .prepare("UPDATE background_tasks SET bytes=?, truncated=? WHERE id=?")
      .run(bytes, truncated ? 1 : 0, id);
  }

  /** Marks the end of a task as told to its owner agent; true only for the first claim. */
  claimDelivery(id: string, now: number): boolean {
    const result = this.db
      .prepare("UPDATE background_tasks SET delivered_at=? WHERE id=? AND delivered_at IS NULL")
      .run(now, id);
    return Number(result.changes) > 0;
  }

  /** Undoes a claim whose wake-up did not start (only the claim of `now`). */
  releaseDelivery(id: string, now: number): void {
    this.db
      .prepare("UPDATE background_tasks SET delivered_at=NULL WHERE id=? AND delivered_at=?")
      .run(id, now);
  }

  /**
   * Startup recovery: tasks left queued, running or stopping by an owner process that no longer
   * exists become `lost`. A task of this process (another application of the same server) or of
   * another LIVE Alisio process is never touched.
   */
  markLost(now: number, ownPid: number = process.pid): TaskRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM background_tasks WHERE status IN (${sqlList(LIVE_STATES)})`)
      .all()
      .map(toRow);
    const lost: TaskRow[] = [];
    for (const row of rows) {
      if (row.ownerPid === ownPid || isProcessAlive(row.ownerPid)) continue;
      if (this.transition(row.id, LIVE_STATES, "lost", { endedAt: now }))
        lost.push(this.get(row.id) as TaskRow);
    }
    return lost;
  }

  /** Terminal tasks that ended before `cutoff`. */
  endedBefore(cutoff: number): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM background_tasks WHERE status IN (${sqlList(TERMINAL_STATES)})
         AND COALESCE(ended_at, created_at) < ?`,
      )
      .all(cutoff)
      .map(toRow);
  }

  delete(id: string): void {
    this.db
      .prepare(
        `DELETE FROM background_tasks WHERE id=? AND status IN (${sqlList(TERMINAL_STATES)})`,
      )
      .run(id);
  }
}
