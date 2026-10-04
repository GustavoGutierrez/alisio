import type {
  DecisionAnswer,
  DecisionOptions,
  DecisionRequest,
  DecisionResponse,
} from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  bucketCount,
  buildCandidates,
  type DashboardSpec,
  type PlanChoices,
  planDashboard,
  profileSheet,
  RuleBasedPlanner,
  ruleBasedChoices,
  timeBucketFor,
  validateSpec,
} from "../packages/core/src/analysis/dashboard/index.ts";
import { column, salesSheet, sheet } from "./dashboard-helpers.ts";

const candidatesOf = (detail = salesSheet()) => buildCandidates(profileSheet(detail));
const widgetIds = (spec: DashboardSpec) => spec.widgets.map((w) => w.id);
const kinds = (spec: DashboardSpec) => spec.widgets.map((w) => w.type);

describe("time buckets (spec 6.2, Phase 0 E2)", () => {
  it("picks the finest bucket for the span", () => {
    const cases: Array<[number, string]> = [
      [0, "day"],
      [60, "day"],
      [61, "week"],
      [420, "week"],
      [421, "month"],
      [1800, "month"],
      [1801, "quarter"],
      [5400, "quarter"],
      [5401, "year"],
    ];
    for (const [days, bucket] of cases) expect(timeBucketFor(days)).toBe(bucket);
  });

  it("never yields more than 400 buckets for a realistic span, and never truncates", () => {
    for (const days of [1, 60, 61, 420, 421, 1800, 1801, 5400, 5401, 20000, 100000])
      expect(bucketCount(days, timeBucketFor(days))).toBeLessThanOrEqual(400);
  });

  it("tolerates nonsense spans", () => {
    expect(timeBucketFor(Number.NaN)).toBe("day");
    expect(timeBucketFor(-5)).toBe("day");
  });
});

describe("ruleBasedChoices: purpose from the goal (spec 6.2)", () => {
  const purposeOf = (goal: string) =>
    ruleBasedChoices({ goal, candidates: candidatesOf() }).purpose;
  it("reads English and Spanish keywords, accents included", () => {
    expect(purposeOf("an executive overview")).toBe("executive");
    expect(purposeOf("resumen de ventas")).toBe("executive");
    expect(purposeOf("monitor the status")).toBe("operational");
    expect(purposeOf("seguimiento operativo")).toBe("operational");
    expect(purposeOf("analyze and compare")).toBe("analytical");
    expect(purposeOf("análisis de ventas")).toBe("analytical");
    expect(purposeOf("explorar los datos")).toBe("analytical");
  });
  it("defaults to executive, also with an empty goal", () => {
    expect(purposeOf("")).toBe("executive");
    expect(purposeOf("show me something")).toBe("executive");
  });
});

