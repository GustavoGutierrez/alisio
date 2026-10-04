import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type {
  DashboardSpec,
  DashboardTimeBucket,
  DashboardWidget,
  DecisionRequest,
  DecisionResponse,
} from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileQuery,
  DashboardQueryError,
  type ProfiledColumn,
  profileSheet,
  type QueryAst,
  QueryPlanError,
  queryDashboard,
  RuleBasedPlanner,
  runQueries,
  type SeriesData,
  SPEC_LIMITS,
  validateSpec,
  type WidgetData,
  type WidgetQuery,
  widgetQueries,
} from "../packages/core/src/analysis/dashboard/index.ts";
import { DataError } from "../packages/core/src/analysis/data/engine-client.ts";
import type { QueryResult } from "../packages/core/src/analysis/data/engine-types.ts";
import { guardSql } from "../packages/core/src/analysis/data/sql-guard.ts";
import { column, sheet } from "./dashboard-helpers.ts";
import { type DataFixture, dataFixture } from "./data-helpers.ts";

// ---- helpers: a real SQLite (node:sqlite) in memory, with untyped columns like the dataset tables ----
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function makeDb(columns: string[], rows: unknown[][], table = "data"): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ${quote(table)} (${columns.map(quote).join(", ")})`);
  const insert = db.prepare(
    `INSERT INTO ${quote(table)} VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows) insert.run(...(row as Array<string | number | null>));
  return db;
}

/** The `run` callback of `runQueries` over an in-memory database; applies maxRows like the engine. */
const sqliteRun =
  (db: DatabaseSync) =>
  async (sql: string, maxRows: number): Promise<QueryResult> => {
    const all = db.prepare(sql).all() as Array<Record<string, unknown>>;
    const rows = all
      .slice(0, maxRows)
      .map((r) => Object.values(r) as Array<string | number | null>);
    return {
      columns: Object.keys(all[0] ?? {}),
      rows,
      truncated: all.length > maxRows,
      clipped: false,
    };
  };

const signal = () => new AbortController().signal;

const catalogOf = (columns: ReturnType<typeof column>[], rows = 100) =>
  profileSheet(sheet(columns, { rows }));

/** g (4 groups), m (real), t (text only). */
const baseColumns = () => [
  column("g", "text", { distinct: 4, label: "Group" }),
  column("m", "real", { distinct: 90, min: "1", max: "100", label: "Metric" }),
  column("t", "text", { distinct: 3 }),
];

const spec = (widgets: DashboardWidget[], extra: Partial<DashboardSpec> = {}): DashboardSpec => ({
  version: 1,
  title: "Test",
  purpose: "executive",
  layout: "executive-grid",
  locale: "en",
  widgets,
  ...extra,
});

/** Plans one widget and returns its (only) query, failing on a planning fallback. */
function one(widget: DashboardWidget, catalog: ProfiledColumn[], rows = 100): WidgetQuery {
  const planned = widgetQueries(spec([widget]), catalog, rows);
  expect(planned.fallbacks).toEqual([]);
  expect(planned.queries).toHaveLength(1);
  return planned.queries[0] as WidgetQuery;
}

async function dataOf(
  widgets: DashboardWidget[],
  catalog: ProfiledColumn[],
  db: DatabaseSync,
  rows = 100,
): Promise<{ data: WidgetData[]; fallbacks: string[] }> {
  const planned = widgetQueries(spec(widgets), catalog, rows);
  const run = await runQueries(planned.queries, sqliteRun(db), signal());
  return { data: run.data, fallbacks: [...planned.fallbacks, ...run.fallbacks] };
}

// g,m rows used by the aggregation tests. Numeric m: 10, 20, 5, 7, 100, 5.5, 7 (sum 154.5);
// "x" is text and null is null: neither is a measure value.
const AGG_ROWS: unknown[][] = [
  ["A", 10, "p"],
  ["A", 20, "p"],
  ["B", 5, "q"],
  ["C", "x", "q"],
  ["C", 7, "r"],
  [null, 100, "r"],
  ["B", null, "r"],
  ["A", 5.5, "p"],
  ["D", 7, "p"],
];

const kpi = (aggregation: string, metric = "m"): DashboardWidget =>
  ({ id: "k", type: "kpi", metric, aggregation }) as DashboardWidget;
const series = (extra: Record<string, unknown>): DashboardWidget =>
  ({
    id: "s",
    type: "bar",
    dimension: "g",
    metric: "m",
    aggregation: "sum",
    ...extra,
  }) as DashboardWidget;

