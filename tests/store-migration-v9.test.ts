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
  const root = await mkdtemp(join(tmpdir(), "alisio-store-v9-"));
  roots.push(root);
  return join(root, "sessions.sqlite");
}
const columns = (store: SQLiteStore, table: string) =>
  (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const indexes = (store: SQLiteStore, table: string) =>
  (store.db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((i) => i.name);

describe("SQLiteStore v9 migration (Forja journal and state)", () => {
  it("creates the three Forja tables with their indexes on a fresh database", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      expect(columns(store, "forge_executions")).toEqual(
        expect.arrayContaining([
          "id",
          "root_session_id",
          "session_id",
          "tool_call_id",
          "engine",
          "isolation",
          "selection_reason",
          "status",
          "code_sha256",
          "started_at",
          "ended_at",
          "metrics_json",
          "error_code",
          "termination_unconfirmed",
          "analysis_execution_id",
        ]),
      );
      expect(columns(store, "forge_calls")).toEqual(
        expect.arrayContaining([
          "execution_id",
          "call_id",
          "tool_name",
          "effect",
          "status",
          "duration_ms",
          "input_sha256",
          "error_code",
          "paths_json",
        ]),
      );
      expect(columns(store, "forge_state")).toEqual(
        expect.arrayContaining(["root_session_id", "key", "value_json", "revision", "updated_at"]),
      );
      expect(indexes(store, "forge_executions")).toContain("forge_executions_root");
      expect(indexes(store, "forge_calls")).toContain("forge_calls_execution");
      expect(
        store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=9").get(),
      ).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("upgrades a v8 database without touching its rows, and is idempotent", async () => {
    const path = await tempDb();
    const v8 = new SQLiteStore(path);
    const session = v8.create("/w", "p", "m").id;
    v8.db.exec(`DROP TABLE forge_calls; DROP TABLE forge_state; DROP TABLE forge_executions;
      DELETE FROM schema_migrations WHERE version=9;`);
    v8.close();

    const upgraded = new SQLiteStore(path);
    try {
      expect(upgraded.get(session)).toMatchObject({ id: session });
      expect(columns(upgraded, "forge_executions")).toContain("analysis_execution_id");
    } finally {
      upgraded.close();
    }
    const again = new SQLiteStore(path);
    try {
      expect(
        (
          again.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=9").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
    } finally {
      again.close();
    }
  });
});