describe("ruleBasedChoices: the defaults", () => {
  it("picks the primary measure from goal synonyms, else the best-scored one that is not a rate", () => {
    const pick = (goal: string) =>
      ruleBasedChoices({ goal, candidates: candidatesOf() }).primaryMeasure;
    expect(pick("ventas por region")).toBe("sales");
    expect(pick("profit")).toBe("profit");
    expect(pick("rentabilidad")).toBe("profit");
    expect(pick("units sold")).toBe("units");
    expect(pick("nothing in particular")).toBe("sales");
    const withRate = candidatesOf(
      sheet([
        column("margin_pct", "real", { distinct: 90, min: "1", max: "9" }),
        column("sales", "real", { distinct: 90, min: "1", max: "9" }),
      ]),
    );
    expect(ruleBasedChoices({ goal: "", candidates: withRate }).primaryMeasure).toBe("sales");
    const onlyRate = candidatesOf(
      sheet([column("margin_pct", "real", { distinct: 90, min: "1", max: "9" })]),
    );
    expect(ruleBasedChoices({ goal: "", candidates: onlyRate }).primaryMeasure).toBe("margin_pct");
  });

  it("among measures that satisfy a synonym, prefers the one sharing more words with the goal", () => {
    const candidates = candidatesOf(
      sheet(
        [
          column("gross_sales", "real", { distinct: 90, min: "1", max: "9" }),
          column("net_sales", "real", { distinct: 90, min: "1", max: "9" }),
        ],
        { rows: 500 },
      ),
    );
    const pick = (goal: string) => ruleBasedChoices({ goal, candidates }).primaryMeasure;
    expect(pick("net sales")).toBe("net_sales");
    expect(pick("sales")).toBe("gross_sales"); // no better match: candidate order
  });

  it("includes trend, ranking and composition by default and correlation only when analytical", () => {
    const exec = ruleBasedChoices({ goal: "overview", candidates: candidatesOf() });
    expect(exec).toMatchObject({
      includeTrend: true,
      includeRanking: true,
      rankingDimension: "region",
      includeComposition: true,
      includeCorrelation: false,
    });
    const analytic = ruleBasedChoices({ goal: "analysis", candidates: candidatesOf() });
    expect(analytic.includeCorrelation).toBe(true);
  });

  it("ranks the best dimension with at least 3 values and composes a different one", () => {
    const choices = ruleBasedChoices({ goal: "", candidates: candidatesOf() });
    expect(choices.rankingDimension).toBe("region");
    expect(choices.compositionDimension).toBe("channel");
  });

  it("composition is off for an analytical goal unless the dimension has at most 5 categories", () => {
    const wide = candidatesOf(
      sheet(
        [
          column("sales", "real", { distinct: 90, min: "1", max: "9" }),
          column("kind", "text", { distinct: 7 }),
        ],
        { rows: 500 },
      ),
    );
    expect(ruleBasedChoices({ goal: "analysis", candidates: wide }).includeComposition).toBe(false);
    expect(ruleBasedChoices({ goal: "overview", candidates: wide }).includeComposition).toBe(true);
    expect(
      ruleBasedChoices({ goal: "analysis", candidates: candidatesOf() }).includeComposition,
    ).toBe(true);
  });

  it("turns off what the data cannot support", () => {
    const bare = candidatesOf(
      sheet([column("sales", "real", { distinct: 90, min: "1", max: "9" })]),
    );
    expect(ruleBasedChoices({ goal: "", candidates: bare })).toMatchObject({
      includeTrend: false,
      includeRanking: false,
      includeComposition: false,
      includeCorrelation: false,
    });
  });

  it("an override replaces a single key and the dependent defaults follow it", () => {
    const base = ruleBasedChoices({ goal: "overview", candidates: candidatesOf() });
    const over = ruleBasedChoices({
      goal: "overview",
      candidates: candidatesOf(),
      overrides: { purpose: "analytical", rankingDimension: "channel" },
    });
    expect(base.includeCorrelation).toBe(false);
    expect(over.purpose).toBe("analytical");
    expect(over.includeCorrelation).toBe(true); // default derived from the overridden purpose
    expect(over.rankingDimension).toBe("channel");
    expect(over.compositionDimension).toBe("region"); // distinct from the overridden ranking
    expect(over.includeTrend).toBe(base.includeTrend); // untouched keys keep the rule
  });
});

