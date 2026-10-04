/**
 * The Smart Dashboard renderer (ADR-2): `DashboardSpec` + `WidgetData[]` to one self-contained HTML
 * page. It emits the same DOM as `alisio_runtime/charts.py` (spec 8.2) and reads the same assets
 * (`charts.css`, `charts-boot.js`, `html-base.css`, Chart.js) from `ALISIO_RUNTIME_FILES`, so the
 * boot script, the theme and the viewer behave identically for both paths. Pure: no I/O.
 *
 * Security: every text is HTML-escaped; the JSON spec of each chart escapes `<`, `>` and `&`; the
 * page has no external resource, no `fetch` and no `eval`.
 */
import type { DashboardLocale, DashboardSpec, DashboardWidget, SeriesWidget } from "@alisio/sdk";
import { ALISIO_RUNTIME_FILES } from "../python/sources.ts";
import { normalizeName } from "./hints.ts";
import { displayName } from "./labels.ts";
import type { SeriesData, WidgetData } from "./query.ts";

/** The text assets the page inlines. */
export interface RenderAssets {
  /** `charts.css`: dashboard theme and layout. */
  css: string;
  /** `charts-boot.js`: reads each figure's JSON spec and draws it with Chart.js. */
  boot: string;
  /** `chart.umd.min.js`: Chart.js, inlined once. */
  chartJs: string;
  /** `html-base.css`: the base page style. */
  baseCss: string;
}

function asset(name: string): string {
  const text = ALISIO_RUNTIME_FILES[name];
  if (text === undefined) throw new Error(`runtime asset ${name} is missing`);
  return text;
}

/** The assets embedded in the package (the same files `python_run` scripts get). */
export function embeddedAssets(): RenderAssets {
  return {
    css: asset("charts.css"),
    boot: asset("charts-boot.js"),
    chartJs: asset("chart.umd.min.js"),
    baseCss: asset("html-base.css"),
  };
}

interface Strings {
  dataTable: string;
  category: string;
  value: string;
  share: string;
  shares: string;
  other: string;
  noData: string;
  andMore: (count: number) => string;
  topOf: (shown: number, groups: number) => string;
  chart: Record<ChartKind, string>;
  scatterSummary: (count: number) => string;
}

type ChartKind = "line" | "area" | "bar" | "hbar" | "pie" | "donut" | "scatter";

const STRINGS: Record<DashboardLocale, Strings> = {
  en: {
    dataTable: "Data table",
    category: "Category",
    value: "Value",
    share: "Share (%)",
    shares: "Shares",
    other: "Other",
    noData: "No data to chart",
    andMore: (n) => ` and ${n} more`,
    topOf: (n, m) => `Top ${n} of ${m}`,
    chart: {
      line: "Line chart",
      area: "Area chart",
      bar: "Bar chart",
      hbar: "Horizontal bar chart",
      pie: "Pie chart",
      donut: "Donut chart",
      scatter: "Scatter chart",
    },
    scatterSummary: (n) => `Scatter chart with ${n} points.`,
  },
  es: {
    dataTable: "Tabla de datos",
    category: "Categoría",
    value: "Valor",
    share: "Participación (%)",
    shares: "Participación",
    other: "Otros",
    noData: "Sin datos para graficar",
    andMore: (n) => ` y ${n} más`,
    topOf: (n, m) => `Principales ${n} de ${m}`,
    chart: {
      line: "Gráfico de líneas",
      area: "Gráfico de áreas",
      bar: "Gráfico de barras",
      hbar: "Gráfico de barras horizontales",
      pie: "Gráfico circular",
      donut: "Gráfico de anillo",
      scatter: "Gráfico de dispersión",
    },
    scatterSummary: (n) => `Gráfico de dispersión con ${n} puntos.`,
  },
};

/** Shown instead of a number that could not be computed (a KPI over no numeric value). */
const DASH = "—";
const MAX_TABLE_ROWS_SCATTER = 200;

