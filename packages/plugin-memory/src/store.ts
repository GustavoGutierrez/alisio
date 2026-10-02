import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { SqlDatabase } from "@alisio/sdk";
import { ftsQuery, normalizeTopicKey, rankScore, redactPrivate } from "./format.ts";
import type {
  MemoryHit,
  MemoryInput,
  MemoryRecord,
  MemoryScope,
  MemoryStore,
  MemoryType,
  SaveAction,
  SearchOptions,
  SessionRecord,
  SessionRecordsQuery,
  SessionSummary,
} from "./types.ts";

/** Memory schema versions live at 100+ so the file can be shared with the session store. */
const MEMORY_SCHEMA_VERSION = 100;
/** Adds `injected_context` (what the plugin put in a chat when it started). */
const INJECTED_CONTEXT_VERSION = 101;
/** Largest context text kept per session (the 20 000-token budget at 4 characters per token). */
export const MAX_INJECTED_CONTEXT = 80_000;
export const MAX_OBSERVATION_LENGTH = 50_000;
const TRUNCATED = "... [truncated]";
const SNIPPET = 300;

/** Stable project id: `<basename>-<sha256(realpath)[0:8]>` of the git root or cwd. */
export async function projectId(path: string): Promise<string> {
  const real = await realpath(path);
  const name = basename(real).replace(/[^\w.-]/g, "-") || "root";
  return `${name}-${createHash("sha256").update(real).digest("hex").slice(0, 8)}`;
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const cap = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - TRUNCATED.length)}${TRUNCATED}` : text;
interface Row {
  id: number;
  session_id: string | null;
  tool_name: string | null;
  type: MemoryType;
  title: string;
  content: string;
  project: string;
  scope: MemoryScope;
  topic_key: string | null;
  revision_count: number;
  duplicate_count: number;
  access_count: number;
  pinned: number;
  created_at: number;
  updated_at: number;
  rank?: number;
}
const hit = (r: Row): MemoryHit => {
  const flat = r.content.replace(/\s+/g, " ").trim();
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    snippet: flat.length > SNIPPET ? `${flat.slice(0, SNIPPET)}…` : flat,
    scope: r.scope,
    ...(r.topic_key ? { topicKey: r.topic_key } : {}),
    updatedAt: r.updated_at,
    ...(r.pinned ? { pinned: true } : {}),
  };
};
const VISIBLE = "o.deleted_at IS NULL AND (o.project=? OR o.scope='personal')";

export class SQLiteMemoryStore implements MemoryStore {
  readonly db: SqlDatabase;
  private now: () => number;
  private dedupWindowMs: number;
  /** `db` comes from the SDK storage port (`api.storage.sqlite`) or any compatible adapter. */
  constructor(db: SqlDatabase, options: { now?: () => number; dedupWindowMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.dedupWindowMs = options.dedupWindowMs ?? 15 * 60_000;
    this.db = db;
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);",
    );
    this.migrate();
  }
  private applied(version: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
  }
  private migrate(): void {
    if (!this.applied(MEMORY_SCHEMA_VERSION)) this.migrateBase();
    if (!this.applied(INJECTED_CONTEXT_VERSION))
      this.db.transaction(() => {
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS injected_context(session_id TEXT PRIMARY KEY, project TEXT NOT NULL,
             content TEXT NOT NULL, created_at INTEGER NOT NULL);`,
        );
        this.db
          .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?)")
          .run(INJECTED_CONTEXT_VERSION);
      });
  }
  private migrateBase(): void {
    this.db.transaction(() => {
      this.db.exec(`
          CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
            tool_name TEXT, project TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'project',
            topic_key TEXT, normalized_hash TEXT NOT NULL,
            revision_count INTEGER NOT NULL DEFAULT 1, duplicate_count INTEGER NOT NULL DEFAULT 1,
            last_seen_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
            access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at INTEGER,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
          CREATE INDEX IF NOT EXISTS observations_recent ON observations(project, deleted_at, updated_at DESC);
          CREATE INDEX IF NOT EXISTS observations_topic ON observations(scope, topic_key, project) WHERE topic_key IS NOT NULL;
          CREATE INDEX IF NOT EXISTS observations_hash ON observations(normalized_hash, project);
          CREATE INDEX IF NOT EXISTS observations_session ON observations(session_id, created_at);
          CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(title, content, tool_name, type,
            project, topic_key, content='observations', content_rowid='id', tokenize='trigram');
          CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
            INSERT INTO observations_fts(rowid,title,content,tool_name,type,project,topic_key)
            VALUES(new.id,new.title,new.content,new.tool_name,new.type,new.project,new.topic_key); END;
          CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts,rowid,title,content,tool_name,type,project,topic_key)
            VALUES('delete',old.id,old.title,old.content,old.tool_name,old.type,old.project,old.topic_key); END;
          CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE OF title,content,tool_name,type,project,topic_key
            ON observations BEGIN
            INSERT INTO observations_fts(observations_fts,rowid,title,content,tool_name,type,project,topic_key)
            VALUES('delete',old.id,old.title,old.content,old.tool_name,old.type,old.project,old.topic_key);
            INSERT INTO observations_fts(rowid,title,content,tool_name,type,project,topic_key)
            VALUES(new.id,new.title,new.content,new.tool_name,new.type,new.project,new.topic_key); END;
          CREATE TABLE IF NOT EXISTS memory_sessions(id TEXT PRIMARY KEY, project TEXT NOT NULL,
            directory TEXT, started_at INTEGER, ended_at INTEGER, summary TEXT);
          CREATE INDEX IF NOT EXISTS memory_sessions_recent ON memory_sessions(project, ended_at DESC);
          CREATE TABLE IF NOT EXISTS user_prompts(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
            content TEXT NOT NULL, project TEXT NOT NULL, created_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS user_prompts_recent ON user_prompts(project, created_at DESC);`);
      this.db
        .prepare("INSERT OR IGNORE INTO schema_migrations VALUES(?)")
        .run(MEMORY_SCHEMA_VERSION);
    });
  }
  save(input: MemoryInput): { id: number; action: SaveAction } {
    const now = this.now();
    const title = cap(redactPrivate(input.title).trim(), 200);
    const content = cap(redactPrivate(input.content).trim(), MAX_OBSERVATION_LENGTH);
    if (!title || !content) throw new Error("Memory title and content are required");
    const hash = createHash("sha256").update(normalize(content)).digest("hex");
    const topicKey = input.topicKey ? normalizeTopicKey(input.topicKey) : undefined;
    return this.db.transaction((): { id: number; action: SaveAction } => {
      const bump = (id: number) => {
        this.db
          .prepare(
            "UPDATE observations SET duplicate_count=duplicate_count+1, last_seen_at=?, updated_at=? WHERE id=?",
          )
          .run(now, now, id);
        return { id, action: "duplicate" as const };
      };
      if (topicKey) {
        // Personal memories upsert across projects; project ones within the project.
        const existing = this.db
          .prepare(
            `SELECT id, normalized_hash, title FROM observations WHERE deleted_at IS NULL AND scope=? AND topic_key=?
               AND (scope='personal' OR project=?) ORDER BY updated_at DESC LIMIT 1`,
          )
          .get(input.scope, topicKey, input.project) as {
          id: number;
          normalized_hash: string;
          title: string;
        } | null;
        if (existing) {
          if (existing.normalized_hash === hash && existing.title === title)
            return bump(existing.id);
          this.db
            .prepare(
              `UPDATE observations SET title=?, type=?, content=?, normalized_hash=?, session_id=?, tool_name=?,
                 revision_count=revision_count+1, last_seen_at=?, updated_at=? WHERE id=?`,
            )
            .run(
              title,
              input.type,
              content,
              hash,
              input.session ?? null,
              input.source ?? null,
              now,
              now,
              existing.id,
            );
          return { id: existing.id, action: "updated" };
        }
      }
      const duplicate = this.db
        .prepare(
          `SELECT id FROM observations WHERE deleted_at IS NULL AND normalized_hash=? AND project=? AND scope=?
             AND type=? AND title=? AND updated_at>=? ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(hash, input.project, input.scope, input.type, title, now - this.dedupWindowMs) as {
        id: number;
      } | null;
      if (duplicate) return bump(duplicate.id);
      const row = this.db
        .prepare(
          `INSERT INTO observations(session_id,type,title,content,tool_name,project,scope,topic_key,normalized_hash,
             last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        )
        .get(
          input.session ?? null,
          input.type,
          title,
          content,
          input.source ?? null,
          input.project,
          input.scope,
          topicKey ?? null,
          hash,
          now,
          now,
          now,
        ) as { id: number };
      return { id: row.id, action: "created" };
    });
  }
  search(project: string, query: string, options: SearchOptions = {}): MemoryHit[] {
    const match = ftsQuery(query, options.mode ?? "all");
    if (!match) return [];
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 20);
    const where = [
      "observations_fts MATCH ?",
      "o.deleted_at IS NULL",
      ...(options.allProjects ? [] : ["(o.project=? OR o.scope='personal')"]),
      ...(options.type ? ["o.type=?"] : []),
      ...(options.scope ? ["o.scope=?"] : []),
    ];
    const params = [
      match,
      ...(options.allProjects ? [] : [project]),
      ...(options.type ? [options.type] : []),
      ...(options.scope ? [options.scope] : []),
    ];
    const rows = this.db
      .prepare(
        `SELECT o.*, bm25(observations_fts, 5.0, 1.0, 0.5, 0.5, 0.2, 2.0) AS rank FROM observations_fts
         JOIN observations o ON o.id = observations_fts.rowid WHERE ${where.join(" AND ")} ORDER BY rank LIMIT 100`,
      )
      .all(...params) as Row[];
    const now = this.now();
    return rows
      .map((r) => ({ r, score: rankScore(r.rank ?? 0, r.updated_at, r.access_count, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ r }) => hit(r));
  }
  recent(project: string, limit = 10): MemoryHit[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM observations o WHERE ${VISIBLE} ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(project, Math.min(Math.max(limit, 1), 50)) as Row[]
    ).map(hit);
  }
  pinned(project: string, limit = 10): MemoryHit[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM observations o WHERE ${VISIBLE} AND pinned=1 ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(project, Math.min(Math.max(limit, 1), 50)) as Row[]
    ).map(hit);
  }
  get(id: number, project: string): MemoryRecord | undefined {
    const r = this.db
      .prepare(`SELECT * FROM observations o WHERE id=? AND ${VISIBLE}`)
      .get(id, project) as Row | null;
    if (!r) return undefined;
    const now = this.now();
    this.db
      .prepare("UPDATE observations SET access_count=access_count+1, last_accessed_at=? WHERE id=?")
      .run(now, id);
    return {
      id: r.id,
      project: r.project,
      scope: r.scope,
      type: r.type,
      title: r.title,
      content: r.content,
      ...(r.topic_key ? { topicKey: r.topic_key } : {}),
      ...(r.session_id ? { session: r.session_id } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      revisionCount: r.revision_count,
      duplicateCount: r.duplicate_count,
      accessCount: r.access_count + 1,
      pinned: !!r.pinned,
    };
  }
  timeline(id: number, project: string, before = 3, after = 3): MemoryHit[] {
    const anchor = this.db
      .prepare(`SELECT * FROM observations o WHERE id=? AND ${VISIBLE}`)
      .get(id, project) as Row | null;
    if (!anchor) return [];
    const b = Math.min(Math.max(before, 0), 10),
      a = Math.min(Math.max(after, 0), 10);
    const scope = anchor.session_id ? "o.session_id=?" : "o.project=?";
    const key = anchor.session_id ?? anchor.project;
    const older = this.db
      .prepare(
        `SELECT * FROM observations o WHERE ${VISIBLE} AND ${scope} AND (o.created_at<? OR (o.created_at=? AND o.id<?))
         ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
      )
      .all(project, key, anchor.created_at, anchor.created_at, id, b) as Row[];
    const newer = this.db
      .prepare(
        `SELECT * FROM observations o WHERE ${VISIBLE} AND ${scope} AND (o.created_at>? OR (o.created_at=? AND o.id>?))
         ORDER BY o.created_at, o.id LIMIT ?`,
      )
      .all(project, key, anchor.created_at, anchor.created_at, id, a) as Row[];
    return [...older.reverse(), anchor, ...newer].map(hit);
  }
  pin(id: number, project: string, pinned: boolean): boolean {
    return (
      this.db
        .prepare(
          `UPDATE observations SET pinned=? WHERE id IN (SELECT id FROM observations o WHERE id=? AND ${VISIBLE})`,
        )
        .run(pinned ? 1 : 0, id, project).changes > 0
    );
  }
  forget(id: number, project: string, hard = false): boolean {
    const visible = `id IN (SELECT id FROM observations o WHERE id=? AND ${VISIBLE})`;
    return hard
      ? this.db.prepare(`DELETE FROM observations WHERE ${visible}`).run(id, project).changes > 0
      : this.db
          .prepare(`UPDATE observations SET deleted_at=? WHERE ${visible}`)
          .run(this.now(), id, project).changes > 0;
  }
  count(project: string): { project: number; personal: number } {
    const row = this.db
      .prepare(
        `SELECT SUM(scope='project' AND project=?) AS p, SUM(scope='personal') AS s FROM observations
         WHERE deleted_at IS NULL`,
      )
      .get(project) as { p: number | null; s: number | null };
    return { project: row.p ?? 0, personal: row.s ?? 0 };
  }
  recordPrompt(project: string, session: string, content: string): void {
    const text = cap(redactPrivate(content).trim(), 2_000);
    if (!text) return;
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO memory_sessions(id,project,started_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(session, project, now);
    this.db
      .prepare("INSERT INTO user_prompts(session_id,content,project,created_at) VALUES(?,?,?,?)")
      .run(session, text, project, now);
  }
  recentPrompts(project: string, limit = 5) {
    return (
      this.db
        .prepare(
          "SELECT session_id, content, created_at FROM user_prompts WHERE project=? ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(project, Math.min(Math.max(limit, 1), 50)) as {
        session_id: string;
        content: string;
        created_at: number;
      }[]
    ).map((r) => ({ session: r.session_id, content: r.content, createdAt: r.created_at }));
  }
  saveSummary(project: string, session: string, content: string): string {
    const now = this.now();
    const stored = cap(redactPrivate(content).trim(), MAX_OBSERVATION_LENGTH);
    this.db
      .prepare(
        `INSERT INTO memory_sessions(id,project,started_at,ended_at,summary) VALUES(?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET summary=excluded.summary, ended_at=excluded.ended_at`,
      )
      .run(session, project, now, now, stored);
    return stored;
  }
  lastSummary(project: string): SessionSummary | undefined {
    const row = this.db
      .prepare(
        "SELECT id, project, summary, ended_at FROM memory_sessions WHERE project=? AND summary IS NOT NULL ORDER BY ended_at DESC LIMIT 1",
      )
      .get(project) as { id: string; project: string; summary: string; ended_at: number } | null;
    return row
      ? { project: row.project, session: row.id, content: row.summary, createdAt: row.ended_at }
      : undefined;
  }
  recordsOfSession(
    project: string,
    session: string,
    query: SessionRecordsQuery,
  ): { items: SessionRecord[]; total: number; hasMore: boolean } {
    const like = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    const filters = [
      "o.session_id=?",
      VISIBLE,
      ...(query.type ? ["o.type=?"] : []),
      ...(query.text
        ? [
            "(o.title LIKE ? ESCAPE '\\' OR o.content LIKE ? ESCAPE '\\' OR COALESCE(o.topic_key,'') LIKE ? ESCAPE '\\')",
          ]
        : []),
    ];
    const params: Array<string | number> = [
      session,
      project,
      ...(query.type ? [query.type] : []),
      ...(query.text ? [like(query.text), like(query.text), like(query.text)] : []),
    ];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM observations o WHERE ${filters.join(" AND ")}`)
        .get(...params) as { n: number }
    ).n;
    const after = query.after;
    const page = after
      ? [
          ...filters,
          "(o.pinned<? OR (o.pinned=? AND o.updated_at<?) OR (o.pinned=? AND o.updated_at=? AND o.id<?))",
        ]
      : filters;
    const pageParams = after
      ? [
          ...params,
          after.pinned,
          after.pinned,
          after.updatedAt,
          after.pinned,
          after.updatedAt,
          after.id,
        ]
      : params;
    const limit = Math.min(Math.max(query.limit, 1), 50);
    const rows = this.db
      .prepare(
        `SELECT o.* FROM observations o WHERE ${page.join(" AND ")}
         ORDER BY o.pinned DESC, o.updated_at DESC, o.id DESC LIMIT ?`,
      )
      .all(...pageParams, limit + 1) as Row[];
    return {
      total,
      hasMore: rows.length > limit,
      items: rows.slice(0, limit).map(
        (r): SessionRecord => ({
          id: r.id,
          type: r.type,
          title: r.title,
          content: r.content,
          scope: r.scope,
          ...(r.topic_key ? { topicKey: r.topic_key } : {}),
          ...(r.tool_name ? { source: r.tool_name } : {}),
          pinned: !!r.pinned,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          revisionCount: r.revision_count,
          duplicateCount: r.duplicate_count,
        }),
      ),
    };
  }
  summaryRow(project: string, session: string) {
    const row = this.db
      .prepare(
        "SELECT summary, ended_at FROM memory_sessions WHERE id=? AND project=? AND summary IS NOT NULL",
      )
      .get(session, project) as { summary: string; ended_at: number | null } | null;
    return row ? { content: row.summary, updatedAt: row.ended_at ?? 0 } : undefined;
  }
  saveInjectedContext(project: string, session: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO injected_context(session_id,project,content,created_at) VALUES(?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET project=excluded.project, content=excluded.content,
           created_at=excluded.created_at`,
      )
      .run(session, project, cap(content, MAX_INJECTED_CONTEXT), this.now());
  }
  injectedContext(project: string, session: string) {
    const row = this.db
      .prepare("SELECT content, created_at FROM injected_context WHERE session_id=? AND project=?")
      .get(session, project) as { content: string; created_at: number } | null;
    return row ? { content: row.content, injectedAt: row.created_at } : undefined;
  }
  /** Session summary of one session, used to confirm an archive write. */
  summaryOf(session: string): string | undefined {
    const row = this.db.prepare("SELECT summary FROM memory_sessions WHERE id=?").get(session) as {
      summary: string | null;
    } | null;
    return row?.summary ?? undefined;
  }
  close(): void {
    this.db.close();
  }
}
