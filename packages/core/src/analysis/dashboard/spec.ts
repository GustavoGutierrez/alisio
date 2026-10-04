/**
 * Runtime side of the `DashboardSpec` contract (the types live in `@alisio/sdk`): the closed
 * enums, the limits, the time-bucket choice and the ordering of widgets per layout. Pure.
 */
import type {
  DashboardAggregation,
  DashboardLayout,
  DashboardLocale,
  DashboardPurpose,
  DashboardTimeBucket,
  DashboardWidget,
} from "@alisio/sdk";

export type {
  DashboardAggregation,
  DashboardLayout,
  DashboardLocale,
  DashboardProvenance,
  DashboardPurpose,
  DashboardSpec,
  DashboardTimeBucket,
  DashboardWidget,
  KpiWidget,
  ScatterWidget,
  SeriesWidget,
  TableWidget,
} from "@alisio/sdk";

export const PURPOSES: readonly DashboardPurpose[] = ["executive", "operational", "analytical"];
export const LAYOUTS: readonly DashboardLayout[] = [
  "executive-grid",
  "operational-grid",
  "analytical-grid",
];
export const LOCALES: readonly DashboardLocale[] = ["en", "es"];
export const AGGREGATIONS: readonly DashboardAggregation[] = [
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "count_distinct",
];
export const TIME_BUCKETS: readonly DashboardTimeBucket[] = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
];
export const SERIES_TYPES = ["line", "area", "bar", "hbar", "pie", "donut"] as const;
export const WIDGET_TYPES = [...SERIES_TYPES, "kpi", "scatter", "table"] as const;

export const SPEC_LIMITS = {
  widgets: 12,
  kpis: 6,
  tableColumns: 8,
  limitMin: 1,
  limitMax: 20,
  defaultLimit: 10,
  title: 120,
  widgetTitle: 80,
  /** A pie or donut with more slices than this reads badly and becomes a horizontal bar. */
  maxSlices: 6,
  /** The query planner caps a trend at this many buckets (never truncates: it coarsens). */
  maxBuckets: 400,
} as const;

export const WIDGET_ID = /^[a-z][a-z0-9-]{0,39}$/;

export const PURPOSE_LAYOUT: Record<DashboardPurpose, DashboardLayout> = {
  executive: "executive-grid",
  operational: "operational-grid",
  analytical: "analytical-grid",
};

/** What a widget is for; the layouts order and trim by it. */
export type WidgetRole = "kpi" | "trend" | "ranking" | "composition" | "correlation" | "table";

export function roleOfWidget(widget: DashboardWidget): WidgetRole {
  switch (widget.type) {
    case "kpi":
      return "kpi";
    case "line":
    case "area":
      return "trend";
    case "bar":
    case "hbar":
      return "ranking";
    case "pie":
    case "donut":
      return "composition";
    case "scatter":
      return "correlation";
    case "table":
      return "table";
  }
}

/** Priority of the widget roles per layout (spec 6.2). Earlier is kept first when trimming. */
export const LAYOUT_ORDER: Record<DashboardLayout, readonly WidgetRole[]> = {
  "executive-grid": ["kpi", "trend", "ranking", "composition"],
  "operational-grid": ["kpi", "table", "ranking", "trend"],
  "analytical-grid": ["kpi", "trend", "ranking", "composition", "correlation", "table"],
};

/** Priority number of a widget in a layout; roles the layout does not list come last. */
export function priorityOf(layout: DashboardLayout, widget: DashboardWidget): number {
  const index = LAYOUT_ORDER[layout].indexOf(roleOfWidget(widget));
  return index === -1 ? LAYOUT_ORDER[layout].length : index;
}

/** Days per bucket; a quarter is 91.3 days and a month 30.4 on average. */
const BUCKET_DAYS: Record<DashboardTimeBucket, number> = {
  day: 1,
  week: 7,
  month: 30.4375,
  quarter: 91.3125,
  year: 365.25,
};
const BUCKET_ORDER: readonly DashboardTimeBucket[] = TIME_BUCKETS;
/** Largest span (days) each bucket serves: about 60 buckets (spec 6.2). */
const BUCKET_MAX_SPAN: Array<[DashboardTimeBucket, number]> = [
  ["day", 60],
  ["week", 420],
  ["month", 1800],
  ["quarter", 5400],
];

/** How many buckets a span of `days` produces at most (both ends included). */
export function bucketCount(days: number, bucket: DashboardTimeBucket): number {
  return Math.floor(Math.max(0, days) / BUCKET_DAYS[bucket]) + 2;
}

/**
 * The finest bucket for a span (spec 6.2: ≤ 60 d day, ≤ 420 d week, ≤ 1800 d month, ≤ 5400 d
 * quarter, else year), coarsened while it would yield more than 400 buckets: the trend query
 * never truncates its tail (Phase 0, E2).
 */
export function timeBucketFor(spanDays: number): DashboardTimeBucket {
  const days = Number.isFinite(spanDays) ? Math.max(0, spanDays) : 0;
  let bucket: DashboardTimeBucket = "year";
  for (const [candidate, maxSpan] of BUCKET_MAX_SPAN)
    if (days <= maxSpan) {
      bucket = candidate;
      break;
    }
  let index = BUCKET_ORDER.indexOf(bucket);
  while (
    index < BUCKET_ORDER.length - 1 &&
    bucketCount(days, BUCKET_ORDER[index] as DashboardTimeBucket) > SPEC_LIMITS.maxBuckets
  )
    index++;
  return BUCKET_ORDER[index] as DashboardTimeBucket;
}
