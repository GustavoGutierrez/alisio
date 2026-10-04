import { describe, expect, it } from "vitest";
import { displayName, kpiLabel } from "../packages/core/src/analysis/dashboard/index.ts";

describe("displayName", () => {
  const cases: Array<[string, string | undefined, string]> = [
    // identifiers are humanized
    ["gross_sales_cop", "gross_sales_cop", "Gross sales (COP)"],
    ["unit_price_cop", undefined, "Unit price (COP)"],
    ["profit_margin_pct", "profit_margin_pct", "Profit margin (%)"],
    ["region", "region", "Region"],
    ["discount_amount_usd", "", "Discount amount (USD)"],
    ["fee_eur", undefined, "Fee (EUR)"],
    ["price_mxn", undefined, "Price (MXN)"],
    ["order-date", "order-date", "Order date"],
    ["customerRating", "customerRating", "Customer rating"],
    ["customerID", "customerID", "Customer ID"],
    ["q4_sales", undefined, "Q4 sales"],
    ["año_fiscal", undefined, "Año fiscal"],
    // a single unit word is not a suffix
    ["cop", "cop", "Cop"],
    ["pct", undefined, "Pct"],
    // the original header wins when it differs and reads like text
    ["gross_sales", "Gross Sales", "Gross Sales"],
    ["ventas_cop", "Ventas (COP)", "Ventas (COP)"],
    ["region", "Región", "Región"],
    // a header that still looks like an identifier is humanized
    ["gross_sales_cop", "Gross_Sales_COP", "Gross sales (COP)"],
    ["unitprice", "unitPrice", "Unit price"],
    // hostile or odd
    ["___", "___", "___"],
    ["", "", ""],
    ["a__b", undefined, "A b"],
    ["x_cop_", undefined, "X (COP)"],
    ["col\u0000umn_name", undefined, "Col umn name"],
  ];
  for (const [name, label, expected] of cases)
    it(`${JSON.stringify(name)} / ${JSON.stringify(label)} -> ${JSON.stringify(expected)}`, () => {
      expect(displayName(name, label)).toBe(expected);
    });

  it("clips a very long name", () => {
    expect(displayName("x".repeat(500)).length).toBeLessThanOrEqual(60);
    expect(displayName("ok", "y y".repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it("never returns an underscore for an identifier-like name", () => {
    for (const name of ["a_b_c", "total_cost_cop", "_leading", "trailing_"])
      expect(displayName(name)).not.toContain("_");
  });
});

describe("label templates with display names", () => {
  it("embed the display name in lowercase after a prefix", () => {
    expect(kpiLabel("en", "sum", "Gross sales (COP)")).toBe("Total gross sales (COP)");
    expect(kpiLabel("es", "avg", "Unit price (COP)")).toBe("Promedio de unit price (COP)");
    expect(kpiLabel("en", "sum", "GDP")).toBe("Total GDP");
  });
});