// ---- the AST compiler ----
describe("compileQuery", () => {
  const catalog = catalogOf(baseColumns());
  const ast = (extra: Partial<QueryAst> = {}): QueryAst => ({
    table: "data",
    select: [{ expr: { col: "g" }, as: "k" }],
    where: [],
    orderBy: [],
    limit: 10,
    ...extra,
  });

  it("quotes every identifier and has no literal but fixed ones", () => {
    const sql = compileQuery(
      ast({
        select: [
          { expr: { col: "g" }, as: "k" },
          { expr: { agg: "sum", col: "m" }, as: "v" },
        ],
        where: [{ notNull: { col: "g" } }, { numeric: "m" }],
        groupBy: [{ col: "g" }],
        orderBy: [{ key: { alias: "v" }, dir: "desc" }],
      }),
      catalog,
    );
    expect(sql).toBe(
      `SELECT "g" AS k, SUM("m") AS v FROM "data" WHERE "g" IS NOT NULL AND typeof("m") IN ('integer','real') GROUP BY "g" ORDER BY v DESC LIMIT 10`,
    );
    expect(guardSql(sql).ok).toBe(true);
  });

  it("throws for any identifier outside the catalog, wherever it appears", () => {
    const bad: QueryAst[] = [
      ast({ select: [{ expr: { col: "ghost" }, as: "k" }] }),
      ast({ select: [{ expr: { agg: "sum", col: "ghost" }, as: "v" }] }),
      ast({ select: [{ expr: { bucket: "day", col: "ghost" }, as: "k" }] }),
      ast({ where: [{ notNull: { col: "ghost" } }] }),
      ast({ where: [{ numeric: "ghost" }] }),
      ast({ where: [{ isoDate: "ghost" }] }),
      ast({ groupBy: [{ col: "ghost" }] }),
      ast({ orderBy: [{ key: { col: "ghost" }, dir: "asc" }] }),
      // a name that merely looks like SQL is not in the catalog either
      ast({ select: [{ expr: { col: 'g" FROM data; --' }, as: "k" }] }),
      // the catalog matches by exact name, not by label or alias
      ast({ select: [{ expr: { col: "Group" }, as: "k" }] }),
      ast({ select: [{ expr: { col: "c1" }, as: "k" }] }),
    ];
    for (const item of bad) expect(() => compileQuery(item, catalog)).toThrow(QueryPlanError);
  });

  it("only accepts plain table names and a closed alias set", () => {
    for (const table of ["", 'data"; DROP TABLE data; --', "a b", "x'y", "ñ"])
      expect(() => compileQuery(ast({ table }), catalog), table).toThrow(QueryPlanError);
    expect(() => compileQuery(ast({ table: "s_ventas_2" }), catalog)).not.toThrow();
    expect(() =>
      compileQuery(ast({ select: [{ expr: { col: "g" }, as: "k; DROP" as "k" }] }), catalog),
    ).toThrow(QueryPlanError);
  });

  it("rejects an aggregate that makes no sense", () => {
    const aggs = (agg: "sum" | "count_distinct", col?: string) =>
      ast({
        select: [{ expr: col ? { agg, col } : { agg }, as: "v" }],
      });
    expect(() => compileQuery(aggs("sum"), catalog)).toThrow(QueryPlanError);
    expect(() => compileQuery(aggs("count_distinct"), catalog)).toThrow(QueryPlanError);
  });

  it("clamps the limit and the stride to integers in range and refuses non-numbers", () => {
    expect(compileQuery(ast({ limit: 5000 }), catalog)).toMatch(/LIMIT 1000$/);
    expect(compileQuery(ast({ limit: -4 }), catalog)).toMatch(/LIMIT 1$/);
    expect(compileQuery(ast({ limit: 7.9 }), catalog)).toMatch(/LIMIT 7$/);
    expect(() => compileQuery(ast({ limit: Number.NaN }), catalog)).toThrow(QueryPlanError);
    expect(compileQuery(ast({ where: [{ stride: 0 }] }), catalog)).toContain("_rowid_ % 1 = 0");
    expect(compileQuery(ast({ where: [{ stride: 3.7 }] }), catalog)).toContain("_rowid_ % 3 = 0");
    expect(() => compileQuery(ast({ where: [{ stride: Number.NaN }] }), catalog)).toThrow(
      QueryPlanError,
    );
  });
});

// ---- KPI and aggregations ----
describe("KPI queries", () => {
  const catalog = catalogOf(baseColumns());
  const db = () => makeDb(["g", "m", "t"], AGG_ROWS);

  const value = async (widget: DashboardWidget) => {
    const { data, fallbacks } = await dataOf([widget], catalog, db());
    expect(fallbacks).toEqual([]);
    expect(data[0]).toMatchObject({ id: widget.id, type: "kpi" });
    return (data[0] as Extract<WidgetData, { type: "kpi" }>).value;
  };

  it("sum, avg, min and max read only numeric cells (not text, not null)", async () => {
    expect(await value(kpi("sum"))).toBe(154.5);
    expect(await value(kpi("avg"))).toBeCloseTo(154.5 / 7, 10);
    expect(await value(kpi("min"))).toBe(5);
    expect(await value(kpi("max"))).toBe(100);
  });

  it("count of * counts every row; count of a column counts its non-null cells", async () => {
    expect(await value(kpi("count", "*"))).toBe(9);
    expect(await value(kpi("count", "m"))).toBe(8);
  });

  it("count_distinct ignores nulls", async () => {
    expect(await value(kpi("count_distinct", "g"))).toBe(4);
  });

  it("is null (rendered as a dash) when there is no valid row", async () => {
    expect(await value(kpi("sum", "t"))).toBeNull();
    expect(await value(kpi("avg", "t"))).toBeNull();
    const empty = makeDb(["g", "m", "t"], []);
    const { data } = await dataOf([kpi("sum")], catalog, empty);
    expect(data[0]).toMatchObject({ type: "kpi", value: null });
  });

  it("reads one row", () => {
    expect(one(kpi("sum"), catalog).maxRows).toBe(1);
  });
});

