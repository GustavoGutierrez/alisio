/**
 * Query planner of the Smart Dashboard (spec 6.4, ADR-3): every widget of a `DashboardSpec` is
 * compiled to one `SELECT` from a small internal AST. Identifiers come only from the dataset's
 * column catalog and are always quoted; the only literals are fixed in this file and the only
 * numbers are clamped integers. Nothing a provider or the model wrote (goal, answers, titles,
 * labels) is an input here. The queries run through the same read-only path as `data_query`, SQL
 * guard included (defence in depth), one after the other, with the caller's `AbortSignal`.
 *
 * `compileQuery` and `widgetQueries` are pure; `runQueries` and `queryDashboard` do the I/O
 * through a `run` callback so the planner never touches the engine itself.
 */
import { DataError } from "../data/engine-client.ts";
import type { QueryResult } from "../data/engine-types.ts";
import type { ProfiledColumn } from "./profile.ts";
import {
  bucketCount,
  type DashboardAggregation,
  type DashboardSpec,
  type DashboardTimeBucket,
  type DashboardWidget,
  SPEC_LIMITS,
  TIME_BUCKETS,
} from "./spec.ts";

// ---- the AST ----

/** The only output names a query may use; fixed, so no text from outside becomes an alias. */
export type Alias = "k" | "v" | "x" | "y";
const ALIASES: ReadonlySet<string> = new Set<Alias>(["k", "v", "x", "y"]);

export type Expr =
  | { col: string }
  /** `count` without `col` is `COUNT(*)`; every other aggregate needs a column. */
  | { agg: DashboardAggregation; col?: string }
  | { bucket: DashboardTimeBucket; col: string };

export interface SelectItem {
  expr: Expr;
  as?: Alias;
}

export type Predicate =
  | { notNull: Expr }
  /** `typeof(col) IN ('integer','real')`: a dataset column can hold text later on (spec 3). */
  | { numeric: string }
  /** Starts like `YYYY-MM-DD`: keeps `strftime`/`date` from reading `"2024"` as a Julian day. */
  | { isoDate: string }
  /** Deterministic sampling: `_rowid_ % n = 0`. */
  | { stride: number }
  /** `expr > 0` (HAVING). */
  | { positive: Expr };

export interface Order {
  key: { alias: Alias } | { col: string } | { rowid: true };
  dir: "asc" | "desc";
}

export interface QueryAst {
  table: string;
  select: SelectItem[];
  where: Predicate[];
  groupBy?: Array<{ alias: Alias } | { col: string }>;
  having?: Predicate[];
  orderBy: Order[];
  limit: number;
}

export type QueryPlanErrorCode =
  | "unknown_column"
  | "invalid_table"
  | "invalid_alias"
  | "invalid_aggregate"
  | "invalid_number"
  | "invalid_widget"
  | "missing_bucket";

/** A widget that cannot be compiled. The message may name the culprit; the `code` never does. */
export class QueryPlanError extends Error {
  constructor(
    readonly code: QueryPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QueryPlanError";
  }
}

/** Every query reads at most this many rows (the engine clamps to the same 1000). */
const ROWS_MAX = 1000;
const SCATTER_POINTS = 500;
/** Sheet table names are `[a-z0-9_]` after ingestion; anything else is not a table of ours. */
const TABLE_NAME = /^[A-Za-z0-9_]{1,200}$/;

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function clampInt(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new QueryPlanError("invalid_number", `${what} is not a finite number`);
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** The widget `limit`: 1..20, default 10; anything that is not a finite number is the default. */
function widgetLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SPEC_LIMITS.defaultLimit;
  return Math.min(SPEC_LIMITS.limitMax, Math.max(SPEC_LIMITS.limitMin, Math.trunc(value)));
}

// ---- compilation ----

const AGGREGATE_FN: Record<DashboardAggregation, string> = {
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
  count: "COUNT",
  count_distinct: "COUNT",
};

/** The SQLite expression of a bucket over an already quoted column (Phase 0, E3). */
function bucketSql(bucket: DashboardTimeBucket, c: string): string {
  switch (bucket) {
    case "day":
      return `strftime('%Y-%m-%d', ${c})`;
    case "week":
      return `date(${c}, '-6 days', 'weekday 1')`;
    case "month":
      return `strftime('%Y-%m', ${c})`;
    case "quarter":
      return `strftime('%Y', ${c}) || '-Q' || ((CAST(strftime('%m', ${c}) AS INTEGER) + 2) / 3)`;
    case "year":
      return `strftime('%Y', ${c})`;
  }
}

