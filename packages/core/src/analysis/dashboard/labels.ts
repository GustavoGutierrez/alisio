/**
 * Titles and labels by template (ADR-5): `en`/`es` tables and formation rules, never an LLM.
 * Column labels are the original headers of the dataset; they reach the page escaped by the
 * renderer, not here. Pure.
 */
import type {
  DashboardAggregation,
  DashboardLocale,
  DashboardPurpose,
  DashboardTimeBucket,
} from "@alisio/sdk";
import { SPEC_LIMITS } from "./spec.ts";

interface Strings {
  rows: string;
  detail: string;
  total: (metric: string) => string;
  average: (metric: string) => string;
  minimum: (metric: string) => string;
  maximum: (metric: string) => string;
  distinct: (metric: string) => string;
  per: (metric: string, bucket: string) => string;
  by: (metric: string, dimension: string) => string;
  share: (metric: string, dimension: string) => string;
  versus: (y: string, x: string) => string;
  bucket: Record<DashboardTimeBucket, string>;
  dashboard: Record<DashboardPurpose, string>;
}

/** Longest display name: widget titles are clipped anyway, this keeps a hostile header bounded. */
const DISPLAY_MAX = 60;
/** Unit suffixes of a column identifier, shown in parentheses: `unit_price_cop` -> «Unit price (COP)». */
const UNIT_SUFFIX: Readonly<Record<string, string>> = {
  cop: "COP",
  usd: "USD",
  eur: "EUR",
  mxn: "MXN",
  pct: "%",
};
const CONTROL = /[\u0000-\u001f\u007f]/;
const CAMEL_BOUNDARY = /[\p{Ll}\p{N}]\p{Lu}/u;

const upperFirst = (text: string): string =>
  text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;

/** Splits an identifier on `_`, `-`, spaces and camelCase boundaries (`customerID` -> customer, ID). */
function words(text: string): string[] {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
}

function humanize(identifier: string): string {
  const tokens = words(identifier);
  if (tokens.length === 0) return identifier.trim();
  let unit = "";
  if (tokens.length > 1) {
    const mapped = UNIT_SUFFIX[(tokens[tokens.length - 1] as string).toLowerCase()];
    if (mapped !== undefined) {
      unit = mapped;
      tokens.pop();
    }
  }
  const text = tokens
    .map((t) =>
      t.length > 1 && t === t.toLocaleUpperCase() && /\p{L}/u.test(t) ? t : t.toLocaleLowerCase(),
    )
    .join(" ");
  return upperFirst(unit ? `${text} (${unit})` : text);
}

/**
 * The readable name of a column for titles, labels and table headers. The original header wins when
 * it differs from the sanitized `name` and reads like text; otherwise the identifier is humanized
 * (`gross_sales_cop` -> «Gross sales (COP)»). Never translates; pure; the spec keeps raw names.
 */
export function displayName(name: string, label?: string): string {
  const header = (label ?? "").trim();
  const readable =
    header !== "" &&
    header !== name &&
    header.length <= DISPLAY_MAX &&
    !header.includes("_") &&
    !CONTROL.test(header) &&
    !CAMEL_BOUNDARY.test(header);
  const text = readable ? header : humanize(header !== "" && header !== name ? header : name);
  return clipName(text);
}

function clipName(text: string): string {
  return text.length <= DISPLAY_MAX ? text : `${text.slice(0, DISPLAY_MAX - 1).trimEnd()}…`;
}

/** A display name in the middle of a sentence: «Total gross sales (COP)»; acronyms keep their case. */
function mid(text: string): string {
  const first = text.charAt(0);
  const second = text.charAt(1);
  if (!first || first === first.toLocaleLowerCase()) return text;
  if (second && second === second.toLocaleUpperCase() && second !== second.toLocaleLowerCase())
    return text;
  return first.toLocaleLowerCase() + text.slice(1);
}

