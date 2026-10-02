/**
 * `/tasks` in the terminal: the pure reducer (list, detail, scroll, a stop that asks first, only a
 * live shell task can be stopped) and the `TasksView` panel driven through fake dependencies: it
 * lists tasks, follows the live output by offset (never repeating text), keeps the view bounded,
 * cleans terminal escapes and stops itself when it is no longer on screen.
 */
import type { BackgroundTaskInfo, BackgroundTaskOutput } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import { reloadGuard } from "../packages/cli/src/tui/modes.ts";
import {
  appendKept,
  formatElapsed,
  initialTasksState,
  reduceTasksPanel,
  sanitizeOutput,
  statusText,
  type TasksDeps,
  TasksView,
  taskRow,
  wakeDecision,
} from "../packages/cli/src/tui/tasks.ts";

const task = (over: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo => ({
  id: "task_1",
  kind: "shell",
  label: "build",
  status: "running",
  sessionId: "s",
  bytes: 0,
  createdAt: 1,
  startedAt: 1_000,
  ...over,
});
const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");
const KEY = { up: "\u001b[A", down: "\u001b[B", enter: "\r", escape: "\u001b", home: "\u001b[H" };

describe("pure helpers", () => {
  it("formats elapsed time, status and rows", () => {
    expect(formatElapsed(4_000)).toBe("4 s");
    expect(formatElapsed(125_000)).toBe("2 min 5 s");
    expect(formatElapsed(3_720_000)).toBe("1 h 2 min");
    expect(statusText(task({ status: "failed", exitCode: 2 }))).toBe("failed · exit 2");
    expect(statusText(task({ status: "failed", errorCode: "timeout" }))).toBe(
      "failed · time limit",
    );
    expect(statusText(task({ status: "cancelled", abortOrigin: "user" }))).toBe(
      "stopped · by user",
    );
    expect(statusText(task({ status: "succeeded" }))).toBe("done");
    const row = taskRow(task({ bytes: 4096, endedAt: 6_000, status: "succeeded" }), 9_000, true);
    expect(row).toContain("› build");
    expect(row).toContain("5 s");
    expect(row).toContain("4 KB");
  });

  it("removes terminal escapes and control characters but keeps the text", () => {
    expect(sanitizeOutput("\u001b[31mred\u001b[0m ok\u001b]0;title\u0007\u0007")).toBe("red ok");
    expect(sanitizeOutput("a\rb\nline\r\nend\tx")).toBe("b\nline\nend    x");
    expect(sanitizeOutput("\u001b[2J\u001b[Hclear")).toBe("clear");
  });

  it("keeps the last characters when the buffer is capped", () => {
    expect(appendKept("abc", "def", 4)).toBe("cdef");
    expect(appendKept("abc", "d", 10)).toBe("abcd");
  });

  it("the reload guard refuses while background tasks run", () => {
    const base = { busy: false, runningChildren: 0, queuedPrompts: false };
    expect(reloadGuard({ ...base, backgroundTasks: 2 })).toContain("2 running background tasks");
    expect(reloadGuard({ ...base, backgroundTasks: 1 })).toContain("1 running background task:");
    expect(reloadGuard({ ...base, backgroundTasks: 0 })).toBeUndefined();
  });
});

describe("reduceTasksPanel", () => {
  const tasks = [
    task({ id: "a" }),
    task({ id: "b", status: "succeeded" }),
    task({ id: "c", kind: "subagent" }),
  ];
  const ctx = { tasks, lines: 100, page: 10 };

  it("moves in the list, opens a task and goes back", () => {
    let { state } = reduceTasksPanel(initialTasksState(), { type: "down" }, ctx);
    expect(state.cursor).toBe(1);
    ({ state } = reduceTasksPanel(state, { type: "end" }, ctx));
    expect(state.cursor).toBe(2);
    ({ state } = reduceTasksPanel(state, { type: "down" }, ctx));
    expect(state.cursor).toBe(2);
    const opened = reduceTasksPanel({ ...state, cursor: 0 }, { type: "enter" }, ctx);
    expect(opened.state).toMatchObject({ view: "detail", selected: "a" });
    expect(opened.effect).toEqual({ type: "open", id: "a" });
    const back = reduceTasksPanel(opened.state, { type: "escape" }, ctx);
    expect(back.state.view).toBe("list");
    expect(back.effect).toEqual({ type: "back" });
    expect(reduceTasksPanel(initialTasksState(), { type: "escape" }, ctx).effect).toEqual({
      type: "close",
    });
  });

  it("scrolls the detail and follows the end again with End", () => {
    const open = { view: "detail" as const, cursor: 0, selected: "a" };
    let { state } = reduceTasksPanel(open, { type: "up" }, ctx);
    expect(state.scroll).toBe(89);
    ({ state } = reduceTasksPanel(state, { type: "home" }, ctx));
    expect(state.scroll).toBe(0);
    ({ state } = reduceTasksPanel(state, { type: "pageDown" }, ctx));
    expect(state.scroll).toBe(9);
    ({ state } = reduceTasksPanel(state, { type: "end" }, ctx));
    expect(state.scroll).toBeUndefined();
    // Scrolling down to the end resumes following.
    ({ state } = reduceTasksPanel({ ...open, scroll: 89 }, { type: "down" }, ctx));
    expect(state.scroll).toBeUndefined();
  });

  it("asks before stopping and stops only a live shell task", () => {
    const ask = reduceTasksPanel(initialTasksState(), { type: "stop" }, ctx);
    expect(ask.state.confirm).toBe("a");
    expect(reduceTasksPanel(ask.state, { type: "yes" }, ctx).effect).toEqual({
      type: "stop",
      id: "a",
    });
    expect(reduceTasksPanel(ask.state, { type: "no" }, ctx).state.confirm).toBeUndefined();
    expect(reduceTasksPanel(ask.state, { type: "down" }, ctx).state.confirm).toBeUndefined();
    // Finished task: nothing to stop. Subagent: explained, never stopped.
    expect(
      reduceTasksPanel({ ...initialTasksState(), cursor: 1 }, { type: "stop" }, ctx).state.confirm,
    ).toBeUndefined();
    const sub = reduceTasksPanel({ ...initialTasksState(), cursor: 2 }, { type: "stop" }, ctx);
    expect(sub.state.confirm).toBeUndefined();
    expect(sub.effect).toMatchObject({ type: "notice" });
  });
});

function fixture(initial: BackgroundTaskInfo[], reads: BackgroundTaskOutput[] = []) {
  let tasks = initial;
  const queue = [...reads];
  const readCalls: number[] = [];
  const stopped: string[] = [];
  const notices: string[] = [];
  let renders = 0;
  let closed = false;
  let activeFlag = true;
  const deps: TasksDeps = {
    list: () => tasks,
    read: async (_id, offset) => {
      readCalls.push(offset);
      return queue.shift() ?? { text: "", nextOffset: offset, eof: false, status: "running" };
    },
    stop: async (id) => {
      stopped.push(id);
    },
    rows: () => 20,
    requestRender: () => {
      renders++;
    },
    close: () => {
      closed = true;
    },
    active: () => activeFlag,
    notice: (text) => notices.push(text),
    now: () => 10_000,
  };
  const view = new TasksView(deps);
  return {
    view,
    readCalls,
    stopped,
    notices,
    set tasks(next: BackgroundTaskInfo[]) {
      tasks = next;
    },
    get renders() {
      return renders;
    },
    get closed() {
      return closed;
    },
    deactivate: () => {
      activeFlag = false;
    },
    text: (width = 100) => view.render(width).map(strip).join("\n"),
  };
}
const out = (text: string, nextOffset: number, eof = false): BackgroundTaskOutput => ({
  text,
  nextOffset,
  eof,
  status: eof ? "succeeded" : "running",
});

describe("TasksView", () => {
  it("lists the tasks with a header, the keys and the not-sandboxed reminder", () => {
    const fx = fixture([
      task({ label: "dev server" }),
      task({ id: "t2", label: "tests", status: "succeeded", endedAt: 4_000 }),
    ]);
    const text = fx.text();
    expect(text).toContain("Background tasks · 2 · 1 running");
    expect(text).toContain("› dev server");
    expect(text).toContain("tests  done");
    expect(text).toContain("Tasks end when Alisio exits");
    expect(fixture([]).text()).toContain("No background tasks in this session yet");
  });

  it("opens a task and follows its output by offset, never repeating text", async () => {
    const fx = fixture(
      [task({ command: "npm run dev", cwd: "." })],
      [out("line 1\nline 2\n", 14), out("line 3\n", 21)],
    );
    fx.view.handleInput(KEY.enter);
    await vi.waitFor(() => expect(fx.text()).toContain("line 2"));
    await fx.view.refresh();
    const text = fx.text();
    expect(text).toContain("$ npm run dev");
    expect(text.match(/line 1/g)).toHaveLength(1);
    expect(text).toContain("line 3");
    expect(text).toContain("following");
    expect(text).toContain("s stop");
    // Offsets advanced by what was read.
    expect(fx.readCalls.slice(0, 3)).toEqual([0, 14, 21]);
  });

  it("stops reading once the task ended and everything was read", async () => {
    const fx = fixture([task({ status: "succeeded", endedAt: 2_000 })], [out("done\n", 5, true)]);
    fx.view.handleInput(KEY.enter);
    await vi.waitFor(() => expect(fx.text()).toContain("done"));
    const calls = fx.readCalls.length;
    await fx.view.refresh();
    await fx.view.refresh();
    expect(fx.readCalls).toHaveLength(calls);
    expect(fx.text()).not.toContain("s stop");
  });

  it("scrolling up stops following; the output is bounded to the screen", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n");
    const fx = fixture([task()], [out(`${lines}\n`, lines.length + 1)]);
    fx.view.handleInput(KEY.enter);
    await vi.waitFor(() => expect(fx.text()).toContain("row 60"));
    expect(fx.view.render(100).length).toBeLessThanOrEqual(20);
    expect(fx.text()).not.toContain("row 1\n");
    fx.view.handleInput(KEY.home);
    expect(fx.text()).toContain("row 1");
    expect(fx.text()).not.toContain("following");
  });

  it("stop asks first, then stops through the dependency", async () => {
    const fx = fixture([task()]);
    fx.view.handleInput("s");
    expect(fx.text()).toContain('Stop "build"? y/n');
    fx.view.handleInput("n");
    expect(fx.stopped).toEqual([]);
    fx.view.handleInput("s");
    fx.view.handleInput("y");
    await vi.waitFor(() => expect(fx.stopped).toEqual(["task_1"]));
  });

  it("reports a subagent as read-only instead of stopping it", () => {
    const fx = fixture([task({ id: "x", kind: "subagent", label: "explore" })]);
    fx.view.handleInput("s");
    expect(fx.notices.join(" ")).toContain("agents panel");
    expect(fx.stopped).toEqual([]);
    fx.view.handleInput(KEY.enter);
    expect(fx.text()).toContain("this shows their status only");
  });

  it("Esc and q close the panel and a stale panel stops its own timer", async () => {
    const fx = fixture([task()]);
    fx.view.handleInput(KEY.escape);
    expect(fx.closed).toBe(true);
    const timed = fixture([task()]);
    vi.useFakeTimers();
    try {
      timed.view.start();
      timed.deactivate();
      const before = timed.readCalls.length;
      await vi.advanceTimersByTimeAsync(3_500);
      expect(timed.readCalls.length).toBe(before);
    } finally {
      vi.useRealTimers();
      timed.view.dispose();
    }
  });

  it("shows a read error without breaking the panel", async () => {
    const fx = fixture([task()]);
    const view = new TasksView({
      list: () => [task()],
      read: async () => {
        throw new Error("Background task not found");
      },
      stop: async () => {},
      rows: () => 20,
      requestRender: () => {},
      close: () => {},
      active: () => true,
      notice: () => {},
    });
    view.handleInput(KEY.enter);
    await vi.waitFor(() => expect(view.render(80).map(strip).join("\n")).toContain("not found"));
    void fx;
  });
});

describe("wakeDecision (the TUI side of the finished-task notification)", () => {
  const idle = {
    exiting: false,
    reloading: false,
    busy: false,
    promptPending: false,
    openRoot: "s1",
    ownerRoot: "s1",
  };
  it("starts a run only when the owner session is open and nothing else is going on", () => {
    expect(wakeDecision(idle)).toBe("start");
  });
  it("waits (never drops) while a turn runs, a prompt is pending, a reload runs or another session is open", () => {
    expect(wakeDecision({ ...idle, busy: true })).toBe("busy");
    expect(wakeDecision({ ...idle, promptPending: true })).toBe("busy");
    expect(wakeDecision({ ...idle, reloading: true })).toBe("busy");
    expect(wakeDecision({ ...idle, openRoot: "s2" })).toBe("busy");
  });
  it("gives up only while exiting", () => {
    expect(wakeDecision({ ...idle, exiting: true, busy: true })).toBe("skip");
  });
});