/**
 * Compiles an AST to SQL. Throws `QueryPlanError` for any identifier that is not a column of
 * `catalog`, a table name that is not a plain name, an alias outside the fixed set or a number
 * that is not finite. The result is always a single `SELECT`.
 */
export function compileQuery(ast: QueryAst, catalog: readonly ProfiledColumn[]): string {
  const names = new Set(catalog.map((c) => c.name));
  const ident = (name: string): string => {
    if (typeof name !== "string" || !names.has(name))
      throw new QueryPlanError("unknown_column", `Column is not in the dataset catalog: ${name}`);
    return quoteIdent(name);
  };
  const alias = (name: string): Alias => {
    if (!ALIASES.has(name)) throw new QueryPlanError("invalid_alias", `Unknown alias: ${name}`);
    return name as Alias;
  };
  const expr = (e: Expr): string => {
    if ("bucket" in e) {
      if (!TIME_BUCKETS.includes(e.bucket))
        throw new QueryPlanError("invalid_widget", "Unknown time bucket");
      return bucketSql(e.bucket, ident(e.col));
    }
    if ("agg" in e) {
      const fn = AGGREGATE_FN[e.agg];
      if (!fn) throw new QueryPlanError("invalid_aggregate", "Unknown aggregation");
      if (e.agg === "count") return e.col === undefined ? "COUNT(*)" : `COUNT(${ident(e.col)})`;
      if (e.col === undefined)
        throw new QueryPlanError("invalid_aggregate", `${e.agg} needs a column`);
      return e.agg === "count_distinct"
        ? `COUNT(DISTINCT ${ident(e.col)})`
        : `${fn}(${ident(e.col)})`;
    }
    return ident(e.col);
  };
  const predicate = (p: Predicate): string => {
    if ("notNull" in p) return `${expr(p.notNull)} IS NOT NULL`;
    if ("numeric" in p) return `typeof(${ident(p.numeric)}) IN ('integer','real')`;
    if ("isoDate" in p)
      return `${ident(p.isoDate)} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`;
    if ("stride" in p) return `_rowid_ % ${clampInt(p.stride, 1, 1_000_000_000, "stride")} = 0`;
    return `${expr(p.positive)} > 0`;
  };

  if (typeof ast.table !== "string" || !TABLE_NAME.test(ast.table))
    throw new QueryPlanError("invalid_table", "The table name is not a plain name");
  if (!ast.select.length) throw new QueryPlanError("invalid_widget", "Nothing to select");

  const select = ast.select
    .map((item) => (item.as ? `${expr(item.expr)} AS ${alias(item.as)}` : expr(item.expr)))
    .join(", ");
  const parts = [`SELECT ${select} FROM ${quoteIdent(ast.table)}`];
  if (ast.where.length) parts.push(`WHERE ${ast.where.map(predicate).join(" AND ")}`);
  if (ast.groupBy?.length)
    parts.push(
      `GROUP BY ${ast.groupBy.map((g) => ("alias" in g ? alias(g.alias) : ident(g.col))).join(", ")}`,
    );
  if (ast.having?.length) parts.push(`HAVING ${ast.having.map(predicate).join(" AND ")}`);
  if (ast.orderBy.length)
    parts.push(
      `ORDER BY ${ast.orderBy
        .map((o) => {
          if ("rowid" in o.key) return o.dir === "desc" ? "_rowid_ DESC" : "_rowid_";
          const key = "alias" in o.key ? alias(o.key.alias) : ident(o.key.col);
          return `${key} ${o.dir === "desc" ? "DESC" : "ASC"}`;
        })
        .join(", ")}`,
    );
  parts.push(`LIMIT ${clampInt(ast.limit, 1, ROWS_MAX, "limit")}`);
  return parts.join(" ");
}

// ---- widgets to queries ----

