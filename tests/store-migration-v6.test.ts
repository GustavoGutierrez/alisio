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
  const root = await mkdtemp(join(tmpdir(), "alisio-store-v6-"));
  roots.push(root);
  return join(root, "sessions.sqlite");
}

/** A v5 database with data in every pre-existing table. */
function v5Fixture(path: string): void {
  const v5 = new SQLiteStore(path);
  // Roll the schema back to exactly what a v5 binary leaves (the v5 store created v6 tables).
  v5.db.exec(`DROP TABLE artifacts; DROP TABLE analysis_executions; DROP TABLE capability_grants;
    DROP TABLE datasets; DELETE FROM schema_migrations WHERE version=6;`);
  const session = v5.create("/w", "p", "m");
  v5.append(session.id, { role: "user", text: "hello" });
  v5.recordWorkspace("/w", { label: "Mine", archived: true });
  v5.event(session.id, "run-1", "run_started", { model: "m" });
  v5.close();
}

const tables = (store: SQLiteStore) =>
  (
    store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);

describe("SQLiteStore v6 migration (analysis, artifacts, grants, datasets)", () => {
  it("adds the v6 tables to a v5 database and keeps every existing row", async () => {
    const path = await tempDb();
    v5Fixture(path);
    const raw = openDatabase(path);
    expect(raw.prepare("SELECT 1 FROM schema_migrations WHERE version=6").get()).toBeUndefined();
    raw.close();
    const store = new SQLiteStore(path);
    try {
      expect(tables(store)).toEqual(
        expect.arrayContaining([
          "analysis_executions",
          "artifacts",
          "capability_grants",
          "datasets",
        ]),
      );
      const [session] = store.list();
      expect(session?.workspace).toBe("/w");
      expect(store.messages(session?.id ?? "")).toEqual([{ role: "user", text: "hello" }]);
      expect(store.workspaces()[0]).toMatchObject({
        label: "Mine",
        archivedAt: expect.any(Number),
      });
      expect(store.lastEventId(session?.id ?? "")).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("is idempotent: a second open repeats nothing and keeps v6 rows", async () => {
    const path = await tempDb();
    const first = new SQLiteStore(path);
    first.db
      .prepare(
        `INSERT INTO capability_grants(id,capability,session,workspace,scope,decision,source,created_at)
         VALUES('g1','analysis.run','s','/w','session','allow','tui',1)`,
      )
      .run();
    first.close();
    const second = new SQLiteStore(path);
    try {
      const versions = (
        second.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((v) => v.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6]);
      expect(second.db.prepare("SELECT count(*) AS n FROM capability_grants").get()).toEqual({
        n: 1,
      });
    } finally {
      second.close();
    }
  });

  it("rejects values outside the CHECK constraints", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      expect(() =>
        store.db
          .prepare(
            `INSERT INTO capability_grants(id,capability,session,workspace,scope,decision,source,created_at)
             VALUES('g','analysis.run','s','/w','workspace','allow','tui',1)`,
          )
          .run(),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("resolves the root of a child session", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      const root = store.create("/w", "p", "m");
      const child = store.createChild({
        parentId: root.id,
        workspace: "/w",
        provider: "p",
        model: "m",
        agent: "explore",
        title: "t",
        depth: 1,
        options: {},
      });
      expect(store.rootOf(child.id)).toBe(root.id);
      expect(store.rootOf(root.id)).toBe(root.id);
      expect(store.rootOf("unknown")).toBe("unknown");
    } finally {
      store.close();
    }
  });
});
