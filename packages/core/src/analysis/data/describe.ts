/**
 * Text and table renderings of a dataset for the model and the terminal (spec §12 and the
 * prompt summary of §21 phase 3). Pure: given the dataset detail and sample rows, produces a
 * bounded text (the model never sees more than `maxChars`).
 */
import type { DatasetColumnWire, DatasetDetailWire } from "@alisio/sdk";

export const formatCount = (n: number): string => n.toLocaleString("en-US");

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One cell as plain, single-line text of at most `max` characters. */
export function cellText(value: string | number | null | undefined, max = 40): string {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\r?\n/g, "\\n").replace(/\t/g, " ");
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function columnLine(column: DatasetColumnWire): string {
  const parts = [`${column.name} (${column.type})`];
  if (column.label !== column.name) parts.push(`header "${cellText(column.label, 30)}"`);
  parts.push(`nulls ${formatCount(column.nulls)}`);
  parts.push(`distinct ${formatCount(column.distinct)}${column.distinctExact ? "" : "~"}`);
  if (column.min !== undefined && column.max !== undefined)
    parts.push(`min ${cellText(column.min, 24)}, max ${cellText(column.max, 24)}`);
  if (column.mean !== undefined) parts.push(`mean ${Number(column.mean.toPrecision(6))}`);
  if (column.textFallbacks > 0)
    parts.push(`${formatCount(column.textFallbacks)} cells kept as exact text`);
  if (column.top.length)
    parts.push(
      `top: ${column.top
        .slice(0, 3)
        .map((t) => `${cellText(t.value, 20)} (${formatCount(t.count)})`)
        .join(", ")}`,
    );
  return `- ${parts.join(" · ")}`;
}

/** `ds_… "sales.csv" · csv · 1.2 MB · 12,480 rows × 6 columns` (one line per dataset). */
export function datasetHeadline(detail: DatasetDetailWire): string {
  const sheet = detail.sheets[0];
  const shape =
    detail.sheets.length === 1 && sheet
      ? `${formatCount(sheet.rows)} rows × ${sheet.columns} columns`
      : `${detail.sheets.length} sheets`;
  return `${detail.id} "${detail.name}" · ${detail.format} · ${formatBytes(detail.bytes)} · ${shape}`;
}

export interface SampleRows {
  table: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

function sampleLines(sample: SampleRows, columnLimit: number): string[] {
  const names = sample.columns.slice(0, columnLimit);
  const lines = [names.join(" | ")];
  for (const row of sample.rows)
    lines.push(
      row
        .slice(0, columnLimit)
        .map((v) => cellText(v, 24))
        .join(" | "),
    );
  if (sample.columns.length > columnLimit)
    lines.push(`… ${sample.columns.length - columnLimit} more columns`);
  return lines;
}

/**
 * The description a model reads: headline, usage note, and for each sheet its columns with
 * statistics and a few sample rows. Fits `maxChars` by dropping column detail first, then sample
 * columns (never silently: a line says what was left out).
 */
export function describeDataset(
  detail: DatasetDetailWire,
  samples: Map<string, SampleRows>,
  options: { maxChars: number; dashboard?: boolean },
): string {
  const header = [
    `Dataset ${datasetHeadline(detail)}`,
    `Stored in SQLite: query it with data_query (SELECT/WITH only, quote column names) or pass { datasetId } to python_run (alisio_runtime.datasets.open).${options.dashboard ? " For a dashboard use dashboard_generate { datasetId, goal }." : ""} Values are exact: numbers are numbers, everything else (e.g. 007, 1,234, N/A) is the original text.`,
  ];
  const blocks = detail.sheetDetails.map((sheet) => {
    const lines = [
      `Table "${sheet.table}" (sheet "${sheet.name}"): ${formatCount(sheet.rows)} rows`,
    ];
    return { sheet, lines };
  });
  const build = (columnCap: number, sampleCols: number): string => {
    const out = [...header];
    for (const { sheet, lines } of blocks) {
      out.push(...lines);
      for (const column of sheet.columns.slice(0, columnCap)) out.push(columnLine(column));
      if (sheet.columns.length > columnCap)
        out.push(
          `… ${sheet.columns.length - columnCap} more columns (see the table in data_inspect)`,
        );
      const sample = samples.get(sheet.table);
      if (sample?.rows.length) {
        out.push(`First ${sample.rows.length} rows:`);
        out.push(...sampleLines(sample, sampleCols));
      }
    }
    return out.join("\n");
  };
  for (const [columns, sampleCols] of [
    [60, 12],
    [30, 10],
    [16, 8],
    [8, 6],
    [4, 4],
  ] as const) {
    const text = build(columns, sampleCols);
    if (text.length <= options.maxChars) return text;
  }
  return `${build(2, 3).slice(0, Math.max(0, options.maxChars - 1))}…`;
}

/** The summary appended to the user's prompt for an attached dataset (≤ 4 KB). */
export function promptSummary(
  detail: DatasetDetailWire,
  samples: Map<string, SampleRows>,
  options: { dashboard?: boolean } = {},
): string {
  return `[Attached ${describeDataset(detail, samples, { maxChars: 3900, dashboard: options.dashboard === true })}]`;
}
