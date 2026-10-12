import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alisio-store-v10-"));
  roots.push(root);
  return join(root, "sessions.sqlite");
}
const insertExecution = (store: SQLiteStore, id: string, runtime: string) =>
  store.db
    .prepare(
      `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at)
       VALUES(?,'s','s','/w',?,'completed','abc','jobs/x',1)`,
    )
    .run(id, runtime);

describe("SQLiteStore v10 migration (analysis_executions.runtime admits wasm)", () => {
  it("a fresh database records wasm executions and still refuses unknown runtimes", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      insertExecution(store, "e_wasm", "wasm");
      expect(
        store.db.prepare("SELECT runtime FROM analysis_executions WHERE id='e_wasm'").get(),
      ).toEqual({ runtime: "wasm" });
      expect(() => insertExecution(store, "e_bad", "bogus")).toThrow();
    } finally {
      store.close?.();
    }
  });

  it("a v9 database keeps its executions and the artifacts that reference them", async () => {
    const path = await tempDb();
    const first = new SQLiteStore(path);
    // Roll back to what a v9 binary leaves: the narrow CHECK and no migration 10.
    first.db.exec(`PRAGMA foreign_keys=OFF;
      DROP TABLE analysis_executions;
      CREATE TABLE analysis_executions(
        id TEXT PRIMARY KEY, session TEXT NOT NULL, root_session TEXT NOT NULL, workspace TEXT NOT NULL,
        run_id TEXT, call_id TEXT,
        runtime TEXT NOT NULL CHECK(runtime IN ('managed','oci')),
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','timed_out')),
        script_sha256 TEXT NOT NULL, exit_code INTEGER, error TEXT, rel_dir TEXT NOT NULL,
        rerun_of TEXT, created_at INTEGER NOT NULL, ended_at INTEGER);
      DELETE FROM schema_migrations WHERE version>=10;
      PRAGMA foreign_keys=ON;`);
    insertExecution(first, "e_old", "oci");
    first.db
      .prepare(
        `INSERT INTO artifacts(id,session,root_session,workspace,execution_id,title,file_name,kind,mime,bytes,sha256,rel_dir,status,provenance,created_at)
         VALUES('a1','s','s','/w','e_old','t','f.txt','file','text/plain',1,'h','art/a1','ready','{}',1)`,
      )
      .run();
    expect(() => insertExecution(first, "e_new", "wasm")).toThrow();
    first.close?.();

    const migrated = new SQLiteStore(path);
    try {
      expect(migrated.db.prepare("SELECT id, runtime FROM analysis_executions").all()).toEqual([
        { id: "e_old", runtime: "oci" },
      ]);
      expect(migrated.db.prepare("SELECT execution_id FROM artifacts").all()).toEqual([
        { execution_id: "e_old" },
      ]);
      insertExecution(migrated, "e_new", "wasm");
      // The foreign key still bites after the rebuild.
      expect(() =>
        migrated.db
          .prepare(
            `INSERT INTO artifacts(id,session,root_session,workspace,execution_id,title,file_name,kind,mime,bytes,sha256,rel_dir,status,provenance,created_at)
             VALUES('a2','s','s','/w','missing','t','g.txt','file','text/plain',1,'h','art/a2','ready','{}',1)`,
          )
          .run(),
      ).toThrow();
    } finally {
      migrated.close?.();
    }
  });

  it("opening twice does not rebuild again", async () => {
    const path = await tempDb();
    new SQLiteStore(path).close?.();
    const again = new SQLiteStore(path);
    try {
      insertExecution(again, "e1", "managed");
      again.close?.();
      const third = new SQLiteStore(path);
      expect(third.db.prepare("SELECT COUNT(*) AS n FROM analysis_executions").get()).toEqual({
        n: 1,
      });
      third.close?.();
    } finally {
      /* already closed */
    }
  });
});
