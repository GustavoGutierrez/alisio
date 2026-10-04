import type { DashboardSpec, DashboardWidget } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  profileSheet,
  SPEC_LIMITS,
  validateSpec,
} from "../packages/core/src/analysis/dashboard/index.ts";
import { column, sheet } from "./dashboard-helpers.ts";

const catalog = profileSheet(
  sheet(
    [
      column("order_id", "text", { distinct: 1000 }), // identifier
      column("order_date", "date", { distinct: 365, min: "2024-01-01", max: "2024-12-31" }), // time, 365 days
      column("region", "text", { distinct: 5 }), // dimension
      column("city", "text", { distinct: 40 }), // dimension
      column("sales", "real", { distinct: 900, min: "1", max: "9" }), // measure
      column("profit", "real", { distinct: 900, min: "1", max: "9" }), // measure
      column("units", "integer", { distinct: 20, min: "1", max: "30" }), // measure
      column("active", "boolean", { distinct: 2 }),
    ],
    { rows: 1000 },
  ),
);

const spec = (widgets: unknown[], extra: Record<string, unknown> = {}): unknown => ({
  version: 1,
  title: "Sales",
  purpose: "executive",
  layout: "executive-grid",
  locale: "en",
  widgets,
  ...extra,
});
const kpi = (id: string, metric = "sales", aggregation = "sum"): DashboardWidget =>
  ({ id, type: "kpi", metric, aggregation }) as DashboardWidget;
const bar = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    type: "hbar",
    dimension: "region",
    metric: "sales",
    aggregation: "sum",
    limit: 10,
    ...extra,
  }) as DashboardWidget;

function repaired(input: unknown) {
  const result = validateSpec(input, catalog);
  if (result.result === "fallback") throw new Error(`fallback: ${result.reasons.join("; ")}`);
  return result;
}
const repairsOf = (input: unknown) => {
  const result = repaired(input);
  return result.result === "repaired" ? result.repairs.join(" | ") : "";
};
const widgetsOf = (input: unknown): DashboardWidget[] => repaired(input).spec.widgets;

describe("validateSpec: valid specs", () => {
  it("returns a well-formed spec unchanged", () => {
    const input = spec([
      kpi("kpi-sales"),
      {
        id: "trend",
        type: "line",
        dimension: "order_date",
        metric: "sales",
        aggregation: "sum",
        timeBucket: "month",
      },
      bar("ranking"),
      {
        id: "mix",
        type: "donut",
        dimension: "region",
        metric: "*",
        aggregation: "count",
        limit: 5,
        other: true,
      },
      { id: "xy", type: "scatter", x: "sales", y: "profit" },
      { id: "detail", type: "table", columns: ["order_date", "region", "sales"], limit: 10 },
    ]);
    const result = validateSpec(input, catalog);
    expect(result.result).toBe("valid");
    expect(result.result === "valid" && result.spec).toEqual(input);
  });

  it("accepts the optional sheet and widget titles", () => {
    const result = validateSpec(
      spec([{ ...kpi("k"), title: "Total" }], { sheet: "s_ventas" }),
      catalog,
    );
    expect(result.result).toBe("valid");
  });
});

