/**
 * Background tasks wired into the Application: tools registered unless disabled, live settings,
 * the project layer unable to shorten the retention, recovery of a dead owner's tasks at start,
 * the retention sweep, the read-only mirror of subagents and the shutdown on `app.close()`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskJanitor } from "../packages/core/src/background/janitor.ts";
import { subagentTasks } from "../packages/core/src/background/mirror.ts";
import { BackgroundTaskStore } from "../packages/core/src/background/store.ts";
import { createApplication } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { alive, sleep, waitFor } from "./background-helpers.ts";

let root: string;
let workspace: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-bg-app-"));
  workspace = join(root, "ws");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const silent: ModelProvider = {
  id: "fake-provider",
  model: "fake-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
};
const dbPath = () => join(root, "state", "sessions.sqlite");
async function app(options: Parameters<typeof createApplication>[0] = {}) {
  const created = await createApplication({
    cwd: workspace,
    db: dbPath(),
    noHerdr: true,
    provider: silent,
    ...options,
  });
  apps.push(created);
  return created;
}
const write = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2));
const SLEEP = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 60000)"`;

describe("registration and settings", () => {
  it("registers the four tools, with the process effect, unless tasks.enabled is false", async () => {
    const a = await app();
    const tools = a.registry.list().filter((t) => t.name.startsWith("bg_"));
    expect(tools.map((t) => t.name).sort()).toEqual(["bg_list", "bg_output", "bg_run", "bg_stop"]);
    expect(tools.every((t) => t.effect === "process")).toBe(true);
    await write(join(root, "config", "config.json"), { tasks: { enabled: false } });
    const off = await app();
    expect(off.registry.list().some((t) => t.name.startsWith("bg_"))).toBe(false);
  });

  it("applies the limits live and persists them", async () => {
    const a = await app();
    await a.updateSetting("tasks.maxPerSession", 1);
    await a.updateSetting("tasks.maxRunMs", 5_000);
    expect(a.config.tasks).toMatchObject({ maxPerSession: 1, maxRunMs: 5_000 });
    const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
    const first = a.tasks.start({ session, workspace, cwd: workspace, command: SLEEP });
    expect(first.timeoutMs).toBe(5_000);
    expect(() => a.tasks.start({ session, workspace, cwd: workspace, command: SLEEP })).toThrow(
      /Limit of 1/,
    );
    await a.updateSetting("tasks.maxPerSession", 2);
    const second = a.tasks.start({ session, workspace, cwd: workspace, command: SLEEP });
    expect(second.status).toBe("running");
    await expect(a.updateSetting("tasks.maxPerSession", 0)).rejects.toThrow(/Invalid value/);
  });

  it("refuses to change a task setting under --read-only and starts nothing", async () => {
    const a = await app({ readOnly: true });
    await expect(a.updateSetting("tasks.maxRunMs", 5000)).rejects.toThrow(/read-only/);
    const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
    expect(() => a.tasks.start({ session, workspace, cwd: workspace, command: SLEEP })).toThrow(
      /read-only/,
    );
  });

  it("a trusted project layer sets the limits but cannot shorten the retention", async () => {
    await write(join(root, "config", "config.json"), { tasks: { retentionDays: 30 } });
    await write(join(workspace, ".alisio", "config.json"), {
      tasks: { maxPerSession: 2, retentionDays: 1 },
    });
    const a = await app({ trustProject: true });
    expect(a.config.tasks.maxPerSession).toBe(2);
    expect(a.config.tasks.retentionDays).toBe(30);
    expect(a.configDiagnostics).toContain("tasks.retentionDays");
  });
});

describe("lifecycle", () => {
  it("marks the tasks of a dead owner lost at start and leaves live ones", async () => {
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => dead.once("exit", resolve));
    const seed = new SQLiteStore(dbPath());
    const session = seed.create(workspace, "fake-provider", "fake-model").id;
    const insert = (id: string, pid: number) =>
      seed.db
        .prepare(
          `INSERT INTO background_tasks(id,session,root_session,workspace,kind,label,status,owner_pid,log_path,created_at)
           VALUES(?,?,?,?,'shell','x','running',?,?,1)`,
        )
        .run(id, session, session, workspace, pid, `tasks/${session}/${id}.log`);
    insert("orphan", dead.pid as number);
    insert("live-owner", process.ppid);
    seed.close();
    const a = await app();
    expect(a.tasks.get(session, "orphan")).toMatchObject({ status: "lost" });
    expect(a.tasks.get(session, "live-owner").status).toBe("running");
  });

  it("app.close() kills every live task: cancelled with origin shutdown, nothing left running", async () => {
    const a = await app();
    const session = a.store.create(a.workspace, "fake-provider", "fake-model").id;
    const task = a.tasks.start({ session, workspace, cwd: workspace, command: SLEEP });
    await waitFor(() => a.tasks.get(session, task.id).pid, 5_000, "the pid");
    const pid = a.tasks.get(session, task.id).pid as number;
    expect(alive(pid)).toBe(true);
    await a.close();
    apps.splice(apps.indexOf(a), 1);
    expect(alive(pid)).toBe(false);
    const reopened = new SQLiteStore(dbPath());
    try {
      expect(new BackgroundTaskStore(reopened.db).get(task.id)).toMatchObject({
        status: "cancelled",
        abortOrigin: "shutdown",
      });
    } finally {
      reopened.close();
    }
  });
});

describe("retention", () => {
  it("deletes finished tasks and their logs after retentionDays; live tasks and recent ones stay", async () => {
    const store = new SQLiteStore(join(root, "r.sqlite"));
    try {
      const tasks = new BackgroundTaskStore(store.db);
      const DAY = 86_400_000;
      const now = Date.now();
      const add = async (id: string, status: "running" | "succeeded", endedAgoDays: number) => {
        const rel = `tasks/s/${id}.log`;
        await mkdir(join(root, "tasks", "s"), { recursive: true });
        await writeFile(join(root, rel), "log");
        tasks.insert({
          id,
          session: "s",
          rootSession: "s",
          workspace: "/w",
          label: id,
          command: "x",
          cwd: "/w",
          ownerPid: process.pid,
          timeoutMs: 1000,
          logPath: rel,
          createdAt: now - endedAgoDays * DAY,
        });
        tasks.transition(id, ["queued"], "running");
        if (status === "succeeded")
          tasks.transition(id, ["running"], "succeeded", { endedAt: now - endedAgoDays * DAY });
      };
      await add("old", "succeeded", 10);
      await add("recent", "succeeded", 1);
      await add("old-live", "running", 10);
      let days = 7;
      const janitor = new TaskJanitor({
        store: tasks,
        stateRoot: root,
        retentionDays: () => days,
        now: () => now,
      });
      expect(await janitor.sweep()).toEqual({ deleted: 1, errors: 0 });
      expect(tasks.get("old")).toBeUndefined();
      expect(existsSync(join(root, "tasks", "s", "old.log"))).toBe(false);
      expect(tasks.get("recent")).toBeDefined();
      expect(existsSync(join(root, "tasks", "s", "recent.log"))).toBe(true);
      expect(tasks.get("old-live")?.status).toBe("running");
      // 0 disables the deletion.
      days = 0;
      expect(await janitor.sweep()).toEqual({ deleted: 0, errors: 0 });
      // A shorter setting applies to the next sweep without a restart.
      days = 0.5 as unknown as number;
      expect((await janitor.sweep()).deleted).toBe(1);
      expect(tasks.get("recent")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe("the subagent mirror", () => {
  it("shows the subagents plugin's tree as read-only tasks of kind subagent", () => {
    const panels = new Map([
      [
        "subagents:agents",
        {
          plugin: "subagents",
          provider: {
            title: "Agents",
            nodes: ({ sessionId }: { sessionId: string }) =>
              sessionId === "root"
                ? [
                    {
                      id: "a1",
                      label: "explore",
                      status: "running",
                      startedAt: 5,
                      detail: "reading",
                    },
                    {
                      id: "a2",
                      parentId: "a1",
                      label: "grep",
                      status: "completed",
                      sessionId: "a2",
                    },
                    { id: "a3", label: "x", status: "weird" },
                  ]
                : [],
          },
        },
      ],
      [
        "other:panel",
        {
          plugin: "other",
          provider: { title: "x", nodes: () => [{ id: "z", label: "z", status: "running" }] },
        },
      ],
    ]);
    const tasks = subagentTasks(panels, "root");
    expect(tasks.map((t) => [t.id, t.kind, t.status])).toEqual([
      ["a1", "subagent", "running"],
      ["a2", "subagent", "succeeded"],
      ["a3", "subagent", "lost"],
    ]);
    expect(tasks[1]?.parentId).toBe("a1");
    expect(subagentTasks(panels, "elsewhere")).toEqual([]);
    void sleep;
  });
});
