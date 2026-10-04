/**
 * Column profiler of the Smart Dashboard (spec 6.1): a role, a cardinality bucket and an opaque
 * alias per column, computed only from the statistics the ingestion already stored in
 * `_alisio_columns` (`DatasetColumnWire`). Pure; never reads a cell.
 */
import type { DatasetDetailWire } from "@alisio/sdk";
import { hintsOf, looksLikeIdentifierName } from "./hints.ts";

export type SheetDetail = DatasetDetailWire["sheetDetails"][number];
export type ColumnWire = SheetDetail["columns"][number];

export type ColumnRole = "time" | "measure" | "dimension" | "identifier" | "boolean" | "unknown";
export type CardinalityBucket = "binary" | "low" | "medium" | "high" | "very-high";

export interface ProfiledColumn {
  /** `c1`..`cN` by ordinal: the opaque handle used toward a decision provider. */
  alias: string;
  /** Position in the sheet (0-based); the tie-break of every ranking. */
  ordinal: number;
  /** Dataset column name (`[a-z0-9_]`) and original header. */
  name: string;
  label: string;
  type: ColumnWire["type"];
  role: ColumnRole;
  /** Why the role was chosen, for diagnostics. Never sent to a provider. */
  roleReason: string;
  nullRatio: number;
  distinctRatio: number;
  /** Distinct non-null values (exact up to a million rows, sampled above). */
  distinct: number;
  cardinality: CardinalityBucket;
  /** True when min and max differ (numeric columns). */
  varies: boolean;
  /** Time columns: the span between min and max. */
  span?: { days: number };
}

/** Buckets of `distinct`: 2 binary, 3-8 low, 9-30 medium, 31-200 high, above very-high. */
export function cardinalityBucket(distinct: number): CardinalityBucket {
  if (distinct <= 2) return "binary";
  if (distinct <= 8) return "low";
  if (distinct <= 30) return "medium";
  if (distinct <= 200) return "high";
  return "very-high";
}

const DAY_MS = 86_400_000;
const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** ISO 8601 text to epoch ms, reading a missing zone as UTC so the span never depends on the host. */
function isoMillis(text: string | undefined): number | undefined {
  if (!text) return undefined;
  let iso = text.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += "T00:00:00Z";
  else if (!ISO_WITH_ZONE.test(iso)) iso += "Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function spanOf(column: ColumnWire): { days: number } | undefined {
  const from = isoMillis(column.min);
  const to = isoMillis(column.max);
  if (from === undefined || to === undefined || to < from) return undefined;
  return { days: Math.round((to - from) / DAY_MS) };
}

interface Decision {
  role: ColumnRole;
  reason: string;
}

function roleFor(
  column: ColumnWire,
  rows: number,
  stats: { nullRatio: number; distinctRatio: number; nonNull: number },
  span: { days: number } | undefined,
): Decision {
  const { nullRatio, distinctRatio, nonNull } = stats;
  const distinct = column.distinct;
  if (nonNull <= 0 || nullRatio > 0.95)
    return { role: "unknown", reason: "empty or almost all null" };
  if (column.type === "date")
    return span
      ? { role: "time", reason: "ISO date" }
      : { role: "unknown", reason: "date range not readable" };
  if (column.type === "boolean") return { role: "boolean", reason: "boolean type" };
  if (looksLikeIdentifierName(column.name, column.label) && distinctRatio >= 0.5)
    return { role: "identifier", reason: "name hint: id, with mostly distinct values" };
  const numeric = column.type === "integer" || column.type === "real";
  if (column.type === "integer" && distinctRatio >= 0.98 && rows >= 20)
    return { role: "identifier", reason: "unique integer (surrogate key)" };
  if (column.type === "integer" && distinct <= 12 && !hintsOf(column.name, column.label).magnitude)
    return { role: "dimension", reason: "integer with few values" };
  if (numeric) return { role: "measure", reason: `${column.type} column` };
  if (column.type === "text") {
    if (distinctRatio >= 0.9 && rows >= 20)
      return { role: "identifier", reason: "text with almost only distinct values" };
    if (distinct >= 2 && distinct <= 200)
      return { role: "dimension", reason: "text with a bounded set of values" };
  }
  return { role: "unknown", reason: "constant or too many distinct values" };
}

/** Profiles every column of a sheet, in ordinal order. */
export function profileSheet(sheet: SheetDetail): ProfiledColumn[] {
  const rows = Math.max(0, sheet.rows);
  return sheet.columns.map((column, ordinal) => {
    const nonNull = Math.max(0, rows - column.nulls);
    const nullRatio = rows > 0 ? Math.min(1, column.nulls / rows) : 1;
    const distinctRatio = nonNull > 0 ? Math.min(1, column.distinct / nonNull) : 0;
    const span = column.type === "date" ? spanOf(column) : undefined;
    const { role, reason } = roleFor(column, rows, { nullRatio, distinctRatio, nonNull }, span);
    return {
      alias: `c${ordinal + 1}`,
      ordinal,
      name: column.name,
      label: column.label,
      type: column.type,
      role,
      roleReason: reason,
      nullRatio,
      distinctRatio,
      distinct: column.distinct,
      cardinality: cardinalityBucket(column.distinct),
      varies: column.min !== undefined && column.max !== undefined && column.min !== column.max,
      ...(role === "time" && span ? { span } : {}),
    };
  });
}