export interface WidgetQuery {
  widgetId: string;
  type: DashboardWidget["type"];
  sql: string;
  /** Rows to read (the engine clamps to 1000). */
  maxRows: number;
  /** Total over the whole dimension, for the "Other" bucket (sum and count only). */
  totalSql?: string;
  /** Top-N limit of a categorical series. */
  limit?: number;
  /** Time series: the bucket in effect (coarsened when the requested one yields too many). */
  bucket?: DashboardTimeBucket;
  /** Pie and donut: "Other" is shown only when it is above zero. */
  positiveOnly?: boolean;
  /** Distinct values of a categorical dimension, from the catalog, for "Top N of M". */
  groups?: number;
  /** Table: the column names, in order. */
  columns?: string[];
}

export interface PlannedQueries {
  queries: WidgetQuery[];
  /** One line per widget that could not be compiled (metadata only, never an identifier). */
  fallbacks: string[];
}

const NUMERIC_AGGREGATES: ReadonlySet<DashboardAggregation> = new Set(["sum", "avg", "min", "max"]);

/** The finest bucket not finer than `requested` that keeps a span within the bucket cap. */
function effectiveBucket(
  requested: DashboardTimeBucket,
  span: ProfiledColumn["span"],
): DashboardTimeBucket {
  if (!span) return requested;
  let index = TIME_BUCKETS.indexOf(requested);
  while (
    index < TIME_BUCKETS.length - 1 &&
    bucketCount(span.days, TIME_BUCKETS[index] as DashboardTimeBucket) > SPEC_LIMITS.maxBuckets
  )
    index++;
  return TIME_BUCKETS[index] as DashboardTimeBucket;
}

function aggregateExpr(aggregation: DashboardAggregation, metric: string): Expr {
  // "*" is no column: only `count` may use it, and compileQuery rejects the rest
  return metric === "*" ? { agg: aggregation } : { agg: aggregation, col: metric };
}

function measureFilter(aggregation: DashboardAggregation, metric: string): Predicate[] {
  return NUMERIC_AGGREGATES.has(aggregation) && metric !== "*" ? [{ numeric: metric }] : [];
}

function compileWidget(
  widget: DashboardWidget,
  catalog: readonly ProfiledColumn[],
  table: string,
  rows: number,
): WidgetQuery {
  const column = (name: string) => catalog.find((c) => c.name === name);
  const base = { widgetId: widget.id, type: widget.type };
  switch (widget.type) {
    case "kpi": {
      const sql = compileQuery(
        {
          table,
          select: [{ expr: aggregateExpr(widget.aggregation, widget.metric), as: "v" }],
          where: measureFilter(widget.aggregation, widget.metric),
          orderBy: [],
          limit: 1,
        },
        catalog,
      );
      return { ...base, sql, maxRows: 1 };
    }
    case "scatter": {
      const sample = Math.max(1, Math.ceil((Number.isFinite(rows) ? rows : 0) / SCATTER_POINTS));
      const sql = compileQuery(
        {
          table,
          select: [
            { expr: { col: widget.x }, as: "x" },
            { expr: { col: widget.y }, as: "y" },
          ],
          where: [{ numeric: widget.x }, { numeric: widget.y }, { stride: sample }],
          orderBy: [{ key: { rowid: true }, dir: "asc" }],
          limit: SCATTER_POINTS,
        },
        catalog,
      );
      return { ...base, sql, maxRows: SCATTER_POINTS };
    }
    case "table": {
      if (
        !Array.isArray(widget.columns) ||
        widget.columns.length < 1 ||
        widget.columns.length > SPEC_LIMITS.tableColumns
      )
        throw new QueryPlanError("invalid_widget", "A table needs between 1 and 8 columns");
      const limit = widgetLimit(widget.limit);
      const sql = compileQuery(
        {
          table,
          select: widget.columns.map((name) => ({ expr: { col: name } })),
          where: [],
          orderBy: [{ key: { rowid: true }, dir: "asc" }],
          limit,
        },
        catalog,
      );
      return { ...base, sql, maxRows: limit, columns: [...widget.columns] };
    }
    default: {
      const dimension = column(widget.dimension);
      if (!dimension)
        throw new QueryPlanError(
          "unknown_column",
          `Column is not in the catalog: ${widget.dimension}`,
        );
      const measure = aggregateExpr(widget.aggregation, widget.metric);
      const filter = measureFilter(widget.aggregation, widget.metric);
      if (dimension.role === "time") {
        if (!widget.timeBucket)
          throw new QueryPlanError("missing_bucket", "A time dimension needs a timeBucket");
        const bucket = effectiveBucket(widget.timeBucket, dimension.span);
        const key: Expr = { bucket, col: widget.dimension };
        const sql = compileQuery(
          {
            table,
            select: [
              { expr: key, as: "k" },
              { expr: measure, as: "v" },
            ],
            where: [{ isoDate: widget.dimension }, { notNull: key }, ...filter],
            groupBy: [{ alias: "k" }],
            orderBy: [{ key: { alias: "k" }, dir: "asc" }],
            limit: SPEC_LIMITS.maxBuckets,
          },
          catalog,
        );
        return { ...base, sql, maxRows: SPEC_LIMITS.maxBuckets, bucket };
      }
      const limit = widgetLimit(widget.limit);
      const positiveOnly = widget.type === "pie" || widget.type === "donut";
      const where: Predicate[] = [{ notNull: { col: widget.dimension } }, ...filter];
      const sql = compileQuery(
        {
          table,
          select: [
            { expr: { col: widget.dimension }, as: "k" },
            { expr: measure, as: "v" },
          ],
          where,
          groupBy: [{ col: widget.dimension }],
          ...(positiveOnly ? { having: [{ positive: measure }] } : {}),
          orderBy: [
            { key: { alias: "v" }, dir: "desc" },
            { key: { alias: "k" }, dir: "asc" },
          ],
          limit,
        },
        catalog,
      );
      const foldable =
        widget.other === true && (widget.aggregation === "sum" || widget.aggregation === "count");
      const totalSql = foldable
        ? compileQuery(
            { table, select: [{ expr: measure, as: "v" }], where, orderBy: [], limit: 1 },
            catalog,
          )
        : undefined;
      return {
        ...base,
        sql,
        maxRows: limit,
        limit,
        ...(totalSql ? { totalSql } : {}),
        ...(positiveOnly ? { positiveOnly } : {}),
        groups: dimension.distinct,
      };
    }
  }
}