describe("validateSpec: repair table (spec 6.3)", () => {
  it("pie/donut with more than 6 categories becomes hbar", () => {
    const widgets = widgetsOf(
      spec([
        { id: "a", type: "pie", dimension: "city", metric: "sales", aggregation: "sum" },
        {
          id: "b",
          type: "donut",
          dimension: "region",
          metric: "sales",
          aggregation: "sum",
          limit: 8,
        },
        {
          id: "c",
          type: "donut",
          dimension: "city",
          metric: "sales",
          aggregation: "sum",
          limit: 5,
          other: true,
        },
        { id: "d", type: "pie", dimension: "region", metric: "sales", aggregation: "sum" },
      ]),
    );
    expect(widgets.map((w) => [w.id, w.type])).toEqual([
      ["a", "hbar"],
      ["b", "hbar"],
      ["c", "donut"], // 5 + Other = 6 slices
      ["d", "pie"], // 5 categories
    ]);
    expect(
      repairsOf(
        spec([
          { id: "a", type: "pie", dimension: "city", metric: "sales", aggregation: "sum" },
          kpi("k"),
        ]),
      ),
    ).toMatch(/a.*hbar/);
  });

  it("drops a later duplicate widget (same type, dimension, metric and aggregation)", () => {
    const widgets = widgetsOf(spec([bar("a"), bar("b"), bar("c", { dimension: "city" })]));
    expect(widgets.map((w) => w.id)).toEqual(["a", "c"]);
  });

  it("drops duplicate KPIs and scatters too", () => {
    const widgets = widgetsOf(
      spec([
        kpi("a"),
        kpi("b"),
        { id: "s1", type: "scatter", x: "sales", y: "profit" },
        { id: "s2", type: "scatter", x: "sales", y: "profit" },
      ]),
    );
    expect(widgets.map((w) => w.id)).toEqual(["a", "s1"]);
  });

  it("trims more than 6 KPIs, and more than 12 widgets by layout priority", () => {
    const kpis = Array.from({ length: 8 }, (_, i) =>
      kpi(
        `k${i}`,
        ["sales", "profit", "units"][i % 3],
        ["sum", "avg", "min", "max"][Math.floor(i / 3)],
      ),
    );
    expect(widgetsOf(spec(kpis)).filter((w) => w.type === "kpi")).toHaveLength(6);
    const many = [
      ...Array.from({ length: 6 }, (_, i) =>
        kpi(`k${i}`, ["sales", "profit", "units"][i % 3], i < 3 ? "sum" : "avg"),
      ),
      { id: "t", type: "table", columns: ["region"] },
      { id: "xy", type: "scatter", x: "sales", y: "profit" },
      bar("r1"),
      bar("r2", { dimension: "city" }),
      bar("r3", { metric: "profit" }),
      bar("r4", { dimension: "city", metric: "profit" }),
      {
        id: "line",
        type: "line",
        dimension: "order_date",
        metric: "sales",
        aggregation: "sum",
        timeBucket: "month",
      },
    ];
    expect(many).toHaveLength(13);
    const trimmed = widgetsOf(spec(many, { layout: "executive-grid" }));
    expect(trimmed).toHaveLength(SPEC_LIMITS.widgets);
    // roles the executive layout does not list go first, the later one before the earlier
    expect(trimmed.map((w) => w.id)).not.toContain("xy");
    expect(trimmed.map((w) => w.id)).toContain("t");
    expect(trimmed.map((w) => w.id)).toContain("line");
  });

  it("clamps limit into 1..20", () => {
    const widgets = widgetsOf(
      spec([
        bar("a", { limit: 0 }),
        bar("b", { dimension: "city", limit: 50 }),
        { id: "t", type: "table", columns: ["region"], limit: 99 },
      ]),
    );
    expect(widgets.map((w) => ("limit" in w ? w.limit : undefined))).toEqual([1, 20, 20]);
    expect(repairsOf(spec([bar("a", { limit: 0 })]))).toMatch(/limit/);
  });

  it("drops a widget that uses an identifier as dimension", () => {
    const widgets = widgetsOf(spec([bar("a", { dimension: "order_id" }), bar("b")]));
    expect(widgets.map((w) => w.id)).toEqual(["b"]);
  });

  it("drops a scatter without two distinct measures", () => {
    const widgets = widgetsOf(
      spec([
        { id: "same", type: "scatter", x: "sales", y: "sales" },
        { id: "dim", type: "scatter", x: "sales", y: "region" },
        { id: "ok", type: "scatter", x: "sales", y: "units" },
      ]),
    );
    expect(widgets.map((w) => w.id)).toEqual(["ok"]);
  });

  it("changes sum/avg/min/max over a non-measure to count_distinct", () => {
    const widgets = widgetsOf(
      spec([kpi("a", "region", "sum"), bar("b", { metric: "city", aggregation: "avg" })]),
    );
    expect(
      widgets.map((w) =>
        w.type === "kpi"
          ? [w.metric, w.aggregation]
          : [w.type === "hbar" && w.metric, w.type === "hbar" && w.aggregation],
      ),
    ).toEqual([
      ["region", "count_distinct"],
      ["city", "count_distinct"],
    ]);
  });

  it("computes a missing timeBucket from the span", () => {
    const widgets = widgetsOf(
      spec([
        { id: "t", type: "line", dimension: "order_date", metric: "sales", aggregation: "sum" },
      ]),
    );
    expect(widgets[0]).toMatchObject({ timeBucket: "week" });
  });

  it("without any valid widget the result is a fallback", () => {
    const result = validateSpec(
      spec([bar("a", { dimension: "order_id" }), kpi("b", "ghost")]),
      catalog,
    );
    expect(result.result).toBe("fallback");
    expect(result.result === "fallback" && result.reasons.length).toBeGreaterThan(0);
    expect(validateSpec(spec([]), catalog).result).toBe("fallback");
  });
});

