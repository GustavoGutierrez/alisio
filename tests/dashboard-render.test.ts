import { readFile } from "node:fs/promises";
import type { DashboardSpec, DashboardWidget } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatKpiValue,
  type QueryRun,
  queryDashboard,
  RuleBasedPlanner,
  renderDashboard,
  type WidgetData,
} from "../packages/core/src/analysis/dashboard/index.ts";
import { chartWarnings } from "../packages/core/src/artifacts/chart-lint.ts";
import { type DataFixture, dataFixture } from "./data-helpers.ts";

// ---- structural helpers: regexes over the generated markup, no snapshots ----
const specOf = (figure: string): Record<string, unknown> => {
  const match = /<script type="application\/json">([\s\S]*?)<\/script>/.exec(figure);
  return JSON.parse(match?.[1] ?? "null");
};
const figures = (html: string): string[] =>
  html.match(/<figure class="ac-chart[\s\S]*?<\/figure>/g) ?? [];
const scriptBlocks = (html: string): string[] =>
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
/** The table cells of the accessible data table of one figure, as text. */
const tableRows = (figure: string): string[][] =>
  [...(figure.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "").matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(
    (row) => [...(row[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? ""),
  );

const widgets: DashboardWidget[] = [
  { id: "orders", type: "kpi", metric: "*", aggregation: "count", label: "Orders" },
  { id: "revenue", type: "kpi", metric: "sales", aggregation: "sum", label: "Total sales" },
  {
    id: "trend",
    type: "line",
    dimension: "d",
    metric: "sales",
    aggregation: "sum",
    title: "Sales per month",
    timeBucket: "month",
  },
  {
    id: "area",
    type: "area",
    dimension: "d",
    metric: "sales",
    aggregation: "sum",
    title: "Area",
    timeBucket: "month",
  },
  {
    id: "rank",
    type: "hbar",
    dimension: "region",
    metric: "sales",
    aggregation: "sum",
    title: "Sales by region",
  },
  {
    id: "bars",
    type: "bar",
    dimension: "region",
    metric: "sales",
    aggregation: "sum",
    title: "Bars",
  },
  {
    id: "share",
    type: "pie",
    dimension: "channel",
    metric: "sales",
    aggregation: "sum",
    title: "Share",
    other: true,
  },
  {
    id: "ring",
    type: "donut",
    dimension: "channel",
    metric: "sales",
    aggregation: "sum",
    title: "Ring",
  },
  { id: "corr", type: "scatter", x: "units", y: "sales", title: "Sales vs units" },
  { id: "detail", type: "table", columns: ["region", "sales"], title: "Detail" },
];

const data: WidgetData[] = [
  { id: "orders", type: "kpi", value: 1204 },
  { id: "revenue", type: "kpi", value: 1234567.891 },
  {
    id: "trend",
    type: "line",
    bucket: "month",
    points: [
      { k: "2024-01", v: 10 },
      { k: "2024-02", v: 14.5 },
    ],
  },
  {
    id: "area",
    type: "area",
    bucket: "month",
    points: [
      { k: "2024-01", v: 10 },
      { k: "2024-02", v: 14.5 },
    ],
  },
  {
    id: "rank",
    type: "hbar",
    points: [
      { k: "West", v: 30 },
      { k: "East", v: 20 },
    ],
    topOf: 9,
  },
  {
    id: "bars",
    type: "bar",
    points: [
      { k: "West", v: 30 },
      { k: "East", v: 20 },
    ],
  },
  {
    id: "share",
    type: "pie",
    points: [
      { k: "Web", v: 60 },
      { k: "Retail", v: 25 },
    ],
    other: 15,
  },
  {
    id: "ring",
    type: "donut",
    points: [
      { k: "Web", v: 60 },
      { k: "Retail", v: 40 },
    ],
  },
  {
    id: "corr",
    type: "scatter",
    points: [
      [1, 2],
      [2, 5],
      [3, 4],
    ],
  },
  {
    id: "detail",
    type: "table",
    columns: ["region", "sales"],
    rows: [
      ["West", 30],
      ["East", null],
    ],
  },
];

const spec = (over: Partial<DashboardSpec> = {}): DashboardSpec => ({
  version: 1,
  title: "Sales overview",
  purpose: "executive",
  layout: "executive-grid",
  locale: "en",
  widgets,
  ...over,
});

describe("renderDashboard structure", () => {
  const html = renderDashboard(spec(), data);

  it("is one complete page with the language of the spec", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("<title>Sales overview</title>");
    expect(html).toContain("<h1>Sales overview</h1>");
    expect(renderDashboard(spec({ locale: "es" }), data)).toContain('<html lang="es">');
  });

  it("has one figure per chart widget, in spec order, with its kind", () => {
    const kinds = figures(html).map((f) => /data-ac-chart="(\w+)"/.exec(f)?.[1]);
    expect(kinds).toEqual(["line", "area", "hbar", "bar", "pie", "donut", "scatter"]);
    for (const figure of figures(html)) {
      expect(figure).toContain('class="ac-chart ac-pending"');
      expect(figure).toMatch(/<canvas role="img" aria-label="[^"]+">/);
      expect(figure).toMatch(/<details class="ac-data" open><summary>Data table<\/summary>/);
      expect(figure).toMatch(/<div class="ac-box" style="--ac-h:\d+px">/);
    }
  });

  it("lays out the KPI row, then a grid of cards, with the table card full width", () => {
    expect(html.indexOf('class="ac-kpis"')).toBeGreaterThan(html.indexOf("<h1>"));
    expect(html.indexOf('class="ac-grid"')).toBeGreaterThan(html.indexOf('class="ac-kpis"'));
    expect(html.match(/<div class="ac-kpi">/g)).toHaveLength(2);
    expect(html.match(/<section class="ac-card"/g)).toHaveLength(8);
    expect(html).toContain('<section class="ac-card" style="grid-column:1/-1"><h3>Detail</h3>');
    expect(html).toContain("<h3>Sales per month</h3>");
  });

  it("gives every chart a parseable JSON spec in the contract shape", () => {
    for (const figure of figures(html)) {
      const s = specOf(figure);
      expect(s.v).toBe(1);
      expect(s.fmt).toEqual({ options: { maximumFractionDigits: 2 }, locale: "en" });
    }
    const [line, , hbar, bar, pie, donut, scatter] = figures(html).map(specOf);
    expect(line).toMatchObject({
      kind: "line",
      labels: ["2024-01", "2024-02"],
      valueLabels: false,
      stacked: false,
      smooth: false,
    });
    expect(hbar).toMatchObject({ kind: "hbar", valueLabels: true });
    expect(bar).toMatchObject({ kind: "bar", series: [{ name: "", data: [30, 20] }] });
    expect(pie).toMatchObject({ kind: "pie", otherLast: true, labels: ["Web", "Retail", "Other"] });
    expect(donut).toMatchObject({ kind: "donut", otherLast: false });
    expect(scatter).toMatchObject({
      kind: "scatter",
      labels: [],
      series: [
        {
          name: "",
          data: [
            { x: 1, y: 2 },
            { x: 2, y: 5 },
            { x: 3, y: 4 },
          ],
        },
      ],
    });
  });

  it("inlines Chart.js exactly once and the boot script after it", () => {
    expect(html.match(/Chart\.js v\d/g)).toHaveLength(1);
    const scripts = scriptBlocks(html);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain("Chart.js v4");
    expect(scripts[1]).toContain("figure[data-ac-chart]");
    expect(html.indexOf("Chart.js v4")).toBeLessThan(html.indexOf("figure[data-ac-chart]"));
  });

  it("carries the light and dark theme and the --ac-* palette", () => {
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain("--ac-c1:");
    expect(html).toContain("--ac-surface:");
  });

  it("is self-contained: no network, no fetch, no eval", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/@import/);
    const [lib, boot] = scriptBlocks(html);
    const rest = html.replace(lib as string, "").replace(boot as string, "");
    expect(rest).not.toMatch(/https?:\/\//);
    expect(rest).not.toMatch(/\bfetch\s*\(/);
    expect(boot).not.toMatch(/\bfetch\s*\(/);
    expect(boot).not.toMatch(/\beval\s*\(/);
    expect(boot).not.toMatch(/https?:\/\//);
    expect(lib).not.toMatch(/\beval\s*\(/);
  });

  it("passes the chart lint without warnings for every widget type", () => {
    expect(chartWarnings(html)).toEqual([]);
    for (const w of widgets) {
      const d = data.find((x) => x.id === w.id) as WidgetData;
      expect(chartWarnings(renderDashboard(spec({ widgets: [w] }), [d]))).toEqual([]);
    }
  });
});

describe("formatKpiValue", () => {
  const plainOpts = { maximumFractionDigits: 2 };
  it("keeps full formatting below one million", () => {
    expect(formatKpiValue(999_999, "en", plainOpts)).toEqual({ text: "999,999" });
    expect(formatKpiValue(1204, "es", plainOpts)).toEqual({ text: "1204" });
    expect(formatKpiValue(-999_999.5, "en", plainOpts).full).toBeUndefined();
  });
  it("uses compact notation from one million, keeping the full value", () => {
    expect(formatKpiValue(1_000_000, "en", plainOpts)).toEqual({
      text: "1M",
      full: "1,000,000",
    });
    expect(formatKpiValue(21_552_280_000, "en", plainOpts)).toEqual({
      text: "21.6B",
      full: "21,552,280,000",
    });
    const es = formatKpiValue(21_552_280_000, "es", plainOpts);
    expect(es.text).toBe("21,6\u00a0mil\u00a0M");
    expect(es.full).toBe("21.552.280.000");
    expect(formatKpiValue(1_326_285_210, "es", plainOpts).text).toBe("1326,3\u00a0M");
  });
  it("handles negative values", () => {
    expect(formatKpiValue(-21_552_280_000, "en", plainOpts)).toEqual({
      text: "-21.6B",
      full: "-21,552,280,000",
    });
  });
  it("never compacts a percentage", () => {
    expect(formatKpiValue(0.372, "en", { style: "percent", maximumFractionDigits: 1 })).toEqual({
      text: "37.2%",
    });
  });
});

describe("renderDashboard content", () => {
  const html = renderDashboard(spec(), data);

  it("shows an em dash for a KPI without a value and formats the others", () => {
    const withNull = renderDashboard(spec(), [
      { id: "orders", type: "kpi", value: null },
      ...data.slice(1),
    ]);
    expect(withNull).toContain("<span>Orders</span><b>—</b>");
    expect(html).toContain("<span>Orders</span><b>1,204</b>");
    // 1,234,567.891 is above the compact threshold: short text, full value kept in title
    expect(html).toContain('<span>Total sales</span><b title="1,234,567.89">');
    expect(html).toContain('<span aria-hidden="true">1.2M</span>');
    expect(renderDashboard(spec({ locale: "es" }), data)).toContain('<b title="1.234.567,89">');
  });

  it("builds the accessible table rows from the data (numbers carry data-v)", () => {
    const [line, , hbar, , pie, , scatter] = figures(html);
    expect(tableRows(line as string)).toEqual([
      ["2024-01", "10"],
      ["2024-02", "14.5"],
    ]);
    expect(tableRows(hbar as string)).toEqual([
      ["West", "30"],
      ["East", "20"],
    ]);
    expect(tableRows(pie as string)).toEqual([
      ["Web", "60", "60"],
      ["Retail", "25", "25"],
      ["Other", "15", "15"],
    ]);
    expect(tableRows(scatter as string)).toEqual([
      ["1", "2"],
      ["2", "5"],
      ["3", "4"],
    ]);
    expect(line).toContain('<td data-v="14.5">14.5</td>');
    expect(line).toContain("<th>Category</th><th>Value</th>");
    expect(pie).toContain("<th>Share (%)</th>");
  });

  it("renders the detail table with formatted numbers and dashes for nulls", () => {
    expect(html).toContain("<th>Region</th><th>Sales</th>");
    expect(html).toContain('<tr><td>West</td><td data-n="30">30</td></tr>');
    expect(html).toContain("<tr><td>East</td><td>—</td></tr>");
  });

  it("adds the localized Other point and the percentages of the pie", () => {
    const pie = specOf(figures(html)[4] as string);
    expect(pie.labels).toEqual(["Web", "Retail", "Other"]);
    expect((pie.series as { data: number[] }[])[0]?.data).toEqual([60, 25, 15]);
    expect(pie.percents).toEqual([60, 25, 15]);
    const es = renderDashboard(spec({ locale: "es" }), data);
    expect(specOf(figures(es)[4] as string).labels).toEqual(["Web", "Retail", "Otros"]);
  });

  it("notes 'Top N of M' when the dimension has more groups than shown", () => {
    expect(figures(html)[2]).toContain('<p class="ac-note">Top 2 of 9</p>');
    const es = renderDashboard(spec({ locale: "es" }), data);
    expect(figures(es)[2]).toContain('<p class="ac-note">Principales 2 de 9</p>');
    expect(figures(html)[3]).not.toContain("ac-note");
  });

  it("localizes the accessible summary and the table headers", () => {
    const es = renderDashboard(spec({ locale: "es" }), data);
    expect(figures(es)[3]).toContain("Gráfico de barras. West: 30; East: 20");
    expect(figures(es)[3]).toContain("<summary>Tabla de datos</summary>");
    expect(figures(html)[3]).toContain("Bars. Bar chart. West: 30; East: 20");
  });

  it("uses the default heights of the contract", () => {
    const heights = figures(html).map((f) => Number(/--ac-h:(\d+)px/.exec(f)?.[1]));
    expect(heights).toEqual([320, 320, 240, 320, 340, 340, 320]);
    const many = Array.from({ length: 20 }, (_, i) => ({ k: `c${i}`, v: 20 - i }));
    const tall = renderDashboard(spec({ widgets: [widgets[4] as DashboardWidget] }), [
      { id: "rank", type: "hbar", points: many },
    ]);
    expect(tall).toContain("--ac-h:536px");
  });

  it("summarizes at most eight categories in the aria-label", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ k: `c${i}`, v: 12 - i }));
    const out = renderDashboard(spec({ widgets: [widgets[4] as DashboardWidget] }), [
      { id: "rank", type: "hbar", points: many },
    ]);
    expect(out).toMatch(
      /aria-label="Sales by region\. Horizontal bar chart\. c0: 12;.*c7: 5 and 4 more"/,
    );
  });

  it("uses percent only for a percentage-named average of fractions", () => {
    const w: DashboardWidget = {
      id: "m",
      type: "kpi",
      metric: "margin_pct",
      aggregation: "avg",
      label: "Margin",
    };
    const frac = renderDashboard(spec({ widgets: [w] }), [{ id: "m", type: "kpi", value: 0.372 }]);
    expect(frac).toContain("<b>37.2%</b>");
    const big = renderDashboard(spec({ widgets: [w] }), [{ id: "m", type: "kpi", value: 37.2 }]);
    expect(big).toContain("<b>37.2</b>");
  });

  it("drops widgets without data and ignores data without a widget", () => {
    const out = renderDashboard(
      spec(),
      data.filter((d) => d.id !== "trend" && d.id !== "revenue"),
    );
    expect(figures(out)).toHaveLength(6);
    expect(out).not.toContain("Sales per month");
    expect(out.match(/<div class="ac-kpi">/g)).toHaveLength(1);
    const extra = renderDashboard(spec({ widgets: [widgets[0] as DashboardWidget] }), data);
    expect(extra.match(/<div class="ac-kpi">/g)).toHaveLength(1);
    expect(extra).not.toContain('class="ac-grid"');
  });

  it("leaves non-positive pie values out and shows a message when nothing is left", () => {
    const out = renderDashboard(spec({ widgets: [widgets[6] as DashboardWidget] }), [
      {
        id: "share",
        type: "pie",
        points: [
          { k: "A", v: 5 },
          { k: "B", v: 0 },
          { k: "C", v: -2 },
        ],
      },
    ]);
    expect(specOf(figures(out)[0] as string).labels).toEqual(["A"]);
    const none = renderDashboard(spec({ widgets: [widgets[6] as DashboardWidget] }), [
      { id: "share", type: "pie", points: [{ k: "B", v: 0 }] },
    ]);
    expect(figures(none)).toHaveLength(0);
    expect(none).toContain('<p class="ac-empty">No data to chart</p>');
  });

  it("renders the percentages with two decimals", () => {
    const out = renderDashboard(spec({ widgets: [widgets[7] as DashboardWidget] }), [
      {
        id: "ring",
        type: "donut",
        points: [
          { k: "A", v: 1 },
          { k: "B", v: 1 },
          { k: "C", v: 1 },
        ],
      },
    ]);
    expect(specOf(figures(out)[0] as string).percents).toEqual([33.33, 33.33, 33.33]);
  });

  it("only shows value labels when there are at most 16 of them", () => {
    const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ k: `c${i}`, v: i + 1 }));
    const flag = (n: number) =>
      specOf(
        figures(
          renderDashboard(spec({ widgets: [widgets[5] as DashboardWidget] }), [
            { id: "bars", type: "bar", points: pts(n) },
          ]),
        )[0] as string,
      ).valueLabels;
    expect([flag(16), flag(17)]).toEqual([true, false]);
  });
});