describe("planDashboard", () => {
  const plan = (goal: string, locale: "en" | "es" = "en", title = "Sales") => {
    const candidates = candidatesOf();
    const choices = ruleBasedChoices({ goal, candidates });
    return planDashboard({ title, locale, choices, candidates });
  };

  it("builds an executive dashboard: KPIs, trend, ranking and composition", () => {
    const spec = plan("overview");
    expect(spec).toMatchObject({
      version: 1,
      purpose: "executive",
      layout: "executive-grid",
      locale: "en",
    });
    expect(spec.sheet).toBeUndefined();
    expect(kinds(spec)).toEqual(["kpi", "kpi", "kpi", "kpi", "kpi", "area", "hbar", "donut"]);
    const kpis = spec.widgets.filter((w) => w.type === "kpi");
    expect(kpis.map((w) => w.type === "kpi" && [w.metric, w.aggregation])).toEqual([
      ["sales", "sum"],
      ["profit", "sum"],
      ["unit_price", "avg"], // a price is averaged, not summed
      ["units", "sum"],
      ["*", "count"],
    ]);
  });

  it("uses the bucket of the time span and the primary measure for the trend", () => {
    const trend = plan("overview").widgets.find((w) => w.id === "trend");
    expect(trend).toMatchObject({
      type: "area",
      dimension: "order_date",
      metric: "sales",
      aggregation: "sum",
      timeBucket: "week",
    });
  });

  it("ranks with hbar limit 10 and composes with a donut of at most 5 plus Other", () => {
    const spec = plan("overview");
    expect(spec.widgets.find((w) => w.id === "ranking")).toMatchObject({
      type: "hbar",
      dimension: "region",
      metric: "sales",
      aggregation: "sum",
      limit: 10,
    });
    expect(spec.widgets.find((w) => w.id === "composition")).toMatchObject({
      type: "donut",
      dimension: "channel",
      limit: 5,
      other: true,
    });
  });

  it("the scatter relates the primary measure (y) to the best other measure (x)", () => {
    const candidates = candidatesOf();
    const choices = {
      ...ruleBasedChoices({ goal: "analysis", candidates }),
      primaryMeasure: "profit",
    };
    const scatter = planDashboard({ title: "x", locale: "en", choices, candidates }).widgets.find(
      (w) => w.type === "scatter",
    );
    expect(scatter).toMatchObject({ y: "profit", x: "sales" });
  });

  it("orders widgets by layout and adds a table for non-executive purposes", () => {
    expect(kinds(plan("monitor status")).filter((k) => k !== "kpi")).toEqual([
      "table",
      "hbar",
      "line",
      "donut",
    ]);
    expect(kinds(plan("analysis")).filter((k) => k !== "kpi")).toEqual([
      "line",
      "hbar",
      "donut",
      "scatter",
      "table",
    ]);
    expect(plan("analysis").layout).toBe("analytical-grid");
    expect(plan("monitor").layout).toBe("operational-grid");
  });

  it("the table shows up to 8 non-identifier columns in dataset order, 10 rows", () => {
    const table = plan("analysis").widgets.find((w) => w.type === "table");
    expect(table).toMatchObject({ type: "table", limit: 10 });
    if (table?.type !== "table") return;
    expect(table.columns).toHaveLength(8);
    expect(table.columns).not.toContain("order_id");
    expect(table.columns[0]).toBe("order_date");
  });

  it("builds titles from templates in the locale, from the original headers", () => {
    const en = plan("overview", "en");
    expect(en.title).toBe("Sales");
    expect(en.widgets.find((w) => w.id === "ranking")?.title).toBe("Sales by region");
    expect(en.widgets.find((w) => w.id === "trend")?.title).toBe("Sales per week");
    const es = plan("resumen", "es");
    expect(es.widgets.find((w) => w.id === "ranking")?.title).toBe("Sales por region");
    expect(es.widgets.find((w) => w.id === "trend")?.title).toBe("Sales por semana");
    const rows = es.widgets.find((w) => w.id === "kpi-rows");
    expect(rows).toMatchObject({ type: "kpi", metric: "*", aggregation: "count", label: "Filas" });
  });

  it("falls back to row counts when there is no measure, and to only the row count KPI", () => {
    const candidates = candidatesOf(
      sheet(
        [
          column("region", "text", { distinct: 5 }),
          column("d", "date", { distinct: 30, min: "2024-01-01", max: "2024-01-31" }),
        ],
        {
          rows: 200,
        },
      ),
    );
    const spec = planDashboard({
      title: "Counts",
      locale: "en",
      choices: ruleBasedChoices({ goal: "", candidates }),
      candidates,
    });
    expect(spec.widgets.filter((w) => w.type === "kpi")).toHaveLength(1);
    expect(spec.widgets.find((w) => w.id === "ranking")).toMatchObject({
      metric: "*",
      aggregation: "count",
    });
    expect(spec.widgets.find((w) => w.id === "trend")).toMatchObject({
      metric: "*",
      aggregation: "count",
      timeBucket: "day",
    });
  });

  it("keeps ids valid and unique, and never more than 6 KPIs or 12 widgets", () => {
    const wide = sheet(
      Array.from({ length: 10 }, (_, i) =>
        column(`measure_${i}_${"x".repeat(40)}`, "real", { distinct: 90, min: "1", max: "9" }),
      ),
    );
    const candidates = candidatesOf(wide);
    const spec = planDashboard({
      title: "Wide",
      locale: "en",
      choices: ruleBasedChoices({ goal: "analysis", candidates }),
      candidates,
    });
    const ids = widgetIds(spec);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    expect(spec.widgets.filter((w) => w.type === "kpi").length).toBeLessThanOrEqual(6);
    expect(spec.widgets.length).toBeLessThanOrEqual(12);
  });

  it("carries the sheet table name when given and clips the title to 120 characters", () => {
    const candidates = candidatesOf();
    const spec = planDashboard({
      title: "T".repeat(300),
      locale: "en",
      choices: ruleBasedChoices({ goal: "", candidates }),
      candidates,
      sheet: "s_ventas",
    });
    expect(spec.sheet).toBe("s_ventas");
    expect(spec.title.length).toBeLessThanOrEqual(120);
  });

  it("ignores stale choices that name a column outside the candidates", () => {
    const candidates = candidatesOf();
    const choices: PlanChoices = {
      ...ruleBasedChoices({ goal: "", candidates }),
      primaryMeasure: "ghost",
      rankingDimension: "ghost",
      compositionDimension: "ghost",
    };
    const spec = planDashboard({ title: "x", locale: "en", choices, candidates });
    expect(spec.widgets.length).toBeGreaterThan(1);
    expect(JSON.stringify(spec)).not.toContain("ghost");
  });

  it("is deterministic", () => {
    expect(plan("overview")).toEqual(plan("overview"));
  });
});

