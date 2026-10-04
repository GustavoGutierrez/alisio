/** Builders for the Smart Dashboard tests: hand-made sheet details, with no dataset on disk. */
import type { DatasetColumnWire, DatasetDetailWire } from "@alisio/sdk";

export type SheetDetail = DatasetDetailWire["sheetDetails"][number];

/** A column wire with sensible defaults; `rows` is applied by `sheet()` for `distinct`. */
export function column(
  name: string,
  type: string,
  extra: Partial<DatasetColumnWire> = {},
): DatasetColumnWire {
  return {
    name,
    label: extra.label ?? name,
    type,
    nulls: 0,
    distinct: 10,
    distinctExact: true,
    textFallbacks: 0,
    top: [],
    ...extra,
  };
}

export function sheet(
  columns: DatasetColumnWire[],
  options: { rows?: number; table?: string } = {},
): SheetDetail {
  return {
    name: options.table ?? "data",
    table: options.table ?? "data",
    rows: options.rows ?? 100,
    columns,
  };
}

/** A sales-like sheet: id, date, three dimensions of different width, four measures. */
export function salesSheet(): SheetDetail {
  const date = (name: string) =>
    column(name, "date", { distinct: 365, min: "2024-01-01", max: "2024-12-31" });
  const num = (name: string, type = "real") =>
    column(name, type, { distinct: 900, min: "1", max: "9999" });
  return sheet(
    [
      column("order_id", "text", { distinct: 1000 }),
      date("order_date"),
      column("region", "text", { distinct: 5, label: "Region" }),
      column("channel", "text", { distinct: 3, label: "Channel" }),
      column("product", "text", { distinct: 20, label: "Product" }),
      num("sales", "real"),
      num("profit", "real"),
      num("unit_price", "real"),
      column("units", "integer", { distinct: 15, min: "1", max: "30" }),
    ],
    { rows: 1000 },
  );
}
