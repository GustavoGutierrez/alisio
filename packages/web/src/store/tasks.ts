/**
 * Background tasks of the open session (the Dock's Tasks tab). Signals plus the pure helpers the
 * tests exercise. The module is its own chunk: `store/app.ts` imports it on demand (when a session
 * opens or the first `tasks_changed` frame arrives), so none of this is in the initial bundle.
 *
 * Output is pulled incrementally by offset (`GET …/tasks/:tid/output?offset=`), like the model's
 * `bg_output`: the client keeps its own offset and a bounded copy of the text.
 */
import type { BackgroundTaskInfo, BackgroundTaskStatus } from "@alisio/sdk";
import { signal } from "@preact/signals";
import { tk } from "../components/tasks/strings.ts";
import { api, currentId, showToast } from "./app.ts";
import { liveTasks } from "./dock.ts";

const LIVE: ReadonlySet<BackgroundTaskStatus> = new Set(["queued", "running", "stopping"]);
export const isLiveTask = (task: Pick<BackgroundTaskInfo, "status">): boolean =>
  LIVE.has(task.status);

/** Characters of output the tab keeps (the stored log can be far larger). */
export const OUTPUT_CAP = 200_000;
const POLL_MS = 1_000;
const POLL_HIDDEN_MS = 4_000;

/** Replaces (or adds) a task and keeps the list newest first. */
export function upsertTask(
  list: BackgroundTaskInfo[],
  task: BackgroundTaskInfo,
): BackgroundTaskInfo[] {
  const next = list.some((item) => item.id === task.id)
    ? list.map((item) => (item.id === task.id ? task : item))
    : [task, ...list];
  return next.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

export const liveCount = (list: BackgroundTaskInfo[]): number => list.filter(isLiveTask).length;

/** Appends a chunk to the kept output; `trimmed` says that older text was dropped. */
export function appendOutput(
  current: string,
  chunk: string,
  cap = OUTPUT_CAP,
): { text: string; trimmed: boolean } {
  const joined = current + chunk;
  return joined.length > cap
    ? { text: joined.slice(joined.length - cap), trimmed: true }
    : { text: joined, trimmed: false };
}

/**
 * Whether a change deserves a toast: a task that was live and ended on its own (success, failure
 * or the time limit). A task the user or the agent stopped, or one that died with Alisio, does not.
 */
export function endedOnItsOwn(
  before: BackgroundTaskInfo | undefined,
  next: BackgroundTaskInfo,
): boolean {
  if (!before || !isLiveTask(before) || isLiveTask(next)) return false;
  if (next.status !== "succeeded" && next.status !== "failed") return false;
  return next.abortOrigin === undefined || next.abortOrigin === "timeout";
}

export interface TasksState {
  sessionId?: string;
  items: BackgroundTaskInfo[];
  loading: boolean;
  error?: boolean;
}
export interface OutputState {
  taskId: string;
  text: string;
  offset: number;
  eof: boolean;
  trimmed: boolean;
  loading: boolean;
  error?: string;
}

export const tasksState = signal<TasksState>({ items: [], loading: false });
export const selectedTask = signal<string | undefined>(undefined);
export const outputState = signal<OutputState | undefined>(undefined);
export const stopping = signal<Set<string>>(new Set());

let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

function setItems(sessionId: string, items: BackgroundTaskInfo[]): void {
  tasksState.value = { sessionId, items, loading: false };
  liveTasks.value = liveCount(items);
}

/** Loads the task list of a session (resets the tab when the session changed). */
export async function loadTasks(sessionId: string): Promise<void> {
  if (tasksState.peek().sessionId !== sessionId) {
    stopPolling();
    selectedTask.value = undefined;
    outputState.value = undefined;
    tasksState.value = { sessionId, items: [], loading: true };
  } else tasksState.value = { ...tasksState.peek(), loading: true };
  try {
    const { tasks } = await api.tasks(sessionId);
    if (currentId.value !== sessionId) return;
    setItems(sessionId, tasks);
  } catch {
    if (currentId.value === sessionId)
      tasksState.value = { ...tasksState.peek(), loading: false, error: true };
  }
}

/** A `tasks_changed` frame: update the list, toast an end on its own and refresh the output. */
export function receiveTask(sessionId: string, task: BackgroundTaskInfo): void {
  if (sessionId !== currentId.value) return;
  const state = tasksState.peek();
  if (state.sessionId !== sessionId) {
    void loadTasks(sessionId);
    return;
  }
  const before = state.items.find((item) => item.id === task.id);
  setItems(sessionId, upsertTask(state.items, task));
  if (endedOnItsOwn(before, task))
    showToast(tk("finished", { label: task.label, status: tk(`status.${task.status}`) }));
  if (selectedTask.peek() === task.id) void poll(sessionId, task.id, generation);
}

function stopPolling(): void {
  generation++;
  if (timer) clearTimeout(timer);
  timer = undefined;
}

async function poll(sessionId: string, taskId: string, mine: number): Promise<void> {
  if (mine !== generation) return;
  if (timer) clearTimeout(timer);
  timer = undefined;
  const before = outputState.peek();
  if (!before || before.taskId !== taskId) return;
  try {
    const out = await api.taskOutput(sessionId, taskId, before.offset);
    if (mine !== generation) return;
    const current = outputState.peek();
    if (!current || current.taskId !== taskId) return;
    const joined = appendOutput(current.text, out.text);
    outputState.value = {
      ...current,
      text: joined.text,
      offset: out.nextOffset,
      eof: out.eof,
      trimmed: current.trimmed || joined.trimmed,
      loading: false,
    };
    if (out.eof) return;
    // More may be waiting: read again at once when this read was full, otherwise on the timer.
    timer = setTimeout(
      () => void poll(sessionId, taskId, mine),
      out.text
        ? 100
        : typeof document !== "undefined" && document.hidden
          ? POLL_HIDDEN_MS
          : POLL_MS,
    );
  } catch (error) {
    if (mine !== generation) return;
    const current = outputState.peek();
    if (current?.taskId === taskId)
      outputState.value = {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      };
  }
}

/** Opens a task (or goes back to the list with `undefined`) and follows its output. */
export function selectTask(taskId: string | undefined): void {
  stopPolling();
  selectedTask.value = taskId;
  const sessionId = tasksState.peek().sessionId;
  const task = tasksState.peek().items.find((item) => item.id === taskId);
  if (!taskId || !sessionId || !task || task.kind !== "shell") {
    outputState.value = undefined;
    return;
  }
  outputState.value = {
    taskId,
    text: "",
    offset: 0,
    eof: false,
    trimmed: false,
    loading: true,
  };
  void poll(sessionId, taskId, generation);
}

/** Stops following (the tab closed): a running poll never outlives the view. */
export function leaveTasks(): void {
  stopPolling();
}

/** The Stop button: the user's stop (the task ends `cancelled`). */
export async function stopTask(taskId: string): Promise<void> {
  const sessionId = tasksState.peek().sessionId;
  if (!sessionId || stopping.peek().has(taskId)) return;
  stopping.value = new Set(stopping.peek()).add(taskId);
  try {
    const { task } = await api.stopTask(sessionId, taskId);
    const state = tasksState.peek();
    if (state.sessionId === sessionId) setItems(sessionId, upsertTask(state.items, task));
    if (selectedTask.peek() === taskId) void poll(sessionId, taskId, generation);
  } catch (error) {
    showToast(tk("stopFailed", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    const next = new Set(stopping.peek());
    next.delete(taskId);
    stopping.value = next;
  }
}
