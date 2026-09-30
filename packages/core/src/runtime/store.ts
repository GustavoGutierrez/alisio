import {
  type Message,
  type SqlDatabase,
  type ToolCall,
  type ToolResult,
  textResult,
} from "@alisio/sdk";
import type {
  BeginRunInput,
  EndRunInput,
  EventPage,
  MessagePage,
  PageOptions,
  RunRecord,
  RunStatus,
  Session,
  SessionStore,
  StoredEvent,
  ToolCallMeta,
} from "../core/contracts.ts";
import { openDatabase } from "./sqlite.ts";

/** Whether a process id belongs to a live process (EPERM still means alive). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
const TERMINAL_RUN = "('completed','turns_exceeded','failed','cancelled','interrupted')";
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
    if (!has(3))
      this.db.transaction(() => {
        // Child sessions: parent link, depth, agent label, lifecycle status, usage and spec.
        const columns = new Set(
          (this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map(
            (c) => c.name,
          ),
        );
        const add = (name: string, type: string) => {
          if (!columns.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
        };
        add("parent_id", "TEXT");
        add("depth", "INTEGER NOT NULL DEFAULT 0");
        add("agent", "TEXT");
        add("status", "TEXT");
        add("title", "TEXT");
        add("usage", "TEXT");
        add("options", "TEXT");
        add("created_at", "INTEGER");
        add("updated_at", "INTEGER");
        this.db.exec("CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id)");
        this.db.exec("INSERT OR IGNORE INTO schema_migrations VALUES(3)");
      });
    if (!has(4))
      this.db.transaction(() => {
        // v4 (additive): run journal, workspace UI metadata, blob index and nullable columns.
        this.db.exec(`CREATE TABLE IF NOT EXISTS runs(
            id TEXT PRIMARY KEY,
            session TEXT NOT NULL REFERENCES sessions(id),
            status TEXT NOT NULL,
            request_id TEXT,
            correlation_id TEXT,
            owner_pid INTEGER,
            model TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            error TEXT,
            usage TEXT);
          CREATE UNIQUE INDEX IF NOT EXISTS runs_request ON runs(session, request_id) WHERE request_id IS NOT NULL;
          CREATE INDEX IF NOT EXISTS runs_session ON runs(session, created_at);
          CREATE TABLE IF NOT EXISTS workspaces(
            path TEXT PRIMARY KEY,
            label TEXT,
            pinned INTEGER NOT NULL DEFAULT 0,
            last_opened_at INTEGER);
          CREATE TABLE IF NOT EXISTS blobs(
            hash TEXT PRIMARY KEY,
            mime TEXT NOT NULL,
            size INTEGER NOT NULL,
            width INTEGER,
            height INTEGER,
            created_at INTEGER NOT NULL);`);
        const add = (table: string, name: string, type: string) => {
          const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
          }[];
          if (!columns.some((c) => c.name === name))
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        };
        add("sessions", "pinned", "INTEGER NOT NULL DEFAULT 0");
        add("sessions", "archived_at", "INTEGER");
        add("events", "created_at", "INTEGER");
        add("events", "correlation_id", "TEXT");
        add("tool_calls", "run_id", "TEXT");
        add("tool_calls", "name", "TEXT");
        add("tool_calls", "effect", "TEXT");
        add("tool_calls", "started_at", "INTEGER");
        add("tool_calls", "ended_at", "INTEGER");
        this.db.exec(`CREATE INDEX IF NOT EXISTS events_session ON events(session, seq);
          CREATE INDEX IF NOT EXISTS messages_session ON messages(session, seq);
          INSERT OR IGNORE INTO schema_migrations VALUES(4);`);
      });
  }
  create(workspace: string, provider: string, model: string): Session {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions(id,workspace,provider,model,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, workspace, provider, model, now, now);
    return { id, workspace, provider, model };
  }
  private row(r: Record<string, unknown>): Session {
    return {
      id: String(r.id),
      workspace: String(r.workspace),
      provider: String(r.provider),
      model: String(r.model),
      ...(r.parent_id ? { parentId: String(r.parent_id) } : {}),
      ...(r.parent_id ? { depth: Number(r.depth ?? 0) } : {}),
      ...(r.agent ? { agent: String(r.agent) } : {}),
      ...(r.status ? { status: r.status as Session["status"] } : {}),
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.usage ? { usage: JSON.parse(String(r.usage)) } : {}),
      ...(r.options ? { options: JSON.parse(String(r.options)) } : {}),
      ...(r.created_at ? { createdAt: Number(r.created_at) } : {}),
      ...(r.updated_at ? { updatedAt: Number(r.updated_at) } : {}),
      ...(r.pinned ? { pinned: true } : {}),
      ...(r.archived_at ? { archivedAt: Number(r.archived_at) } : {}),
    };
  }
  get(id: string): Session {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    return this.row(row);
  }
  /** Root sessions (children are listed through `children`). */
  list(): Session[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE parent_id IS NULL ORDER BY rowid DESC")
      .all()
      .map((r) => this.row(r));
  }
  createChild(record: import("../core/contracts.ts").ChildSessionRecord): Session {
    const id = record.id ?? crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions(id,workspace,provider,model,parent_id,depth,agent,status,title,usage,options,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?)`,
      )
      .run(
        id,
        record.workspace,
        record.provider,
        record.model,
        record.parentId,
        record.depth,
        record.agent,
        record.title,
        JSON.stringify({ input: 0, output: 0 }),
        JSON.stringify(record.options),
        now,
        now,
      );
    return this.get(id);
  }
  children(parentId: string): Session[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE parent_id=? ORDER BY created_at, rowid")
      .all(parentId)
      .map((r) => this.row(r));
  }
  updateSession(
    id: string,
    patch: { status?: Session["status"]; usage?: { input: number; output: number } },
  ): void {
    if (patch.status)
      this.db
        .prepare("UPDATE sessions SET status=?, updated_at=? WHERE id=?")
        .run(patch.status, Date.now(), id);
    if (patch.usage)
      this.db
        .prepare("UPDATE sessions SET usage=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(patch.usage), Date.now(), id);
  }
  updateBinding(id: string, provider: string, model: string): void {
    if (!provider.trim() || !model.trim()) throw new Error("Provider and model must not be empty");
    this.get(id);
    this.db
      .prepare("UPDATE sessions SET provider=?, model=?, updated_at=? WHERE id=?")
      .run(provider, model, Date.now(), id);
  }
  interruptStale(): number {
    let count = 0;
    const rows = this.db
      .prepare("SELECT id, locked_pid FROM sessions WHERE status IN ('queued','running')")
      .all() as { id: string; locked_pid: number | null }[];
    for (const row of rows) {
      if (row.locked_pid && row.locked_pid !== process.pid) {
        try {
          process.kill(row.locked_pid, 0);
          continue; // Another live process owns it.
        } catch {
          /* dead owner */
        }
      }
      if (row.locked_pid === process.pid) continue;
      this.updateSession(row.id, { status: "interrupted" });
      count++;
    }
    return count;
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
    this.touch(id);
  }
  private touch(id: string): void {
    this.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(Date.now(), id);
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
  overwrite(id: string, messages: Message[]): void {
    this.db.transaction(() => {
      // Retire the active rows (originals stay marked compacted for auditing), then rewrite
      // the reduced transcript in the same order.
      this.db.prepare("UPDATE messages SET compacted=1 WHERE session=? AND compacted=0").run(id);
      for (const message of messages) this.append(id, message);
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
  beginCall(id: string, call: ToolCall, meta: ToolCallMeta = {}): void {
    this.db
      .prepare(
        "INSERT INTO tool_calls(session,call_id,status,run_id,name,effect,started_at) VALUES(?,?,'pending',?,?,?,?)",
      )
      .run(id, call.id, meta.runId ?? null, call.name, meta.effect ?? null, Date.now());
  }
  endCall(id: string, call: ToolCall, result: ToolResult): void {
    this.db
      .prepare(
        "INSERT INTO tool_calls(session,call_id,status,result,name,ended_at) VALUES(?,?,'completed',?,?,?) ON CONFLICT(session,call_id) DO UPDATE SET status='completed',result=excluded.result,ended_at=excluded.ended_at,name=COALESCE(tool_calls.name,excluded.name)",
      )
      .run(id, call.id, JSON.stringify(result), call.name, Date.now());
  }
  /**
   * Calls of a session with one effect (for example `write`), oldest first. Needs the v4
   * `effect`/`run_id`/`started_at` columns; rows written by older versions have no effect.
   */
  effectCalls(
    session: string,
    effect: string,
  ): Array<{ callId: string; name: string; runId?: string; startedAt?: number }> {
    const rows = this.db
      .prepare(
        "SELECT call_id,name,run_id,started_at FROM tool_calls WHERE session=? AND effect=? ORDER BY started_at, rowid",
      )
      .all(session, effect) as Array<{
      call_id: string;
      name: string | null;
      run_id: string | null;
      started_at: number | null;
    }>;
    return rows.map((row) => ({
      callId: row.call_id,
      name: row.name ?? "",
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.started_at != null ? { startedAt: Number(row.started_at) } : {}),
    }));
  }
  /** Rich (ui/image) parts persist as part of the serialized result and replay verbatim. */
  callResult(id: string, callId: string): ToolResult | undefined {
    const row = this.db
      .prepare("SELECT result FROM tool_calls WHERE session=? AND call_id=? AND status='completed'")
      .get(id, callId) as { result: string | null } | null;
    return row?.result ? (JSON.parse(row.result) as ToolResult) : undefined;
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
  /** Persists a durable event and returns its global `events.seq`. */
  event(
    id: string,
    runId: string,
    type: string,
    data: unknown,
    meta: { correlationId?: string } = {},
  ): number {
    const { lastInsertRowid } = this.db
      .prepare(
        "INSERT INTO events(session,run_id,type,body,created_at,correlation_id) VALUES(?,?,?,?,?,?)",
      )
      .run(id, runId, type, JSON.stringify(data), Date.now(), meta.correlationId ?? null);
    return Number(lastInsertRowid);
  }
  private runRow(r: Record<string, unknown>): RunRecord {
    return {
      id: String(r.id),
      session: String(r.session),
      status: r.status as RunStatus,
      ...(r.request_id != null ? { requestId: String(r.request_id) } : {}),
      ...(r.correlation_id != null ? { correlationId: String(r.correlation_id) } : {}),
      ...(r.owner_pid != null ? { ownerPid: Number(r.owner_pid) } : {}),
      ...(r.model != null ? { model: String(r.model) } : {}),
      createdAt: Number(r.created_at),
      ...(r.started_at != null ? { startedAt: Number(r.started_at) } : {}),
      ...(r.ended_at != null ? { endedAt: Number(r.ended_at) } : {}),
      ...(r.error != null ? { error: String(r.error) } : {}),
      ...(r.usage != null ? { usage: JSON.parse(String(r.usage)) } : {}),
    };
  }
  private runById(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    return row ? this.runRow(row) : undefined;
  }
  beginRun(input: BeginRunInput): { run: RunRecord; created: boolean } {
    return this.db.transaction(() => {
      const status = input.status ?? "running";
      const now = Date.now();
      const existing = this.runById(input.id);
      if (existing) {
        if (existing.status === "queued" && status === "running")
          this.db
            .prepare(
              "UPDATE runs SET status='running', started_at=?, owner_pid=?, model=COALESCE(?,model) WHERE id=?",
            )
            .run(now, process.pid, input.model ?? null, input.id);
        return { run: this.runById(input.id) as RunRecord, created: false };
      }
      if (input.requestId !== undefined) {
        const retried = this.runByRequest(input.session, input.requestId);
        if (retried) return { run: retried, created: false };
      }
      this.db
        .prepare(
          `INSERT INTO runs(id,session,status,request_id,correlation_id,owner_pid,model,created_at,started_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.session,
          status,
          input.requestId ?? null,
          input.correlationId ?? null,
          process.pid,
          input.model ?? null,
          now,
          status === "running" ? now : null,
        );
      return { run: this.runById(input.id) as RunRecord, created: true };
    });
  }
  endRun(id: string, input: EndRunInput): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE runs SET status=?, ended_at=?, error=?, usage=COALESCE(?,usage)
           WHERE id=? AND status NOT IN ${TERMINAL_RUN}`,
        )
        .run(
          input.status,
          now,
          input.error ?? null,
          input.usage ? JSON.stringify(input.usage) : null,
          id,
        );
      const run = this.runById(id);
      if (run) this.touch(run.session);
    });
  }
  runByRequest(session: string, requestId: string): RunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE session=? AND request_id=?")
      .get(session, requestId);
    return row ? this.runRow(row) : undefined;
  }
  runs(session: string, options: { limit?: number } = {}): RunRecord[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE session=? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(session, options.limit ?? 100)
      .map((r) => this.runRow(r));
  }
  interruptRuns(): number {
    const rows = this.db
      .prepare("SELECT id, owner_pid FROM runs WHERE status IN ('queued','running')")
      .all() as { id: string; owner_pid: number | null }[];
    let count = 0;
    for (const row of rows) {
      // Runs of this process (another Application in it) or of another live process stay.
      if (row.owner_pid && (row.owner_pid === process.pid || alive(row.owner_pid))) continue;
      this.endRun(row.id, { status: "interrupted" });
      count++;
    }
    return count;
  }
  /**
   * A page of messages by `seq`. With `after`, the first `limit` rows after it; otherwise the
   * newest `limit` rows (before `before` when given). Items are always in ascending order.
   */
  messagesPage(session: string, options: PageOptions & { compacted?: boolean } = {}): MessagePage {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const active = options.compacted ? "" : " AND compacted=0";
    const rows = (
      options.after !== undefined
        ? this.db
            .prepare(
              `SELECT seq,body,compacted FROM messages WHERE session=? AND seq>?${active} ORDER BY seq LIMIT ?`,
            )
            .all(session, options.after, limit + 1)
        : this.db
            .prepare(
              `SELECT seq,body,compacted FROM messages WHERE session=? AND seq<?${active} ORDER BY seq DESC LIMIT ?`,
            )
            .all(session, options.before ?? Number.MAX_SAFE_INTEGER, limit + 1)
    ) as { seq: number; body: string; compacted: number }[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    if (options.after === undefined) page.reverse();
    return {
      items: page.map((r) => ({
        seq: Number(r.seq),
        message: JSON.parse(r.body) as Message,
        compacted: !!r.compacted,
      })),
      hasMore,
    };
  }
  /** Durable events of a session after `after` (a previous `eventId`), ascending. */
  eventsPage(session: string, options: PageOptions = {}): EventPage {
    const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
    const rows = this.db
      .prepare(
        "SELECT seq,run_id,type,body,created_at,correlation_id FROM events WHERE session=? AND seq>? AND seq<? ORDER BY seq LIMIT ?",
      )
      .all(
        session,
        options.after ?? 0,
        options.before ?? Number.MAX_SAFE_INTEGER,
        limit + 1,
      ) as Record<string, unknown>[];
    return {
      items: rows.slice(0, limit).map(
        (r): StoredEvent => ({
          eventId: String(r.seq),
          runId: String(r.run_id),
          type: String(r.type),
          data: r.body == null ? undefined : JSON.parse(String(r.body)),
          ...(r.created_at != null ? { createdAt: Number(r.created_at) } : {}),
          ...(r.correlation_id != null ? { correlationId: String(r.correlation_id) } : {}),
        }),
      ),
      hasMore: rows.length > limit,
    };
  }
  /**
   * Known workspaces for web clients: the workspaces of root sessions plus the ones recorded with
   * `recordWorkspace` (v4 `workspaces` table), with their UI metadata and root-session count.
   */
  workspaces(): Array<{
    path: string;
    label?: string;
    pinned: boolean;
    lastOpenedAt?: number;
    sessions: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT p.path, w.label, COALESCE(w.pinned, 0) AS pinned, w.last_opened_at,
           (SELECT count(*) FROM sessions s WHERE s.workspace=p.path AND s.parent_id IS NULL) AS sessions
         FROM (SELECT workspace AS path FROM sessions WHERE parent_id IS NULL AND workspace IS NOT NULL
               UNION SELECT path FROM workspaces) p
         LEFT JOIN workspaces w ON w.path=p.path
         ORDER BY p.path`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      path: String(r.path),
      ...(r.label != null ? { label: String(r.label) } : {}),
      pinned: !!r.pinned,
      ...(r.last_opened_at != null ? { lastOpenedAt: Number(r.last_opened_at) } : {}),
      sessions: Number(r.sessions ?? 0),
    }));
  }
  /** Records a workspace and patches its UI metadata (`label: null` clears the label). */
  recordWorkspace(
    path: string,
    patch: { label?: string | null; pinned?: boolean; lastOpenedAt?: number } = {},
  ): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO workspaces(path) VALUES(?)").run(path);
      if (patch.label !== undefined)
        this.db.prepare("UPDATE workspaces SET label=? WHERE path=?").run(patch.label, path);
      if (patch.pinned !== undefined)
        this.db
          .prepare("UPDATE workspaces SET pinned=? WHERE path=?")
          .run(patch.pinned ? 1 : 0, path);
      if (patch.lastOpenedAt !== undefined)
        this.db
          .prepare("UPDATE workspaces SET last_opened_at=? WHERE path=?")
          .run(patch.lastOpenedAt, path);
    });
  }
  /**
   * Patches web-facing session metadata: title, pin, archive flag and `options` (shallow-merged
   * into the stored options object). Does not touch the run-relevant columns.
   */
  updateSessionMeta(
    id: string,
    patch: {
      title?: string | null;
      pinned?: boolean;
      archived?: boolean;
      options?: Record<string, unknown>;
    },
  ): void {
    this.db.transaction(() => {
      const current = this.get(id);
      if (patch.title !== undefined)
        this.db.prepare("UPDATE sessions SET title=? WHERE id=?").run(patch.title, id);
      if (patch.pinned !== undefined)
        this.db.prepare("UPDATE sessions SET pinned=? WHERE id=?").run(patch.pinned ? 1 : 0, id);
      if (patch.archived !== undefined)
        this.db
          .prepare("UPDATE sessions SET archived_at=? WHERE id=?")
          .run(patch.archived ? Date.now() : null, id);
      if (patch.options)
        this.db
          .prepare("UPDATE sessions SET options=? WHERE id=?")
          .run(JSON.stringify({ ...(current.options ?? {}), ...patch.options }), id);
    });
  }
  /** `MAX(events.seq)` of a session (0 without events): the web snapshot cursor. */
  lastEventId(session: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS seq FROM events WHERE session=?")
      .get(session) as { seq: number | null } | undefined;
    return Number(row?.seq ?? 0);
  }
  /** The pid of another live process holding the session lock, if any. */
  lockedBy(id: string): number | undefined {
    const row = this.db.prepare("SELECT locked_pid FROM sessions WHERE id=?").get(id) as
      | { locked_pid: number | null }
      | undefined;
    const pid = row?.locked_pid;
    return pid && pid !== process.pid && alive(pid) ? pid : undefined;
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
