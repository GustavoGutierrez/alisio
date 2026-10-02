/**
 * `BackgroundTasks`: the runtime behind `bg_run`, `bg_list`, `bg_output` and `bg_stop`, and behind
 * the `/tasks` panels of the TUI and the web.
 *
 * A task is an ordinary child process of Alisio started through the shared process runner
 * (`runProcess`: same shell, same environment allowlist, process-group kill, `taskkill /T /F` on
 * Windows). It is NOT detached and NOT sandboxed: it dies with Alisio. The process group of every
 * live task is killed on an orderly `close()` and, as a last resort, from a synchronous `exit`
 * handler; after an abrupt death of Alisio (SIGKILL, power loss) nothing can run, so the next start
 * marks the leftovers `lost` (by owner pid) without touching them.
 *
 * Every state change is a compare-and-set in the database (see `store.ts`). The origin of an abort
 * is kept apart from its effect: a stop by the user or the model, or a shutdown, ends `cancelled`
 * (never `failed`); the watchdog ends `failed` with the code `timeout`.
 */
import type {
  BackgroundTaskAbortOrigin,
  BackgroundTaskInfo,
  BackgroundTaskOutput,
  BackgroundTaskStatus,
  SqlDatabase,
} from "@alisio/sdk";
import { newId } from "../runtime/ids.ts";
import { killProcessTree, runProcess } from "../runtime/process.ts";
import { type NotifierTiming, TaskNotifier, type TaskWake } from "./notify.ts";
import {
  DEFAULT_READ_BYTES,
  readLog,
  resolveLogPath,
  TaskLogWriter,
  taskLogPath,
} from "./output.ts";
import { BackgroundTaskStore, isTerminal, LIVE_STATES, type TaskRow, toInfo } from "./store.ts";

/** Why a task could not be started. */
export type TaskAdmissionCode =
  | "disabled"
  | "read_only"
  | "shutting_down"
  | "session_limit"
  | "process_limit";
