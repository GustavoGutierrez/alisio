/**
 * Web side of the background tasks (Phase 3): the pure list/output helpers, the tasks store driven
 * through a fake API (list, live frames, a toast only for a task that ended on its own, output
 * followed by offset, the user's stop), EN/ES strings and the lazy loading that keeps the initial
 * bundle inside its budget.
 */
import { readFileSync } from "node:fs";
import type { BackgroundTaskInfo, BackgroundTaskOutput } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskStrings } from "../packages/web/src/components/tasks/strings.ts";
import { en } from "../packages/web/src/i18n/en.ts";
import { es } from "../packages/web/src/i18n/es.ts";
import { api, currentId, toast } from "../packages/web/src/store/app.ts";
import { liveTasks } from "../packages/web/src/store/dock.ts";
import {
  appendOutput,
  endedOnItsOwn,
  isLiveTask,
  leaveTasks,
  liveCount,
  loadTasks,
  OUTPUT_CAP,
  outputState,
  receiveTask,
  selectedTask,
  selectTask,
  stopTask,
  tasksState,
  upsertTask,
} from "../packages/web/src/store/tasks.ts";

const task = (over: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({
  id: "t1",
  kind: "shell",
  label: "dev server",
  status: "running",
  sessionId: "s1",
  bytes: 0,
  createdAt: 100,
  ...over,
});

describe("pure helpers", () => {
  it("keeps the list newest first and replaces by id", () => {
    let list: BackgroundTaskInfo[] = [];
    list = upsertTask(list, task({ id: "a", createdAt: 1 }));
    list = upsertTask(list, task({ id: "b", createdAt: 3 }));
    list = upsertTask(list, task({ id: "c", createdAt: 2 }));
    expect(list.map((t) => t.id)).toEqual(["b", "c", "a"]);
    list = upsertTask(list, task({ id: "c", createdAt: 2, status: "succeeded" }));
    expect(list).toHaveLength(3);
    expect(list.find((t) => t.id === "c")?.status).toBe("succeeded");
    expect(liveCount(list)).toBe(2);
    expect(isLiveTask(task({ status: "stopping" }))).toBe(true);
    expect(isLiveTask(task({ status: "lost" }))).toBe(false);
  });

  it("toasts only a task that was live and ended on its own", () => {
    const running = task();
    expect(endedOnItsOwn(running, task({ status: "succeeded" }))).toBe(true);
    expect(
      endedOnItsOwn(
        running,
        task({ status: "failed", errorCode: "timeout", abortOrigin: "timeout" }),
      ),
    ).toBe(true);
    expect(endedOnItsOwn(running, task({ status: "cancelled", abortOrigin: "user" }))).toBe(false);
    expect(endedOnItsOwn(running, task({ status: "cancelled", abortOrigin: "model" }))).toBe(false);
    expect(endedOnItsOwn(running, task({ status: "lost" }))).toBe(false);
    expect(endedOnItsOwn(running, task({ status: "stopping" }))).toBe(false);
    // A task never seen live (missed frames, a list load) does not toast.
    expect(endedOnItsOwn(undefined, task({ status: "succeeded" }))).toBe(false);
    expect(endedOnItsOwn(task({ status: "succeeded" }), task({ status: "succeeded" }))).toBe(false);
  });

  it("keeps the last characters of a long output and says it trimmed", () => {
    expect(appendOutput("ab", "cd")).toEqual({ text: "abcd", trimmed: false });
    expect(appendOutput("abc", "def", 4)).toEqual({ text: "cdef", trimmed: true });
    expect(OUTPUT_CAP).toBeGreaterThan(10_000);
  });
});

describe("the tasks store", () => {
  const original = { tasks: api.tasks, output: api.taskOutput, stop: api.stopTask };
  let outputs: BackgroundTaskOutput[];
  let readOffsets: number[];
  let stopped: string[];
  let listed: BackgroundTaskInfo[];

  beforeEach(() => {
    vi.useFakeTimers();
    outputs = [];
    readOffsets = [];
    stopped = [];
    listed = [];
    currentId.value = "s1";
    toast.value = undefined;
    liveTasks.value = 0;
    tasksState.value = { items: [], loading: false };
    selectedTask.value = undefined;
    outputState.value = undefined;
    api.tasks = (async () => ({ tasks: listed })) as typeof api.tasks;
    api.taskOutput = (async (_sid: string, _tid: string, offset: number) => {
      readOffsets.push(offset);
      return outputs.shift() ?? { text: "", nextOffset: offset, eof: false, status: "running" };
    }) as typeof api.taskOutput;
    api.stopTask = (async (_sid: string, id: string) => {
      stopped.push(id);
      return { task: task({ id, status: "cancelled", abortOrigin: "user" }) };
    }) as typeof api.stopTask;
  });
  afterEach(() => {
    leaveTasks();
    vi.useRealTimers();
    api.tasks = original.tasks;
    api.taskOutput = original.output;
    api.stopTask = original.stop;
    currentId.value = undefined;
    toast.value = undefined;
  });

  it("loads the list of the open session and counts the live tasks", async () => {
    listed = [task({ id: "a" }), task({ id: "b", status: "succeeded", createdAt: 50 })];
    await loadTasks("s1");
    expect(tasksState.value.items.map((t) => t.id)).toEqual(["a", "b"]);
    expect(liveTasks.value).toBe(1);
    expect(tasksState.value.error).toBeUndefined();
  });

  it("an API failure shows an error state, not an empty list", async () => {
    api.tasks = (async () => {
      throw new Error("boom");
    }) as typeof api.tasks;
    await loadTasks("s1");
    expect(tasksState.value.error).toBe(true);
    expect(tasksState.value.loading).toBe(false);
  });

  it("applies live frames: adds the task and toasts only when it ends on its own", async () => {
    listed = [];
    await loadTasks("s1");
    receiveTask("s1", task());
    expect(liveTasks.value).toBe(1);
    expect(toast.value).toBeUndefined();
    receiveTask("s1", task({ status: "succeeded", exitCode: 0, endedAt: 5 }));
    expect(liveTasks.value).toBe(0);
    expect(toast.value).toContain("dev server");
    // A user's stop does not toast.
    toast.value = undefined;
    receiveTask("s1", task({ id: "t2", createdAt: 200 }));
    receiveTask("s1", task({ id: "t2", createdAt: 200, status: "stopping", abortOrigin: "user" }));
    receiveTask("s1", task({ id: "t2", createdAt: 200, status: "cancelled", abortOrigin: "user" }));
    expect(toast.value).toBeUndefined();
  });

  it("ignores frames of another session", async () => {
    await loadTasks("s1");
    receiveTask("other", task({ id: "x" }));
    expect(tasksState.value.items).toEqual([]);
    expect(liveTasks.value).toBe(0);
  });

  it("follows the output by offset and stops reading at the end", async () => {
    listed = [task({ id: "t1" })];
    await loadTasks("s1");
    outputs = [
      { text: "one\n", nextOffset: 4, eof: false, status: "running" },
      { text: "two\n", nextOffset: 8, eof: true, status: "succeeded" },
    ];
    selectTask("t1");
    await vi.advanceTimersByTimeAsync(0);
    expect(outputState.value).toMatchObject({ taskId: "t1", text: "one\n", offset: 4, eof: false });
    // A full read is followed by another one at once (more may be waiting).
    await vi.advanceTimersByTimeAsync(150);
    expect(outputState.value).toMatchObject({ text: "one\ntwo\n", offset: 8, eof: true });
    expect(readOffsets).toEqual([0, 4]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readOffsets).toEqual([0, 4]);
  });

  it("keeps polling a running task on the timer and stops when the view is left", async () => {
    listed = [task({ id: "t1" })];
    await loadTasks("s1");
    selectTask("t1");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(readOffsets.length).toBeGreaterThanOrEqual(3);
    const reads = readOffsets.length;
    leaveTasks();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(readOffsets).toHaveLength(reads);
  });

  it("a subagent has no output to read", async () => {
    listed = [task({ id: "sub", kind: "subagent" })];
    await loadTasks("s1");
    selectTask("sub");
    expect(outputState.value).toBeUndefined();
    expect(readOffsets).toEqual([]);
  });

  it("the Stop button asks the server once and shows the task as stopped", async () => {
    listed = [task({ id: "t1" })];
    await loadTasks("s1");
    await Promise.all([stopTask("t1"), stopTask("t1")]);
    expect(stopped).toEqual(["t1"]);
    expect(tasksState.value.items[0]).toMatchObject({ status: "cancelled", abortOrigin: "user" });
    expect(liveTasks.value).toBe(0);
  });

  it("a failed stop is reported", async () => {
    listed = [task({ id: "t1" })];
    await loadTasks("s1");
    api.stopTask = (async () => {
      throw new Error("owned by another process");
    }) as typeof api.stopTask;
    await stopTask("t1");
    expect(toast.value).toContain("owned by another process");
    expect(tasksState.value.items[0]?.status).toBe("running");
  });
});

describe("strings and loading", () => {
  it("has every Tasks string in English and Spanish, translated", () => {
    const keys = Object.keys(taskStrings.en) as Array<keyof typeof taskStrings.en>;
    expect(Object.keys(taskStrings.es).sort()).toEqual([...keys].sort());
    const same = ["bytes"];
    for (const key of keys) {
      expect(taskStrings.en[key], `en ${key}`).toBeTruthy();
      expect(taskStrings.es[key], `es ${key}`).toBeTruthy();
      if (!same.includes(key))
        expect(taskStrings.es[key], `es differs ${key}`).not.toBe(taskStrings.en[key]);
    }
    for (const key of ["dock.tasks", "dock.tasksLive"] as const) {
      expect(en[key]).toBeTruthy();
      expect(es[key]).toBeTruthy();
      expect(es[key]).not.toBe(en[key]);
    }
  });

  it("keeps the panel, its store and its strings out of the initial bundle", () => {
    const dock = readFileSync("packages/web/src/components/dock/Dock.tsx", "utf8");
    expect(dock).not.toMatch(/^import .*TasksTab/m);
    expect(dock).toMatch(/import\("\.\.\/tasks\/TasksTab\.tsx"\)/);
    const app = readFileSync("packages/web/src/store/app.ts", "utf8");
    expect(app).not.toMatch(/^import .*from "\.\/tasks\.ts"/m);
    expect(app).toMatch(/import\("\.\/tasks\.ts"\)/);
    for (const file of [
      "packages/web/src/components/dock/Dock.tsx",
      "packages/web/src/components/header/Header.tsx",
      "packages/web/src/app.tsx",
    ])
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /from "\.\.\/tasks\/strings\.ts"|from "\.\/components\/tasks\/strings\.ts"/,
      );
  });
});
