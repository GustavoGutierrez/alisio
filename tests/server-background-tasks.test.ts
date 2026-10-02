/**
 * Background tasks over HTTP: the three routes (auth and Origin like every route, a task is only
 * reachable through its owning session), the `tasks_changed` frame, the finished-task
 * notification that wakes the owner agent through the run scheduler (exactly one run per batch,
 * held back while the session is busy, none after a user stop), recovery of a dead process's
 * tasks at startup and the shutdown that leaves nothing running.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTaskInfo, BackgroundTaskOutput, ProviderEvent } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { alive } from "./background-helpers.ts";
import {
  deferred,
  fakeProvider,
  newSession,
  openStream,
  raw,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const NODE = JSON.stringify(process.execPath);
const LONG = `${NODE} -e "console.log('line 1'); setTimeout(() => console.log('line 2'), 300); setTimeout(() => {}, 60000)"`;
const SHORT = `${NODE} -e "console.log('done-output')"`;
const SHORT_LATER = `${NODE} -e "setTimeout(() => console.log('later-output'), 150)"`;
const TIMING = { batchMs: 40, minIntervalMs: 0, retryMs: 40, burstMax: 100, burstWindowMs: 60_000 };

/** Prompt "start-long" / "start-short" start a task; the wake-up message reads its output. */
function scripted(options: { gate?: () => Promise<void> } = {}) {
  const notifications: string[] = [];
  let calls = 0;
  const provider = fakeProvider(async function* (request): AsyncGenerator<ProviderEvent> {
    const last = request.messages.at(-1);
    const reply = (text: string): ProviderEvent => ({
      type: "completed",
      message: { role: "assistant", text, calls: [] },
    });
    if (last?.role === "user") {
      if (last.text.startsWith("<background-task-notification>")) {
        notifications.push(last.text);
        const id = /id=(\S+)/.exec(last.text)?.[1] ?? "";
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: "",
            calls: [{ id: `out-${++calls}`, name: "bg_output", arguments: JSON.stringify({ id }) }],
          },
        };
        return;
      }
      if (last.text === "start-long" || last.text === "start-short") {
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: "",
            calls: [
              {
                id: `run-${++calls}`,
                name: "bg_run",
                arguments: JSON.stringify({
                  command: last.text === "start-long" ? LONG : SHORT,
                  label: last.text,
                }),
              },
            ],
          },
        };
        return;
      }
      if (last.text === "busy-run") {
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: "",
            calls: [
              {
                id: `run-${++calls}`,
                name: "bg_run",
                arguments: JSON.stringify({ command: SHORT_LATER, label: "later" }),
              },
            ],
          },
        };
        return;
      }
    }
    // After the tool result of `busy-run`: stay busy until the test opens the gate.
    if (last?.role === "tool" && options.gate) {
      await options.gate();
      yield reply("busy done");
      return;
    }
    yield reply("ok");
  });
  return { provider, notifications };
}

async function start(options: Parameters<typeof scripted>[0] = {}) {
  const model = scripted(options);
  t = await startTestServer({
    provider: model.provider,
    app: { allowProcess: true, allowWrite: true },
    tasks: { timing: TIMING, killGraceMs: 300 },
  });
  const session = await newSession(t, { preset: "full-access" });
  return { t, session, ...model };
}
const prompt = (sid: string, text: string) =>
  t?.api.post(`/api/sessions/${sid}/prompts`, {
    requestId: `r${Math.random().toString(36).slice(2, 10)}`,
    text,
  });
const tasksOf = async (sid: string) =>
  (await (t as TestServer).api.get(`/api/sessions/${sid}/tasks`)).json<{
    tasks: BackgroundTaskInfo[];
  }>().tasks;
/** Waits for the first task of a session to exist. */
const firstTask = async (sid: string) =>
  (await until(async () => (await tasksOf(sid))[0])) as BackgroundTaskInfo;
const runsOf = async (sid: string) =>
  (await (t as TestServer).api.get(`/api/sessions/${sid}/runs`)).json<
    Array<{ id: string; status: string; requestId?: string }>
  >();
const idle = async (sid: string) =>
  (await runsOf(sid)).every((r) => r.status !== "queued" && r.status !== "running");

