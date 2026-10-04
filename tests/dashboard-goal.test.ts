/**
 * Goal-aware planning (spec E7c): the rule planner reads which columns the goal names, in
 * English and Spanish, and plans for them. Behavior at the planner boundary: sheet + goal in,
 * spec out. The goal itself never reaches SQL.
 */
import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  type DashboardSpec,
  goalColumns,
  profileSheet,
  RuleBasedPlanner,
  SPEC_LIMITS,
} from "../packages/core/src/analysis/dashboard/index.ts";
import { column, sheet } from "./dashboard-helpers.ts";

const num = (name: string, extra = {}) =>
  column(name, "real", { distinct: 900, min: "1", max: "9999", ...extra });

/** Orders: time, six dimensions of different width, three measures (one is a rate). */
function ordersSheet() {
  return sheet(
    [
      column("order_id", "text", { distinct: 1000 }),
      column("order_date", "date", { distinct: 365, min: "2024-01-01", max: "2024-12-31" }),
      column("region", "text", { distinct: 5, label: "Region" }),
      column("channel", "text", { distinct: 3, label: "Channel" }),
      column("category", "text", { distinct: 6, label: "Category" }),
      column("salesperson", "text", { distinct: 12, label: "Salesperson" }),
      column("order_status", "text", { distinct: 4, label: "Order status" }),
      num("net_sales_cop"),
      num("profit_cop"),
      num("discount_pct", { label: "Discount (%)" }),
    ],
    { rows: 1000 },
  );
}

async function planOf(goal: string, detail = ordersSheet(), locale: "en" | "es" = "en") {
  const result = await new RuleBasedPlanner().plan({ sheet: detail, goal, locale });
  if (!result.ok) throw new Error(`plan failed: ${result.error}`);
  return result;
}
const dimensionsOf = (spec: DashboardSpec) =>
  spec.widgets.flatMap((w) =>
    w.type === "kpi" || w.type === "scatter" || w.type === "table" ? [] : [w.dimension],
  );
const kpiMetrics = (spec: DashboardSpec) =>
  spec.widgets.flatMap((w) => (w.type === "kpi" ? [w.metric] : []));

describe("goalColumns: which columns the goal names", () => {
  const names = (goal: string, detail = ordersSheet()) =>
    goalColumns(goal, profileSheet(detail)).map((m) => m.column.name);

  it("matches display name, header and normalized name, ignoring case and accents", () => {
    expect(names("CATEGORY and Salesperson")).toEqual(["category", "salesperson"]);
    expect(names("order_status")).toEqual(["order_status"]);
    const es = sheet([
      column("categoria", "text", { distinct: 6, label: "Categoría" }),
      column("ano_fiscal", "text", { distinct: 4, label: "Año Fiscal ($)" }),
      num("ventas"),
    ]);
    expect(names("por CATEGORÍA y año fiscal", es)).toEqual(["categoria", "ano_fiscal"]);
  });

  it("matches singular and plural, and simple English and Spanish synonyms", () => {
    expect(names("categories")).toEqual(["category"]);
    expect(names("by sellers")).toEqual(["salesperson"]);
    const es = sheet([
      column("salesperson", "text", { distinct: 8 }),
      column("status", "text", { distinct: 4 }),
      num("discount_pct"),
    ]);
    expect(names("vendedores, estado y descuento", es)).toEqual([
      "salesperson",
      "status",
      "discount_pct",
    ]);
  });

  it("matches a word only when it is a whole word, and a unique partial name", () => {
    expect(names("categoryless statuses")).toEqual(["order_status"]);
    expect(names("regional trend")).toEqual([]);
    // "status" is only in order_status; "net" is too generic to name a column on its own
    expect(names("status")).toEqual(["order_status"]);
    expect(names("net")).toEqual([]);
    // "order" is in several columns: ambiguous, so none
    expect(names("order")).toEqual([]);
  });

  it("orders the matches as the goal names them", () => {
    expect(names("status, then region, then category")).toEqual([
      "order_status",
      "region",
      "category",
    ]);
  });

  it("never matches a one-letter column on a stray word", () => {
    const opaque = sheet([column("a", "text", { distinct: 4 }), num("b")]);
    expect(names("a general overview", opaque)).toEqual([]);
  });
});

