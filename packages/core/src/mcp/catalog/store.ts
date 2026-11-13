/**
 * The local catalog index: its own SQLite database (`<stateHome>/mcp/catalog.sqlite`) with a
 * `schema_migrations` table of its own, FTS5 search and one row per (source, name, version).
 * It knows only the domain model of `source.ts`: every row carries its `sourceId`, queries are
 * always scoped to one source, and rows of a previous source are purged only after the new one
 * synced, so a source switch never mixes data.
 */
import type {
  McpCatalogFacets,
  McpCatalogItem,
  McpCatalogPage,
  SqlDatabase,
  SqlValue,
} from "@alisio/sdk";
import { openDatabase } from "../../runtime/sqlite.ts";
import { assessEntry } from "./availability.ts";
import { CATEGORY_LABELS, type CategoryId, isCategoryId } from "./categories.ts";
import { type CategoryClassifier, fold } from "./classifier.ts";
import type { CatalogEntry, RejectedEntry } from "./source.ts";

export interface CatalogQuery {
  /** Free text; applied from two characters (shorter input shows the plain list). */
  q?: string;
  category?: string;
  execution?: "local" | "remote";
  method?: string;
  /** Only entries that could be installed automatically. */
  ready?: boolean;
  /** `active` (default) hides deprecated entries; `all` shows them with their reason. */
  status?: "active" | "all";
  page?: number;
  pageSize?: number;
}

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;
export const MIN_QUERY_LENGTH = 2;

export interface SourceState {
  id: string;
  baseUrl?: string;
  checkpoint?: string;
  lastSuccess?: string;
  lastAttempt?: string;
  lastError?: { code: string; message: string };
  partial: boolean;
}

export interface AttemptRecord {
  at: string;
  baseUrl?: string;
  /** The walk finished: the checkpoint advances. */
  success?: { checkpoint: string };
  error?: { code: string; message: string };
  partial?: boolean;
}