describe("renderDashboard escaping", () => {
  const evil = `<script>alert(1)</script>"'&`;
  const hostile = renderDashboard(
    spec({
      title: `T ${evil}`,
      widgets: [
        { id: "k", type: "kpi", metric: "*", aggregation: "count", label: evil },
        {
          id: "b",
          type: "bar",
          dimension: "d",
          metric: "*",
          aggregation: "count",
          title: `"><img src=x onerror=1>`,
        },
        { id: "p", type: "pie", dimension: "d", metric: "*", aggregation: "count", title: evil },
        { id: "t", type: "table", columns: [evil], title: evil },
      ],
    }),
    [
      { id: "k", type: "kpi", value: 3 },
      {
        id: "b",
        type: "bar",
        points: [
          { k: `</script><b>x</b>`, v: 2 },
          { k: evil, v: 1 },
        ],
      },
      {
        id: "p",
        type: "pie",
        points: [
          { k: `</SCRIPT><i>`, v: 2 },
          { k: `a"b'c`, v: 1 },
        ],
      },
      { id: "t", type: "table", columns: [evil], rows: [[evil], [`</script>`]] },
    ],
  );

  it("escapes every visible text", () => {
    expect(hostile).not.toContain("<script>alert");
    expect(hostile).not.toContain("<img");
    expect(hostile).not.toContain("<b>x</b>");
    expect(hostile).not.toContain("<i>");
    expect(hostile).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#x27;&amp;");
    expect(hostile).toContain("<title>T &lt;script&gt;");
  });

  it("keeps hostile labels inside the JSON without closing the script", () => {
    const opened = hostile.match(/<script\b/g)?.length ?? 0;
    const closed = hostile.match(/<\/script>/g)?.length ?? 0;
    expect(opened).toBe(closed);
    expect(opened).toBe(2 + 2);
    const [bar, pie] = figures(hostile).map(specOf);
    expect(bar?.labels).toEqual([`</script><b>x</b>`, evil]);
    expect(pie?.labels).toEqual([`</SCRIPT><i>`, `a"b'c`]);
    for (const figure of figures(hostile)) {
      const body = /<script type="application\/json">([\s\S]*?)<\/script>/.exec(figure)?.[1] ?? "";
      expect(body).not.toMatch(/[<>&]/);
    }
  });
});

