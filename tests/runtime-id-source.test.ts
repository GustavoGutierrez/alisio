/**
 * The optional, process-wide id source (`setIdSource`): characterization of the id shapes the
 * production code generates today (these pass before and after the change), and the contract of
 * the source the reliability lab installs for record/replay.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { registerExitPlan } from "../packages/core/src/plan/exit-plan.ts";
import { currentPlan } from "../packages/core/src/plan/state.ts";
import {
  type IdSource,
  newId,
  newUuid,
  seededIdSource,
  setIdSource,
  ulid,
} from "../packages/core/src/runtime/ids.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { cleanupFixtures, startNode, taskFixture } from "./background-helpers.ts";
import { kernelFixture } from "./forge-kernel-helpers.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

afterEach(async () => {
  setIdSource(undefined);
  await cleanupFixtures();
});

const dirs: string[] = [];
function memoryStore(): SQLiteStore {
  const dir = mkdtempSync(join(tmpdir(), "id-source-"));
  dirs.push(dir);
  return new SQLiteStore(join(dir, "s.sqlite"));
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fixed: IdSource = {
  uuid: () => "00000000-0000-4000-8000-000000000001",
  ulid: () => "0123456789ABCDEFGHJKMNPQRS",
};

describe("id shapes without an installed source (characterization)", () => {
  it("ulid is 26 Crockford characters and newId prefixes it", () => {
    expect(ulid()).toMatch(ULID);
    expect(newId("art")).toMatch(/^art_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid()).not.toBe(ulid());
  });

  it("newUuid is a random v4 UUID", () => {
    expect(newUuid()).toMatch(UUID);
    expect(newUuid()).not.toBe(newUuid());
  });

  it("sessions and child sessions get random UUIDs", () => {
    const store = memoryStore();
    const root = store.create("/w", "p", "m");
    expect(root.id).toMatch(UUID);
    const child = store.createChild({
      parentId: root.id,
      workspace: "/w",
      provider: "p",
      model: "m",
      depth: 1,
      agent: "a",
      title: "t",
      options: {},
    });
    expect(child.id).toMatch(UUID);
    store.close();
  });

  it("background tasks get task_<ULID> ids", async () => {
    const fx = await taskFixture();
    try {
      const task = await startNode(fx, "setTimeout(() => {}, 10)");
      expect(task.id).toMatch(/^task_[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      await fx.close();
    }
  });

  it("forge executions get fx_<uuid> ids", async () => {
    const fx = await kernelFixture();
    try {
      await fx.run("return 1");
      const id = fx.progress[0]?.executionId ?? "";
      expect(id).toMatch(/^fx_[0-9a-f-]{36}$/);
    } finally {
      await fx.close();
    }
  });

  it("plan proposals get a random UUID planId", async () => {
    const { store, session, registry } = planFixture();
    await registry.get("exit_plan")?.execute({ plan: "# Plan" }, toolContext(session));
    expect(currentPlan(store, session)?.planId).toMatch(UUID);
    store.close();
  });
});

describe("setIdSource", () => {
  it("routes uuid, ulid and newId through the installed source until it is removed", () => {
    setIdSource(fixed);
    expect(newUuid()).toBe(fixed.uuid());
    expect(ulid()).toBe(fixed.ulid());
    expect(newId("task")).toBe(`task_${fixed.ulid()}`);
    setIdSource(undefined);
    expect(newUuid()).toMatch(UUID);
    expect(ulid()).toMatch(ULID);
  });

  it("is used by sessions, child sessions and background tasks", async () => {
    setIdSource(seededIdSource("test"));
    const store = memoryStore();
    const a = store.create("/w", "p", "m").id;
    const b = store.create("/w", "p", "m").id;
    const child = store.createChild({
      parentId: a,
      workspace: "/w",
      provider: "p",
      model: "m",
      depth: 1,
      agent: "a",
      title: "t",
      options: {},
    }).id;
    const reference = seededIdSource("test");
    expect([a, b, child]).toEqual([reference.uuid(), reference.uuid(), reference.uuid()]);
    store.close();

    setIdSource(seededIdSource("tasks"));
    const tasks = await taskFixture();
    try {
      const task = await startNode(tasks, "setTimeout(() => {}, 10)");
      expect(task.id).toBe(`task_${seededIdSource("tasks").ulid()}`);
    } finally {
      await tasks.close();
    }
  });

  it("a seeded source replays the same sequence for the same seed and differs by seed", () => {
    const run = (seed: string) => {
      const source = seededIdSource(seed);
      return [source.uuid(), source.ulid(), source.uuid(), source.ulid(123)];
    };
    expect(run("a")).toEqual(run("a"));
    expect(run("a")).not.toEqual(run("b"));
    const [uuid, id] = run("a");
    expect(uuid).toMatch(UUID);
    expect(id).toMatch(ULID);
  });

  it("makes forge and plan ids repeatable", async () => {
    const forgeIds: string[] = [];
    for (let n = 0; n < 2; n++) {
      setIdSource(seededIdSource("same"));
      const fx = await kernelFixture();
      try {
        await fx.run("return 1");
        forgeIds.push(fx.progress[0]?.executionId ?? "");
      } finally {
        await fx.close();
      }
    }
    expect(forgeIds[0]).toBe(forgeIds[1]);
    expect(forgeIds[0]).toMatch(/^fx_/);

    const planIds: string[] = [];
    for (let n = 0; n < 2; n++) {
      setIdSource(seededIdSource("same"));
      const { store, session, registry } = planFixture();
      await registry.get("exit_plan")?.execute({ plan: "# Plan" }, toolContext(session));
      planIds.push(currentPlan(store, session)?.planId ?? "");
      store.close();
    }
    expect(planIds[0]).toBe(planIds[1]);
    expect(planIds[0]).toMatch(UUID);
  });
});

function planFixture() {
  const store = memoryStore();
  const session = store.create("/w", "p", "m").id;
  const registry = new ToolRegistry();
  registerExitPlan(registry, {
    store,
    ui: { interactive: () => false, askQuestions: async () => ({}) },
    readOnly: false,
  });
  return { store, session, registry };
}

function toolContext(session: string) {
  return {
    workspace: "/w",
    signal: new AbortController().signal,
    session,
    sessionId: session,
  } as unknown as Parameters<NonNullable<ReturnType<ToolRegistry["get"]>>["execute"]>[1];
}
