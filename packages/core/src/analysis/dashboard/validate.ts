/**
 * Validator of a `DashboardSpec` (spec 6.3): schema, data and UX checks, with the deterministic
 * repair table. Pure; never calls a model. Returns a normalized copy: only the fields the contract
 * knows survive, and free text is limited to `title`/`label` (clipped here, escaped when rendered).
 */
import type {
  DashboardAggregation,
  DashboardSpec,
  DashboardTimeBucket,
  DashboardWidget,
} from "@alisio/sdk";
import { clip } from "./labels.ts";
import type { ProfiledColumn } from "./profile.ts";
import {
  AGGREGATIONS,
  LAYOUTS,
  LOCALES,
  PURPOSES,
  priorityOf,
  SERIES_TYPES,
  SPEC_LIMITS,
  TIME_BUCKETS,
  timeBucketFor,
  WIDGET_ID,
} from "./spec.ts";

export type Validation =
  | { result: "valid"; spec: DashboardSpec }
  | { result: "repaired"; spec: DashboardSpec; repairs: string[] }
  | { result: "fallback"; reasons: string[] };

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  isString(value) && (list as readonly string[]).includes(value);

const TOP_KEYS = new Set(["version", "title", "purpose", "layout", "locale", "sheet", "widgets"]);
const WIDGET_KEYS: Record<string, ReadonlySet<string>> = {
  kpi: new Set(["id", "title", "type", "metric", "aggregation", "label"]),
  series: new Set([
    "id",
    "title",
    "type",
    "dimension",
    "metric",
    "aggregation",
    "timeBucket",
    "limit",
    "other",
  ]),
  scatter: new Set(["id", "title", "type", "x", "y"]),
  table: new Set(["id", "title", "type", "columns", "limit"]),
};
const NUMERIC_AGGREGATIONS: readonly DashboardAggregation[] = ["sum", "avg", "min", "max"];
const ADDITIVE: readonly DashboardAggregation[] = ["sum", "count"];

class Context {
  readonly repairs: string[] = [];
  readonly byName: Map<string, ProfiledColumn>;
  constructor(catalog: ProfiledColumn[]) {
    this.byName = new Map(catalog.map((c) => [c.name, c]));
  }
  fix(message: string): void {
    this.repairs.push(message);
  }
}

/** Free text: control characters out, bounded. Returns `undefined` when it was not text. */
function text(value: unknown, max: number): string | undefined {
  return isString(value) ? clip(value, max) : undefined;
}

function stripUnknown(raw: Raw, allowed: ReadonlySet<string>, at: string, ctx: Context): void {
  for (const key of Object.keys(raw))
    if (!allowed.has(key)) ctx.fix(`${at}: unknown field "${clip(key, 40)}" removed`);
}

/** Resolves `metric` and `aggregation` against the catalog; `null` drops the widget. */
function resolveMetric(
  raw: Raw,
  at: string,
  ctx: Context,
): { metric: string; aggregation: DashboardAggregation } | null {
  if (!isString(raw.metric) || !oneOf(AGGREGATIONS, raw.aggregation)) {
    ctx.fix(`${at} dropped: metric or aggregation missing or unknown`);
    return null;
  }
  let aggregation: DashboardAggregation = raw.aggregation;
  if (raw.metric === "*") {
    if (aggregation !== "count") {
      ctx.fix(`${at}: metric * only counts, aggregation set to count`);
      aggregation = "count";
    }
    return { metric: "*", aggregation };
  }
  const column = ctx.byName.get(raw.metric);
  if (!column) {
    ctx.fix(`${at} dropped: column is not in the dataset`);
    return null;
  }
  if (NUMERIC_AGGREGATIONS.includes(aggregation) && column.role !== "measure") {
    if (column.role === "unknown") {
      ctx.fix(`${at} dropped: column has no usable values`);
      return null;
    }
    ctx.fix(`${at}: ${aggregation} over a non-measure, aggregation set to count_distinct`);
    aggregation = "count_distinct";
  }
  return { metric: raw.metric, aggregation };
}