describe("task routes", () => {
  it("lists tasks, reads output by offset and stops one as the user", async () => {
    const { t, session } = await start();
    await prompt(session.id, "start-long");
    const task = await firstTask(session.id);
    expect(task).toMatchObject({ kind: "shell", label: "start-long", status: "running" });
    expect(task).not.toHaveProperty("logPath");
    const base = `/api/sessions/${session.id}/tasks/${task.id}`;
    const first = (await until(async () => {
      const res = (await t.api.get(`${base}/output?offset=0`)).json<BackgroundTaskOutput>();
      return res.text.includes("line 1") ? res : undefined;
    })) as BackgroundTaskOutput;
    expect(first).toMatchObject({ eof: false, status: "running" });
    const second = (await until(async () => {
      const res = (
        await t.api.get(`${base}/output?offset=${first.nextOffset}`)
      ).json<BackgroundTaskOutput>();
      return res.text.includes("line 2") ? res : undefined;
    })) as BackgroundTaskOutput;
    expect(second.text).not.toContain("line 1");
    // `limit` bounds a read.
    const small = (await t.api.get(`${base}/output?offset=0&limit=3`)).json<BackgroundTaskOutput>();
    expect(Buffer.byteLength(small.text)).toBeLessThanOrEqual(3);
    expect((await t.api.get(`${base}/output?offset=-1`)).status).toBe(400);

    const stopped = await t.api.post(`${base}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.json<{ task: BackgroundTaskInfo }>().task).toMatchObject({
      status: "cancelled",
      abortOrigin: "user",
    });
    const after = (
      await t.api.get(`${base}/output?offset=${second.nextOffset}`)
    ).json<BackgroundTaskOutput>();
    expect(after).toMatchObject({ eof: true, status: "cancelled" });
  });

  it("uses the same auth and Origin rules as the rest of the API", async () => {
    const { t, session } = await start();
    await prompt(session.id, "start-long");
    const task = await firstTask(session.id);
    const base = `/api/sessions/${session.id}/tasks`;
    const anonymous = await raw(t.server.port, base);
    expect(anonymous.status).toBe(401);
    expect((await raw(t.server.port, `${base}/${task.id}/output`)).status).toBe(401);
    const foreign = await raw(t.server.port, `${base}/${task.id}/stop`, {
      method: "POST",
      body: {},
      headers: {
        Cookie: t.cookie,
        Origin: "http://evil.example",
        "Content-Type": "application/json",
      },
    });
    expect(foreign.status).toBe(403);
    const notJson = await raw(t.server.port, `${base}/${task.id}/stop`, {
      method: "POST",
      body: "x",
      headers: {
        Cookie: t.cookie,
        Origin: `http://127.0.0.1:${t.server.port}`,
        "Content-Type": "text/plain",
      },
    });
    expect(notJson.status).toBe(415);
    // Nothing above stopped it.
    expect((await tasksOf(session.id))[0]?.status).toBe("running");
  });

  it("a task is reachable only through the session that owns it", async () => {
    const { t, session } = await start();
    await prompt(session.id, "start-long");
    const task = await firstTask(session.id);
    const other = await newSession(t, { preset: "full-access" });
    expect(await tasksOf(other.id)).toEqual([]);
    for (const [method, path] of [
      ["get", `/api/sessions/${other.id}/tasks/${task.id}/output`],
      ["post", `/api/sessions/${other.id}/tasks/${task.id}/stop`],
    ] as const) {
      const res = method === "get" ? await t.api.get(path) : await t.api.post(path, {});
      expect(res.status).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: "task_not_found" } });
    }
    expect((await t.api.get(`/api/sessions/nope/tasks`)).status).toBe(404);
    expect((await tasksOf(session.id))[0]?.status).toBe("running");
  });

  it("publishes tasks_changed frames to the owning session's stream", async () => {
    const { t, session } = await start();
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await prompt(session.id, "start-long");
    const started = await stream.next((e) => e.frame.t === "tasks_changed");
    expect((started.frame as { task: BackgroundTaskInfo }).task).toMatchObject({
      status: "running",
    });
    const id = (started.frame as { task: BackgroundTaskInfo }).task.id;
    await t.api.post(`/api/sessions/${session.id}/tasks/${id}/stop`, {});
    const ended = await stream.next(
      (e) => e.frame.t === "tasks_changed" && e.frame.task.status === "cancelled",
    );
    expect((ended.frame as { sessionId: string }).sessionId).toBe(session.id);
    // A stream of another session does not get them.
    const other = await newSession(t, {});
    const otherStream = openStream(t.server.port, t.cookie, [other.id]);
    await otherStream.next((e) => e.frame.t === "snapshot");
    await prompt(session.id, "start-long");
    await until(async () => (await tasksOf(session.id)).length === 2);
    expect(otherStream.frames().some((f) => f.t === "tasks_changed")).toBe(false);
    stream.close();
    otherStream.close();
  });
});

