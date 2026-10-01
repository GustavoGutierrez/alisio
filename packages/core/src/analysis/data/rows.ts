/**
 * SQL of `SpreadsheetView` pages (spec §17.4). Pure: builds trusted statements for the engine.
 * Paging is keyset-based on `rowid` (dense, in file order), so a page never scans from the start
 * for the unsorted view and never duplicates or skips rows while sorting. `LIMIT/OFFSET` only
 * serves jumps to a position when a sort or filter is active (≤ 100 000 rows in).
 */
import { quoteIdent } from "./infer.ts";

export const MAX_PAGE_ROWS = 500;
export const MAX_OFFSET = 100_000;
/** Filtering every column at once (no `column`) is only allowed up to this many rows. */
export const MAX_ALL_COLUMNS_FILTER_ROWS = 100_000;

export interface PageParams {
  table: string;
  columns: string[];
  limit: number;
  sort?: { column: string; dir: "asc" | "desc" };
  /** Substring filter on one column (or on every column when `column` is absent). */
  filter?: { column?: string; text: string };
  /** Opaque cursor returned by the previous page. */
  after?: string;
  /** Rows to skip (jump). */
  offset?: number;
}

export class PageParamError extends Error {}

/** The cursor of a row: base64 of `[rowid]`. */
export const encodeCursor = (rowid: number): string =>
  Buffer.from(JSON.stringify([rowid])).toString("base64url");

export function decodeCursor(cursor: string): number {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && Number.isSafeInteger(value[0]) && (value[0] as number) >= 0)
      return value[0] as number;
  } catch {
    /* falls through */
  }
  throw new PageParamError("Invalid cursor");
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

type Param = string | number | null;

/** Statement and parameters of one page (`limit + 1` rows, to know whether a next page exists). */
export function buildPageQuery(params: PageParams): { sql: string; params: Param[] } {
  const table = quoteIdent(params.table);
  const known = new Set(params.columns);
  const values: Param[] = [];
  const where: string[] = [];
  const sortColumn = params.sort?.column;
  if (sortColumn !== undefined && !known.has(sortColumn))
    throw new PageParamError(`Unknown column: ${sortColumn}`);
  if (params.filter?.text) {
    const like = `%${escapeLike(params.filter.text)}%`;
    if (params.filter.column !== undefined) {
      if (!known.has(params.filter.column))
        throw new PageParamError(`Unknown column: ${params.filter.column}`);
      where.push(`${quoteIdent(params.filter.column)} LIKE ? ESCAPE '\\'`);
      values.push(like);
    } else {
      where.push(
        `(${params.columns.map((c) => `${quoteIdent(c)} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
      );
      for (let i = 0; i < params.columns.length; i++) values.push(like);
    }
  }
  const filtered = where.length > 0;
  let order = "rowid";
  let offset = 0;
  if (sortColumn === undefined) {
    if (params.after) {
      where.push("rowid > ?");
      values.push(decodeCursor(params.after));
    } else if (params.offset) {
      if (!filtered) {
        // rowid is dense (1..N in file order): jumping needs no OFFSET at all.
        where.push("rowid > ?");
        values.push(params.offset);
      } else offset = params.offset;
    }
  } else {
    const k = quoteIdent(sortColumn);
    const asc = params.sort?.dir !== "desc";
    order = `${k} ${asc ? "ASC" : "DESC"}, rowid ASC`;
    if (params.after) {
      const r = decodeCursor(params.after);
      const v = `(SELECT ${k} FROM ${table} WHERE rowid = ?)`;
      // NULLs sort first ascending and last descending; ties break on rowid ascending.
      const next = asc
        ? `((${v} IS NULL AND (${k} IS NOT NULL OR rowid > ?)) OR ` +
          `(${v} IS NOT NULL AND (${k} > ${v} OR (${k} = ${v} AND rowid > ?))))`
        : `((${v} IS NULL AND ${k} IS NULL AND rowid > ?) OR ` +
          `(${v} IS NOT NULL AND (${k} < ${v} OR (${k} = ${v} AND rowid > ?) OR ${k} IS NULL)))`;
      where.push(next);
      for (let i = 0; i < 6; i++) values.push(r);
    } else if (params.offset) offset = params.offset;
  }
  if (offset > MAX_OFFSET)
    throw new PageParamError(
      `Jumping is limited to the first ${MAX_OFFSET} rows when sorting or filtering`,
    );
  const select = ["rowid", ...params.columns.map(quoteIdent)].join(", ");
  values.push(Math.min(params.limit, MAX_PAGE_ROWS) + 1);
  const sql =
    `SELECT ${select} FROM ${table}` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${order} LIMIT ?` +
    (offset ? ` OFFSET ${Math.floor(offset)}` : "");
  return { sql, params: values };
}

/** `SELECT count(*)` of the filter (shown on the first page of a filtered view). */
export function buildCountQuery(params: Pick<PageParams, "table" | "columns" | "filter">): {
  sql: string;
  params: Param[];
} {
  const table = quoteIdent(params.table);
  const text = params.filter?.text;
  if (!text) return { sql: `SELECT count(*) FROM ${table}`, params: [] };
  const like = `%${escapeLike(text)}%`;
  if (params.filter?.column !== undefined) {
    if (!params.columns.includes(params.filter.column))
      throw new PageParamError(`Unknown column: ${params.filter.column}`);
    return {
      sql: `SELECT count(*) FROM ${table} WHERE ${quoteIdent(params.filter.column)} LIKE ? ESCAPE '\\'`,
      params: [like],
    };
  }
  return {
    sql: `SELECT count(*) FROM ${table} WHERE (${params.columns
      .map((c) => `${quoteIdent(c)} LIKE ? ESCAPE '\\'`)
      .join(" OR ")})`,
    params: params.columns.map(() => like),
  };
}