function clampLimit(value: unknown, at: string, ctx: Context): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    ctx.fix(`${at}: limit is not a number, removed`);
    return undefined;
  }
  const clamped = Math.min(SPEC_LIMITS.limitMax, Math.max(SPEC_LIMITS.limitMin, Math.floor(value)));
  if (clamped !== value) ctx.fix(`${at}: limit ${value} clamped to ${clamped}`);
  return clamped;
}

function cleanKpi(
  raw: Raw,
  id: string,
  title: string | undefined,
  ctx: Context,
): DashboardWidget | null {
  const at = `widget ${id}`;
  stripUnknown(raw, WIDGET_KEYS.kpi as ReadonlySet<string>, at, ctx);
  const metric = resolveMetric(raw, at, ctx);
  if (!metric) return null;
  const label = text(raw.label, SPEC_LIMITS.widgetTitle);
  return { id, type: "kpi", ...metric, ...(label ? { label } : {}), ...(title ? { title } : {}) };
}

function cleanSeries(
  raw: Raw,
  id: string,
  title: string | undefined,
  ctx: Context,
): DashboardWidget | null {
  const at = `widget ${id}`;
  stripUnknown(raw, WIDGET_KEYS.series as ReadonlySet<string>, at, ctx);
  let type = raw.type as (typeof SERIES_TYPES)[number];
  const dimension = isString(raw.dimension) ? ctx.byName.get(raw.dimension) : undefined;
  if (!dimension) {
    ctx.fix(`${at} dropped: dimension is not in the dataset`);
    return null;
  }
  const isTime = dimension.role === "time";
  if (!isTime && dimension.role !== "dimension" && dimension.role !== "boolean") {
    ctx.fix(`${at} dropped: ${dimension.role} column used as dimension`);
    return null;
  }
  const metric = resolveMetric(raw, at, ctx);
  if (!metric) return null;

  if (!isTime && (type === "line" || type === "area")) {
    ctx.fix(`${at}: ${type} needs a time dimension, changed to bar`);
    type = "bar";
  } else if (isTime && (type === "pie" || type === "donut")) {
    ctx.fix(`${at}: ${type} over time, changed to bar`);
    type = "bar";
  }

  let timeBucket: DashboardTimeBucket | undefined;
  if (isTime) {
    if (oneOf(TIME_BUCKETS, raw.timeBucket)) timeBucket = raw.timeBucket;
    else {
      timeBucket = timeBucketFor(dimension.span?.days ?? 0);
      ctx.fix(
        `${at}: timeBucket ${raw.timeBucket === undefined ? "missing" : "unknown"}, set to ${timeBucket}`,
      );
    }
  } else if (raw.timeBucket !== undefined)
    ctx.fix(`${at}: timeBucket removed, the dimension is not a time column`);

  const limit = clampLimit(raw.limit, at, ctx);
  let other = raw.other === true;
  if (raw.other !== undefined && typeof raw.other !== "boolean")
    ctx.fix(`${at}: other is not a boolean, removed`);
  if (other && (!ADDITIVE.includes(metric.aggregation) || isTime)) {
    ctx.fix(`${at}: other only folds sum or count over categories, removed`);
    other = false;
  }

  if (type === "pie" || type === "donut") {
    const effectiveLimit = limit ?? SPEC_LIMITS.defaultLimit;
    const slices =
      other && dimension.distinct > effectiveLimit
        ? effectiveLimit + 1
        : Math.min(dimension.distinct, effectiveLimit);
    const explicitWide = limit !== undefined && limit > SPEC_LIMITS.maxSlices && !other;
    if (!ADDITIVE.includes(metric.aggregation)) {
      ctx.fix(`${at}: ${type} of a ${metric.aggregation}, changed to hbar`);
      type = "hbar" as typeof type;
    } else if (slices > SPEC_LIMITS.maxSlices || explicitWide) {
      ctx.fix(`${at}: ${type} with more than ${SPEC_LIMITS.maxSlices} categories, changed to hbar`);
      type = "hbar" as typeof type;
    }
  }

  return {
    id,
    type,
    dimension: dimension.name,
    ...metric,
    ...(timeBucket ? { timeBucket } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(other ? { other } : {}),
    ...(title ? { title } : {}),
  };
}

function cleanScatter(
  raw: Raw,
  id: string,
  title: string | undefined,
  ctx: Context,
): DashboardWidget | null {
  const at = `widget ${id}`;
  stripUnknown(raw, WIDGET_KEYS.scatter as ReadonlySet<string>, at, ctx);
  const x = isString(raw.x) ? ctx.byName.get(raw.x) : undefined;
  const y = isString(raw.y) ? ctx.byName.get(raw.y) : undefined;
  if (!x || !y || x.role !== "measure" || y.role !== "measure" || x.name === y.name) {
    ctx.fix(`${at} dropped: a scatter needs two distinct measures`);
    return null;
  }
  return { id, type: "scatter", x: x.name, y: y.name, ...(title ? { title } : {}) };
}

function cleanTable(
  raw: Raw,
  id: string,
  title: string | undefined,
  ctx: Context,
): DashboardWidget | null {
  const at = `widget ${id}`;
  stripUnknown(raw, WIDGET_KEYS.table as ReadonlySet<string>, at, ctx);
  if (!Array.isArray(raw.columns)) {
    ctx.fix(`${at} dropped: columns missing`);
    return null;
  }
  const columns: string[] = [];
  for (const name of raw.columns) {
    if (!isString(name) || !ctx.byName.has(name))
      ctx.fix(`${at}: column removed, it is not in the dataset`);
    else if (columns.includes(name)) ctx.fix(`${at}: repeated column removed`);
    else if (columns.length >= SPEC_LIMITS.tableColumns)
      ctx.fix(`${at}: column beyond ${SPEC_LIMITS.tableColumns} removed`);
    else columns.push(name);
  }
  if (columns.length === 0) {
    ctx.fix(`${at} dropped: no column left`);
    return null;
  }
  const limit = clampLimit(raw.limit, at, ctx);
  return {
    id,
    type: "table",
    columns,
    ...(limit !== undefined ? { limit } : {}),
    ...(title ? { title } : {}),
  };
}

function cleanWidget(raw: unknown, index: number, ctx: Context): DashboardWidget | null {
  if (!isRecord(raw)) {
    ctx.fix(`widget #${index + 1} dropped: not an object`);
    return null;
  }
  if (!isString(raw.id)) {
    ctx.fix(`widget #${index + 1} dropped: id missing`);
    return null;
  }
  const id = raw.id;
  const at = `widget ${clip(id, 40)}`;
  const title = text(raw.title, SPEC_LIMITS.widgetTitle);
  if (raw.title !== undefined && title === undefined) ctx.fix(`${at}: title is not text, removed`);
  else if (isString(raw.title) && title !== raw.title) ctx.fix(`${at}: title cleaned or clipped`);
  if (raw.type === "kpi") return cleanKpi(raw, id, title, ctx);
  if (oneOf(SERIES_TYPES, raw.type)) return cleanSeries(raw, id, title, ctx);
  if (raw.type === "scatter") return cleanScatter(raw, id, title, ctx);
  if (raw.type === "table") return cleanTable(raw, id, title, ctx);
  ctx.fix(`${at} dropped: unknown widget type`);
  return null;
}

/** Same type, dimension, metric and aggregation (spec 6.3); scatter and table by their columns. */
function signature(widget: DashboardWidget): string {
  switch (widget.type) {
    case "kpi":
      return JSON.stringify(["kpi", widget.metric, widget.aggregation]);
    case "scatter":
      return JSON.stringify(["scatter", widget.x, widget.y]);
    case "table":
      return JSON.stringify(["table", widget.columns]);
    default:
      return JSON.stringify([widget.type, widget.dimension, widget.metric, widget.aggregation]);
  }
}

function normalizeId(id: string): string {
  if (WIDGET_ID.test(id)) return id;
  let clean = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(clean)) clean = `w-${clean}`.replace(/-+$/, "");
  return clean.slice(0, 40).replace(/-+$/, "") || "widget";
}