// ---- integration: a real CSV through profile, plan, validate, query and render ----
describe("end to end over examples/data", () => {
  let fixture: DataFixture | undefined;
  afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
  });

  for (const [file, goal, locale] of [
    ["dashboard_simple_300.csv", "resumen de ventas y rentabilidad", "es"],
    ["dataset_dashboard_4000.csv", "analyze sales performance", "en"],
  ] as const) {
    it(`${file}: renders a valid page with a card per answered widget`, async () => {
      fixture = await dataFixture();
      const f = fixture;
      const bytes = new Uint8Array(
        await readFile(new URL(`../examples/data/${file}`, import.meta.url)),
      );
      const { record } = await f.ingest(file, bytes);
      const detail = f.service.detail(record).sheetDetails[0];
      if (!detail) throw new Error("no sheet");
      const plan = await new RuleBasedPlanner().plan({ sheet: detail, goal, locale });
      if (!plan.ok) throw new Error("plan failed");
      const run: QueryRun = await queryDashboard({
        spec: plan.spec,
        catalog: plan.catalog,
        rows: detail.rows,
        signal: new AbortController().signal,
        run: (sql, maxRows) => f.service.query(record, sql, { maxRows }),
      });
      expect(run.fallbacks).toEqual([]);
      const html = renderDashboard(plan.spec, run.data);
      const charts = plan.spec.widgets.filter((w) => w.type !== "kpi" && w.type !== "table");
      expect(figures(html)).toHaveLength(charts.length);
      expect(html.match(/<div class="ac-kpi">/g)?.length ?? 0).toBe(
        plan.spec.widgets.filter((w) => w.type === "kpi").length,
      );
      expect(html).toContain(`<html lang="${locale}">`);
      expect(html.match(/Chart\.js v\d/g)).toHaveLength(1);
      expect(chartWarnings(html)).toEqual([]);
      expect(html.length).toBeLessThan(600_000);
      // readable: no KPI value is long enough to clip, no label shows a raw identifier
      const kpiValues = [
        ...html.matchAll(/<div class="ac-kpi"><span>[\s\S]*?<\/span><b[^>]*>([\s\S]*?)<\/b>/g),
      ].map((m) =>
        (m[1] ?? "").replace(/<span class="ac-sr">[\s\S]*?<\/span>/, "").replace(/<[^>]+>/g, ""),
      );
      expect(kpiValues.length).toBeGreaterThan(0);
      for (const value of kpiValues) expect(value.length).toBeLessThanOrEqual(10);
      const labels = [
        ...[...html.matchAll(/<h3>([\s\S]*?)<\/h3>/g)].map((m) => m[1] ?? ""),
        ...[...html.matchAll(/<div class="ac-kpi"><span>([\s\S]*?)<\/span>/g)].map(
          (m) => m[1] ?? "",
        ),
        ...[...html.matchAll(/<th>([\s\S]*?)<\/th>/g)].map((m) => m[1] ?? ""),
      ];
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) expect(label).not.toContain("_");
    });
  }
});
