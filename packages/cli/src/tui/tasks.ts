/**
 * `/tasks`: the terminal panel of the session's background tasks. A list (shell tasks started with
 * `bg_run`, plus a read-only mirror of the subagents), a detail view that follows the live output
 * and the user's stop (asked to confirm: the task is not recoverable).
 *
 * The logic is split like the other panels: pure helpers and a reducer (`reduceTasksPanel`), and a
 * thin `TasksView` component that owns the polling. The view never talks to a process: it reads
 * and stops through the `TasksDeps` the app wires to `app.tasks`.
 */
import type { BackgroundTaskInfo, BackgroundTaskOutput } from "@alisio/sdk";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { style } from "./theme.ts";

/** Characters of output kept in memory by the view (the stored log can be much larger). */
export const VIEW_OUTPUT_CAP = 200_000;
const POLL_MS = 1_000;

const LIVE = new Set(["queued", "running", "stopping"]);
export const isLiveTask = (task: Pick<BackgroundTaskInfo, "status">): boolean =>
  LIVE.has(task.status);

/** `3 s`, `2 min 5 s`, `1 h 2 min`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

const STATUS_LABEL: Record<BackgroundTaskInfo["status"], string> = {
  queued: "queued",
  running: "running",
  stopping: "stopping",
  succeeded: "done",
  failed: "failed",
  cancelled: "stopped",
  lost: "lost",
};

/** The status as shown, with the reason when there is one (`failed · time limit`). */
export function statusText(task: BackgroundTaskInfo): string {
  const base = STATUS_LABEL[task.status];
  if (task.errorCode === "timeout") return `${base} · time limit`;
  if (task.status === "failed" && task.exitCode !== undefined)
    return `${base} · exit ${task.exitCode}`;
  if (task.status === "cancelled" && task.abortOrigin)
    return `${base} · by ${task.abortOrigin === "timeout" ? "time limit" : task.abortOrigin}`;
  return base;
}

