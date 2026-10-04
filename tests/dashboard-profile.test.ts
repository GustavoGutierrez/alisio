import { describe, expect, it } from "vitest";
import {
  cardinalityBucket,
  hintsOf,
  normalizeName,
  profileSheet,
} from "../packages/core/src/analysis/dashboard/index.ts";
import { column, sheet } from "./dashboard-helpers.ts";

function roleOf(c: ReturnType<typeof column>, rows = 100) {
  const [profiled] = profileSheet(sheet([c], { rows }));
  if (!profiled) throw new Error("no column");
  return profiled;
}

describe("dashboard hints", () => {
  it("normalizes names without accents or punctuation", () => {
    expect(normalizeName("Año Fiscal ($)")).toBe("ano_fiscal");
    expect(normalizeName("  Unit-Price  ")).toBe("unit_price");
  });

  it("recognises English and Spanish hints by whole word", () => {
    expect(hintsOf("sales_cop", "Sales COP").magnitude).toBe(true);
    expect(hintsOf("ventas_netas", "Ventas netas").magnitude).toBe(true);
    expect(hintsOf("latitude", "Latitude").negative).toBe(true);
    expect(hintsOf("region", "Región").dimension).toBe(true);
    expect(hintsOf("order_date", "Order date").time).toBe(true);
    expect(hintsOf("unit_price", "Unit price").average).toBe(true);
    // a substring is not a word: "salesforce" is not "sales"
    expect(hintsOf("salesforce", "Salesforce").magnitude).toBe(false);
  });
});

describe("dashboard cardinality buckets", () => {
  it("buckets by distinct count", () => {
    expect([2, 3, 8, 9, 30, 31, 200, 201].map(cardinalityBucket)).toEqual([
      "binary",
      "low",
      "low",
      "medium",
      "medium",
      "high",
      "high",
      "very-high",
    ]);
    expect(cardinalityBucket(1)).toBe("binary");
    expect(cardinalityBucket(0)).toBe("binary");
  });
});

describe("dashboard profile: roles (spec 6.1)", () => {
  it("1: an empty or almost all-null column is unknown, whatever its type", () => {
    expect(roleOf(column("a", "real", { nulls: 100, distinct: 0 })).role).toBe("unknown");
    expect(roleOf(column("b", "real", { nulls: 96, distinct: 4 })).role).toBe("unknown");
    expect(roleOf(column("c", "date", { nulls: 96, distinct: 4 })).role).toBe("unknown");
    expect(roleOf(column("d", "real", { nulls: 95, distinct: 5 })).role).toBe("measure");
  });

  it("2: ISO dates are time; their span comes from min/max", () => {
    const c = roleOf(column("order_date", "date", { min: "2024-01-01", max: "2024-12-31" }));
    expect(c.role).toBe("time");
    expect(c.span).toEqual({ days: 365 });
  });

  it("2: a date whose min/max cannot be parsed degrades to unknown", () => {
    expect(roleOf(column("d", "date", { min: "soon", max: "later" })).role).toBe("unknown");
    expect(roleOf(column("d", "date", {})).role).toBe("unknown");
  });

  it("2: timestamps with a space, a zone or fractions parse without depending on the local zone", () => {
    const c = roleOf(
      column("ts", "date", { min: "2024-01-01 00:00:00", max: "2024-01-31T00:00:00.500+00:00" }),
    );
    expect(c.span).toEqual({ days: 30 });
  });

  it("2: non-ISO dates stay text and become dimension or identifier, never time", () => {
    const c = roleOf(column("fecha", "text", { distinct: 20 }));
    expect(c.type).toBe("text");
    expect(c.role).toBe("dimension");
  });

  it("3: boolean columns", () => {
    expect(roleOf(column("active", "boolean", { distinct: 2 })).role).toBe("boolean");
  });

  it("4: an identifier by name needs a high distinct ratio", () => {
    expect(roleOf(column("order_id", "text", { distinct: 100 })).role).toBe("identifier");
    expect(roleOf(column("customer_id", "integer", { distinct: 60 })).role).toBe("identifier");
    expect(roleOf(column("sku", "text", { distinct: 50 })).role).toBe("identifier");
    // few distinct values: a code that repeats is a category
    expect(roleOf(column("country_code", "text", { distinct: 5 })).role).toBe("dimension");
  });

  it("5: a unique integer is a surrogate key once there are enough rows", () => {
    expect(roleOf(column("n", "integer", { distinct: 100 }), 100).role).toBe("identifier");
    expect(roleOf(column("n", "integer", { distinct: 15 }), 15).role).toBe("measure");
  });

  it("6: a low-cardinality integer is a dimension unless the name says magnitude", () => {
    expect(roleOf(column("quarter", "integer", { distinct: 4 })).role).toBe("dimension");
    expect(roleOf(column("rating", "integer", { distinct: 5 })).role).toBe("dimension");
    expect(roleOf(column("units", "integer", { distinct: 5 })).role).toBe("measure");
    expect(roleOf(column("cantidad", "integer", { distinct: 5 })).role).toBe("measure");
  });

  it("7: numbers with enough distinct values are measures", () => {
    expect(roleOf(column("amount", "real", { distinct: 90 })).role).toBe("measure");
    expect(roleOf(column("weight", "integer", { distinct: 40 })).role).toBe("measure");
  });

  it("7: an integer column with late text stays a measure (queries filter by typeof)", () => {
    const c = roleOf(column("amount", "integer", { distinct: 60, textFallbacks: 3 }));
    expect(c.role).toBe("measure");
  });

  it("8: free text with a high distinct ratio is an identifier", () => {
    expect(roleOf(column("comment", "text", { distinct: 95 }), 100).role).toBe("identifier");
  });

  it("9: text with a bounded number of values is a dimension", () => {
    expect(roleOf(column("region", "text", { distinct: 6 })).role).toBe("dimension");
    expect(roleOf(column("city", "text", { distinct: 200 }), 5000).role).toBe("dimension");
  });

  it("10: constant or very-high-cardinality text is unknown", () => {
    expect(roleOf(column("flag", "text", { distinct: 1 })).role).toBe("unknown");
    expect(roleOf(column("blob", "text", { distinct: 201 }), 5000).role).toBe("unknown");
  });

  it("derives ratios, bucket and an opaque alias per column in ordinal order", () => {
    const profiled = profileSheet(
      sheet(
        [column("a", "real", { nulls: 20, distinct: 40 }), column("b", "text", { distinct: 3 })],
        {
          rows: 100,
        },
      ),
    );
    expect(profiled.map((c) => c.alias)).toEqual(["c1", "c2"]);
    expect(profiled.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(profiled[0]?.nullRatio).toBeCloseTo(0.2);
    expect(profiled[0]?.distinctRatio).toBeCloseTo(0.5);
    expect(profiled[0]?.cardinality).toBe("high");
    expect(profiled[1]?.cardinality).toBe("low");
    expect(profiled[0]?.roleReason).toMatch(/\S/);
  });

  it("is a pure function of its input", () => {
    const input = sheet([
      column("a", "real", { distinct: 40 }),
      column("b", "text", { distinct: 3 }),
    ]);
    expect(profileSheet(input)).toEqual(profileSheet(structuredClone(input)));
  });
});
