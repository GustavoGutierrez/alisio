import {
  type Message,
  type SqlDatabase,
  type ToolCall,
  type ToolResult,
  textResult,
} from "@alisio/sdk";
import type { Session, SessionStore } from "../core/contracts.ts";
import { openDatabase } from "./sqlite.ts";
export class SQLiteStore implements SessionStore {
  readonly db: SqlDatabase;
  constructor(path: string) {
    this.db = openDatabase(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_migrations VALUES(1);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,workspace TEXT,provider TEXT,model TEXT,locked_pid INTEGER);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT REFERENCES sessions(id),body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_calls(session TEXT,call_id TEXT,status TEXT,result TEXT,PRIMARY KEY(session,call_id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,run_id TEXT,type TEXT,body TEXT);
      CREATE TABLE IF NOT EXISTS plugin_state(plugin TEXT,key TEXT,value TEXT,PRIMARY KEY(plugin,key));`);
    this.migrate();
  }
  /** Forward-only, idempotent migrations. Existing databases keep all rows. */
  private migrate(): void {
    const has = (version: number) =>
      !!this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
    if (!has(2))
      this.db.transaction(() => {
        const columns = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
        // Compacted rows stay for audit but are excluded from the active conversation.
        if (!columns.some((c) => c.name === "compacted"))
          this.db.exec("ALTER TABLE messages ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0");
        this.db.exec("INSERT OR IGNORE INTO schema_migrations VALUES(2)");
      });
  }
  create(workspace: string, provider: string, model: string): Session {
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO sessions(id,workspace,provider,model) VALUES(?,?,?,?)")
      .run(id, workspace, provider, model);
    return { id, workspace, provider, model };
  }
  get(id: string): Session {
    const row = this.db
      .prepare("SELECT id,workspace,provider,model FROM sessions WHERE id=?")
      .get(id) as Session | null;
    if (!row) throw new Error(`Session not found: ${id}`);
    return row;
  }
  list(): Session[] {
    return this.db
      .prepare("SELECT id,workspace,provider,model FROM sessions ORDER BY rowid DESC")
      .all() as Session[];
  }
  messages(id: string): Message[] {
    return (
      this.db
        .prepare("SELECT body FROM messages WHERE session=? AND compacted=0 ORDER BY seq")
        .all(id) as {
        body: string;
      }[]
    ).map((x) => JSON.parse(x.body));
  }
  append(id: string, message: Message): void {
    this.db
      .prepare("INSERT INTO messages(session,body) VALUES(?,?)")
      .run(id, JSON.stringify(message));
  }
  setModel(id: string, model: string): void {
    if (!model.trim()) throw new Error("Model ID must not be empty");
    this.get(id);
    this.db.prepare("UPDATE sessions SET model=? WHERE id=?").run(model, id);
  }
  compact(id: string, replaced: number, summary: Message): void {
    this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT seq,body FROM messages WHERE session=? AND compacted=0 ORDER BY seq")
        .all(id) as { seq: number; body: string }[];
      if (replaced < 1 || replaced > rows.length)
        throw new Error("Compaction range does not match the active history");
      // Keep ordering by seq: retire every active row, then write summary + kept copies.
      this.db.prepare("UPDATE messages SET compacted=1 WHERE session=? AND compacted=0").run(id);
      this.append(id, summary);
      for (const row of rows.slice(replaced))
        this.db.prepare("INSERT INTO messages(session,body) VALUES(?,?)").run(id, row.body);
    });
  }
  acquire(id: string): void {
    this.db.transaction(() => {
      this.get(id);
      const row = this.db.prepare("SELECT locked_pid FROM sessions WHERE id=?").get(id) as {
        locked_pid: number | null;
      };
      if (row.locked_pid) {
        let alive = true;
        try {
          process.kill(row.locked_pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive) throw new Error("Session is already in use");
      }
      this.db.prepare("UPDATE sessions SET locked_pid=? WHERE id=?").run(process.pid, id);
    });
  }
  release(id: string): void {
    this.db
      .prepare("UPDATE sessions SET locked_pid=NULL WHERE id=? AND locked_pid=?")
      .run(id, process.pid);
  }
  beginCall(id: string, call: ToolCall): void {
    this.db
      .prepare("INSERT INTO tool_calls(session,call_id,status) VALUES(?,?,'pending')")
      .run(id, call.id);
  }
  endCall(id: string, call: ToolCall, result: ToolResult): void {
    this.db
      .prepare(
        "INSERT INTO tool_calls(session,call_id,status,result) VALUES(?,?,'completed',?) ON CONFLICT(session,call_id) DO UPDATE SET status='completed',result=excluded.result",
      )
      .run(id, call.id, JSON.stringify(result));
  }
  reconcile(id: string, acknowledge = false): void {
    this.db.transaction(() => {
      const messages = this.messages(id);
      const done = new Set(messages.filter((m) => m.role === "tool").map((m) => m.callId));
      for (const m of messages) {
        if (m.role !== "assistant") continue;
        for (const call of m.calls) {
          if (done.has(call.id)) continue;
          const row = this.db
            .prepare("SELECT status,result FROM tool_calls WHERE session=? AND call_id=?")
            .get(id, call.id) as { status: string; result: string | null } | null;
          if (row?.status === "pending" && !acknowledge)
            throw new Error(
              `Uncertain tool outcome ${call.id}. Inspect effects, then use sessions recover ${id} --acknowledge`,
            );
          const result: ToolResult =
            row?.status === "completed" && row.result
              ? JSON.parse(row.result)
              : textResult(
                  row
                    ? "Previous execution outcome is uncertain; user acknowledged it. Do not repeat automatically."
                    : "Previous run stopped before this tool was executed.",
                  true,
                );
          this.endCall(id, call, result);
          this.append(id, { role: "tool", callId: call.id, result });
        }
      }
    });
  }
  event(id: string, runId: string, type: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO events(session,run_id,type,body) VALUES(?,?,?,?)")
      .run(id, runId, type, JSON.stringify(data));
  }
  getState(plugin: string, key: string): unknown {
    const row = this.db
      .prepare("SELECT value FROM plugin_state WHERE plugin=? AND key=?")
      .get(plugin, key) as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  }
  setState(plugin: string, key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO plugin_state VALUES(?,?,?) ON CONFLICT(plugin,key) DO UPDATE SET value=excluded.value",
      )
      .run(plugin, key, JSON.stringify(value));
  }
  close(): void {
    this.db.close();
  }
}