const STRINGS: Record<DashboardLocale, Strings> = {
  en: {
    rows: "Rows",
    detail: "Detail",
    total: (m) => `Total ${mid(m)}`,
    average: (m) => `Average ${mid(m)}`,
    minimum: (m) => `Minimum ${mid(m)}`,
    maximum: (m) => `Maximum ${mid(m)}`,
    distinct: (m) => `Distinct ${m}`,
    per: (m, b) => `${m} per ${b}`,
    by: (m, d) => `${m} by ${mid(d)}`,
    share: (m, d) => `${m} share by ${mid(d)}`,
    versus: (y, x) => `${y} vs ${mid(x)}`,
    bucket: { day: "day", week: "week", month: "month", quarter: "quarter", year: "year" },
    dashboard: {
      executive: "Executive dashboard",
      operational: "Operational dashboard",
      analytical: "Analytical dashboard",
    },
  },
  es: {
    rows: "Filas",
    detail: "Detalle",
    total: (m) => `Total ${mid(m)}`,
    average: (m) => `Promedio de ${mid(m)}`,
    minimum: (m) => `Mínimo de ${mid(m)}`,
    maximum: (m) => `Máximo de ${mid(m)}`,
    distinct: (m) => `${m} distintos`,
    per: (m, b) => `${m} por ${b}`,
    by: (m, d) => `${m} por ${mid(d)}`,
    share: (m, d) => `Participación de ${mid(m)} por ${mid(d)}`,
    versus: (y, x) => `${y} vs ${mid(x)}`,
    bucket: { day: "día", week: "semana", month: "mes", quarter: "trimestre", year: "año" },
    dashboard: {
      executive: "Panel ejecutivo",
      operational: "Panel operativo",
      analytical: "Panel analítico",
    },
  },
};

/** Truncates to `max` characters with an ellipsis; control characters become spaces. */
export function clip(text: string, max: number): string {
  const clean = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const widgetTitle = (text: string): string => clip(text, SPEC_LIMITS.widgetTitle);

export function defaultTitle(locale: DashboardLocale, purpose: DashboardPurpose): string {
  return STRINGS[locale].dashboard[purpose];
}

export function rowsLabel(locale: DashboardLocale): string {
  return STRINGS[locale].rows;
}

/** The KPI label: «Total {metric}», «Average {metric}», … or «Rows» for `count(*)`. */
export function kpiLabel(
  locale: DashboardLocale,
  aggregation: DashboardAggregation,
  metricLabel: string | null,
): string {
  const t = STRINGS[locale];
  if (metricLabel === null) return t.rows;
  switch (aggregation) {
    case "sum":
      return widgetTitle(t.total(metricLabel));
    case "avg":
      return widgetTitle(t.average(metricLabel));
    case "min":
      return widgetTitle(t.minimum(metricLabel));
    case "max":
      return widgetTitle(t.maximum(metricLabel));
    case "count_distinct":
      return widgetTitle(t.distinct(metricLabel));
    case "count":
      return widgetTitle(`${t.rows} · ${metricLabel}`);
  }
}

/** «{metric} per {bucket}»; `null` metric means the row count. */
export function trendTitle(
  locale: DashboardLocale,
  metricLabel: string | null,
  bucket: DashboardTimeBucket,
): string {
  const t = STRINGS[locale];
  return widgetTitle(t.per(metricLabel ?? t.rows, t.bucket[bucket]));
}

/** «{metric} by {dimension}». */
export function byTitle(
  locale: DashboardLocale,
  metricLabel: string | null,
  dimensionLabel: string,
): string {
  const t = STRINGS[locale];
  return widgetTitle(t.by(metricLabel ?? t.rows, dimensionLabel));
}

export function shareTitle(
  locale: DashboardLocale,
  metricLabel: string | null,
  dimensionLabel: string,
): string {
  const t = STRINGS[locale];
  return widgetTitle(t.share(metricLabel ?? t.rows, dimensionLabel));
}

export function scatterTitle(locale: DashboardLocale, yLabel: string, xLabel: string): string {
  return widgetTitle(STRINGS[locale].versus(yLabel, xLabel));
}

export function tableTitle(locale: DashboardLocale): string {
  return STRINGS[locale].detail;
}
