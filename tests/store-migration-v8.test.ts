import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoalStore } from "../packages/core/src/goal/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alisio-store-v8-"));
  roots.push(root);
  return join(root, "sessions.sqlite");
}
const columns = (store: SQLiteStore) =>
  (store.db.prepare("PRAGMA table_info(session_goals)").all() as { name: string }[]).map(
    (c) => c.name,
  );

describe("SQLiteStore v8 migration (goal runtime columns)", () => {
  it("adds the goal runtime columns on a fresh database", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      expect(columns(store)).toEqual(
        expect.arrayContaining([
          "goal_id",
          "detail",
          "summary",
          "blocked_run",
          "continuations",
          "inflight",
          "last_run_id",
          "kickoff_sent",
          "owner_pid",
        ]),
      );
      expect(
        store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=8").get(),
      ).toBeDefined();
    } finally {
      store.close();
    }
  });

  it("upgrades a database that already has the v7 table (and a goal row) without losing it", async () => {
    const path = await tempDb();
    const v7 = new SQLiteStore(path);
    const session = v7.create("/w", "p", "m").id;
    // Roll back to what a v7 build left: the table without the v8 columns, version 8 absent.
    v7.db.exec(`DROP TABLE session_goals;
      CREATE TABLE session_goals(
        session TEXT PRIMARY KEY REFERENCES sessions(id),
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','budget_limited','complete')),
        reason TEXT, evidence TEXT,
        epoch INTEGER NOT NULL DEFAULT 1,
        token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0,
        turns_used INTEGER NOT NULL DEFAULT 0,
        max_turns INTEGER NOT NULL, max_wall_ms INTEGER NOT NULL,
        active_ms INTEGER NOT NULL DEFAULT 0,
        no_tool_streak INTEGER NOT NULL DEFAULT 0, repeat_streak INTEGER NOT NULL DEFAULT 0,
        last_reply_hash TEXT, blocked_streak INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
      DELETE FROM schema_migrations WHERE version=8;`);
    v7.db
      .prepare(
        `INSERT INTO session_goals(session,objective,status,max_turns,max_wall_ms,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(session, "Left by v7", "paused", 50, 1000, 1, 1);
    v7.close();
    const store = new SQLiteStore(path);
    try {
      expect(columns(store)).toContain("owner_pid");
      // The old row reads fine, with defaults for what v7 never stored.
      expect(new GoalStore(store.db).get(session)).toMatchObject({
        objective: "Left by v7",
        status: "paused",
        continuations: 0,
        kickoffSent: false,
      });
    } finally {
      store.close();
    }
  });

  it("is idempotent", async () => {
    const path = await tempDb();
    new SQLiteStore(path).close();
    const again = new SQLiteStore(path);
    try {
      expect(columns(again).filter((name) => name === "goal_id")).toHaveLength(1);
    } finally {
      again.close();
    }
  });
});