type Row = Record<string, unknown>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sources(
    id TEXT PRIMARY KEY,
    base_url TEXT,
    adapter_version TEXT,
    checkpoint TEXT,
    last_success TEXT,
    last_attempt TEXT,
    last_error TEXT,
    last_partial INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE catalog_versions(
    source_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL,
    is_latest INTEGER NOT NULL,
    title TEXT,
    description TEXT NOT NULL,
    ready INTEGER NOT NULL,
    blocked_reason TEXT,
    blocked_detail TEXT,
    execution TEXT NOT NULL,
    methods TEXT NOT NULL,
    category_id TEXT NOT NULL,
    category_method TEXT NOT NULL,
    category_confidence REAL NOT NULL,
    taxonomy_version INTEGER NOT NULL,
    published_at TEXT,
    updated_at TEXT,
    fetched_at TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    PRIMARY KEY(source_id, name, version)
  );
  CREATE INDEX catalog_browse ON catalog_versions(source_id, is_latest, status);
  CREATE VIRTUAL TABLE catalog_search USING fts5(
    name, title, description, category,
    tokenize='unicode61 remove_diacritics 2', prefix='2 3'
  );
  CREATE TABLE rejected_entries(
    source_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    schema_version TEXT,
    detail TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY(source_id, name, version)
  );
  `,
];

const intFlag = (v: unknown) => (v ? 1 : 0);
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Turns user input into a safe FTS5 query: quoted prefix tokens, all required. */
export function ftsQuery(input: string): string | undefined {
  const tokens = fold(input)
    .split(" ")
    .filter((t) => t.length > 0)
    .slice(0, 8);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(" ") : undefined;
}

export class CatalogStore {
  constructor(private db: SqlDatabase) {
    this.migrate();
  }

  static open(path: string): CatalogStore {
    return new CatalogStore(openDatabase(path));
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)");
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (this.db.prepare("SELECT 1 AS ok FROM schema_migrations WHERE version=?").get(version))
        return;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(version);
      });
    });
  }

  // ---- sources -------------------------------------------------------------------------------

  getSource(id: string): SourceState | undefined {
    const row = this.db.prepare("SELECT * FROM sources WHERE id=?").get(id);
    if (!row) return undefined;
    let lastError: SourceState["lastError"];
    try {
      lastError = row.last_error
        ? (JSON.parse(String(row.last_error)) as { code: string; message: string })
        : undefined;
    } catch {
      lastError = undefined;
    }
    return {
      id,
      ...(text(row.base_url) ? { baseUrl: text(row.base_url) as string } : {}),
      ...(text(row.checkpoint) ? { checkpoint: text(row.checkpoint) as string } : {}),
      ...(text(row.last_success) ? { lastSuccess: text(row.last_success) as string } : {}),
      ...(text(row.last_attempt) ? { lastAttempt: text(row.last_attempt) as string } : {}),
      ...(lastError ? { lastError } : {}),
      partial: !!row.last_partial,
    };
  }

  recordAttempt(id: string, attempt: AttemptRecord): void {
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO sources(id) VALUES(?) ON CONFLICT(id) DO NOTHING").run(id);
      if (attempt.baseUrl)
        this.db.prepare("UPDATE sources SET base_url=? WHERE id=?").run(attempt.baseUrl, id);
      if (attempt.success)
        this.db
          .prepare(
            "UPDATE sources SET checkpoint=?, last_success=?, last_attempt=?, last_error=NULL, last_partial=0 WHERE id=?",
          )
          .run(attempt.success.checkpoint, attempt.at, attempt.at, id);
      else
        this.db
          .prepare("UPDATE sources SET last_attempt=?, last_error=?, last_partial=? WHERE id=?")
          .run(
            attempt.at,
            attempt.error ? JSON.stringify(attempt.error) : null,
            intFlag(attempt.partial),
            id,
          );
    });
  }

  /** Drops the rows of every source but `keep` (after the active source synced once). */
  purgeOtherSources(keep: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM catalog_search WHERE rowid IN (SELECT rowid FROM catalog_versions WHERE source_id<>?)",
        )
        .run(keep);
      this.db.prepare("DELETE FROM catalog_versions WHERE source_id<>?").run(keep);
      this.db.prepare("DELETE FROM rejected_entries WHERE source_id<>?").run(keep);
      this.db.prepare("DELETE FROM sources WHERE id<>?").run(keep);
    });
  }

  counts(sourceId: string): { entries: number; rejected: number } {
    const entries = this.db
      .prepare(
        "SELECT count(*) AS n FROM catalog_versions WHERE source_id=? AND is_latest=1 AND status<>'deleted'",
      )
      .get(sourceId);
    const rejected = this.db
      .prepare("SELECT count(*) AS n FROM rejected_entries WHERE source_id=?")
      .get(sourceId);
    return { entries: Number(entries?.n ?? 0), rejected: Number(rejected?.n ?? 0) };
  }

  /** Total rows of any source (diagnostics and tests). */
  rowCount(sourceId: string): number {
    return Number(
      this.db.prepare("SELECT count(*) AS n FROM catalog_versions WHERE source_id=?").get(sourceId)
        ?.n ?? 0,
    );
  }

  // ---- writes --------------------------------------------------------------------------------

  /** Upserts one page in a single transaction; idempotent by (source, name, version). */
  applyPage(input: {
    sourceId: string;
    entries: CatalogEntry[];
    rejected: RejectedEntry[];
    classifier: CategoryClassifier;
    fetchedAt: string;
  }): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;
    this.db.transaction(() => {
      for (const entry of input.entries) {
        if (entry.sourceId !== input.sourceId) {
          skipped++;
          continue;
        }
        const existing = this.db
          .prepare(
            "SELECT updated_at AS u, raw_json AS raw FROM catalog_versions WHERE source_id=? AND name=? AND version=?",
          )
          .get(input.sourceId, entry.name, entry.version);
        if (existing && isOlder(entry.updatedAt, text(existing.u))) {
          skipped++;
          continue;
        }
        this.upsert(entry, input.classifier, input.fetchedAt);
        applied++;
      }
      for (const r of input.rejected)
        this.db
          .prepare(
            `INSERT INTO rejected_entries(source_id,name,version,reason,schema_version,detail,fetched_at)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(source_id,name,version) DO UPDATE SET reason=excluded.reason,
               schema_version=excluded.schema_version, detail=excluded.detail, fetched_at=excluded.fetched_at`,
          )
          .run(
            input.sourceId,
            r.name ?? "",
            r.version ?? "",
            r.reason,
            r.schemaVersion ?? null,
            r.detail ?? null,
            input.fetchedAt,
          );
    });
    return { applied, skipped };
  }

  private upsert(entry: CatalogEntry, classifier: CategoryClassifier, fetchedAt: string): void {
    const assessment = assessEntry(entry);
    const category = classifier.classify(entry);
    const { rawJson, ...provenance } = entry.provenance;
    const stored: CatalogEntry = { ...entry, provenance: { ...provenance, rawJson: "" } };
    this.db
      .prepare(
        `INSERT INTO catalog_versions(source_id,name,version,status,is_latest,title,description,ready,
           blocked_reason,blocked_detail,execution,methods,category_id,category_method,
           category_confidence,taxonomy_version,published_at,updated_at,fetched_at,entry_json,raw_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_id,name,version) DO UPDATE SET status=excluded.status,
           is_latest=excluded.is_latest,title=excluded.title,description=excluded.description,
           ready=excluded.ready,blocked_reason=excluded.blocked_reason,blocked_detail=excluded.blocked_detail,
           execution=excluded.execution,methods=excluded.methods,category_id=excluded.category_id,
           category_method=excluded.category_method,category_confidence=excluded.category_confidence,
           taxonomy_version=excluded.taxonomy_version,published_at=excluded.published_at,
           updated_at=excluded.updated_at,fetched_at=excluded.fetched_at,entry_json=excluded.entry_json,
           raw_json=excluded.raw_json`,
      )
      .run(
        entry.sourceId,
        entry.name,
        entry.version,
        entry.status,
        intFlag(entry.isLatest),
        entry.title ?? null,
        entry.description,
        intFlag(assessment.ready),
        assessment.blocked?.reason ?? null,
        assessment.blocked?.detail ?? null,
        assessment.execution,
        ` ${assessment.methods.join(" ")} `,
        category.categoryId,
        category.method,
        category.confidence,
        classifier.taxonomyVersion,
        entry.publishedAt ?? null,
        entry.updatedAt ?? null,
        fetchedAt,
        JSON.stringify(stored),
        rawJson,
      );
    const row = this.db
      .prepare(
        "SELECT rowid AS id FROM catalog_versions WHERE source_id=? AND name=? AND version=?",
      )
      .get(entry.sourceId, entry.name, entry.version);
    const id = Number(row?.id);
    if (entry.isLatest) this.demoteOtherVersions(entry);
    this.db.prepare("DELETE FROM catalog_search WHERE rowid=?").run(id);
    const label = CATEGORY_LABELS[category.categoryId];
    this.db
      .prepare(
        "INSERT INTO catalog_search(rowid,name,title,description,category) VALUES(?,?,?,?,?)",
      )
      .run(id, entry.name, entry.title ?? "", entry.description, `${label.en} ${label.es}`);
  }

  /** At most one latest version per server: a new latest demotes the rest. */
  private demoteOtherVersions(entry: CatalogEntry): void {
    this.db
      .prepare(
        "UPDATE catalog_versions SET is_latest=0 WHERE source_id=? AND name=? AND version<>? AND is_latest=1",
      )
      .run(entry.sourceId, entry.name, entry.version);
  }

  /** Recomputes every assignment of a source when the taxonomy or its rules changed. */
  reclassify(sourceId: string, classifier: CategoryClassifier): number {
    const stale = this.db
      .prepare(
        "SELECT count(*) AS n FROM catalog_versions WHERE source_id=? AND taxonomy_version<>?",
      )
      .get(sourceId, classifier.taxonomyVersion);
    if (!Number(stale?.n)) return 0;
    let changed = 0;
    this.db.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT rowid AS id, entry_json AS json, raw_json AS raw FROM catalog_versions WHERE source_id=?",
        )
        .all(sourceId);
      for (const row of rows) {
        const entry = JSON.parse(String(row.json)) as CatalogEntry;
        const category = classifier.classify(entry);
        this.db
          .prepare(
            "UPDATE catalog_versions SET category_id=?,category_method=?,category_confidence=?,taxonomy_version=? WHERE rowid=?",
          )
          .run(
            category.categoryId,
            category.method,
            category.confidence,
            classifier.taxonomyVersion,
            Number(row.id),
          );
        const label = CATEGORY_LABELS[category.categoryId];
        this.db
          .prepare("UPDATE catalog_search SET category=? WHERE rowid=?")
          .run(`${label.en} ${label.es}`, Number(row.id));
        changed++;
      }
    });
    return changed;
  }

  // ---- reads ---------------------------------------------------------------------------------

  /** The stored domain entry of one version (`undefined` version = the latest). */
  detail(sourceId: string, name: string, version?: string): CatalogEntry | undefined {
    const row = version
      ? this.db
          .prepare(
            "SELECT entry_json AS json, raw_json AS raw FROM catalog_versions WHERE source_id=? AND name=? AND version=?",
          )
          .get(sourceId, name, version)
      : this.db
          .prepare(
            "SELECT entry_json AS json, raw_json AS raw FROM catalog_versions WHERE source_id=? AND name=? AND is_latest=1 AND status<>'deleted'",
          )
          .get(sourceId, name);
    if (!row) return undefined;
    const entry = JSON.parse(String(row.json)) as CatalogEntry;
    return { ...entry, provenance: { ...entry.provenance, rawJson: String(row.raw) } };
  }

  /** Filters, then pages: `total` and `facets` describe exactly the query that produced `items`. */
  query(sourceId: string, query: CatalogQuery): Omit<McpCatalogPage, "syncStatus"> {
    const pageSize = Math.max(1, Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const trimmed = (query.q ?? "").trim();
    const match = trimmed.length >= MIN_QUERY_LENGTH ? ftsQuery(trimmed) : undefined;

    const where: string[] = ["v.source_id=?", "v.is_latest=1"];
    const params: SqlValue[] = [sourceId];
    where.push(
      query.status === "all" ? "v.status IN ('active','deprecated')" : "v.status='active'",
    );
    // The text match scopes the rows of every count; the ranked list joins the same match instead.
    const matchClause =
      "v.rowid IN (SELECT rowid FROM catalog_search WHERE catalog_search MATCH ?)";
    if (match) {
      where.push(matchClause);
      params.push(match);
    }
    const common = [...where];
    const commonParams = [...params];
    if (query.execution) {
      common.push("v.execution IN (?, 'both')");
      commonParams.push(query.execution);
    }
    if (query.method) {
      common.push("instr(v.methods, ?) > 0");
      commonParams.push(` ${query.method} `);
    }
    if (query.ready) common.push("v.ready=1");

    const withCategory = [...common];
    const withCategoryParams = [...commonParams];
    if (query.category && isCategoryId(query.category)) {
      withCategory.push("v.category_id=?");
      withCategoryParams.push(query.category);
    }

    const clause = (parts: string[]) => parts.join(" AND ");
    const total = Number(
      this.db
        .prepare(`SELECT count(*) AS n FROM catalog_versions v WHERE ${clause(withCategory)}`)
        .get(...withCategoryParams)?.n ?? 0,
    );

    const listWhere = match ? withCategory.filter((c) => c !== matchClause) : withCategory;
    const listParams = [...withCategoryParams];
    if (match) listParams.splice(1, 1); // the match parameter follows the source id
    const source = match
      ? "catalog_versions v JOIN (SELECT rowid AS rid, bm25(catalog_search) AS score FROM catalog_search WHERE catalog_search MATCH ?) s ON s.rid=v.rowid"
      : "catalog_versions v";
    const rows = this.db
      .prepare(
        `SELECT v.* FROM ${source} WHERE ${clause(listWhere)}
         ORDER BY ${match ? "s.score ASC, " : ""}v.name COLLATE NOCASE ASC, v.name ASC, v.version ASC LIMIT ? OFFSET ?`,
      )
      .all(...(match ? [match] : []), ...listParams, pageSize, (page - 1) * pageSize);

    return {
      items: rows.map(toItem),
      total,
      page,
      pageSize,
      queryApplied: !!match,
      facets: this.facets(common, commonParams, [...where], [...params], query),
    };
  }

  private facets(
    common: string[],
    commonParams: SqlValue[],
    base: string[],
    baseParams: SqlValue[],
    query: CatalogQuery,
  ): McpCatalogFacets {
    const count = (sql: string, params: SqlValue[]) => this.db.prepare(sql).all(...params);
    // Categories: every other filter applies, the category filter itself does not.
    const categories = count(
      `SELECT v.category_id AS id, count(*) AS n FROM catalog_versions v WHERE ${common.join(" AND ")}
       GROUP BY v.category_id ORDER BY n DESC, id ASC`,
      commonParams,
    ).map((r) => ({ id: String(r.id), count: Number(r.n) }));
    // Execution: everything but the execution filter (so both choices keep their counts).
    const noExec = [...base];
    const noExecParams = [...baseParams];
    if (query.method) {
      noExec.push("instr(v.methods, ?) > 0");
      noExecParams.push(` ${query.method} `);
    }
    if (query.ready) noExec.push("v.ready=1");
    if (query.category && isCategoryId(query.category)) {
      noExec.push("v.category_id=?");
      noExecParams.push(query.category);
    }
    const execution = (["local", "remote"] as const).map((id) => ({
      id,
      count: Number(
        this.db
          .prepare(
            `SELECT count(*) AS n FROM catalog_versions v WHERE ${noExec.join(" AND ")} AND v.execution IN (?, 'both')`,
          )
          .get(...noExecParams, id)?.n ?? 0,
      ),
    }));
    const ready = Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM catalog_versions v WHERE ${common.join(" AND ")} AND v.ready=1`,
        )
        .get(...commonParams)?.n ?? 0,
    );
    return { categories, execution, ready };
  }
}

