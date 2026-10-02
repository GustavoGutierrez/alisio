import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alisio-store-v7-"));
  roots.push(root);
  return join(root, "sessions.sqlite");
}

/** A v6 database with data in the pre-existing tables. */
function v6Fixture(path: string): void {
  const v6 = new SQLiteStore(path);
  // Roll the schema back to exactly what a v6 binary leaves (this store created the v7 tables).
  v6.db.exec(
    "DROP TABLE background_tasks; DROP TABLE session_goals; DELETE FROM schema_migrations WHERE version>=7;",
  );
  const session = v6.create("/w", "p", "m");
  v6.append(session.id, { role: "user", text: "hello" });
  v6.db
    .prepare(
      `INSERT INTO capability_grants(id,capability,session,workspace,scope,decision,source,created_at)
       VALUES('g1','analysis.run',?,'/w','session','allow','tui',1)`,
    )
    .run(session.id);
  v6.close();
}

const tables = (store: SQLiteStore) =>
  (
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);

describe("SQLiteStore v7 migration (background tasks, session goals)", () => {
  it("creates the v7 tables on a fresh database", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      expect(tables(store)).toEqual(expect.arrayContaining(["background_tasks", "session_goals"]));
      expect(
        store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get(),
      ).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("upgrades a v6 database and keeps every existing row", async () => {
    const path = await tempDb();
    v6Fixture(path);
    const raw = openDatabase(path);
    expect(raw.prepare("SELECT 1 FROM schema_migrations WHERE version=7").get()).toBeUndefined();
    raw.close();
    const store = new SQLiteStore(path);
    try {
      expect(tables(store)).toEqual(expect.arrayContaining(["background_tasks", "session_goals"]));
      const [session] = store.list();
      expect(session?.workspace).toBe("/w");
      expect(store.messages(session?.id ?? "")).toEqual([{ role: "user", text: "hello" }]);
      expect(store.db.prepare("SELECT id FROM capability_grants").all()).toEqual([{ id: "g1" }]);
    } finally {
      store.close();
    }
  });

  it("is idempotent: a second open repeats nothing and keeps v7 rows", async () => {
    const path = await tempDb();
    const first = new SQLiteStore(path);
    first.db
      .prepare(
        `INSERT INTO background_tasks(id,session,root_session,workspace,kind,label,status,owner_pid,log_path,created_at)
         VALUES('t1','s','s','/w','shell','x','succeeded',1,'tasks/s/t1.log',1)`,
      )
      .run();
    first.close();
    const second = new SQLiteStore(path);
    try {
      const versions = (
        second.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(second.db.prepare("SELECT id FROM background_tasks").all()).toEqual([{ id: "t1" }]);
    } finally {
      second.close();
    }
  });

  it("rejects a status outside the state machine", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      expect(() =>
        store.db
          .prepare(
            `INSERT INTO background_tasks(id,session,root_session,workspace,kind,label,status,owner_pid,log_path,created_at)
             VALUES('t1','s','s','/w','shell','x','completed',1,'p',1)`,
          )
          .run(),
      ).toThrow();
    } finally {
      store.close();
    }
  });
});
