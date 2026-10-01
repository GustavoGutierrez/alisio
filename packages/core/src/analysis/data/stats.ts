/**
 * Metadata tables of a dataset file and the per-column statistics (spec §17.2). The same
 * `finalizeDatabase` runs after Node parses a CSV/TSV/JSON/JSONL file and after the Python helper
 * converts an XLSX workbook, so both routes produce identical types and statistics.
 */
import { inferType, quoteIdent } from "./infer.ts";

/** Minimal view of `node:sqlite`'s `DatabaseSync` (the engine runs outside the type roots). */
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export const INGEST_VERSION = 1;
/** Distinct counts and top values are exact up to this many rows; above, a sample is used. */
export const EXACT_DISTINCT_ROWS = 1_000_000;
const SAMPLE_ROWS = 200_000;
const TYPE_SAMPLE = 1000;

export const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS _alisio_meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS _alisio_sheets(ordinal INTEGER PRIMARY KEY, name TEXT NOT NULL,
  table_name TEXT NOT NULL, rows INTEGER NOT NULL, columns INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS _alisio_columns(table_name TEXT NOT NULL, ordinal INTEGER NOT NULL,
  name TEXT NOT NULL, label TEXT NOT NULL, inferred_type TEXT NOT NULL,
  nulls INTEGER, distinct_count INTEGER, distinct_exact INTEGER,
  min TEXT, max TEXT, mean REAL, text_fallbacks INTEGER, top_values TEXT,
  PRIMARY KEY(table_name, ordinal));
`;

interface ColumnRow {
  table_name: string;
  ordinal: number;
  name: string;
}

/**
 * Computes `_alisio_columns` statistics for every registered column and refreshes the row and
 * column counts of `_alisio_sheets`. Column rows (table, ordinal, name, label) must exist.
 */
export function finalizeDatabase(db: Db): void {
  const sheets = db
    .prepare("SELECT ordinal, table_name FROM _alisio_sheets ORDER BY ordinal")
    .all() as Array<{ ordinal: number; table_name: string }>;
  db.exec("BEGIN");
  try {
    for (const sheet of sheets) {
      const table = quoteIdent(sheet.table_name);
      const rows = (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      const columns = db
        .prepare(
          "SELECT table_name, ordinal, name FROM _alisio_columns WHERE table_name=? ORDER BY ordinal",
        )
        .all(sheet.table_name) as unknown as ColumnRow[];
      db.prepare("UPDATE _alisio_sheets SET rows=?, columns=? WHERE ordinal=?").run(
        rows,
        columns.length,
        sheet.ordinal,
      );
      const exact = rows <= EXACT_DISTINCT_ROWS;
      const stride = exact ? 1 : Math.ceil(rows / SAMPLE_ROWS);
      const andWhere = exact ? "" : `AND rowid % ${stride} = 0`;
      for (const column of columns) {
        const col = quoteIdent(column.name);
        const sample = db
          .prepare(
            `SELECT typeof(${col}) AS kind, ${col} AS value FROM ${table} LIMIT ${TYPE_SAMPLE}`,
          )
          .all() as Array<{ kind: string; value: unknown }>;
        const type = inferType(sample);
        const agg = db
          .prepare(
            `SELECT sum(${col} IS NULL) AS nulls, min(${col}) AS mn, max(${col}) AS mx,
               sum(typeof(${col}) IN ('integer','real')) AS nums,
               sum(typeof(${col})='text') AS texts,
               sum(typeof(${col})='text' AND ${col} GLOB '*[0-9]*' AND NOT ${col} GLOB '*[A-Za-z]*') AS numlike,
               avg(CASE WHEN typeof(${col}) IN ('integer','real') THEN ${col} END) AS mean
             FROM ${table}`,
          )
          .get() as {
          nulls: number | null;
          mn: unknown;
          mx: unknown;
          nums: number | null;
          texts: number | null;
          numlike: number | null;
          mean: number | null;
        };
        const groups = db
          .prepare(
            `WITH g AS MATERIALIZED (
               SELECT ${col} AS v, count(*) AS n FROM ${table}
               WHERE ${col} IS NOT NULL ${andWhere} GROUP BY ${col})
             SELECT (SELECT count(*) FROM g) AS d, CAST(v AS TEXT) AS v, n FROM g
             ORDER BY n DESC, v LIMIT 5`,
          )
          .all() as Array<{ d: number; v: string; n: number }>;
        const nums = Number(agg.nums ?? 0);
        const texts = Number(agg.texts ?? 0);
        const fallbacks = nums > 0 ? texts : type === "text" ? Number(agg.numlike ?? 0) : 0;
        const numeric = type === "integer" || type === "real";
        db.prepare(
          `UPDATE _alisio_columns SET inferred_type=?, nulls=?, distinct_count=?, distinct_exact=?,
             min=?, max=?, mean=?, text_fallbacks=?, top_values=? WHERE table_name=? AND ordinal=?`,
        ).run(
          type,
          Number(agg.nulls ?? 0),
          Number(groups[0]?.d ?? 0),
          exact ? 1 : 0,
          agg.mn === null || agg.mn === undefined ? null : String(agg.mn),
          agg.mx === null || agg.mx === undefined ? null : String(agg.mx),
          numeric && agg.mean !== null ? Number(agg.mean) : null,
          fallbacks,
          JSON.stringify(groups.map((g) => ({ value: g.v, count: Number(g.n) }))),
          sheet.table_name,
          column.ordinal,
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