/** A widget id is validated upstream; this keeps a hostile one out of the notes anyway. */
const noteId = (id: unknown): string =>
  typeof id === "string" ? id.replace(/[^a-z0-9-]/g, "_").slice(0, 40) : "?";

/**
 * Compiles every widget of a validated spec (`rows` is the sheet's row count, for the scatter
 * stride). The table is the spec's `sheet` or `data`. A widget that cannot be compiled is dropped
 * and noted; a table name that is not a plain name throws (the whole spec is unusable).
 */
export function widgetQueries(
  spec: DashboardSpec,
  catalog: readonly ProfiledColumn[],
  rows: number,
): PlannedQueries {
  const table = spec.sheet ?? "data";
  if (typeof table !== "string" || !TABLE_NAME.test(table))
    throw new QueryPlanError("invalid_table", "The sheet name is not a plain table name");
  const queries: WidgetQuery[] = [];
  const fallbacks: string[] = [];
  for (const widget of spec.widgets) {
    try {
      queries.push(compileWidget(widget, catalog, table, rows));
    } catch (error) {
      if (!(error instanceof QueryPlanError)) throw error;
      fallbacks.push(`widget ${noteId(widget.id)} dropped: ${error.code.replaceAll("_", " ")}`);
    }
  }
  return { queries, fallbacks };
}

// ---- running ----

export interface SeriesData {
  id: string;
  type: "line" | "area" | "bar" | "hbar" | "pie" | "donut";
  points: Array<{ k: string; v: number }>;
  /** Value folded into "Other" (the renderer adds the localized label). Absent when none. */
  other?: number;
  /** "Top N of M": the dimension has M groups and only N are shown, with no "Other". */
  topOf?: number;
  /** Time series: the bucket in effect. */
  bucket?: DashboardTimeBucket;
}
export type WidgetData =
  | { id: string; type: "kpi"; value: number | null }
  | SeriesData
  | { id: string; type: "scatter"; points: Array<[number, number]> }
  | {
      id: string;
      type: "table";
      columns: string[];
      rows: Array<Array<string | number | null>>;
    };

export interface QueryRun {
  /** In the order of the queries (the spec's widget order). */
  data: WidgetData[];
  /** One line per widget dropped (metadata only: widget id and an error code). */
  fallbacks: string[];
}

/** Every widget failed: the dashboard cannot be built from this dataset. */
export class DashboardQueryError extends Error {
  readonly code = "query_failed";
  constructor(
    message: string,
    readonly fallbacks: string[] = [],
  ) {
    super(message);
    this.name = "DashboardQueryError";
  }
}

