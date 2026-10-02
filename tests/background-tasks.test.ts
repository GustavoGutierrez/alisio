/**
 * The background-task runtime at its module boundary: real short-lived child processes (a node
 * script, never shell-specific syntax), the compare-and-set state machine, output by offsets,
 * the limits, recovery by owner pid and the orderly shutdown.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundTaskInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { TaskAdmissionError, TaskNotFoundError } from "../packages/core/src/background/service.ts";
import { BackgroundTaskStore } from "../packages/core/src/background/store.ts";
import {
  alive,
  cleanupFixtures,
  sleep,
  startNode,
  taskFixture,
  waitFor,
} from "./background-helpers.ts";

afterEach(cleanupFixtures);

const terminal = (task: BackgroundTaskInfo) =>
  ["succeeded", "failed", "cancelled", "lost"].includes(task.status);
const settled = (fx: Awaited<ReturnType<typeof taskFixture>>, id: string) =>
  waitFor(
    () => {
      const task = fx.tasks.get(fx.session, id);
      return terminal(task) ? task : undefined;
    },
    15_000,
    `task ${id} to end`,
  );

describe("output and exit codes", () => {
  it("captures output incrementally by offset and ends succeeded with eof", async () => {
    const fx = await taskFixture();
    try {
      const task = await startNode(
        fx,
        'console.log("one"); setTimeout(() => { console.error("two"); }, 200); setTimeout(() => {}, 250);',
      );
      expect(task.status).toBe("running");
      const first = await waitFor(async () => {
        const out = await fx.tasks.read(fx.session, task.id, { offset: 0 });
        return out.text.includes("one") ? out : undefined;
      });
      expect(first.status).toBe("running");
      expect(first.eof).toBe(false);
      const done = await settled(fx, task.id);
      expect(done).toMatchObject({ status: "succeeded", exitCode: 0 });
      // Continue from the offset of the first read: nothing is repeated, stdout and stderr are both there.
      const rest = await fx.tasks.read(fx.session, task.id, { offset: first.nextOffset });
      expect(rest.text).toContain("two");
      expect(rest.text).not.toContain("one");
      expect(rest.eof).toBe(true);
      const after = await fx.tasks.read(fx.session, task.id, { offset: rest.nextOffset });
      expect(after).toMatchObject({ text: "", nextOffset: rest.nextOffset, eof: true });
    } finally {
      await fx.close();
    }
  });

  it("reports a non-zero exit as failed with its exit code", async () => {
    const fx = await taskFixture();
    try {
      const task = await startNode(fx, "console.log('bad'); process.exit(3);");
      expect(await settled(fx, task.id)).toMatchObject({ status: "failed", exitCode: 3 });
    } finally {
      await fx.close();
    }
  });

  it("runs in the requested directory", async () => {
    const fx = await taskFixture();
    try {
      const task = fx.tasks.start({
        session: fx.session,
        workspace: fx.root,
        cwd: fx.root,
        command: await fx.node("console.log(process.cwd())"),
      });
      await settled(fx, task.id);
      const out = await fx.tasks.read(fx.session, task.id);
      expect(out.text.trim().length).toBeGreaterThan(0);
      expect(out.text.trim().endsWith(fx.root.split("/").at(-1) as string)).toBe(true);
      expect(fx.tasks.get(fx.session, task.id).cwd).toBe(".");
    } finally {
      await fx.close();
    }
  });

  it("keeps the head, marks the cut and appends the tail when the log limit is reached", async () => {
    const fx = await taskFixture({ maxOutputBytes: 2_000 });
    try {
      const task = await startNode(
        fx,
        'process.stdout.write("HEAD-START\\n" + "x".repeat(40000) + "\\nTAIL-END-MARKER\\n");',
      );
      const done = await settled(fx, task.id);
      expect(done.truncated).toBe(true);
      const out = await fx.tasks.read(fx.session, task.id, { offset: 0, limit: 65_536 });
      expect(out.text.startsWith("HEAD-START")).toBe(true);
      expect(out.text).toContain("[output truncated");
      expect(out.text).toContain("bytes omitted");
      expect(out.text.trimEnd().endsWith("TAIL-END-MARKER")).toBe(true);
      expect(out.truncated).toBe(true);
      // Bounded: head limit + markers + the 32 KiB tail, far below the 40 KB written.
      expect(Buffer.byteLength(out.text)).toBeLessThan(2_000 + 1_000 + 32 * 1024);
    } finally {
      await fx.close();
    }
  });

  it("returns at most `limit` bytes per read and never splits a character", async () => {
    const fx = await taskFixture();
    try {
      const task = await startNode(fx, 'process.stdout.write("é".repeat(100));');
      await settled(fx, task.id);
      let offset = 0;
      let text = "";
      for (let i = 0; i < 100; i++) {
        const out = await fx.tasks.read(fx.session, task.id, { offset, limit: 7 });
        expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(7);
        expect(out.text).not.toContain("�");
        text += out.text;
        offset = out.nextOffset;
        if (out.eof) break;
      }
      expect(text).toBe("é".repeat(100));
    } finally {
      await fx.close();
    }
  });
});

describe("stop, timeout and the process tree", () => {
  const TREE =
    'const { spawn } = require("node:child_process");' +
    'const fs = require("node:fs");' +
    'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });' +
    "fs.writeFileSync(process.argv[2], String(child.pid));" +
    'console.log("ready"); setTimeout(() => {}, 60000);';

  it("a user stop ends cancelled (never failed) and kills the whole process tree", async () => {
    const fx = await taskFixture();
    try {
      const pidFile = join(fx.root, "grandchild.pid");
      const command = `${await fx.node(TREE)} ${JSON.stringify(pidFile)}`;
      const task = fx.tasks.start({
        session: fx.session,
        workspace: fx.root,
        cwd: fx.root,
        command,
      });
      const grandchild = Number(
        await waitFor(
          async () => readFile(pidFile, "utf8").catch(() => ""),
          10_000,
          "grandchild pid",
        ),
      );
      expect(alive(grandchild)).toBe(true);
      const stopped = await fx.tasks.stop(fx.session, task.id, "user");
      expect(stopped).toMatchObject({ status: "cancelled", abortOrigin: "user" });
      expect(stopped.errorCode).toBeUndefined();
      await waitFor(() => !alive(grandchild), 5_000, "grandchild to die");
      expect(alive(task.pid as number)).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it("a model stop is cancelled with origin model; stopping twice is idempotent", async () => {
    const fx = await taskFixture();
    try {
      const task = await startNode(fx, "setTimeout(() => {}, 60000);");
      const [a, b] = await Promise.all([
        fx.tasks.stop(fx.session, task.id, "model"),
        fx.tasks.stop(fx.session, task.id, "user"),
      ]);
      expect(a.status).toBe("cancelled");
      expect(b.status).toBe("cancelled");
      // The first request wins the origin; the second never rewrites it.
      expect(a.abortOrigin).toBe("model");
      expect(b.abortOrigin).toBe("model");
      expect((await fx.tasks.stop(fx.session, task.id, "user")).abortOrigin).toBe("model");
    } finally {
      await fx.close();
    }
  });

  it("the watchdog stops a task that runs too long: failed with the code timeout", async () => {
    const fx = await taskFixture({ maxRunMs: 1_000 });
    try {
      const task = await startNode(fx, "setTimeout(() => {}, 60000);");
      const done = await settled(fx, task.id);
      expect(done).toMatchObject({
        status: "failed",
        errorCode: "timeout",
        abortOrigin: "timeout",
      });
      expect(alive(task.pid as number)).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it("a requested timeout cannot exceed the configured maximum", async () => {
    const fx = await taskFixture({ maxRunMs: 5_000 });
    try {
      const task = await startNode(fx, "setTimeout(() => {}, 20000);", { timeoutMs: 600_000 });
      expect(task.timeoutMs).toBe(5_000);
      await fx.tasks.stop(fx.session, task.id, "user");
    } finally {
      await fx.close();
    }
  });

  it("a stop racing the natural exit never leaves a terminal state and ends in exactly one", async () => {
    const fx = await taskFixture();
    try {
      for (let i = 0; i < 8; i++) {
        const task = await startNode(fx, "process.exit(0);");
        await sleep(i * 15);
        const result = await fx.tasks.stop(fx.session, task.id, "user");
        expect(["succeeded", "cancelled"]).toContain(result.status);
        const final = await settled(fx, task.id);
        expect(["succeeded", "cancelled"]).toContain(final.status);
        // Once terminal it stays that way.
        await sleep(30);
        expect(fx.tasks.get(fx.session, task.id).status).toBe(final.status);
      }
    } finally {
      await fx.close();
    }
  });
});

describe("compare-and-set transitions", () => {
  it("never leaves a terminal state and moves only from the expected one", async () => {
    const fx = await taskFixture();
    try {
      const task = await startNode(fx, "setTimeout(() => {}, 60000);");
      const { store } = fx.tasks;
      expect(store.transition(task.id, ["queued"], "running")).toBe(false);
      expect(store.transition(task.id, ["running"], "stopping", { abortOrigin: "user" })).toBe(
        true,
      );
      expect(store.transition(task.id, ["running"], "stopping")).toBe(false);
      expect(store.transition(task.id, ["stopping"], "cancelled", { endedAt: 1 })).toBe(true);
      // Terminal is final: nothing moves a cancelled task, whatever the actor expects it to be.
      for (const to of ["running", "stopping", "succeeded", "failed", "lost"] as const)
        expect(store.transition(task.id, ["queued", "running", "stopping"], to)).toBe(false);
      expect(store.get(task.id)?.status).toBe("cancelled");
      // The process is still alive: stop it for real so nothing leaks.
      const fresh = await startNode(fx, "setTimeout(() => {}, 60000);");
      await fx.tasks.stop(fx.session, fresh.id, "user");
      await fx.tasks.stop(fx.session, task.id, "user");
    } finally {
      await fx.close();
    }
  });
});

describe("recovery by owner pid", () => {
  const insert = (
    fx: Awaited<ReturnType<typeof taskFixture>>,
    id: string,
    ownerPid: number,
    status = "running",
  ) =>
    fx.store.db
      .prepare(
        `INSERT INTO background_tasks(id,session,root_session,workspace,kind,label,status,owner_pid,log_path,created_at)
         VALUES(?,?,?,?,'shell','x',?,?,?,1)`,
      )
      .run(id, fx.session, fx.session, fx.root, status, ownerPid, `tasks/${fx.session}/${id}.log`);

  it("marks the tasks of a dead owner lost and leaves live owners and this process alone", async () => {
    const fx = await taskFixture();
    // A process that has already exited: its pid is dead.
    const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((resolve) => dead.once("exit", resolve));
    // Another live "Alisio process": any process that keeps running.
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      for (const status of ["queued", "running", "stopping"])
        insert(fx, `dead-${status}`, dead.pid as number, status);
      insert(fx, "dead-done", dead.pid as number, "succeeded");
      insert(fx, "other", other.pid as number);
      insert(fx, "mine", process.pid);
      const lost = fx.tasks.recover();
      expect(lost.map((task) => task.id).sort()).toEqual([
        "dead-queued",
        "dead-running",
        "dead-stopping",
      ]);
      for (const task of lost) expect(task.status).toBe("lost");
      expect(fx.tasks.store.get("dead-running")?.endedAt).toBeGreaterThan(0);
      expect(fx.tasks.store.get("dead-done")?.status).toBe("succeeded");
      expect(fx.tasks.store.get("other")?.status).toBe("running");
      expect(fx.tasks.store.get("mine")?.status).toBe("running");
      // Recovery is idempotent.
      expect(fx.tasks.recover()).toHaveLength(0);
    } finally {
      other.kill("SIGKILL");
      fx.store.db.prepare("DELETE FROM background_tasks WHERE id IN ('other','mine')").run();
      await fx.close();
    }
  });

  it("a second application of the same process does not mark live tasks lost", async () => {
    const fx = await taskFixture();
    try {
      const task = await startNode(fx, "setTimeout(() => {}, 60000);");
      const store = new BackgroundTaskStore(fx.store.db);
      expect(store.markLost(Date.now())).toHaveLength(0);
      expect(fx.tasks.get(fx.session, task.id).status).toBe("running");
    } finally {
      await fx.close();
    }
  });
});

describe("admission and scoping", () => {
  it("limits live tasks per session and frees a slot when one ends", async () => {
    const fx = await taskFixture();
    try {
      const live = [];
      for (let i = 0; i < 4; i++) live.push(await startNode(fx, "setTimeout(() => {}, 60000);"));
      await expect(startNode(fx, "0")).rejects.toMatchObject({ code: "session_limit" });
      await fx.tasks.stop(fx.session, (live[0] as BackgroundTaskInfo).id, "user");
      const again = await startNode(fx, "setTimeout(() => {}, 60000);");
      expect(again.status).toBe("running");
    } finally {
      await fx.close();
    }
  });

  it("limits live tasks per process across sessions", async () => {
    const fx = await taskFixture({ maxPerProcess: 2 });
    try {
      const other = fx.store.create(fx.root, "test", "m").id;
      await startNode(fx, "setTimeout(() => {}, 60000);");
      await startNode(fx, "setTimeout(() => {}, 60000);", { session: other });
      await expect(startNode(fx, "0", { session: other })).rejects.toMatchObject({
        code: "process_limit",
      });
    } finally {
      await fx.close();
    }
  });

  it("a session sees and stops only its own tree's tasks", async () => {
    const fx = await taskFixture();
    try {
      const task = await startNode(fx, "setTimeout(() => {}, 60000);");
      const stranger = fx.store.create(fx.root, "test", "m").id;
      expect(() => fx.tasks.get(stranger, task.id)).toThrow(TaskNotFoundError);
      await expect(fx.tasks.read(stranger, task.id)).rejects.toThrow(TaskNotFoundError);
      await expect(fx.tasks.stop(stranger, task.id, "user")).rejects.toThrow(TaskNotFoundError);
      expect(fx.tasks.list(stranger)).toEqual([]);
      expect(fx.tasks.list(fx.session).map((t) => t.id)).toEqual([task.id]);
      // A child session shares the root's tasks.
      const child = fx.store.createChild({
        parentId: fx.session,
        workspace: fx.root,
        provider: "test",
        model: "m",
        agent: "general",
        title: "c",
        depth: 1,
        options: {},
      });
      expect(fx.tasks.list(fx.store.rootOf(child.id))).toHaveLength(1);
      await fx.tasks.stop(fx.session, task.id, "user");
    } finally {
      await fx.close();
    }
  });

  it("refuses admission when disabled or read-only", async () => {
    const readOnly = await taskFixture({ readOnly: true });
    try {
      await expect(startNode(readOnly, "0")).rejects.toBeInstanceOf(TaskAdmissionError);
    } finally {
      await readOnly.close();
    }
    const disabled = await taskFixture({
      limits: () => ({ enabled: false, maxPerSession: 4, maxRunMs: 1000, maxOutputBytes: 1000 }),
    });
    try {
      await expect(startNode(disabled, "0")).rejects.toMatchObject({ code: "disabled" });
    } finally {
      await disabled.close();
    }
  });

  it("emits a change for every state a task goes through", async () => {
    const changes: string[] = [];
    const fx = await taskFixture({ onChange: (task) => changes.push(task.status) });
    try {
      const task = await startNode(fx, "setTimeout(() => {}, 60000);");
      await fx.tasks.stop(fx.session, task.id, "user");
      expect(changes).toEqual(["running", "stopping", "cancelled"]);
    } finally {
      await fx.close();
    }
  });
});

describe("orderly shutdown", () => {
  it("refuses new tasks, kills every live task (cancelled, origin shutdown) and leaves nothing running", async () => {
    const fx = await taskFixture();
    const stubborn =
      'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000); console.log("ready");';
    const a = await startNode(fx, "setTimeout(() => {}, 60000);");
    const b = await startNode(fx, stubborn);
    const pids = [a.pid as number, b.pid as number];
    await waitFor(async () => (await fx.tasks.read(fx.session, b.id)).text.includes("ready"));
    const closing = fx.tasks.close();
    await expect(startNode(fx, "0")).rejects.toMatchObject({ code: "shutting_down" });
    await closing;
    for (const pid of pids) expect(alive(pid)).toBe(false);
    for (const id of [a.id, b.id])
      expect(fx.tasks.get(fx.session, id)).toMatchObject({
        status: "cancelled",
        abortOrigin: "shutdown",
      });
    expect(fx.tasks.liveCount()).toBe(0);
    fx.store.close();
  });
});