describe("the finished-task notification", () => {
  it("wakes the owner agent with exactly one run, which can read the output", async () => {
    const { t, session, notifications } = await start();
    await prompt(session.id, "start-short");
    // Run 1 (the prompt) and run 2 (the wake-up) both complete; nothing else follows.
    await until(async () => (await runsOf(session.id)).length === 2 && (await idle(session.id)));
    await new Promise((r) => setTimeout(r, 400));
    const runs = await runsOf(session.id);
    expect(runs).toHaveLength(2);
    expect(notifications).toHaveLength(1);
    const [task] = await tasksOf(session.id);
    expect(task).toMatchObject({ status: "succeeded", exitCode: 0, delivered: true });
    expect(notifications[0]).toContain(`id=${task?.id}`);
    // The wake-up run is idempotent by its batch id.
    expect(runs.some((r) => r.requestId === `bg-${task?.id}`)).toBe(true);
    // The agent could read the output through bg_output (it did, in the wake-up run).
    const messages = (await t.api.get(`/api/sessions/${session.id}/messages?limit=100`)).json<{
      items: Array<{ message: { role: string; text?: string; display?: string } }>;
    }>();
    const wake = messages.items.find((m) =>
      m.message.text?.startsWith("<background-task-notification>"),
    );
    expect(wake?.message.display).toBe("Background task finished: start-short (succeeded)");
  });

  it("holds the notification while the session is busy, then sends it once", async () => {
    const gate = deferred();
    const { t, session, notifications } = await start({ gate: () => gate.promise });
    await prompt(session.id, "busy-run");
    const task = await firstTask(session.id);
    // The task ends while the run that started it is still going.
    await until(async () => (await tasksOf(session.id))[0]?.status === "succeeded");
    expect(task.label).toBe("later");
    await new Promise((r) => setTimeout(r, 500));
    expect(notifications).toHaveLength(0);
    expect(await runsOf(session.id)).toHaveLength(1);
    // Not delivered yet: the claim was released while the session was busy.
    expect((await tasksOf(session.id))[0]?.delivered).toBeFalsy();
    gate.resolve();
    await until(async () => (await runsOf(session.id)).length === 2 && (await idle(session.id)));
    await new Promise((r) => setTimeout(r, 400));
    expect(notifications).toHaveLength(1);
    expect(await runsOf(session.id)).toHaveLength(2);
    expect((await tasksOf(session.id))[0]?.delivered).toBe(true);
    void t;
  });

  it("does not wake the agent for a task the user stopped", async () => {
    const { t, session, notifications } = await start();
    await prompt(session.id, "start-long");
    const task = await firstTask(session.id);
    await until(() => idle(session.id));
    await t.api.post(`/api/sessions/${session.id}/tasks/${task.id}/stop`, {});
    await new Promise((r) => setTimeout(r, 500));
    expect(notifications).toHaveLength(0);
    expect(await runsOf(session.id)).toHaveLength(1);
  });

  it("does not wake an archived session", async () => {
    const { t, session, notifications } = await start();
    await prompt(session.id, "start-long");
    const task = await firstTask(session.id);
    await until(() => idle(session.id));
    expect((await t.api.patch(`/api/sessions/${session.id}`, { archived: true })).status).toBe(200);
    await t.api.post(`/api/sessions/${session.id}/tasks/${task.id}/stop`, {});
    await new Promise((r) => setTimeout(r, 300));
    expect(notifications).toHaveLength(0);
  });
});

describe("lifecycle", () => {
  it("marks the tasks of a dead process lost when the server starts, and keeps live ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-server-bg-"));
    await mkdir(join(root, "state"), { recursive: true });
    const db = join(root, "state", "sessions.sqlite");
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => dead.once("exit", resolve));
    const workspace = join(root, "ws");
    await mkdir(workspace);
    const seed = new SQLiteStore(db);
    const session = seed.create(workspace, "fake", "fake-model").id;
    const row = (id: string, pid: number) =>
      seed.db
        .prepare(
          `INSERT INTO background_tasks(id,session,root_session,workspace,kind,label,status,owner_pid,log_path,created_at)
           VALUES(?,?,?,?,'shell','x','running',?,?,1)`,
        )
        .run(id, session, session, workspace, pid, `tasks/${session}/${id}.log`);
    row("orphan", dead.pid as number);
    row("other-live", process.ppid);
    seed.close();
    await writeFile(join(root, "marker"), "");
    t = await startTestServer({ app: { db, allowProcess: true } });
    const tasks = await tasksOf(session);
    expect(tasks.find((x) => x.id === "orphan")?.status).toBe("lost");
    expect(tasks.find((x) => x.id === "other-live")?.status).toBe("running");
  });

  it("refuses /reload while background tasks run, and closing the server kills them", async () => {
    const { t: running, session } = await start();
    await prompt(session.id, "start-long");
    const task = await firstTask(session.id);
    await until(() => idle(session.id));
    const wid = (await running.api.get(`/api/sessions/${session.id}`)).json<{
      workspaceId: string;
    }>().workspaceId;
    const reload = await running.api.post(`/api/workspaces/${wid}/reload`, {});
    expect(reload.status).toBe(409);
    expect(reload.text).toContain("background tasks");
    const pid = task.pid as number;
    expect(alive(pid)).toBe(true);
    await running.close();
    t = undefined;
    expect(alive(pid)).toBe(false);
  });
});