export type RunQuery = (sql: string, maxRows: number) => Promise<QueryResult>;

const abortError = () => Object.assign(new Error("Cancelled"), { name: "AbortError" });
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
/** 0.1 + 0.2 style noise out of a difference of sums. */
const tidy = (value: number): number => Number(value.toPrecision(12));

async function runOne(query: WidgetQuery, run: RunQuery): Promise<WidgetData> {
  const result = await run(query.sql, query.maxRows);
  const id = query.widgetId;
  switch (query.type) {
    case "kpi": {
      const value = result.rows[0]?.[0];
      return { id, type: "kpi", value: isNumber(value) ? value : null };
    }
    case "scatter": {
      const points: Array<[number, number]> = [];
      for (const row of result.rows) {
        const [x, y] = row;
        if (isNumber(x) && isNumber(y)) points.push([x, y]);
      }
      return { id, type: "scatter", points };
    }
    case "table":
      return { id, type: "table", columns: query.columns ?? result.columns, rows: result.rows };
    default: {
      const points: Array<{ k: string; v: number }> = [];
      for (const row of result.rows) {
        const [k, v] = row;
        if (k !== null && k !== undefined && isNumber(v)) points.push({ k: String(k), v });
      }
      const data: SeriesData = { id, type: query.type, points };
      if (query.bucket) data.bucket = query.bucket;
      let folded = false;
      if (query.totalSql && query.limit !== undefined && points.length >= query.limit) {
        const total = (await run(query.totalSql, 1)).rows[0]?.[0];
        if (isNumber(total)) {
          const other = tidy(total - points.reduce((sum, p) => sum + p.v, 0));
          if (query.positiveOnly ? other > 0 : other !== 0) {
            data.other = other;
            folded = true;
          }
        }
      }
      if (
        !folded &&
        !query.bucket &&
        query.limit !== undefined &&
        query.groups !== undefined &&
        query.groups > query.limit
      )
        data.topOf = query.groups;
      return data;
    }
  }
}

/** The short reason of a failed query for `fallbacks`: an error code, never the SQL or a value. */
function reasonOf(error: unknown): string {
  if (error instanceof DataError) return error.code.replaceAll("_", " ");
  if (error instanceof QueryPlanError) return error.code.replaceAll("_", " ");
  return "query error";
}

/**
 * Runs the queries one after the other. A query that fails (timeout, rejected, SQL error) drops
 * only its widget and is noted in `fallbacks`; a cancelled call rethrows; when no widget is left
 * the result is a `DashboardQueryError` (`query_failed`). `onProgress(done, total)` fires after
 * each widget, between queries.
 */
export async function runQueries(
  queries: readonly WidgetQuery[],
  run: RunQuery,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<QueryRun> {
  const data: WidgetData[] = [];
  const fallbacks: string[] = [];
  let done = 0;
  for (const query of queries) {
    if (signal.aborted) throw abortError();
    try {
      data.push(await runOne(query, run));
    } catch (error) {
      if (signal.aborted || (error instanceof DataError && error.code === "cancelled"))
        throw abortError();
      fallbacks.push(`widget ${noteId(query.widgetId)} dropped: ${reasonOf(error)}`);
    }
    onProgress?.(++done, queries.length);
  }
  if (!data.length)
    throw new DashboardQueryError("None of the dashboard queries could be answered", fallbacks);
  return { data, fallbacks };
}

export interface QueryDashboardInput {
  spec: DashboardSpec;
  catalog: readonly ProfiledColumn[];
  /** Row count of the sheet (the scatter stride). */
  rows: number;
  run: RunQuery;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Plan and run: the spec's widgets to data. `fallbacks` lists the widgets dropped while planning
 * and while running; no widget answered means `DashboardQueryError`.
 */
export async function queryDashboard(input: QueryDashboardInput): Promise<QueryRun> {
  const planned = widgetQueries(input.spec, input.catalog, input.rows);
  try {
    const result = await runQueries(planned.queries, input.run, input.signal, input.onProgress);
    return { data: result.data, fallbacks: [...planned.fallbacks, ...result.fallbacks] };
  } catch (error) {
    if (error instanceof DashboardQueryError)
      throw new DashboardQueryError(error.message, [...planned.fallbacks, ...error.fallbacks]);
    throw error;
  }
}