/** HTML escape of text and attribute values (`&`, `<`, `>`, `"`, `'`). */
function esc(text: unknown): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/** JSON that is safe inside `<script>`: no `</script>` and no HTML comment can appear. */
function json(data: unknown): string {
  return JSON.stringify(data)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

/** A number as text: the shortest round-trip form. */
const plain = (value: number): string => String(value);

interface FmtSpec {
  options: Record<string, unknown>;
  locale: DashboardLocale;
}

const PERCENT_WORDS: ReadonlySet<string> = new Set(["pct", "percent", "percentage", "porcentaje"]);

/**
 * `number` (at most 2 decimals) unless the metric's name says it is a percentage and every value
 * is a fraction: then `percent` (spec 8.2). Currency is never inferred: there is no code to use.
 */
function fmtFor(
  widget: DashboardWidget,
  locale: DashboardLocale,
  values: readonly number[],
): FmtSpec {
  const metric = "metric" in widget ? widget.metric : "";
  const aggregation = "aggregation" in widget ? widget.aggregation : "sum";
  const percent =
    metric !== "*" &&
    aggregation !== "sum" &&
    aggregation !== "count" &&
    aggregation !== "count_distinct" &&
    values.length > 0 &&
    values.every((v) => Math.abs(v) <= 1) &&
    normalizeName(metric)
      .split("_")
      .some((token) => PERCENT_WORDS.has(token));
  return {
    options: percent
      ? { style: "percent", maximumFractionDigits: 1 }
      : { maximumFractionDigits: 2 },
    locale,
  };
}

function formatNumber(value: number, fmt: FmtSpec): string {
  try {
    return new Intl.NumberFormat(fmt.locale, fmt.options as Intl.NumberFormatOptions).format(value);
  } catch {
    return plain(value);
  }
}

/** From this magnitude a KPI value is shown in compact notation (the full value stays in `title`). */
const COMPACT_FROM = 1_000_000;

export interface KpiText {
  /** What the tile shows. */
  text: string;
  /** The full formatted value, present only when `text` is compact. */
  full?: string;
}

/**
 * A KPI value as text: full formatting below one million, compact notation (`21.6B`, `21,6 mil M`)
 * from there so no tile clips, with the exact value kept in `full`. Percentages never compact.
 */
export function formatKpiValue(
  value: number,
  locale: DashboardLocale,
  options: Record<string, unknown>,
): KpiText {
  const fmt: FmtSpec = { options, locale };
  const full = formatNumber(value, fmt);
  if (options.style === "percent" || !Number.isFinite(value) || Math.abs(value) < COMPACT_FROM)
    return { text: full };
  try {
    const text = new Intl.NumberFormat(locale, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
    return { text, full };
  } catch {
    return { text: full };
  }
}

function table(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = row
        .map((cell, j) =>
          j > 0 && typeof cell === "number" && Number.isFinite(cell)
            ? `<td data-v="${plain(cell)}">${plain(cell)}</td>`
            : `<td>${esc(cell === null || cell === undefined ? "" : cell)}</td>`,
        )
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<div class="ac-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function defaultHeight(kind: ChartKind, count: number): number {
  if (kind === "hbar") return Math.max(240, Math.min(900, 56 + count * 24));
  if (kind === "pie" || kind === "donut") return 340;
  return 320;
}

function summaryOf(
  t: Strings,
  kind: ChartKind,
  title: string,
  labels: readonly string[],
  values: readonly number[],
): string {
  const parts = labels.slice(0, 8).map((label, i) => `${label}: ${plain(values[i] as number)}`);
  const more = labels.length > 8 ? t.andMore(labels.length - 8) : "";
  return `${title ? `${title}. ` : ""}${t.chart[kind]}. ${parts.join("; ")}${more}`;
}

interface FragmentInput {
  spec: Record<string, unknown> & { kind: ChartKind };
  height: number;
  summary: string;
  headers: readonly string[];
  rows: ReadonlyArray<ReadonlyArray<unknown>>;
  note?: string;
  t: Strings;
}

/** The chart `<figure>` of spec 8.2 (`charts.py` `_fragment`). The card carries the title. */
function fragment(input: FragmentInput): string {
  const foot = input.note ? `<p class="ac-note">${esc(input.note)}</p>` : "";
  return (
    `<figure class="ac-chart ac-pending" data-ac-chart="${esc(input.spec.kind)}">` +
    `<div class="ac-box" style="--ac-h:${input.height}px"><canvas role="img" aria-label="${esc(input.summary)}">${esc(input.summary)}</canvas></div>` +
    `<details class="ac-data" open><summary>${esc(input.t.dataTable)}</summary>${table(input.headers, input.rows)}</details>${foot}` +
    `<script type="application/json">${json(input.spec)}</script></figure>`
  );
}

const empty = (t: Strings): string => `<p class="ac-empty">${esc(t.noData)}</p>`;

function card(title: string, content: string, wide = false): string {
  const head = title ? `<h3>${esc(title)}</h3>` : "";
  const style = wide ? ' style="grid-column:1/-1"' : "";
  return `<section class="ac-card"${style}>${head}${content}</section>`;
}

/** Pie and donut: positive values only, the folded rest as the last slice. */
function shareChart(
  widget: SeriesWidget,
  data: SeriesData,
  locale: DashboardLocale,
  title: string,
): string {
  const t = STRINGS[locale];
  const labels: string[] = [];
  const values: number[] = [];
  for (const point of data.points)
    if (point.v > 0) {
      labels.push(point.k);
      values.push(point.v);
    }
  const folded = data.other !== undefined && data.other > 0;
  if (folded) {
    labels.push(t.other);
    values.push(data.other as number);
  }
  if (values.length === 0) return empty(t);
  const total = values.reduce((sum, v) => sum + v, 0);
  const percents = values.map((v) => round2((100 * v) / total));
  const spec = {
    v: 1,
    kind: widget.type,
    labels,
    series: [{ name: "", data: values }],
    percents,
    fmt: fmtFor(widget, locale, values),
    otherLast: folded,
  };
  const shares = labels.map((l, i) => `${l} ${(percents[i] as number).toFixed(1)}%`).join(", ");
  return fragment({
    spec,
    height: defaultHeight(widget.type, labels.length),
    summary: `${summaryOf(t, widget.type, title, labels, values)} ${t.shares}: ${shares}.`,
    headers: [t.category, t.value, t.share],
    rows: labels.map((l, i) => [l, values[i], percents[i]]),
    ...(data.topOf !== undefined ? { note: t.topOf(data.points.length, data.topOf) } : {}),
    t,
  });
}

const round2 = (value: number): number => Number(value.toFixed(2));

/** Line, area, bar and horizontal bar: one series. */
function cartesianChart(
  widget: SeriesWidget,
  data: SeriesData,
  locale: DashboardLocale,
  title: string,
): string {
  const t = STRINGS[locale];
  const labels = data.points.map((p) => p.k);
  const values = data.points.map((p) => p.v);
  if (data.other !== undefined && data.other !== 0) {
    labels.push(t.other);
    values.push(data.other);
  }
  if (values.length === 0) return empty(t);
  const spec = {
    v: 1,
    kind: widget.type,
    labels,
    series: [{ name: "", data: values }],
    stacked: false,
    valueLabels: (widget.type === "bar" || widget.type === "hbar") && labels.length <= 16,
    smooth: false,
    fmt: fmtFor(widget, locale, values),
  };
  return fragment({
    spec,
    height: defaultHeight(widget.type, labels.length),
    summary: summaryOf(t, widget.type, title, labels, values),
    headers: [t.category, t.value],
    rows: labels.map((l, i) => [l, values[i]]),
    ...(data.topOf !== undefined ? { note: t.topOf(data.points.length, data.topOf) } : {}),
    t,
  });
}

function scatterChart(
  widget: DashboardWidget & { type: "scatter" },
  data: Extract<WidgetData, { type: "scatter" }>,
  locale: DashboardLocale,
  title: string,
): string {
  const t = STRINGS[locale];
  if (data.points.length === 0) return empty(t);
  const spec = {
    v: 1,
    kind: "scatter" as const,
    labels: [],
    series: [{ name: "", data: data.points.map(([x, y]) => ({ x, y })) }],
    fmt: fmtFor(widget, locale, data.points.flat()),
  };
  return fragment({
    spec,
    height: defaultHeight("scatter", data.points.length),
    summary: `${title ? `${title}. ` : ""}${t.scatterSummary(data.points.length)}`,
    headers: ["x", "y"],
    rows: data.points.slice(0, MAX_TABLE_ROWS_SCATTER),
    t,
  });
}

/** A detail table (no chart): numbers formatted for the locale, `null` as an em dash. */
function tableWidget(
  data: Extract<WidgetData, { type: "table" }>,
  locale: DashboardLocale,
): string {
  const fmt: FmtSpec = { options: { maximumFractionDigits: 2 }, locale };
  const head = data.columns.map((c) => `<th>${esc(displayName(c))}</th>`).join("");
  const body = data.rows
    .map((row) => {
      const cells = row
        .map((cell) =>
          typeof cell === "number" && Number.isFinite(cell)
            ? `<td data-n="${plain(cell)}">${esc(formatNumber(cell, fmt))}</td>`
            : `<td>${cell === null || cell === undefined ? DASH : esc(cell)}</td>`,
        )
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<div class="ac-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function kpiCell(
  widget: DashboardWidget & { type: "kpi" },
  data: Extract<WidgetData, { type: "kpi" }>,
  locale: DashboardLocale,
): string {
  const label = widget.label || widget.title || widget.id;
  if (data.value === null)
    return `<div class="ac-kpi"><span>${esc(label)}</span><b>${DASH}</b></div>`;
  const { text, full } = formatKpiValue(
    data.value,
    locale,
    fmtFor(widget, locale, [data.value]).options,
  );
  const value =
    full === undefined
      ? `<b>${esc(text)}</b>`
      : `<b title="${esc(full)}"><span aria-hidden="true">${esc(text)}</span><span class="ac-sr">${esc(full)}</span></b>`;
  return `<div class="ac-kpi"><span>${esc(label)}</span>${value}</div>`;
}

const titleOf = (widget: DashboardWidget): string => widget.title || widget.id;

/** Chart.js source safe inside an inline `<script>`. */
const inlineScript = (code: string): string => code.replace(/<\/script/gi, "<\\/script");

/**
 * The widgets that have data, in spec order, as one page: a row of KPIs, then a grid of cards (one
 * per chart or table). Widgets without data (dropped by the query step) are left out; data without
 * a widget is ignored.
 */
export function renderDashboard(
  spec: DashboardSpec,
  data: readonly WidgetData[],
  assets: RenderAssets = embeddedAssets(),
): string {
  const locale = spec.locale;
  const byId = new Map(data.map((d) => [d.id, d] as const));
  const kpis: string[] = [];
  const cards: string[] = [];
  for (const widget of spec.widgets) {
    const d = byId.get(widget.id);
    if (!d || d.type !== widget.type) continue;
    const title = titleOf(widget);
    switch (widget.type) {
      case "kpi":
        kpis.push(kpiCell(widget, d as Extract<WidgetData, { type: "kpi" }>, locale));
        break;
      case "pie":
      case "donut":
        cards.push(card(title, shareChart(widget, d as SeriesData, locale, title)));
        break;
      case "line":
      case "area":
      case "bar":
      case "hbar":
        cards.push(card(title, cartesianChart(widget, d as SeriesData, locale, title)));
        break;
      case "scatter":
        cards.push(
          card(
            title,
            scatterChart(widget, d as Extract<WidgetData, { type: "scatter" }>, locale, title),
          ),
        );
        break;
      case "table":
        cards.push(
          card(title, tableWidget(d as Extract<WidgetData, { type: "table" }>, locale), true),
        );
        break;
    }
  }
  const body =
    `<h1>${esc(spec.title)}</h1>` +
    (kpis.length ? `<div class="ac-kpis">${kpis.join("")}</div>` : "") +
    (cards.length ? `<div class="ac-grid" style="--ac-min:340px">${cards.join("")}</div>` : "") +
    `<script>${inlineScript(assets.chartJs)}</script><script>${inlineScript(assets.boot)}</script>`;
  return (
    `<!doctype html>\n<html lang="${esc(locale)}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(spec.title)}</title><style>${assets.baseCss}${assets.css}</style></head>` +
    `<body>${body}</body></html>\n`
  );
}