describe("goal-aware plan (rules)", () => {
  it("charts every named dimension in the goal's order, with the named measure as KPI", async () => {
    const { spec } = await planOf("category, seller, discount, status");
    const dims = dimensionsOf(spec);
    const order = ["category", "salesperson", "order_status"];
    expect(order.map((d) => dims.indexOf(d))).toEqual(
      [...order.map((d) => dims.indexOf(d))].sort((a, b) => a - b),
    );
    for (const d of order) expect(dims).toContain(d);
    expect(kpiMetrics(spec)).toContain("discount_pct");
    const discount = spec.widgets.find((w) => w.type === "kpi" && w.metric === "discount_pct");
    expect(discount).toMatchObject({ aggregation: "avg" });
  });

  it("uses a donut only for narrow dimensions and a ranking otherwise", async () => {
    const { spec } = await planOf("seller and status");
    const byDim = (d: string) =>
      spec.widgets.find(
        (w) => w.type !== "kpi" && w.type !== "table" && w.type !== "scatter" && w.dimension === d,
      );
    expect(byDim("salesperson")?.type).toBe("hbar");
    expect(byDim("order_status")?.type).toBe("donut");
  });

  it("leads with a named additive measure over the default primary", async () => {
    const { choices, spec } = await planOf("profit by region");
    expect(choices.primaryMeasure).toBe("profit_cop");
    expect(kpiMetrics(spec)[0]).toBe("profit_cop");
    const trend = spec.widgets.find((w) => w.type === "area");
    expect(trend).toMatchObject({ metric: "profit_cop" });
  });

  it("trends over the named time column", async () => {
    const detail = sheet([
      column("created", "date", { distinct: 300, min: "2024-01-01", max: "2024-12-31" }),
      column("shipped", "date", { distinct: 300, min: "2024-01-01", max: "2024-12-31" }),
      column("team", "text", { distinct: 5 }),
      num("hours"),
    ]);
    const { spec } = await planOf("hours by shipped", detail);
    const trend = spec.widgets.find((w) => w.type === "area" || w.type === "line");
    expect(trend).toMatchObject({ dimension: "shipped" });
  });

  it("never uses an identifier as a dimension, even when the goal names it", async () => {
    const { spec } = await planOf("sales by order id and region");
    expect(dimensionsOf(spec)).not.toContain("order_id");
    expect(dimensionsOf(spec)).toContain("region");
  });

  it("respects the limits and keeps the goal's order when the goal names too much", async () => {
    const wide = sheet([
      column("day", "date", { distinct: 300, min: "2024-01-01", max: "2024-12-31" }),
      ...Array.from({ length: 12 }, (_, i) => column(`dim${i}`, "text", { distinct: 6 + i })),
      ...Array.from({ length: 8 }, (_, i) => num(`measure${i}`)),
    ]);
    const goal = Array.from({ length: 12 }, (_, i) => `dim${i}`)
      .concat(Array.from({ length: 8 }, (_, i) => `measure${i}`))
      .join(", ");
    const { spec } = await planOf(goal, wide);
    expect(spec.widgets.length).toBeLessThanOrEqual(SPEC_LIMITS.widgets);
    expect(spec.widgets.filter((w) => w.type === "kpi").length).toBeLessThanOrEqual(
      SPEC_LIMITS.kpis,
    );
    const dims = dimensionsOf(spec).filter((d) => d.startsWith("dim"));
    const indexes = dims.map((d) => Number(d.slice(3)));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(indexes[0]).toBe(0);
  });

  it("is deterministic and the plan validates without repairs", async () => {
    const a = await planOf("category, seller, discount, status");
    const b = await planOf("category, seller, discount, status");
    expect(a.spec).toEqual(b.spec);
    expect(a.fallbacks).toEqual([]);
  });

  it("does not read a column it names as the purpose of the dashboard", async () => {
    // "status" names the order_status column here, it does not ask for an operational monitor
    expect((await planOf("net sales by category and status")).spec.purpose).toBe("executive");
    expect((await planOf("monitor the status")).spec.purpose).toBe("operational");
  });

  it("changes nothing when the goal names no column", async () => {
    const detail = ordersSheet();
    const plain = await planOf("a general overview", detail);
    const none = await planOf("", detail);
    expect(plain.spec).toEqual(none.spec);
  });

  it("finds named columns outside the shortlists", async () => {
    const detail = sheet([
      ...Array.from({ length: 9 }, (_, i) =>
        column(`d${i}x`, "text", { distinct: 6, label: `Zone ${i}x` }),
      ),
      column("late", "text", { distinct: 7, label: "Late bucket" }),
      num("amount"),
    ]);
    const candidates = buildCandidates(profileSheet(detail));
    expect(candidates.dimensions.map((c) => c.name)).not.toContain("late");
    const { spec } = await planOf("amount by late bucket", detail);
    expect(dimensionsOf(spec)).toContain("late");
  });
});