function uniqueIds(widgets: DashboardWidget[], ctx: Context): DashboardWidget[] {
  const used = new Set<string>();
  return widgets.map((widget) => {
    const base = normalizeId(widget.id);
    let id = base;
    for (let n = 2; used.has(id); n++) {
      const suffix = `-${n}`;
      id = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    }
    used.add(id);
    if (id !== widget.id) ctx.fix(`widget ${clip(widget.id, 40)}: id changed to ${id}`);
    return id === widget.id ? widget : { ...widget, id };
  });
}

/** Drops from the tail of the layout's priority until the limits hold. */
function trim(
  widgets: DashboardWidget[],
  layout: DashboardSpec["layout"],
  ctx: Context,
): DashboardWidget[] {
  let out = widgets;
  const kpis = out.filter((w) => w.type === "kpi");
  if (kpis.length > SPEC_LIMITS.kpis) {
    const dropped = new Set<DashboardWidget>(kpis.slice(SPEC_LIMITS.kpis));
    for (const w of dropped) ctx.fix(`widget ${w.id} dropped: more than ${SPEC_LIMITS.kpis} KPIs`);
    out = out.filter((w) => !dropped.has(w));
  }
  while (out.length > SPEC_LIMITS.widgets) {
    let worst = 0;
    out.forEach((w, i) => {
      const a = priorityOf(layout, w);
      const b = priorityOf(layout, out[worst] as DashboardWidget);
      if (a >= b) worst = i;
    });
    const [gone] = out.splice(worst, 1);
    out = [...out];
    ctx.fix(`widget ${gone?.id} dropped: more than ${SPEC_LIMITS.widgets} widgets`);
  }
  return out;
}