// ---- ranking, composition and Other ----
describe("categorical series", () => {
  const catalog = catalogOf(baseColumns());
  const db = () => makeDb(["g", "m", "t"], AGG_ROWS);
  const points = (d: WidgetData | undefined) => d as SeriesData;

  it("groups by the dimension, orders by value descending then key, and drops null keys", async () => {
    const { data } = await dataOf([series({ limit: 10 })], catalog, db());
    expect(data[0]).toMatchObject({
      id: "s",
      type: "bar",
      points: [
        { k: "A", v: 35.5 },
        { k: "C", v: 7 },
        { k: "D", v: 7 }, // tie with C: the key breaks it, so the order is deterministic
        { k: "B", v: 5 },
      ],
    });
  });

  it("applies the limit and folds the rest into Other for sum", async () => {
    const { data } = await dataOf([series({ limit: 2, other: true })], catalog, db());
    expect(points(data[0]).points.map((p) => p.k)).toEqual(["A", "C"]);
    expect(points(data[0])).toMatchObject({ other: 12 }); // D 7 + B 5
    expect(points(data[0]).topOf).toBeUndefined();
  });

  it("Other for count is total minus the shown groups", async () => {
    const { data } = await dataOf(
      [series({ metric: "*", aggregation: "count", limit: 3, other: true })],
      catalog,
      db(),
    );
    expect(points(data[0]).points).toEqual([
      { k: "A", v: 3 },
      { k: "B", v: 2 },
      { k: "C", v: 2 },
    ]);
    expect(points(data[0])).toMatchObject({ other: 1 }); // D
  });

  it("has no Other when everything fits, and no Other without the flag", async () => {
    const fits = await dataOf([series({ limit: 10, other: true })], catalog, db());
    expect(points(fits.data[0]).other).toBeUndefined();
    const flagless = await dataOf([series({ limit: 2 })], catalog, db());
    expect(points(flagless.data[0]).other).toBeUndefined();
    expect(points(flagless.data[0]).topOf).toBe(4); // "Top 2 of 4"
  });

  it("never folds avg, min, max or count_distinct: it reports Top N of M", async () => {
    for (const aggregation of ["avg", "min", "max", "count_distinct"]) {
      const planned = one(series({ aggregation, limit: 2, other: true }), catalog);
      expect(planned.totalSql, aggregation).toBeUndefined();
      const { data } = await dataOf(
        [series({ aggregation, limit: 2, other: true })],
        catalog,
        db(),
      );
      expect(points(data[0]).other, aggregation).toBeUndefined();
      expect(points(data[0]).points, aggregation).toHaveLength(2);
      expect(points(data[0]).topOf, aggregation).toBe(4);
    }
  });

  it("pie and donut keep only groups above zero and never show a non-positive Other", async () => {
    const rows = [
      ["A", 10],
      ["B", 5],
      ["N", -8],
      ["Z", 0],
      ["C", 1],
    ];
    const cat = catalogOf(baseColumns());
    for (const type of ["pie", "donut"]) {
      const { data } = await dataOf(
        [series({ type, limit: 2, other: true })],
        cat,
        makeDb(["g", "m"], rows),
      );
      expect(points(data[0]).points).toEqual([
        { k: "A", v: 10 },
        { k: "B", v: 5 },
      ]);
      // total over every group is 8, shown 15: the remainder is negative, so there is no slice
      expect(points(data[0]).other).toBeUndefined();
    }
  });

  it("rounds the float noise out of Other", async () => {
    const rows = [
      ["A", 0.1],
      ["B", 0.2],
      ["C", 0.3],
    ];
    const { data } = await dataOf(
      [series({ limit: 1, other: true })],
      catalog,
      makeDb(["g", "m"], rows),
    );
    // top is C 0.3; total 0.6000000000000001 - 0.3 would leak noise
    expect(points(data[0]).other).toBe(0.3);
  });

  it("converts numeric keys to text and ignores text cells in the measure", async () => {
    const rows = [
      [1, 10],
      [2, "n/a"],
      [2, 4],
    ];
    const { data } = await dataOf([series({})], catalog, makeDb(["g", "m"], rows));
    expect(points(data[0]).points).toEqual([
      { k: "1", v: 10 },
      { k: "2", v: 4 },
    ]);
  });

  it("clamps the limit", () => {
    const sqlOf = (limit: unknown) => one(series({ limit }), catalog).sql;
    expect(sqlOf(500)).toMatch(/LIMIT 20$/);
    expect(sqlOf(0)).toMatch(/LIMIT 1$/);
    expect(sqlOf(-3)).toMatch(/LIMIT 1$/);
    expect(sqlOf(7.9)).toMatch(/LIMIT 7$/);
    expect(sqlOf(undefined)).toMatch(new RegExp(`LIMIT ${SPEC_LIMITS.defaultLimit}$`));
    expect(sqlOf("5; DROP TABLE data")).toMatch(new RegExp(`LIMIT ${SPEC_LIMITS.defaultLimit}$`));
    expect(one(series({ limit: 500 }), catalog).maxRows).toBeLessThanOrEqual(1000);
  });
});