// ---- the planner with a decision consumer ----
const select = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "select",
  value,
  confidence,
});
const flag = (value: boolean): DecisionAnswer => ({
  type: "boolean",
  value,
  confidence: 0.9,
  probability: 0.9,
});
const reply = (
  decisions: Record<string, DecisionAnswer>,
  rejected: DecisionResponse["rejected"] = {},
): DecisionResponse => ({ provider: "fake-provider", latencyMs: 3, decisions, rejected });

function consumer(
  answer: (request: DecisionRequest) => DecisionResponse | null | Promise<DecisionResponse | null>,
) {
  const calls: DecisionRequest[] = [];
  return {
    calls,
    tryDecide: vi.fn(async (request: DecisionRequest, _options?: DecisionOptions) => {
      calls.push(request);
      return answer(request);
    }),
  };
}

async function run(
  decisions: Parameters<RuleBasedPlanner["plan"]>[0]["decisions"],
  goal = "overview",
  signal?: AbortSignal,
) {
  const result = await new RuleBasedPlanner().plan({
    sheet: salesSheet(),
    goal,
    locale: "en",
    decisions,
    ...(signal ? { signal } : {}),
  });
  if (!result.ok) throw new Error(`plan failed: ${result.error}`);
  // the contract of the planner: every spec it returns is valid
  expect(validateSpec(result.spec, result.catalog).result).toBe("valid");
  return result;
}