describe("validateSpec: schema and data checks", () => {
  it("rejects what is not a spec at all", () => {
    for (const bad of [
      null,
      undefined,
      3,
      "x",
      [],
      {},
      spec([kpi("a")], { version: 2 }),
      spec([kpi("a")], { title: 4 }),
      spec([kpi("a")], { locale: "fr" }),
      spec([kpi("a")], { purpose: "x" }),
      spec([kpi("a")], { layout: "y" }),
      spec("nope" as unknown as unknown[]),
    ])
      expect(validateSpec(bad, catalog).result).toBe("fallback");
  });

  it("drops widgets whose columns are not in the catalog, SQL-looking names included", () => {
    const widgets = widgetsOf(
      spec([
        bar("a", { dimension: '"; DROP TABLE data; --' }),
        bar("b", { metric: "sales) FROM x; --" }),
        { id: "c", type: "table", columns: ["region", "ghost", "1=1"] },
        kpi("d"),
      ]),
    );
    expect(widgets.map((w) => w.id)).toEqual(["c", "d"]);
    expect(widgets[0]).toMatchObject({ columns: ["region"] });
  });

  it("drops a widget with an unknown type or missing fields", () => {
    const widgets = widgetsOf(
      spec([
        { id: "a", type: "map" },
        { id: "b", type: "kpi" },
        { type: "kpi", metric: "sales", aggregation: "sum" },
        7,
        kpi("ok"),
      ]),
    );
    expect(widgets.map((w) => w.id)).toEqual(["ok"]);
  });

  it("metric * is only valid with count", () => {
    const widgets = widgetsOf(spec([kpi("a", "*", "sum"), kpi("b", "*", "count")]));
    expect(widgets.map((w) => w.type === "kpi" && w.aggregation)).toEqual(["count"]);
    // the two now say the same thing: the later duplicate is dropped, the first is repaired
    expect(widgets[0]?.id).toBe("a");
  });

  it("line and area need a time dimension; pie and donut do not take one", () => {
    const widgets = widgetsOf(
      spec([
        { id: "a", type: "line", dimension: "region", metric: "sales", aggregation: "sum" },
        {
          id: "b",
          type: "pie",
          dimension: "order_date",
          metric: "sales",
          aggregation: "sum",
          timeBucket: "month",
        },
        {
          id: "c",
          type: "bar",
          dimension: "order_date",
          metric: "profit",
          aggregation: "sum",
          timeBucket: "month",
        },
      ]),
    );
    expect(widgets.map((w) => w.type)).toEqual(["bar", "bar", "bar"]);
  });

  it("drops a timeBucket given to a non-time dimension and `other` where it does not apply", () => {
    const widgets = widgetsOf(
      spec([bar("a", { timeBucket: "month", other: true, aggregation: "avg" })]),
    );
    expect(widgets[0]).not.toHaveProperty("timeBucket");
    expect(widgets[0]).not.toHaveProperty("other");
  });

  it("renames duplicate or malformed ids deterministically", () => {
    const widgets = widgetsOf(
      spec([
        kpi("same"),
        kpi("same", "profit"),
        kpi("Bad Id!", "units"),
        kpi("x".repeat(60), "sales", "avg"),
      ]),
    );
    const ids = widgets.map((w) => w.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    expect(ids[0]).toBe("same");
  });

  it("keeps HTML and SQL in titles as inert text and clips them", () => {
    const evil = "<script>alert(1)</script>'; DROP TABLE data; --";
    const result = repaired(spec([{ ...kpi("a"), title: evil, label: evil }], { title: evil }));
    expect(result.spec.title).toBe(evil); // escaped when rendered, never interpreted here
    const long = repaired(
      spec([{ ...kpi("a"), title: "t".repeat(500) }], { title: "T".repeat(500) }),
    );
    expect(long.spec.title.length).toBeLessThanOrEqual(SPEC_LIMITS.title);
    expect(long.spec.widgets[0]?.title?.length).toBeLessThanOrEqual(SPEC_LIMITS.widgetTitle);
    // control characters are not carried through
    expect(repaired(spec([kpi("a")], { title: "a\u0000b\nc" })).spec.title).not.toMatch(
      /[\u0000-\u001f]/,
    );
  });

  it("removes fields the contract does not know", () => {
    const input = spec([{ ...kpi("a"), sql: "SELECT 1", onclick: "x()" }], { script: "x" });
    const result = repaired(input);
    expect(result.result).toBe("repaired");
    expect(JSON.stringify(result.spec)).not.toMatch(/SELECT|onclick|script/);
  });

  it("does not mutate its input", () => {
    const input = spec([bar("a", { limit: 99 })]);
    const copy = structuredClone(input);
    validateSpec(input, catalog);
    expect(input).toEqual(copy);
  });

  it("the repaired spec is itself valid", () => {
    const input = spec([
      bar("a", { limit: 99 }),
      { id: "p", type: "pie", dimension: "city", metric: "sales", aggregation: "sum" },
    ]);
    const first = repaired(input);
    expect(first.result).toBe("repaired");
    expect(validateSpec(first.spec, catalog).result).toBe("valid");
  });
});