// ---- time buckets ----
describe("time buckets", () => {
  /** A date column whose span keeps the requested bucket (no coarsening) plus a measure. */
  const timeCatalog = (days = 40) => {
    const min = "2024-01-01";
    const max = new Date(Date.parse(`${min}T00:00:00Z`) + days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return catalogOf([
      column("d", "date", { distinct: 300, min, max }),
      column("m", "real", { distinct: 90, min: "1", max: "100" }),
    ]);
  };
  const trend = (timeBucket: DashboardTimeBucket): DashboardWidget => ({
    id: "t",
    type: "line",
    dimension: "d",
    metric: "m",
    aggregation: "sum",
    timeBucket,
  });
  /** The bucket keys of the dates, one row of measure 1 each. */
  async function keys(
    bucket: DashboardTimeBucket,
    dates: unknown[],
    catalog = timeCatalog(),
  ): Promise<string[]> {
    const db = makeDb(
      ["d", "m"],
      dates.map((d) => [d, 1]),
    );
    const { data, fallbacks } = await dataOf([trend(bucket)], catalog, db);
    expect(fallbacks).toEqual([]);
    return (data[0] as SeriesData).points.map((p) => p.k);
  }

  it("day, month, quarter and year", async () => {
    const dates = ["2023-12-31", "2024-01-01", "2024-03-31", "2024-04-01"];
    expect(await keys("day", dates)).toEqual(dates);
    expect(await keys("month", dates)).toEqual(["2023-12", "2024-01", "2024-03", "2024-04"]);
    expect(await keys("quarter", dates)).toEqual(["2023-Q4", "2024-Q1", "2024-Q2"]);
    expect(await keys("year", dates)).toEqual(["2023", "2024"]);
  });

  it("week starts on Monday: a Monday, a Sunday and the year boundaries (Phase 0, E3)", async () => {
    const cases: Array<[string, string]> = [
      ["2024-01-15", "2024-01-15"], // Monday: its own week, not the previous one
      ["2024-01-16", "2024-01-15"],
      ["2024-01-21", "2024-01-15"], // Sunday: belongs to the week that started on the 15th
      ["2024-01-22", "2024-01-22"],
      ["2023-12-31", "2023-12-25"], // Sunday, Dec 31
      ["2024-01-01", "2024-01-01"], // Monday, Jan 1
      ["2023-01-01", "2022-12-26"], // Sunday, Jan 1: the week started the previous year
      ["2024-12-31", "2024-12-30"],
    ];
    for (const [date, week] of cases) expect(await keys("week", [date]), date).toEqual([week]);
  });

  it("every day of 2020-2023 lands on its Monday", async () => {
    const dates: string[] = [];
    const expected = new Set<string>();
    for (
      let t = Date.parse("2020-01-01T00:00:00Z");
      t <= Date.parse("2023-12-31T00:00:00Z");
      t += 86_400_000
    ) {
      const day = new Date(t);
      dates.push(day.toISOString().slice(0, 10));
      const monday = new Date(t - ((day.getUTCDay() + 6) % 7) * 86_400_000);
      expected.add(monday.toISOString().slice(0, 10));
    }
    const cat = timeCatalog(1461);
    const got = await keys("week", dates, cat);
    expect(got).toEqual([...expected].sort());
  });

  it("normalizes offsets and Z to UTC, and reads fractions and a space separator", async () => {
    expect(
      await keys("day", [
        "2024-01-01T00:30:00+05:30", // 2023-12-31 19:00 UTC
        "2024-01-01T23:30:00Z",
        "2024-01-01T23:30:00-05:00", // 2024-01-02 04:30 UTC
        "2024-01-01T10:00:00.123Z",
        "2024-03-05 10:00:00",
      ]),
    ).toEqual(["2023-12-31", "2024-01-01", "2024-01-02", "2024-03-05"]);
  });

  it("a text such as 2024 is not read as a Julian day: the GLOB guard excludes it", async () => {
    const odd = ["2024", "20240115", 2024, "abc", "", "2024-1-5", "2024-13-01", "2024-02-10"];
    expect(await keys("day", odd)).toEqual(["2024-02-10"]);
    expect(await keys("year", odd)).toEqual(["2024"]);
    const sql = one(trend("day"), timeCatalog()).sql;
    expect(sql).toContain(`"d" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`);
  });

  it("sums per bucket, sorts ascending and leaves gaps empty", async () => {
    const db = makeDb(
      ["d", "m"],
      [
        ["2024-01-03", 5],
        ["2024-01-01", 1],
        ["2024-01-03", 2],
        ["2024-01-09", "n/a"],
        ["2024-01-09", 4],
      ],
    );
    const { data } = await dataOf([trend("day")], timeCatalog(), db);
    expect(data[0]).toMatchObject({
      type: "line",
      bucket: "day",
      points: [
        { k: "2024-01-01", v: 1 },
        { k: "2024-01-03", v: 7 },
        { k: "2024-01-09", v: 4 },
      ],
    });
  });

  it("filters null dates and counts rows with metric *", async () => {
    const db = makeDb(
      ["d", "m"],
      [
        [null, 1],
        ["2024-01-01", 1],
        ["2024-01-01", null],
      ],
    );
    const widget = { ...trend("day"), metric: "*", aggregation: "count" } as DashboardWidget;
    const { data } = await dataOf([widget], timeCatalog(), db);
    expect((data[0] as SeriesData).points).toEqual([{ k: "2024-01-01", v: 2 }]);
  });

  it("coarsens a bucket that would produce more than 400, instead of truncating the tail", () => {
    // 1826 days of daily buckets would be 1828: weekly gives 262
    const wide = timeCatalog(1826);
    const q = one(trend("day"), wide);
    expect(q.bucket).toBe("week");
    expect(q.sql).toContain("'weekday 1'");
    expect(q.sql).toMatch(/LIMIT 400$/);
    // 5000 days of weekly buckets is 716: monthly gives 166
    expect(one(trend("week"), timeCatalog(5000)).bucket).toBe("month");
    // a bucket that already fits is kept
    expect(one(trend("day"), timeCatalog(40)).bucket).toBe("day");
    expect(one(trend("year"), timeCatalog(40)).bucket).toBe("year");
  });

  it("never returns more than 400 buckets for a long span", async () => {
    const days = 3000;
    const dates: string[] = [];
    for (let i = 0; i < days; i++)
      dates.push(
        new Date(Date.parse("2016-01-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10),
      );
    const cat = catalogOf([
      column("d", "date", { distinct: days, min: "2016-01-01", max: dates.at(-1) }),
      column("m", "real", { distinct: 9, min: "1", max: "2" }),
    ]);
    const got = await keys("day", dates, cat);
    // 3000 days: daily (3002) and weekly (431) buckets exceed 400, monthly (~99) fits
    expect(got.length).toBeLessThanOrEqual(400);
    expect(got.every((k) => /^\d{4}-\d{2}$/.test(k))).toBe(true);
    expect(got).toHaveLength(99);
  });

  it("a time dimension without a bucket is a planning failure of that widget only", () => {
    const widget = { ...trend("day"), timeBucket: undefined } as unknown as DashboardWidget;
    const planned = widgetQueries(
      spec([widget, kpi("sum")]),
      catalogOf([
        ...baseColumns(),
        column("d", "date", { distinct: 300, min: "2024-01-01", max: "2024-02-01" }),
      ]),
      100,
    );
    expect(planned.queries.map((q) => q.widgetId)).toEqual(["k"]);
    expect(planned.fallbacks).toEqual([expect.stringContaining("t")]);
  });
});

// ---- scatter and table ----
describe("scatter and table", () => {
  const catalog = catalogOf([
    column("x", "real", { distinct: 900, min: "1", max: "9" }),
    column("y", "real", { distinct: 900, min: "1", max: "9" }),
    column("t", "text", { distinct: 3 }),
  ]);
  const scatter = { id: "sc", type: "scatter", x: "x", y: "y" } as DashboardWidget;

  it("samples deterministically by rowid with a stride from the row count", async () => {
    expect(one(scatter, catalog, 300).sql).toContain("_rowid_ % 1 = 0");
    expect(one(scatter, catalog, 500).sql).toContain("_rowid_ % 1 = 0");
    expect(one(scatter, catalog, 501).sql).toContain("_rowid_ % 2 = 0");
    expect(one(scatter, catalog, 1200).sql).toContain("_rowid_ % 3 = 0");
    expect(one(scatter, catalog, 1200).sql).toMatch(/ORDER BY _rowid_ LIMIT 500$/);
    expect(one(scatter, catalog, 0).sql).toContain("_rowid_ % 1 = 0");

    const rows = Array.from({ length: 1000 }, (_, i) => [i + 1, (i + 1) * 2, "a"]);
    const db = makeDb(["x", "y", "t"], rows);
    const first = await dataOf([scatter], catalog, db, 1000);
    expect(first).toEqual(await dataOf([scatter], catalog, db, 1000));
    const pts = (first.data[0] as Extract<WidgetData, { type: "scatter" }>).points;
    expect(pts).toHaveLength(500);
    expect(pts[0]).toEqual([2, 4]);
    expect(pts.at(-1)).toEqual([1000, 2000]);
  });

  it("keeps only rows where both axes are numbers", async () => {
    const db = makeDb(
      ["x", "y", "t"],
      [
        [1, 2, "a"],
        ["n/a", 3, "a"],
        [4, null, "a"],
        [5, "z", "a"],
        [6.5, 7.5, "a"],
      ],
    );
    const { data } = await dataOf([scatter], catalog, db, 5);
    expect((data[0] as Extract<WidgetData, { type: "scatter" }>).points).toEqual([
      [1, 2],
      [6.5, 7.5],
    ]);
  });

  it("the table selects its columns in order by rowid, with a clamped limit, even if a column is called rowid", async () => {
    const cat = catalogOf([
      column("name", "text", { distinct: 50 }),
      column("rowid", "integer", { distinct: 50, min: "1", max: "9" }),
    ]);
    const widget = {
      id: "tb",
      type: "table",
      columns: ["rowid", "name"],
      limit: 3,
    } as DashboardWidget;
    const db = makeDb(
      ["name", "rowid"],
      [
        ["c", 9],
        ["b", 1],
        ["a", 5],
        ["d", 0],
      ],
    );
    const { data } = await dataOf([widget], cat, db);
    expect(data[0]).toEqual({
      id: "tb",
      type: "table",
      columns: ["rowid", "name"],
      rows: [
        [9, "c"],
        [1, "b"],
        [5, "a"],
      ],
    });
    const big = { ...widget, limit: 500 } as DashboardWidget;
    expect(one(big, cat).sql).toMatch(/LIMIT 20$/);
  });

  it("a table needs between 1 and 8 columns", () => {
    const cols = Array.from({ length: 9 }, (_, i) => column(`c${i}`, "text", { distinct: 9 }));
    const cat = catalogOf(cols);
    const wide = { id: "w", type: "table", columns: cols.map((c) => c.name) } as DashboardWidget;
    const none = { id: "n", type: "table", columns: [] } as unknown as DashboardWidget;
    const planned = widgetQueries(spec([wide, none]), cat, 10);
    expect(planned.queries).toEqual([]);
    expect(planned.fallbacks).toHaveLength(2);
  });
});

// ---- identifiers, the guard and untrusted text ----
describe("identifier safety", () => {
  const hostile = [
    'a"b',
    'x"; DROP TABLE data; --',
    "with space",
    "select",
    "drop",
    "replace",
    "attach",
    "ünï_çødé",
    "日本語",
    "emoji_😀",
    "back`tick",
    "[brackets]",
    "it's",
    "semi;colon",
    "comment--x",
    "/*c*/",
  ];

  it("quotes hostile column names, runs them, and the guard accepts the result", async () => {
    const names = [...hostile, "dimension", "measure"];
    const cat = catalogOf(names.map((n) => column(n, "text", { distinct: 3 })));
    const rows = [
      names.map((_, i) => (i % 2 ? `v${i}` : i)),
      names.map((_, i) => (i % 2 ? `v${i}` : i + 10)),
    ];
    const db = makeDb(names, rows);
    const widgets: DashboardWidget[] = [
      ...hostile.map(
        (n, i) =>
          ({
            id: `k${i}`,
            type: "kpi",
            metric: n,
            aggregation: "count_distinct",
          }) as DashboardWidget,
      ),
      ...hostile.map(
        (n, i) =>
          ({
            id: `b${i}`,
            type: "bar",
            dimension: n,
            metric: "*",
            aggregation: "count",
          }) as DashboardWidget,
      ),
      { id: "tb", type: "table", columns: hostile.slice(0, 8) },
      { id: "sc", type: "scatter", x: hostile[0] as string, y: hostile[1] as string },
    ];
    const planned = widgetQueries(spec(widgets), cat, 10);
    expect(planned.fallbacks).toEqual([]);
    expect(planned.queries).toHaveLength(widgets.length);
    for (const q of planned.queries) {
      expect(guardSql(q.sql).ok, q.sql).toBe(true);
      if (q.totalSql) expect(guardSql(q.totalSql).ok, q.totalSql).toBe(true);
    }
    const run = await runQueries(planned.queries, sqliteRun(db), signal());
    expect(run.fallbacks).toEqual([]);
    const kpis = run.data.filter((d) => d.type === "kpi") as Array<
      Extract<WidgetData, { type: "kpi" }>
    >;
    expect(kpis).toHaveLength(hostile.length);
    // even columns hold two different numbers, odd ones the same text twice
    kpis.forEach((d, i) => expect(d.value).toBe(i % 2 ? 1 : 2));
    const table = run.data.find((d) => d.id === "tb") as Extract<WidgetData, { type: "table" }>;
    expect(table.columns).toEqual(hostile.slice(0, 8));
    expect(table.rows).toHaveLength(2);
  });

  it("a hostile sheet name never reaches the SQL", () => {
    const cat = catalogOf(baseColumns());
    for (const sheetName of ['x"; DROP TABLE data; --', "a b", ""])
      expect(
        () => widgetQueries(spec([kpi("sum")], { sheet: sheetName }), cat, 10),
        sheetName,
      ).toThrow(QueryPlanError);
    const planned = widgetQueries(spec([kpi("sum")], { sheet: "s_ventas" }), cat, 10);
    expect(planned.queries[0]?.sql).toContain('FROM "s_ventas"');
    expect(widgetQueries(spec([kpi("sum")]), cat, 10).queries[0]?.sql).toContain('FROM "data"');
  });

  it("a widget naming a column outside the catalog is dropped and the others stay", () => {
    const cat = catalogOf(baseColumns());
    const planned = widgetQueries(
      spec([
        { id: "bad", type: "kpi", metric: 'm"; DROP TABLE data; --', aggregation: "sum" },
        { id: "bad2", type: "bar", dimension: "ghost", metric: "m", aggregation: "sum" },
        { id: "bad3", type: "kpi", metric: "*", aggregation: "sum" },
        kpi("sum"),
      ]),
      cat,
      10,
    );
    expect(planned.queries.map((q) => q.widgetId)).toEqual(["k"]);
    expect(planned.fallbacks).toHaveLength(3);
    // metadata only: widget ids and a reason, never the identifier that was refused
    for (const note of planned.fallbacks) {
      expect(note).not.toContain("DROP");
      expect(note).not.toContain("ghost");
    }
  });

  it("no value from a goal, a decision answer or a title can reach a query", async () => {
    const sentinel = "SENTINEL'; DROP TABLE data; --";
    const decisions = {
      tryDecide: vi.fn(
        async (_request: DecisionRequest): Promise<DecisionResponse | null> => ({
          provider: "evil",
          latencyMs: 1,
          decisions: {
            purpose: { type: "select", value: sentinel, confidence: 0.9 },
            primaryMeasure: { type: "select", value: sentinel, confidence: 0.9 },
            rankingDimension: { type: "select", value: sentinel, confidence: 0.9 },
            includeTrend: { type: "boolean", value: true, confidence: 0.9, probability: 0.9 },
          },
          rejected: {},
        }),
      ),
    };
    const detail = sheet(
      [
        column("order_date", "date", { distinct: 300, min: "2024-01-01", max: "2024-12-31" }),
        column("region", "text", { distinct: 5 }),
        column("sales", "real", { distinct: 900, min: "1", max: "999" }),
        column("profit", "real", { distinct: 900, min: "1", max: "999" }),
      ],
      { rows: 500 },
    );
    const result = await new RuleBasedPlanner().plan({
      sheet: detail,
      goal: sentinel,
      title: sentinel,
      locale: "en",
      decisions,
    });
    if (!result.ok) throw new Error("plan failed");
    const poisoned: DashboardSpec = {
      ...result.spec,
      title: sentinel,
      widgets: result.spec.widgets.map((w) => ({
        ...w,
        title: sentinel,
        label: sentinel,
      })) as DashboardWidget[],
    };
    expect(validateSpec(result.spec, result.catalog).result).toBe("valid");
    const planned = widgetQueries(poisoned, result.catalog, 500);
    expect(planned.queries.length).toBe(result.spec.widgets.length);
    const text = planned.queries.map((q) => `${q.sql}\n${q.totalSql ?? ""}`).join("\n");
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain("DROP");
    for (const q of planned.queries) expect(guardSql(q.sql).ok).toBe(true);
  });
});

// ---- running: failures, progress, cancellation, the guard ----
describe("runQueries", () => {
  const catalog = catalogOf(baseColumns());
  const widgets: DashboardWidget[] = [
    { id: "a", type: "kpi", metric: "m", aggregation: "sum" },
    { id: "b", type: "bar", dimension: "g", metric: "m", aggregation: "sum" },
    { id: "c", type: "table", columns: ["g", "m"] },
  ];
  const planned = () => widgetQueries(spec(widgets), catalog, 10).queries;
  const db = () => makeDb(["g", "m", "t"], AGG_ROWS);

  it("returns the data in widget order and reports progress between queries", async () => {
    const progress = vi.fn();
    const { data, fallbacks } = await runQueries(planned(), sqliteRun(db()), signal(), progress);
    expect(data.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(fallbacks).toEqual([]);
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("a timeout drops only its widget and records it in fallbacks, without the SQL", async () => {
    const real = sqliteRun(db());
    const run = async (sql: string, maxRows: number) => {
      if (sql.includes("GROUP BY"))
        throw new DataError("query_timeout", `The query ${sql} took longer`);
      return real(sql, maxRows);
    };
    const { data, fallbacks } = await runQueries(planned(), run, signal());
    expect(data.map((d) => d.id)).toEqual(["a", "c"]);
    expect(fallbacks).toEqual([expect.stringMatching(/widget b dropped.*timeout/i)]);
    expect(fallbacks.join(" ")).not.toMatch(/SELECT|FROM/);
  });

  it("an unexpected error of one query is also contained, by code", async () => {
    const real = sqliteRun(db());
    const run = async (sql: string, maxRows: number) => {
      if (sql.includes("SUM(") && !sql.includes("GROUP BY") && !sql.includes("ORDER"))
        throw new Error("boom with secret-value");
      return real(sql, maxRows);
    };
    const { data, fallbacks } = await runQueries(planned(), run, signal());
    expect(data.map((d) => d.id)).toEqual(["b", "c"]);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).not.toContain("secret-value");
  });

  it("when every widget fails it is an error", async () => {
    const run = async () => {
      throw new DataError("query_timeout", "slow");
    };
    await expect(runQueries(planned(), run, signal())).rejects.toBeInstanceOf(DashboardQueryError);
    await expect(runQueries(planned(), run, signal())).rejects.toMatchObject({
      code: "query_failed",
    });
    await expect(runQueries([], sqliteRun(db()), signal())).rejects.toMatchObject({
      code: "query_failed",
    });
  });

  it("a cancelled call stops and rethrows instead of dropping widgets", async () => {
    const controller = new AbortController();
    const real = sqliteRun(db());
    const run = vi.fn(async (sql: string, maxRows: number) => {
      controller.abort();
      return real(sql, maxRows);
    });
    await expect(runQueries(planned(), run, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(run).toHaveBeenCalledTimes(1);
    const cancelled = async () => {
      throw new DataError("cancelled", "Cancelled");
    };
    const second = new AbortController();
    second.abort();
    await expect(runQueries(planned(), cancelled, second.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("runs the queries one after the other", async () => {
    let active = 0;
    let peak = 0;
    const real = sqliteRun(db());
    const run = async (sql: string, maxRows: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return real(sql, maxRows);
    };
    await runQueries(planned(), run, signal());
    expect(peak).toBe(1);
  });
});

// ---- integration: a real ingested dataset through the real query path (guard on) ----
describe("over a real dataset", () => {
  let fixture: DataFixture | undefined;
  afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
  });

  const FILES = ["dashboard_simple_300.csv", "dataset_dashboard_4000.csv"];
  const read = (name: string) => readFile(new URL(`../examples/data/${name}`, import.meta.url));

  for (const file of FILES) {
    it(`${file}: plans, queries every widget and the numbers agree with a direct SQL`, async () => {
      fixture = await dataFixture();
      const f = fixture;
      const { record } = await f.ingest(file, new Uint8Array(await read(file)));
      const detail = f.service.detail(record).sheetDetails[0];
      if (!detail) throw new Error("no sheet");
      const planResult = await new RuleBasedPlanner().plan({
        sheet: detail,
        goal: "resumen de ventas y rentabilidad",
        locale: "es",
      });
      if (!planResult.ok) throw new Error("plan failed");
      const calls: string[] = [];
      const started = Date.now();
      const result = await queryDashboard({
        spec: planResult.spec,
        catalog: planResult.catalog,
        rows: detail.rows,
        signal: signal(),
        run: (sql, maxRows) => {
          calls.push(sql);
          return f.service.query(record, sql, { maxRows });
        },
      });
      expect(Date.now() - started).toBeLessThan(5000 * calls.length);
      expect(result.fallbacks).toEqual([]);
      expect(result.data.map((d) => d.id)).toEqual(planResult.spec.widgets.map((w) => w.id));
      expect(calls.every((sql) => guardSql(sql).ok)).toBe(true);

      for (const widget of planResult.spec.widgets) {
        const d = result.data.find((x) => x.id === widget.id) as WidgetData;
        expect(d.type).toBe(widget.type);
        if (widget.type === "kpi") {
          const metric = widget.metric === "*" ? "*" : `"${widget.metric}"`;
          const fn = {
            sum: "SUM",
            avg: "AVG",
            min: "MIN",
            max: "MAX",
            count: "COUNT",
            count_distinct: "COUNT",
          }[widget.aggregation];
          const distinct = widget.aggregation === "count_distinct" ? "DISTINCT " : "";
          const filter = ["sum", "avg", "min", "max"].includes(widget.aggregation)
            ? ` WHERE typeof(${metric}) IN ('integer','real')`
            : "";
          const direct = await f.service.query(
            record,
            `SELECT ${fn}(${distinct}${metric}) FROM data${filter}`,
          );
          expect((d as Extract<WidgetData, { type: "kpi" }>).value).toBe(direct.rows[0]?.[0]);
        } else if (widget.type === "scatter") {
          const pts = (d as Extract<WidgetData, { type: "scatter" }>).points;
          expect(pts.length).toBeGreaterThan(0);
          expect(pts.length).toBeLessThanOrEqual(500);
        } else if (widget.type === "table") {
          const t = d as Extract<WidgetData, { type: "table" }>;
          expect(t.columns).toEqual(widget.columns);
          expect(t.rows.length).toBeGreaterThan(0);
          expect(t.rows.length).toBeLessThanOrEqual(20);
        } else {
          const s = d as SeriesData;
          expect(s.points.length).toBeGreaterThan(0);
          const timeDim =
            planResult.catalog.find((c) => c.name === widget.dimension)?.role === "time";
          if (timeDim) {
            expect(s.points.length).toBeLessThanOrEqual(SPEC_LIMITS.maxBuckets);
            const ks = s.points.map((p) => p.k);
            expect(ks).toEqual([...ks].sort());
          } else {
            expect(s.points.length).toBeLessThanOrEqual(20);
            const vs = s.points.map((p) => p.v);
            expect(vs).toEqual([...vs].sort((a, b) => b - a));
          }
          if (
            widget.aggregation === "sum" &&
            widget.other &&
            !timeDim &&
            "other" in s &&
            s.other !== undefined
          ) {
            const total = await f.service.query(
              record,
              `SELECT SUM("${widget.metric}") FROM data WHERE "${widget.dimension}" IS NOT NULL AND typeof("${widget.metric}") IN ('integer','real')`,
            );
            const shown = s.points.reduce((acc, p) => acc + p.v, 0) + s.other;
            expect(shown).toBeCloseTo(Number(total.rows[0]?.[0]), 3);
          }
        }
      }
    });
  }

  it("the guard stays on: a tampered query is rejected and the dataset is intact", async () => {
    fixture = await dataFixture();
    const f = fixture;
    const { record } = await f.ingest("t.csv", "region,revenue\nWest,10\nEast,20\nWest,5\n");
    const detail = f.service.detail(record).sheetDetails[0];
    if (!detail) throw new Error("no sheet");
    const catalog = profileSheet(detail);
    const q = widgetQueries(spec([kpi("sum", "revenue")]), catalog, detail.rows).queries;
    const tampered: WidgetQuery[] = q.map((x) => ({ ...x, sql: `${x.sql}; DROP TABLE data` }));
    const good = widgetQueries(
      spec([kpi("sum", "revenue"), { ...kpi("count", "*"), id: "n" } as DashboardWidget]),
      catalog,
      detail.rows,
    ).queries;
    const run = (sql: string, maxRows: number) => f.service.query(record, sql, { maxRows });
    const mixed = await runQueries(
      [...tampered.map((t) => ({ ...t, widgetId: "evil" })), ...good],
      run,
      signal(),
    );
    expect(mixed.fallbacks).toEqual([expect.stringMatching(/widget evil dropped.*rejected/i)]);
    expect(mixed.data.map((d) => d.id)).toEqual(["k", "n"]);
    expect((await f.service.query(record, "SELECT count(*) FROM data")).rows).toEqual([[3]]);
  });

  it("an XLSX-style sheet table name is used as given", async () => {
    fixture = await dataFixture();
    const f = fixture;
    const { record } = await f.ingest("t.csv", "region,revenue\nWest,10\n");
    const detail = f.service.detail(record).sheetDetails[0];
    if (!detail) throw new Error("no sheet");
    const result = await queryDashboard({
      spec: spec([kpi("sum", "revenue")], { sheet: detail.table }),
      catalog: profileSheet(detail),
      rows: detail.rows,
      signal: signal(),
      run: (sql, maxRows) => f.service.query(record, sql, { maxRows }),
    });
    expect(result.data).toEqual([{ id: "k", type: "kpi", value: 10 }]);
  });

  it("queryDashboard fails with query_failed when no widget can be planned", async () => {
    const cat = catalogOf(baseColumns());
    await expect(
      queryDashboard({
        spec: spec([{ id: "x", type: "kpi", metric: "ghost", aggregation: "sum" }]),
        catalog: cat,
        rows: 1,
        signal: signal(),
        run: async () => ({ columns: [], rows: [], truncated: false, clipped: false }),
      }),
    ).rejects.toMatchObject({ code: "query_failed" });
  });
});