/** Removes terminal escape sequences and control characters so output cannot move the cursor. */
export function sanitizeOutput(text: string): string {
  return (
    text
      // OSC (title, hyperlinks) up to BEL or ST, then CSI and two-character escapes.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\u001b[@-Z\\-_]/g, "")
      .replace(/\r\n/g, "\n")
      // A carriage return rewrites the line: keep what was written last.
      .replace(/[^\n]*\r(?!\n)/g, "")
      .replace(/\t/g, "    ")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}

/** Appends a chunk to the kept output; older text beyond the cap is dropped. */
export function appendKept(current: string, chunk: string, cap = VIEW_OUTPUT_CAP): string {
  const joined = current + chunk;
  return joined.length > cap ? joined.slice(joined.length - cap) : joined;
}

/** One list row: `label  status  kind  elapsed  size`. */
export function taskRow(task: BackgroundTaskInfo, now: number, selected: boolean): string {
  const ran = task.startedAt ? formatElapsed((task.endedAt ?? now) - task.startedAt) : "";
  const bits = [
    statusText(task),
    task.kind === "subagent" ? "subagent" : "",
    ran,
    task.kind === "shell" && task.bytes ? `${Math.max(1, Math.round(task.bytes / 1024))} KB` : "",
  ].filter(Boolean);
  return `${selected ? "›" : " "} ${task.label}  ${bits.join(" · ")}`;
}

/**
 * Whether the TUI can take the wake-up of a finished background task now. `skip` only while
 * exiting; everything else waits (`busy`) and the core retries: a turn is running, a reload is
 * in progress, a question or approval is on screen, or another session is open (the notification
 * is for the session that started the task and waits until the user is back in it).
 */
export function wakeDecision(state: {
  exiting: boolean;
  reloading: boolean;
  busy: boolean;
  promptPending: boolean;
  openRoot: string;
  ownerRoot: string;
}): "start" | "busy" | "skip" {
  if (state.exiting) return "skip";
  if (state.reloading || state.busy || state.promptPending || state.openRoot !== state.ownerRoot)
    return "busy";
  return "start";
}

export interface TasksPanelState {
  view: "list" | "detail";
  cursor: number;
  /** Detail view: the task shown. */
  selected?: string;
  /** Detail view: first visible output line, or `undefined` while following the end. */
  scroll?: number;
  /** A stop waits for `y`/`n` (the id of the task). */
  confirm?: string;
}
export type TasksAction =
  | { type: "up" | "down" | "pageUp" | "pageDown" | "home" | "end" }
  | { type: "enter" | "escape" | "stop" | "yes" | "no" | "quit" };
export type TasksEffect =
  | { type: "close" }
  | { type: "open"; id: string }
  | { type: "back" }
  | { type: "stop"; id: string }
  | { type: "notice"; text: string };

export const initialTasksState = (): TasksPanelState => ({ view: "list", cursor: 0 });

/**
 * Pure reducer. `tasks` is the current list (newest first), `lines` the number of output lines
 * of the open task and `page` the rows that fit on screen. Only a LIVE SHELL task can be stopped.
 */
export function reduceTasksPanel(
  state: TasksPanelState,
  action: TasksAction,
  context: { tasks: BackgroundTaskInfo[]; lines: number; page: number },
): { state: TasksPanelState; effect?: TasksEffect } {
  const { tasks, lines, page } = context;
  if (state.confirm) {
    if (action.type === "yes")
      return {
        state: { ...state, confirm: undefined },
        effect: { type: "stop", id: state.confirm },
      };
    return { state: { ...state, confirm: undefined } };
  }
  if (action.type === "quit") return { state, effect: { type: "close" } };
  if (state.view === "list") {
    const last = Math.max(0, tasks.length - 1);
    switch (action.type) {
      case "up":
        return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
      case "down":
        return { state: { ...state, cursor: Math.min(last, state.cursor + 1) } };
      case "home":
        return { state: { ...state, cursor: 0 } };
      case "end":
        return { state: { ...state, cursor: last } };
      case "enter": {
        const task = tasks[Math.min(state.cursor, last)];
        if (!task) return { state };
        return {
          state: { ...state, view: "detail", selected: task.id, scroll: undefined },
          effect: { type: "open", id: task.id },
        };
      }
      case "escape":
        return { state, effect: { type: "close" } };
      case "stop": {
        const task = tasks[Math.min(state.cursor, last)];
        if (!task) return { state };
        if (task.kind !== "shell")
          return {
            state,
            effect: { type: "notice", text: "Subagents are managed from the agents panel." },
          };
        return isLiveTask(task) ? { state: { ...state, confirm: task.id } } : { state };
      }
      default:
        return { state };
    }
  }
  // Detail view.
  const maxScroll = Math.max(0, lines - page);
  const current = state.scroll ?? maxScroll;
  const to = (scroll: number): TasksPanelState => ({
    ...state,
    scroll: scroll >= maxScroll ? undefined : Math.max(0, scroll),
  });
  switch (action.type) {
    case "up":
      return { state: to(current - 1) };
    case "down":
      return { state: to(current + 1) };
    case "pageUp":
      return { state: to(current - Math.max(1, page - 1)) };
    case "pageDown":
      return { state: to(current + Math.max(1, page - 1)) };
    case "home":
      return { state: to(0) };
    case "end":
      return { state: { ...state, scroll: undefined } };
    case "escape":
    case "enter":
      return {
        state: { ...state, view: "list", selected: undefined, scroll: undefined },
        effect: { type: "back" },
      };
    case "stop": {
      const task = tasks.find((item) => item.id === state.selected);
      if (!task || task.kind !== "shell" || !isLiveTask(task)) return { state };
      return { state: { ...state, confirm: task.id } };
    }
    default:
      return { state };
  }
}

export interface TasksDeps {
  /** The tasks of the session, newest first. */
  list(): BackgroundTaskInfo[];
  read(id: string, offset: number): Promise<BackgroundTaskOutput>;
  stop(id: string): Promise<unknown>;
  /** Terminal rows available for the panel. */
  rows(): number;
  requestRender(): void;
  /** Closes the panel (the app puts the editor back). */
  close(): void;
  /** Whether this panel is still the one on screen (a stale timer stops itself). */
  active(): boolean;
  notice(text: string): void;
  now?(): number;
}

/** The `/tasks` panel component. */
export class TasksView implements Component {
  private state = initialTasksState();
  private text = "";
  private offset = 0;
  private eof = false;
  private lineCache: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading = false;
  private disposed = false;
  private error: string | undefined;

  constructor(private readonly deps: TasksDeps) {}

  /** Starts the refresh timer (one second): the list and the output of the open task. */
  start(): void {
    this.timer = setInterval(() => {
      if (!this.deps.active()) return this.dispose();
      void this.refresh();
    }, POLL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private selectedTask(): BackgroundTaskInfo | undefined {
    return this.deps.list().find((task) => task.id === this.state.selected);
  }

  private page(): number {
    return Math.max(3, this.deps.rows() - 9);
  }

  private outputLines(): string[] {
    return this.lineCache;
  }

  /** Reads what the open task wrote since the last read, and repaints. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const task = this.selectedTask();
    if (
      this.state.view === "detail" &&
      task &&
      task.kind === "shell" &&
      !this.reading &&
      !this.eof
    ) {
      this.reading = true;
      try {
        // Keep reading while the task fills the buffer faster than one read returns.
        for (let i = 0; i < 8; i++) {
          const out = await this.deps.read(task.id, this.offset);
          if (this.disposed || this.state.selected !== task.id) break;
          this.error = undefined;
          this.offset = out.nextOffset;
          this.eof = out.eof;
          if (out.text) {
            this.text = appendKept(this.text, sanitizeOutput(out.text));
            this.lineCache = this.text.split("\n");
            if (this.lineCache.at(-1) === "") this.lineCache.pop();
          }
          if (!out.text || out.eof) break;
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      } finally {
        this.reading = false;
      }
    }
    this.deps.requestRender();
  }

  private open(): void {
    this.text = "";
    this.lineCache = [];
    this.offset = 0;
    this.eof = false;
    this.error = undefined;
    void this.refresh().catch(() => {});
  }

  handleInput(data: string): void {
    const action = this.actionFor(data);
    if (!action) return;
    const tasks = this.deps.list();
    const { state, effect } = reduceTasksPanel(this.state, action, {
      tasks,
      lines: this.outputLines().length,
      page: this.page(),
    });
    this.state = state;
    if (effect?.type === "close") {
      this.dispose();
      this.deps.close();
      return;
    }
    if (effect?.type === "open") this.open();
    if (effect?.type === "notice") this.deps.notice(effect.text);
    if (effect?.type === "stop")
      void this.deps
        .stop(effect.id)
        .catch((error: unknown) =>
          this.deps.notice(
            `Could not stop the task: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        .finally(() => void this.refresh());
    this.deps.requestRender();
  }

  private actionFor(data: string): TasksAction | undefined {
    if (matchesKey(data, Key.up)) return { type: "up" };
    if (matchesKey(data, Key.down)) return { type: "down" };
    if (matchesKey(data, Key.pageUp)) return { type: "pageUp" };
    if (matchesKey(data, Key.pageDown)) return { type: "pageDown" };
    if (matchesKey(data, Key.home)) return { type: "home" };
    if (matchesKey(data, Key.end)) return { type: "end" };
    if (matchesKey(data, Key.enter)) return { type: "enter" };
    if (matchesKey(data, Key.escape)) return { type: "escape" };
    if (data === "q") return { type: "quit" };
    if (data === "s") return { type: "stop" };
    if (data === "y" || data === "Y") return { type: "yes" };
    if (data === "n" || data === "N") return { type: "no" };
    return undefined;
  }

  render(width: number): string[] {
    const tasks = this.deps.list();
    const now = this.now();
    const fit = (text: string) => truncateToWidth(text, width);
    if (this.state.view === "list") {
      const cursor = Math.min(this.state.cursor, Math.max(0, tasks.length - 1));
      const live = tasks.filter(isLiveTask).length;
      const lines = [
        fit(
          style.bold(
            style.yellow(`Background tasks · ${tasks.length}${live ? ` · ${live} running` : ""}`),
          ),
        ),
      ];
      if (!tasks.length)
        lines.push(
          fit(
            style.dim(
              "  No background tasks in this session yet. The agent starts them with bg_run.",
            ),
          ),
        );
      for (const [index, task] of tasks.entries())
        lines.push(fit(taskRow(task, now, index === cursor)));
      if (this.state.confirm)
        lines.push(
          fit(
            style.yellow(
              `  Stop "${tasks.find((t) => t.id === this.state.confirm)?.label ?? "task"}"? y/n`,
            ),
          ),
        );
      lines.push(
        fit(style.dim("  ↑↓ move · Enter open · s stop · Esc close · Tasks end when Alisio exits")),
      );
      return lines;
    }
    const task = this.selectedTask();
    if (!task) return [fit(style.dim("  This task no longer exists. Esc to go back."))];
    const page = this.page();
    const all = this.outputLines();
    const maxScroll = Math.max(0, all.length - page);
    const first =
      this.state.scroll === undefined ? maxScroll : Math.min(this.state.scroll, maxScroll);
    const shown = all.slice(first, first + page);
    const facts = [
      task.command ? `$ ${task.command}` : "",
      task.kind === "shell" && task.cwd ? `in ${task.cwd}` : "",
    ].filter(Boolean);
    const lines = [
      fit(style.bold(style.yellow(`Task · ${task.label}`)) + style.dim(`  ${statusText(task)}`)),
      ...facts.map((fact) => fit(style.dim(`  ${fact}`))),
      ...(task.kind === "subagent"
        ? [
            fit(
              style.dim(
                "  Subagents are managed from the agents panel; this shows their status only.",
              ),
            ),
          ]
        : this.error
          ? [fit(style.red(`  ${this.error}`))]
          : shown.length
            ? shown.map(fit)
            : [fit(style.dim(isLiveTask(task) ? "  (no output yet)" : "  (no output)"))]),
    ];
    if (task.truncated) lines.push(fit(style.dim("  The stored log was cut at its size limit.")));
    if (this.state.confirm) lines.push(fit(style.yellow(`  Stop this task? y/n`)));
    const position = all.length
      ? `${Math.min(all.length, first + shown.length)}/${all.length}${this.state.scroll === undefined && isLiveTask(task) ? " · following" : ""}`
      : "";
    lines.push(
      fit(
        style.dim(
          `  ${position ? `${position} · ` : ""}↑↓ PgUp/PgDn Home/End · ${isLiveTask(task) && task.kind === "shell" ? "s stop · " : ""}Esc back`,
        ),
      ),
    );
    return lines;
  }
}