function isOlder(incoming: string | undefined, stored: string | undefined): boolean {
  if (!incoming || !stored) return false;
  const a = Date.parse(incoming);
  const b = Date.parse(stored);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

function toItem(row: Row): McpCatalogItem {
  const categoryId = isCategoryId(String(row.category_id))
    ? (row.category_id as CategoryId)
    : "other";
  const blockedReason = text(row.blocked_reason);
  return {
    sourceId: String(row.source_id),
    name: String(row.name),
    ...(text(row.title) ? { title: text(row.title) as string } : {}),
    description: String(row.description),
    version: String(row.version),
    status: row.status === "deprecated" ? "deprecated" : "active",
    execution: (row.execution as McpCatalogItem["execution"]) ?? "unknown",
    methods: String(row.methods).trim().split(" ").filter(Boolean),
    category: {
      id: categoryId,
      method: row.category_method as McpCatalogItem["category"]["method"],
      confidence: Number(row.category_confidence),
    },
    ready: !!row.ready,
    ...(blockedReason
      ? {
          blocked: {
            reason: blockedReason as NonNullable<McpCatalogItem["blocked"]>["reason"],
            ...(text(row.blocked_detail) ? { detail: text(row.blocked_detail) as string } : {}),
          },
        }
      : {}),
    ...(text(row.published_at) ? { publishedAt: text(row.published_at) as string } : {}),
    ...(text(row.updated_at) ? { updatedAt: text(row.updated_at) as string } : {}),
  };
}
