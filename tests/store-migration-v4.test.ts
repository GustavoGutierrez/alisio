import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textResult } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempDb(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alisio-store-v4-"));
  roots.push(root);
  return join(root, "sessions.sqlite");
}

/** Builds a database exactly as a v3 binary left it (old DDL plus the v2/v3 ALTERs), with data. */
function v3Fixture(path: string): void {
  const db = openDatabase(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations VALUES(1),(2),(3);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT,provider TEXT,model TEXT,locked_pid INTEGER,
      parent_id TEXT,depth INTEGER NOT NULL DEFAULT 0,agent TEXT,status TEXT,title TEXT,usage TEXT,options TEXT,
      created_at INTEGER,updated_at INTEGER);
    CREATE INDEX sessions_parent ON sessions(parent_id);
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT REFERENCES sessions(id),body TEXT NOT NULL,
      compacted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tool_calls(session TEXT,call_id TEXT,status TEXT,result TEXT,PRIMARY KEY(session,call_id));
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,run_id TEXT,type TEXT,body TEXT);
    CREATE TABLE plugin_state(plugin TEXT,key TEXT,value TEXT,PRIMARY KEY(plugin,key));
    INSERT INTO sessions(id,workspace,provider,model) VALUES('root-1','/w','p','m');
    INSERT INTO sessions(id,workspace,provider,model,parent_id,depth,agent,status,title,created_at,updated_at)
      VALUES('child-1','/w','p','m','root-1',1,'explore','completed','t',1,2);
    INSERT INTO messages(session,body) VALUES('root-1','{"role":"user","text":"hello"}');
    INSERT INTO messages(session,body,compacted) VALUES('root-1','{"role":"user","text":"old"}',1);
    INSERT INTO tool_calls VALUES('root-1','c1','completed','{"content":[{"type":"text","text":"ok"}]}');
    INSERT INTO events(session,run_id,type,body) VALUES('root-1','r0','run_started','{"model":"m"}');
    INSERT INTO plugin_state VALUES('memory','k','1');`);
  db.close();
}

const columns = (store: SQLiteStore, table: string) =>
  (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/** A pid that certainly belongs to no live process: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid ?? 999_999;
}

describe("SQLiteStore v4 migration", () => {
  it("opens a v3 database with data without losing rows and records version 4", async () => {
    const path = await tempDb();
    v3Fixture(path);
    const store = new SQLiteStore(path);
    try {
      expect(store.list().map((s) => s.id)).toEqual(["root-1"]);
      expect(store.children("root-1").map((s) => s.id)).toEqual(["child-1"]);
      expect(store.messages("root-1")).toEqual([{ role: "user", text: "hello" }]);
      expect(store.callResult("root-1", "c1")).toEqual(textResult("ok"));
      expect(store.getState("memory", "k")).toBe(1);
      const versions = store.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as { version: number }[];
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
      expect(columns(store, "runs")).toEqual(
        expect.arrayContaining(["id", "session", "status", "request_id", "owner_pid", "usage"]),
      );
      expect(columns(store, "workspaces")).toEqual(
        expect.arrayContaining(["path", "label", "pinned", "last_opened_at"]),
      );
      expect(columns(store, "blobs")).toEqual(
        expect.arrayContaining(["hash", "mime", "size", "width", "height", "created_at"]),
      );
      expect(columns(store, "sessions")).toEqual(expect.arrayContaining(["pinned", "archived_at"]));
      expect(columns(store, "events")).toEqual(
        expect.arrayContaining(["created_at", "correlation_id"]),
      );
      expect(columns(store, "tool_calls")).toEqual(
        expect.arrayContaining(["run_id", "name", "effect", "started_at", "ended_at"]),
      );
      // Legacy rows keep NULL in the new columns and still read the same way.
      expect(store.get("root-1")).toEqual({
        id: "root-1",
        workspace: "/w",
        provider: "p",
        model: "m",
      });
    } finally {
      store.close();
    }
  });

  it("is idempotent across reopen", async () => {
    const path = await tempDb();
    v3Fixture(path);
    new SQLiteStore(path).close();
    const store = new SQLiteStore(path);
    try {
      const count = store.db
        .prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=4")
        .get() as {
        n: number;
      };
      expect(count.n).toBe(1);
      expect(store.messages("root-1")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("creates fresh databases at v4", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      expect(columns(store, "runs")).toContain("request_id");
    } finally {
      store.close();
    }
  });
});

describe("SQLiteStore v4 runs", () => {
  it("keeps runs unique per (session, request_id) and returns the existing run on retry", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      const a = store.create("/w", "p", "m").id;
      const b = store.create("/w", "p", "m").id;
      const first = store.beginRun({
        id: "run-1",
        session: a,
        requestId: "req-1",
        status: "queued",
      });
      expect(first.created).toBe(true);
      expect(first.run).toMatchObject({
        id: "run-1",
        session: a,
        status: "queued",
        requestId: "req-1",
      });
      const retry = store.beginRun({
        id: "run-2",
        session: a,
        requestId: "req-1",
        status: "queued",
      });
      expect(retry).toMatchObject({ created: false, run: { id: "run-1" } });
      expect(store.runByRequest(a, "req-1")?.id).toBe("run-1");
      // Same request id in another session is a different run.
      expect(store.beginRun({ id: "run-3", session: b, requestId: "req-1" }).created).toBe(true);
      // Runs without a request id are never deduplicated.
      expect(store.beginRun({ id: "run-4", session: a }).created).toBe(true);
      expect(store.beginRun({ id: "run-5", session: a }).created).toBe(true);
      // The partial unique index itself rejects a raw duplicate insert.
      expect(() =>
        store.db
          .prepare("INSERT INTO runs(id,session,status,request_id,created_at) VALUES(?,?,?,?,?)")
          .run("run-x", a, "queued", "req-1", Date.now()),
      ).toThrow();
      expect(
        store
          .runs(a)
          .map((r) => r.id)
          .sort(),
      ).toEqual(["run-1", "run-4", "run-5"]);
    } finally {
      store.close();
    }
  });

  it("moves a queued run to running and then to exactly one terminal state", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      const s = store.create("/w", "p", "m").id;
      store.beginRun({ id: "r", session: s, status: "queued", correlationId: "corr" });
      const running = store.beginRun({ id: "r", session: s, status: "running", model: "m" });
      expect(running).toMatchObject({
        created: false,
        run: { status: "running", model: "m", ownerPid: process.pid, correlationId: "corr" },
      });
      expect(running.run.startedAt).toEqual(expect.any(Number));
      store.endRun("r", { status: "completed", usage: { input: 3, output: 4 } });
      store.endRun("r", { status: "failed", error: "late" });
      const [run] = store.runs(s);
      expect(run).toMatchObject({ status: "completed", usage: { input: 3, output: 4 } });
      expect(run?.error).toBeUndefined();
      expect(run?.endedAt).toEqual(expect.any(Number));
      expect(store.get(s).updatedAt).toEqual(expect.any(Number));
    } finally {
      store.close();
    }
  });

  it("interruptRuns marks only non-terminal runs whose owner process is dead", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      const s = store.create("/w", "p", "m").id;
      const insert = (id: string, status: string, pid: number | null) =>
        store.db
          .prepare("INSERT INTO runs(id,session,status,owner_pid,created_at) VALUES(?,?,?,?,?)")
          .run(id, s, status, pid, Date.now());
      const dead = deadPid();
      insert("dead-running", "running", dead);
      insert("dead-queued", "queued", dead);
      insert("orphan", "running", null);
      insert("alive-other", "running", process.ppid);
      insert("mine", "running", process.pid);
      insert("done", "completed", dead);
      expect(store.interruptRuns()).toBe(3);
      const status = Object.fromEntries(store.runs(s).map((r) => [r.id, r.status]));
      expect(status).toEqual({
        "dead-running": "interrupted",
        "dead-queued": "interrupted",
        orphan: "interrupted",
        "alive-other": "running",
        mine: "running",
        done: "completed",
      });
    } finally {
      store.close();
    }
  });
});

describe("SQLiteStore v4 timestamps, tool calls and pages", () => {
  it("stamps root sessions on create and on append", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      const before = Date.now();
      const session = store.create("/w", "p", "m");
      const created = store.get(session.id);
      expect(created.createdAt).toBeGreaterThanOrEqual(before);
      expect(created.updatedAt).toBe(created.createdAt);
      store.db.prepare("UPDATE sessions SET updated_at=1 WHERE id=?").run(session.id);
      store.append(session.id, { role: "user", text: "hi" });
      expect(store.get(session.id).updatedAt).toBeGreaterThanOrEqual(before);
    } finally {
      store.close();
    }
  });

  it("writes run id, name, effect and times for tool calls", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      const s = store.create("/w", "p", "m").id;
      const call = { id: "c1", name: "write_file", arguments: "{}" };
      store.beginCall(s, call, { runId: "r1", effect: "write" });
      const pending = store.db
        .prepare("SELECT * FROM tool_calls WHERE call_id='c1'")
        .get() as Record<string, unknown>;
      expect(pending).toMatchObject({
        status: "pending",
        run_id: "r1",
        name: "write_file",
        effect: "write",
      });
      expect(pending.started_at).toEqual(expect.any(Number));
      expect(pending.ended_at).toBeNull();
      store.endCall(s, call, textResult("done"));
      const done = store.db.prepare("SELECT * FROM tool_calls WHERE call_id='c1'").get() as Record<
        string,
        unknown
      >;
      expect(done).toMatchObject({ status: "completed", run_id: "r1", name: "write_file" });
      expect(done.ended_at).toEqual(expect.any(Number));
      // Legacy two-argument calls keep working.
      store.beginCall(s, { id: "c2", name: "read_file", arguments: "{}" });
      store.endCall(s, { id: "c2", name: "read_file", arguments: "{}" }, textResult("x"));
      expect(store.callResult(s, "c2")).toEqual(textResult("x"));
    } finally {
      store.close();
    }
  });

  it("pages messages and events by sequence", async () => {
    const store = new SQLiteStore(await tempDb());
    try {
      const s = store.create("/w", "p", "m").id;
      for (let i = 0; i < 5; i++) store.append(s, { role: "user", text: `m${i}` });
      const latest = store.messagesPage(s, { limit: 2 });
      expect(latest.items.map((x) => (x.message as { text: string }).text)).toEqual(["m3", "m4"]);
      expect(latest.hasMore).toBe(true);
      const older = store.messagesPage(s, { before: latest.items[0]?.seq, limit: 10 });
      expect(older.items.map((x) => (x.message as { text: string }).text)).toEqual([
        "m0",
        "m1",
        "m2",
      ]);
      expect(older.hasMore).toBe(false);
      const newer = store.messagesPage(s, { after: older.items[0]?.seq, limit: 2 });
      expect(newer.items.map((x) => (x.message as { text: string }).text)).toEqual(["m1", "m2"]);
      expect(newer.hasMore).toBe(true);

      const e1 = store.event(s, "r1", "run_started", { model: "m" }, { correlationId: "c" });
      const e2 = store.event(s, "r1", "run_completed", { tokens: 1, text: "" });
      const events = store.eventsPage(s, { after: e1 - 1 });
      expect(events.items).toEqual([
        expect.objectContaining({
          eventId: String(e1),
          runId: "r1",
          type: "run_started",
          data: { model: "m" },
          correlationId: "c",
          createdAt: expect.any(Number),
        }),
        expect.objectContaining({ eventId: String(e2), type: "run_completed" }),
      ]);
      expect(store.eventsPage(s, { after: e1 }).items.map((e) => e.eventId)).toEqual([String(e2)]);
    } finally {
      store.close();
    }
  });
});