export class TaskAdmissionError extends Error {
  constructor(
    readonly code: TaskAdmissionCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskAdmissionError";
  }
}
/** An unknown task id, or one that belongs to another session tree. */
export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Background task not found: ${id}`);
    this.name = "TaskNotFoundError";
  }
}
/** The task belongs to another live Alisio process: only that process can stop it. */
export class TaskForeignError extends Error {
  constructor(readonly ownerPid: number) {
    super(
      `This task belongs to another Alisio process (pid ${ownerPid}); stop it from that process.`,
    );
    this.name = "TaskForeignError";
  }
}

/** The abort reason of a task: carries WHO asked, so the origin survives to the final state. */
class TaskAbort extends Error {
  constructor(readonly origin: BackgroundTaskAbortOrigin) {
    super(`Background task aborted (${origin})`);
  }
}

export interface TaskLimits {
  enabled: boolean;
  maxPerSession: number;
  maxRunMs: number;
  maxOutputBytes: number;
}

export interface BackgroundTasksOptions {
  db: SqlDatabase;
  /** State root: logs live under `<stateRoot>/tasks/<root session>/`. */
  stateRoot: string;
  /** The root of a session (a child session shares its root's tasks). */
  rootOf: (session: string) => string;
  /** Read live on every call, so a changed setting applies to the next task. */
  limits: () => TaskLimits;
  /** `--read-only`: no task can be started. */
  readOnly?: boolean;
  /** Host hook that starts a run to tell the owner about finished tasks (absent: no wake-ups). */
  wake?: TaskWake;
  /** Whether the session may still be woken (default: always). */
  timing?: Partial<NotifierTiming>;
  /** Live tasks across every application of this process (default 16). */
  maxPerProcess?: number;
  /** SIGTERM → SIGKILL grace of a stop (default 3 s). */
  killGraceMs?: number;
  /** How long `close()` waits for processes to end before killing their groups (default 1.5 s). */
  closeGraceMs?: number;
  /** A task appeared or changed state. */
  onChange?: (task: BackgroundTaskInfo, rootSession: string) => void;
  /** Read-only mirror of other task sources (subagents) for the unified list. */
  mirror?: (rootSession: string) => BackgroundTaskInfo[];
  onError?: (error: unknown) => void;
  now?: () => number;
  /** Owner pid recorded on new rows (tests simulate another process). */
  pid?: number;
}

interface Live {
  id: string;
  root: string;
  session: string;
  controller: AbortController;
  writer: TaskLogWriter;
  origin?: BackgroundTaskAbortOrigin;
  watchdog?: ReturnType<typeof setTimeout>;
  progress?: ReturnType<typeof setInterval>;
  pid?: number;
  done: Promise<void>;
  finish: () => void;
}

const DEFAULT_MAX_PER_PROCESS = 16;
/** Live tasks of every service of this process: the limit per process and the exit handler. */
const PROCESS_LIVE = new Map<string, { pid?: number }>();
let exitHookInstalled = false;
/** Last resort for an `exit` that bypasses `close()`: kill every live task's process group. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const entry of PROCESS_LIVE.values())
      if (entry.pid !== undefined) killProcessTree(entry.pid);
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export class BackgroundTasks {
  readonly store: BackgroundTaskStore;
  private live = new Map<string, Live>();
  private closing = false;
  private notifier: TaskNotifier | undefined;
  private readonly pid: number;

  constructor(private options: BackgroundTasksOptions) {
    this.store = new BackgroundTaskStore(options.db);
    this.pid = options.pid ?? process.pid;
    if (options.wake)
      this.notifier = new TaskNotifier({
        store: this.store,
        wake: options.wake,
        ...(options.timing ? { timing: options.timing } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
      });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Whether finished tasks wake the owner agent in this host (tools say so in their result). */
  get notifies(): boolean {
    return !!this.notifier;
  }

  /** Startup recovery: tasks of a dead owner process become `lost`. */
  recover(): BackgroundTaskInfo[] {
    const lost = this.store.markLost(this.now(), this.pid).map((row) => toInfo(row));
    return lost;
  }

  private emit(row: TaskRow): void {
    try {
      this.options.onChange?.(this.info(row), row.rootSession);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private info(row: TaskRow): BackgroundTaskInfo {
    const live = this.live.get(row.id);
    return toInfo(
      row,
      live ? { bytes: live.writer.bytes, truncated: live.writer.truncated } : undefined,
    );
  }

  /** Starts `command` in the background. Throws `TaskAdmissionError` when it cannot be admitted. */
  start(input: {
    session: string;
    workspace: string;
    command: string;
    /** Absolute working directory (already resolved through the path policy). */
    cwd: string;
    label?: string;
    timeoutMs?: number;
  }): BackgroundTaskInfo {
    const limits = this.options.limits();
    if (this.options.readOnly)
      throw new TaskAdmissionError(
        "read_only",
        "Background tasks are unavailable under --read-only.",
      );
    if (!limits.enabled)
      throw new TaskAdmissionError("disabled", "Background tasks are disabled (tasks.enabled).");
    if (this.closing)
      throw new TaskAdmissionError("shutting_down", "Alisio is shutting down: no new tasks.");
    const root = this.options.rootOf(input.session);
    const mine = [...this.live.values()].filter((live) => live.root === root).length;
    if (mine >= limits.maxPerSession)
      throw new TaskAdmissionError(
        "session_limit",
        `Limit of ${limits.maxPerSession} live background tasks per session reached. Stop one with bg_stop or wait for one to finish.`,
      );
    const processMax = this.options.maxPerProcess ?? DEFAULT_MAX_PER_PROCESS;
    if (PROCESS_LIVE.size >= processMax)
      throw new TaskAdmissionError(
        "process_limit",
        `Limit of ${processMax} live background tasks per Alisio process reached.`,
      );
    const id = newId("task");
    const timeoutMs = Math.max(
      1_000,
      Math.min(input.timeoutMs ?? limits.maxRunMs, limits.maxRunMs),
    );
    const relative = taskLogPath(root, id);
    const logPath = resolveLogPath(this.options.stateRoot, relative);
    const row = this.store.insert({
      id,
      session: input.session,
      rootSession: root,
      workspace: input.workspace,
      label: oneLine(input.label?.trim() || input.command, 80) || "task",
      command: input.command,
      cwd: input.cwd,
      ownerPid: this.pid,
      timeoutMs,
      logPath: relative,
      createdAt: this.now(),
    });
    let writer: TaskLogWriter;
    try {
      writer = new TaskLogWriter(logPath, limits.maxOutputBytes);
    } catch (error) {
      this.store.transition(id, ["queued"], "failed", {
        errorCode: "log_unavailable",
        endedAt: this.now(),
      });
      throw new Error(
        `Cannot create the task log: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const live: Live = {
      id,
      root,
      session: input.session,
      controller: new AbortController(),
      writer,
      done,
      finish,
    };
    this.live.set(id, live);
    PROCESS_LIVE.set(id, {});
    installExitHook();
    this.store.transition(id, ["queued"], "running", { startedAt: this.now() });
    live.watchdog = setTimeout(() => this.requestStop(live, "timeout"), timeoutMs);
    live.watchdog.unref?.();
    live.progress = setInterval(() => {
      this.store.setProgress(id, writer.bytes, writer.truncated);
    }, 1_000);
    live.progress.unref?.();
    void this.run(live, input.command, input.cwd, timeoutMs);
    const started = this.store.get(id) as TaskRow;
    this.emit(started);
    return this.info(started);
  }

  private async run(live: Live, command: string, cwd: string, timeoutMs: number): Promise<void> {
    const windows = process.platform === "win32";
    let outcome:
      | { kind: "exit"; code: number }
      | { kind: "aborted" }
      | { kind: "error"; code: string };
    try {
      const result = await runProcess(
        windows ? "cmd.exe" : "/bin/sh",
        windows ? ["/d", "/s", "/c", command] : ["-c", command],
        {
          cwd,
          signal: live.controller.signal,
          // The watchdog (`requestStop("timeout")`) fires first; this is only a backstop.
          timeoutMs: timeoutMs + 60_000,
          killGraceMs: this.options.killGraceMs ?? 3_000,
          // The output is streamed to the log; the runner keeps almost nothing in memory.
          maxBytes: 4_096,
          onOverflow: "truncate",
          onData: (chunk) => live.writer.append(chunk),
          onSpawn: (pid) => {
            live.pid = pid;
            const entry = PROCESS_LIVE.get(live.id);
            if (entry) entry.pid = pid;
            this.store.setPid(live.id, pid);
          },
        },
      );
      outcome = { kind: "exit", code: result.exitCode };
    } catch (error) {
      if (live.controller.signal.aborted) outcome = { kind: "aborted" };
      else {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        outcome = { kind: "error", code: typeof code === "string" ? code : "error" };
      }
    }
    this.settle(live, outcome);
  }

  /** Final state of a task, exactly once (compare-and-set), then the notification decision. */
  private settle(
    live: Live,
    outcome: { kind: "exit"; code: number } | { kind: "aborted" } | { kind: "error"; code: string },
  ): void {
    if (outcome.kind === "error") live.writer.append(`\n[task could not run: ${outcome.code}]\n`);
    live.writer.finish();
    if (live.watchdog) clearTimeout(live.watchdog);
    if (live.progress) clearInterval(live.progress);
    this.live.delete(live.id);
    PROCESS_LIVE.delete(live.id);
    const current = this.store.get(live.id);
    const origin = live.origin ?? current?.abortOrigin;
    const base = {
      endedAt: this.now(),
      bytes: live.writer.bytes,
      truncated: live.writer.truncated,
    };
    let status: BackgroundTaskStatus;
    let patch: Parameters<BackgroundTaskStore["transition"]>[3];
    // A stop that was requested wins over whatever the process reported: it was asked to die.
    if (origin === "timeout") {
      status = "failed";
      patch = { ...base, errorCode: "timeout", abortOrigin: "timeout" };
    } else if (origin) {
      status = "cancelled";
      patch = {
        ...base,
        abortOrigin: origin,
        ...(outcome.kind === "exit" ? { exitCode: outcome.code } : {}),
      };
    } else if (outcome.kind === "exit") {
      status = outcome.code === 0 ? "succeeded" : "failed";
      patch = { ...base, exitCode: outcome.code };
    } else {
      status = "failed";
      patch = {
        ...base,
        errorCode: outcome.kind === "error" ? "spawn_failed" : "aborted",
      };
    }
    const changed = this.store.transition(live.id, LIVE_STATES, status, patch);
    const row = this.store.get(live.id);
    live.finish();
    if (!row) return;
    if (changed) {
      this.emit(row);
      // Only tasks of root sessions that ended on their own announce themselves.
      if (
        row.session === row.rootSession &&
        (row.abortOrigin === undefined || row.abortOrigin === "timeout") &&
        (row.status === "succeeded" || row.status === "failed")
      )
        this.notifier?.note(row);
    }
  }

  /** Moves a live task to `stopping` (compare-and-set) and aborts it. Idempotent. */
  private requestStop(live: Live, origin: BackgroundTaskAbortOrigin): void {
    if (!live.origin) live.origin = origin;
    const moved = this.store.transition(live.id, ["queued", "running"], "stopping", {
      abortOrigin: live.origin,
    });
    if (moved) {
      const row = this.store.get(live.id);
      if (row) this.emit(row);
    }
    if (!live.controller.signal.aborted) live.controller.abort(new TaskAbort(live.origin));
  }

  private ownRow(rootSession: string, id: string): TaskRow {
    const row = this.store.get(id);
    if (!row || row.rootSession !== rootSession || row.kind !== "shell")
      throw new TaskNotFoundError(id);
    return row;
  }

  /** One task of a root session (its tree), or `TaskNotFoundError`. */
  get(rootSession: string, id: string): BackgroundTaskInfo {
    return this.info(this.ownRow(rootSession, id));
  }

  /** Tasks of a root session, newest first (shell tasks, plus the read-only subagent mirror). */
  list(
    rootSession: string,
    options: { status?: BackgroundTaskStatus[]; limit?: number; mirror?: boolean } = {},
  ): BackgroundTaskInfo[] {
    const shell = this.store
      .list(rootSession, {
        ...(options.status ? { status: options.status } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      })
      .map((row) => this.info(row));
    if (!options.mirror || !this.options.mirror) return shell;
    const mirrored = this.options
      .mirror(rootSession)
      .filter((task) => !options.status?.length || options.status.includes(task.status));
    return [...shell, ...mirrored].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Live (queued, running, stopping) tasks of this service, optionally of one root session. */
  liveCount(rootSession?: string): number {
    if (rootSession === undefined) return this.live.size;
    return [...this.live.values()].filter((live) => live.root === rootSession).length;
  }

  /**
   * Reads the log from `offset`. `reader: "model"` (the `bg_output` tool) also marks a finished
   * task as consumed: the agent has seen that it ended, so it is never announced afterwards.
   */
  async read(
    rootSession: string,
    id: string,
    options: { offset?: number; limit?: number; reader?: "model" | "user" } = {},
  ): Promise<BackgroundTaskOutput> {
    const row = this.ownRow(rootSession, id);
    const result = await readLog(
      resolveLogPath(this.options.stateRoot, row.logPath),
      options.offset ?? 0,
      options.limit ?? DEFAULT_READ_BYTES,
    );
    const live = this.live.get(id);
    const terminal = isTerminal(row.status);
    if (terminal && options.reader === "model") this.markSeen([row.id]);
    return {
      text: result.text,
      nextOffset: result.nextOffset,
      eof: terminal && result.nextOffset >= result.size,
      status: row.status,
      ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
      ...((live?.writer.truncated ?? row.truncated) ? { truncated: true } : {}),
    };
  }

  /** The agent saw that these tasks finished (read or listed them): nothing to announce. */
  markSeen(ids: string[]): void {
    for (const id of ids) {
      const row = this.store.get(id);
      if (row && isTerminal(row.status)) this.store.claimDelivery(id, this.now());
    }
  }

  /**
   * Stops a task. The origin (`user` from a UI, `model` from `bg_stop`) is kept: the task ends
   * `cancelled`, never `failed`. Resolves with the task as it is after the process ended (or after
   * the grace period when it is slow to die). A finished task is returned unchanged.
   */
  async stop(
    rootSession: string,
    id: string,
    origin: "user" | "model",
  ): Promise<BackgroundTaskInfo> {
    const row = this.ownRow(rootSession, id);
    if (isTerminal(row.status)) return this.info(row);
    const live = this.live.get(id);
    if (!live) {
      if (row.ownerPid !== this.pid) throw new TaskForeignError(row.ownerPid);
      // A live row nobody runs (it cannot happen inside one process): close it honestly.
      this.store.transition(id, LIVE_STATES, "cancelled", {
        abortOrigin: origin,
        endedAt: this.now(),
      });
      return this.info(this.store.get(id) as TaskRow);
    }
    this.requestStop(live, origin);
    await Promise.race([live.done, sleep((this.options.killGraceMs ?? 3_000) + 2_000)]);
    return this.info(this.store.get(id) as TaskRow);
  }

  /** The host reports that a session is idle again: a notification held back may go now. */
  sessionIdle(rootSession: string): void {
    this.notifier?.poke(rootSession);
  }

  /** Tasks announced as finished but not yet delivered (tests and diagnostics). */
  pendingNotifications(rootSession: string): number {
    return this.notifier?.pending(rootSession) ?? 0;
  }

  /**
   * Orderly shutdown: refuse new tasks, stop announcing, abort every live task (origin
   * `shutdown`, so they end `cancelled`), wait for the processes and kill the groups of any that
   * ignore SIGTERM. Nothing is left running when it resolves.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.notifier?.dispose();
    const lives = [...this.live.values()];
    for (const live of lives) this.requestStop(live, "shutdown");
    const settled = Promise.allSettled(lives.map((live) => live.done));
    await Promise.race([settled, sleep(this.options.closeGraceMs ?? 1_500)]);
    for (const live of lives)
      if (this.live.has(live.id) && live.pid !== undefined) killProcessTree(live.pid);
    await Promise.race([settled, sleep(1_000)]);
    // Anything still marked live (a process that would not die) is closed as cancelled.
    for (const live of this.live.values()) {
      live.writer.finish();
      if (live.watchdog) clearTimeout(live.watchdog);
      if (live.progress) clearInterval(live.progress);
      this.store.transition(live.id, LIVE_STATES, "cancelled", {
        abortOrigin: "shutdown",
        endedAt: this.now(),
        bytes: live.writer.bytes,
        truncated: live.writer.truncated,
      });
      PROCESS_LIVE.delete(live.id);
      live.finish();
    }
    this.live.clear();
  }
}
