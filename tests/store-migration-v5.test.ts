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
  const root = await mkdtemp(join(tmpdir(), "alisio-store-v5-"));
  roots.push(root);
  return join(root, "sessions.sqlite");
}

const V3_DDL = `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
  CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT,provider TEXT,model TEXT,locked_pid INTEGER,
    parent_id TEXT,depth INTEGER NOT NULL DEFAULT 0,agent TEXT,status TEXT,title TEXT,usage TEXT,options TEXT,
    created_at INTEGER,updated_at INTEGER);
  CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT REFERENCES sessions(id),body TEXT NOT NULL,
    compacted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE tool_calls(session TEXT,call_id TEXT,status TEXT,result TEXT,PRIMARY KEY(session,call_id));
  CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,run_id TEXT,type TEXT,body TEXT);
  CREATE TABLE plugin_state(plugin TEXT,key TEXT,value TEXT,PRIMARY KEY(plugin,key));
  INSERT INTO sessions(id,workspace,provider,model) VALUES('root-1','/w','p','m');`;

/** A database exactly as a v4 binary left it: the v4 `workspaces` table without `archived_at`. */
function v4Fixture(path: string): void {
  const db = openDatabase(path);
  db.exec(`${V3_DDL}
    INSERT INTO schema_migrations VALUES(1),(2),(3),(4);
    ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
    CREATE TABLE workspaces(path TEXT PRIMARY KEY, label TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      last_opened_at INTEGER);
    INSERT INTO workspaces(path,label,pinned,last_opened_at) VALUES('/labelled','Mine',1,42);`);
  db.close();
}

function v3Fixture(path: string): void {
  const db = openDatabase(path);
  db.exec(`${V3_DDL}
    INSERT INTO schema_migrations VALUES(1),(2),(3);`);
  db.close();
}

const versions = (store: SQLiteStore) =>
  (
    store.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[]
  ).map((v) => v.version);

describe("SQLiteStore v5 migration (archived workspaces)", () => {
  it("adds archived_at to a v4 workspaces table and keeps its rows", async () => {
    const path = await tempDb();
    v4Fixture(path);
    const store = new SQLiteStore(path);
    try {
      expect(versions(store)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(store.workspaces()).toEqual([
        { path: "/labelled", label: "Mine", pinned: true, lastOpenedAt: 42, sessions: 0 },
        { path: "/w", pinned: false, sessions: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  it("migrates a v3 database straight to v5", async () => {
    const path = await tempDb();
    v3Fixture(path);
    const store = new SQLiteStore(path);
    try {
      expect(versions(store)).toEqual([1, 2, 3, 4, 5, 6]);
      store.recordWorkspace("/w", { archived: true });
      expect(store.workspaces()[0]).toMatchObject({ path: "/w", archivedAt: expect.any(Number) });
    } finally {
      store.close();
    }
    // Idempotent across reopen.
    const again = new SQLiteStore(path);
    try {
      expect(versions(again)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(again.workspaces()[0]?.archivedAt).toEqual(expect.any(Number));
    } finally {
      again.close();
    }
  });

  it("archives a workspace known only from its sessions and unarchives it", async () => {
    const store = new SQLiteStore(":memory:");
    try {
      const session = store.create("/only/sessions", "p", "m");
      expect(store.workspaces()).toEqual([{ path: "/only/sessions", pinned: false, sessions: 1 }]);
      store.recordWorkspace("/only/sessions", { archived: true });
      const [archived] = store.workspaces();
      expect(archived?.archivedAt).toEqual(expect.any(Number));
      // Sessions are untouched and stay readable.
      expect(store.get(session.id).workspace).toBe("/only/sessions");
      expect(store.get(session.id).archivedAt).toBeUndefined();
      store.recordWorkspace("/only/sessions", { archived: false });
      expect(store.workspaces()[0]?.archivedAt).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
