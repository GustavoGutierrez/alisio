import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackgroundTasks,
  type BackgroundTasksOptions,
} from "../packages/core/src/background/service.ts";
import { isProcessAlive } from "../packages/core/src/runtime/process.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `condition` until it is truthy (or fails after `timeoutMs`). */
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  timeoutMs = 10_000,
  label = "condition",
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(20);
  }
}

export const alive = isProcessAlive;

export interface TaskFixture {
  root: string;
  store: SQLiteStore;
  tasks: BackgroundTasks;
  session: string;
  /** A shell command that runs a node script (portable: only quotes, no shell syntax). */
  node(script: string, ...args: string[]): Promise<string>;
  close(): Promise<void>;
}

const roots: string[] = [];
export async function cleanupFixtures(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/** A database, a task service over it and one root session. */
export async function taskFixture(
  options: Partial<BackgroundTasksOptions> & { maxOutputBytes?: number; maxRunMs?: number } = {},
): Promise<TaskFixture> {
  const root = await mkdtemp(join(tmpdir(), "alisio-tasks-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const { maxOutputBytes, maxRunMs, ...rest } = options;
  const tasks = new BackgroundTasks({
    db: store.db,
    stateRoot: root,
    rootOf: (id) => store.rootOf(id),
    limits: () => ({
      enabled: true,
      maxPerSession: 4,
      maxRunMs: maxRunMs ?? 3_600_000,
      maxOutputBytes: maxOutputBytes ?? 1_000_000,
    }),
    killGraceMs: 500,
    closeGraceMs: 800,
    ...rest,
  });
  const session = store.create(root, "test", "m").id;
  let counter = 0;
  return {
    root,
    store,
    tasks,
    session,
    async node(script, ...args) {
      const file = join(root, `script-${counter++}.cjs`);
      await writeFile(file, script);
      return [process.execPath, file, ...args].map((part) => JSON.stringify(part)).join(" ");
    },
    async close() {
      await tasks.close();
      store.close();
    },
  };
}

/** Starts a task of `fixture.session` running a node script. */
export async function startNode(
  fixture: TaskFixture,
  script: string,
  extra: { session?: string; label?: string; timeoutMs?: number } = {},
) {
  return fixture.tasks.start({
    session: extra.session ?? fixture.session,
    workspace: fixture.root,
    cwd: fixture.root,
    command: await fixture.node(script),
    ...(extra.label ? { label: extra.label } : {}),
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
  });
}