describe("RuleBasedPlanner", () => {
  it("without a provider (undefined or null) the plan is the rule plan", async () => {
    const none = await run(undefined);
    const nullish = await run(null);
    expect(none.planner).toBe("rules");
    expect(none.decisionProvider).toBeUndefined();
    expect(nullish.spec).toEqual(none.spec);
    expect(none.spec.widgets.length).toBeGreaterThan(5);
  });

  it("asks the pack once, with the dataset's metadata and the locale", async () => {
    const c = consumer(() => null);
    await run(c, "sales overview");
    expect(c.tryDecide).toHaveBeenCalledTimes(1);
    expect(c.calls[0]).toMatchObject({ id: "smart-dashboard-v1", language: "en", version: 1 });
  });

  it("a consumer answering null (no provider, timeout, circuit open, all rejected) keeps the rule plan", async () => {
    const base = await run(undefined);
    const result = await run(consumer(() => null));
    expect(result.spec).toEqual(base.spec);
    expect(result.planner).toBe("rules");
    expect(result.fallbacks.join(" ")).toMatch(/decisions/i);
  });

  it("the purpose answer replaces its rule default", async () => {
    const base = await run(undefined, "overview");
    const result = await run(
      consumer(() => reply({ purpose: select("analytical") })),
      "overview",
    );
    expect(result.planner).toBe("rules+decisions");
    expect(result.decisionProvider).toBe("fake-provider");
    expect(result.spec.purpose).toBe("analytical");
    expect(result.spec.layout).toBe("analytical-grid");
    expect(base.spec.purpose).not.toBe("analytical");
  });

  it("answers for keys outside the provider allowlist are ignored (rules decide them)", async () => {
    const base = await run(undefined, "overview");
    const result = await run(
      consumer(() =>
        reply({
          primaryMeasure: select("c7"),
          includeTrend: flag(false),
          includeRanking: flag(false),
          rankingDimension: select("c4"),
          includeComposition: flag(false),
          includeCorrelation: flag(true),
        }),
      ),
      "overview",
    );
    expect(result.spec).toEqual(base.spec);
    expect(result.planner).toBe("rules");
  });

  it("a rejected purpose keeps the rule and is noted", async () => {
    const base = await run(undefined);
    const result = await run(consumer(() => reply({}, { purpose: "low_confidence" })));
    expect(result.spec).toEqual(base.spec);
    expect(result.fallbacks.join(" ")).toMatch(/purpose/);
  });

  it("when every answer was rejected the result is the rule plan and says rules", async () => {
    const base = await run(undefined);
    const result = await run(
      consumer(() => reply({}, { purpose: "low_confidence", includeTrend: "low_confidence" })),
    );
    expect(result.spec).toEqual(base.spec);
    expect(result.planner).toBe("rules");
    expect(result.decisionProvider).toBeUndefined();
  });

  it("invalid or hostile answers (unknown aliases, wrong types, injected text) never break the plan", async () => {
    const base = await run(undefined);
    const hostile = await run(
      consumer(() =>
        reply({
          purpose: select("<script>alert(1)</script>"),
          primaryMeasure: select("c999"),
          rankingDimension: select("order_id; DROP TABLE data"),
          compositionDimension: select("c1"),
          includeTrend: select("yes"),
          includeRanking: {
            type: "boolean",
            value: "true" as unknown as boolean,
            confidence: 1,
            probability: 1,
          },
          includeCorrelation: { type: "ordinal", level: "high", index: 1, confidence: 1 },
        }),
      ),
    );
    expect(hostile.spec).toEqual(base.spec);
    expect(hostile.planner).toBe("rules");
    expect(JSON.stringify(hostile.spec)).not.toMatch(/script|DROP/);
  });

  it("an override naming a column the validator rejects falls back to a valid plan", async () => {
    // the ranking dimension is a valid alias, but a provider cannot make the plan invalid
    const result = await run(consumer(() => reply({ rankingDimension: select("c5") })));
    expect(result.spec.widgets.length).toBeGreaterThan(1);
  });

  it("a consumer that throws, or fails the request, still yields the rule plan", async () => {
    const base = await run(undefined);
    const thrower = consumer(() => {
      throw new Error("boom");
    });
    const result = await run(thrower);
    expect(result.spec).toEqual(base.spec);
    expect(result.fallbacks.join(" ")).toMatch(/decisions/i);
  });

  it("rethrows an abort requested by the caller", async () => {
    const controller = new AbortController();
    const c = consumer(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await expect(
      new RuleBasedPlanner().plan({
        sheet: salesSheet(),
        goal: "x",
        locale: "en",
        decisions: c,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("passes the signal to the consumer", async () => {
    const controller = new AbortController();
    const c = consumer(() => null);
    await run(c, "x", controller.signal);
    expect(c.tryDecide.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });

  it("is deterministic for the same data, goal and answers", async () => {
    const answers = () => consumer(() => reply({ purpose: select("operational") }));
    expect((await run(answers())).spec).toEqual((await run(answers())).spec);
  });

  it("does not ask when there is nothing to ask, and reports no usable columns", async () => {
    const c = consumer(() => reply({}));
    const result = await new RuleBasedPlanner().plan({
      sheet: sheet([column("order_id", "text", { distinct: 100 })], { rows: 100 }),
      goal: "x",
      locale: "en",
      decisions: c,
    });
    expect(result).toMatchObject({ ok: false, error: "no_usable_columns" });
    expect(c.tryDecide).not.toHaveBeenCalled();
  });

  it("uses the title given, else a template title in the locale", async () => {
    const planner = new RuleBasedPlanner();
    const given = await planner.plan({
      sheet: salesSheet(),
      goal: "",
      locale: "en",
      title: "My sales",
    });
    const dflt = await planner.plan({ sheet: salesSheet(), goal: "", locale: "es" });
    expect(given.ok && given.spec.title).toBe("My sales");
    expect(dflt.ok && dflt.spec.title).toBe("Panel ejecutivo");
  });

  it("sets spec.sheet for a sheet table other than data", async () => {
    const detail = { ...salesSheet(), name: "Ventas", table: "s_ventas" };
    const result = await new RuleBasedPlanner().plan({ sheet: detail, goal: "", locale: "es" });
    expect(result.ok && result.spec.sheet).toBe("s_ventas");
  });
});