export function validateSpec(input: unknown, catalog: ProfiledColumn[]): Validation {
  const bad = (...reasons: string[]): Validation => ({ result: "fallback", reasons });
  if (!isRecord(input)) return bad("spec is not an object");
  if (input.version !== 1) return bad("spec version is not 1");
  const title = text(input.title, SPEC_LIMITS.title);
  if (title === undefined) return bad("title is not text");
  if (!oneOf(PURPOSES, input.purpose)) return bad("unknown purpose");
  if (!oneOf(LAYOUTS, input.layout)) return bad("unknown layout");
  if (!oneOf(LOCALES, input.locale)) return bad("unknown locale");
  if (
    input.sheet !== undefined &&
    (!isString(input.sheet) || input.sheet.length === 0 || input.sheet.length > 200)
  )
    return bad("sheet is not a table name");
  if (!Array.isArray(input.widgets)) return bad("widgets is not a list");

  const ctx = new Context(catalog);
  for (const key of Object.keys(input))
    if (!TOP_KEYS.has(key)) ctx.fix(`unknown field "${clip(key, 40)}" removed`);
  if (title !== input.title) ctx.fix("title cleaned or clipped");

  const seen = new Set<string>();
  let widgets: DashboardWidget[] = [];
  input.widgets.forEach((raw, index) => {
    const widget = cleanWidget(raw, index, ctx);
    if (!widget) return;
    const key = signature(widget);
    if (seen.has(key)) {
      ctx.fix(`widget ${clip(widget.id, 40)} dropped: duplicate`);
      return;
    }
    seen.add(key);
    widgets.push(widget);
  });
  widgets = trim(uniqueIds(widgets, ctx), input.layout, ctx);
  if (widgets.length === 0) return bad("no valid widget left", ...ctx.repairs);

  const spec: DashboardSpec = {
    version: 1,
    title,
    purpose: input.purpose,
    layout: input.layout,
    locale: input.locale,
    ...(isString(input.sheet) ? { sheet: input.sheet } : {}),
    widgets,
  };
  return ctx.repairs.length === 0
    ? { result: "valid", spec }
    : { result: "repaired", spec, repairs: ctx.repairs };
}
