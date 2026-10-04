import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  type ProfiledColumn,
  profileSheet,
} from "../packages/core/src/analysis/dashboard/index.ts";
import { column, sheet } from "./dashboard-helpers.ts";

const measure = (name: string, extra: Parameters<typeof column>[2] = {}) =>
  column(name, "real", { distinct: 90, min: "1", max: "9", ...extra });
const dimension = (name: string, distinct: number, extra: Parameters<typeof column>[2] = {}) =>
  column(name, "text", { distinct, ...extra });
const time = (name: string, extra: Parameters<typeof column>[2] = {}) =>
  column(name, "date", { distinct: 90, min: "2024-01-01", max: "2024-12-31", ...extra });

function candidatesOf(...columns: ReturnType<typeof column>[]) {
  return buildCandidates(profileSheet(sheet(columns, { rows: 1000 })));
}
const names = (list: ProfiledColumn[]) => list.map((c) => c.name);

describe("dashboard candidates", () => {
  it("splits columns by role and ignores identifiers, booleans and unknowns", () => {
    const c = candidatesOf(
      column("order_id", "text", { distinct: 1000 }),
      time("order_date"),
      dimension("region", 5),
      measure("amount"),
      column("active", "boolean", { distinct: 2 }),
      column("empty", "text", { nulls: 1000, distinct: 0 }),
    );
    expect(names(c.time)).toEqual(["order_date"]);
    expect(names(c.dimensions)).toEqual(["region"]);
    expect(names(c.measures)).toEqual(["amount"]);
  });

  it("caps the shortlists at 8 measures, 8 dimensions and 4 time columns", () => {
    const c = candidatesOf(
      ...Array.from({ length: 12 }, (_, i) => measure(`m${i}`)),
      ...Array.from({ length: 12 }, (_, i) => dimension(`d${i}`, 5)),
      ...Array.from({ length: 6 }, (_, i) => time(`t${i}`)),
    );
    expect([c.measures.length, c.dimensions.length, c.time.length]).toEqual([8, 8, 4]);
  });

  it("ranks measures by score (magnitude hint up, negative hint down) and breaks ties by ordinal", () => {
    const c = candidatesOf(
      measure("plain_b"),
      measure("latitude"),
      measure("sales_total"),
      measure("plain_a"),
      measure("flat", { min: "5", max: "5" }),
    );
    expect(names(c.measures)).toEqual(["sales_total", "plain_b", "plain_a", "flat", "latitude"]);
  });

  it("ranks dimensions: 3-12 values beat 13-30, hints help, very high cardinality sinks", () => {
    const c = candidatesOf(
      dimension("big", 150),
      dimension("mid", 20),
      dimension("small", 5),
      dimension("region", 20),
    );
    expect(names(c.dimensions)).toEqual(["region", "small", "mid", "big"]);
  });

  it("ranks time columns by hint and span, and prefers fewer nulls", () => {
    const c = candidatesOf(
      time("short", { min: "2024-01-01", max: "2024-01-31" }),
      time("order_date"),
      time("gappy", { nulls: 500 }),
    );
    expect(names(c.time)).toEqual(["order_date", "short", "gappy"]);
  });

  it("composition dimensions are the shortlisted ones with 2 to 8 values", () => {
    const c = candidatesOf(
      dimension("flag", 2),
      dimension("region", 6),
      dimension("city", 50),
      dimension("tier", 9),
    );
    expect(names(c.compositionDims).sort()).toEqual(["flag", "region"]);
  });

  it("is deterministic: the same sheet gives the same order every time", () => {
    const columns = [
      ...Array.from({ length: 10 }, (_, i) => measure(`m${i}`)),
      ...Array.from({ length: 10 }, (_, i) => dimension(`d${i}`, 5)),
    ];
    const first = candidatesOf(...columns);
    for (let i = 0; i < 3; i++) expect(candidatesOf(...columns)).toEqual(first);
    expect(names(first.measures)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
  });

  it("returns empty lists for a sheet without usable columns", () => {
    expect(candidatesOf(column("id", "text", { distinct: 1000 }))).toEqual({
      measures: [],
      dimensions: [],
      time: [],
      compositionDims: [],
    });
  });
});