describe("goal vocabulary: Spanish phrasing names the same columns", () => {
  /** Gross first (the default primary), then net and profit; plus the usual dimensions. */
  function salesSheet() {
    return sheet(
      [
        column("order_date", "date", { distinct: 365, min: "2025-01-01", max: "2025-12-31" }),
        column("region", "text", { distinct: 5, label: "Region" }),
        column("channel", "text", { distinct: 3, label: "Channel" }),
        column("category", "text", { distinct: 6, label: "Category" }),
        column("order_status", "text", { distinct: 4, label: "Order status" }),
        column("seller", "text", { distinct: 12, label: "Seller" }),
        num("gross_sales_cop"),
        num("net_sales_cop"),
        num("profit_cop"),
        num("discount_pct", { label: "Discount (%)" }),
      ],
      { rows: 1000 },
    );
  }
  const primaryOf = async (goal: string) =>
    (await planOf(goal, salesSheet(), "es")).choices.primaryMeasure;
  const names = (goal: string) =>
    goalColumns(goal, profileSheet(salesSheet())).map((m) => m.column.name);

  it.each([
    "dashboard ejecutivo de ventas netas por canal y región",
    "ingresos netos por canal y región",
    "ventas neto 2025 por canal",
    "ventas neta, facturación neta",
    "Ventas NETAS por Región",
    "net sales by channel",
  ])("chooses net sales for %j", async (goal) => {
    expect(await primaryOf(goal)).toBe("net_sales_cop");
  });

  it.each([
    "dashboard de ventas brutas por canal",
    "ingresos brutos por región",
    "venta bruta 2025",
    "ventas brutos y brutas",
    "gross sales by channel",
  ])("chooses gross sales for %j", async (goal) => {
    expect(await primaryOf(goal)).toBe("gross_sales_cop");
  });

  it("keeps the default for a plain sales goal", async () => {
    expect(await primaryOf("dashboard de ventas por canal")).toBe("gross_sales_cop");
    expect(await primaryOf("sales by channel")).toBe("gross_sales_cop");
  });

  it("names net or gross columns only when the specific word is in the goal", () => {
    expect(names("ventas netas")).toEqual(["net_sales_cop"]);
    expect(names("ventas brutas")).toEqual(["gross_sales_cop"]);
    expect(names("ventas")).toEqual([]);
    expect(names("neto")).toEqual([]);
    expect(names("bruta")).toEqual([]);
  });

  it("maps Spanish measure and dimension words, accents and plurals included", () => {
    expect(names("utilidades por región")).toEqual(["region", "profit_cop"].sort());
    expect(names("beneficio")).toEqual(["profit_cop"]);
    expect(names("ganancias")).toEqual(["profit_cop"]);
    expect(names("descuentos")).toEqual(["discount_pct"]);
    expect(names("canales")).toEqual(["channel"]);
    expect(names("regiones")).toEqual(["region"]);
    expect(names("categorías")).toEqual(["category"]);
    expect(names("estados")).toEqual(["order_status"]);
    expect(names("vendedores")).toEqual(["seller"]);
    expect(names("vendedora")).toEqual(["seller"]);
  });

  it("maps cost and units words", () => {
    const detail = sheet([
      column("cost_cop", "real", { distinct: 900, min: "1", max: "9" }),
      column("units", "real", { distinct: 900, min: "1", max: "9" }),
      column("region", "text", { distinct: 5 }),
    ]);
    const of = (goal: string) => goalColumns(goal, profileSheet(detail)).map((m) => m.column.name);
    expect(of("costos")).toEqual(["cost_cop"]);
    expect(of("coste")).toEqual(["cost_cop"]);
    expect(of("unidades")).toEqual(["units"]);
  });

  it("does not let a region goal name unrelated columns", () => {
    expect(names("ventas por región")).toEqual(["region"]);
    expect(names("región")).toEqual(["region"]);
    expect(names("región")).not.toContain("discount_pct");
    expect(names("facturación por región")).toEqual(["region"]);
  });
});
