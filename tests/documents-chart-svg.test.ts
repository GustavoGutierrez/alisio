import { describe, expect, it } from "vitest";
import { chartSvg, niceScale } from "../packages/core/src/documents/chart-svg.ts";
import { sanitizeSvg } from "../packages/core/src/documents/svg-sanitize.ts";

const base = { labels: ["Q1", "Q2", "Q3"], series: [{ name: "Sales", values: [10, 25, 18] }] };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("niceScale", () => {
  it("rounds the axis to readable steps and includes zero", () => {
    expect(niceScale(0, 23)).toEqual({ min: 0, max: 25, step: 5 });
    expect(niceScale(3, 940)).toMatchObject({ min: 0, max: 1000 });
    expect(niceScale(-4, 12)).toMatchObject({ min: -5, max: 15 });
    expect(niceScale(0, 0)).toMatchObject({ min: 0, max: 1 });
  });
});

describe("chartSvg (spec 026 chart block)", () => {
  it("draws one bar per value with classed series and survives the SVG sanitizer unchanged", () => {
    const svg = chartSvg({ kind: "bar", title: "Ventas", ...base });
    expect(count(svg, /<rect class="bar s0"/g)).toBe(3);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Ventas"');
    const clean = sanitizeSvg(svg);
    expect(clean.ok).toBe(true);
  });

  it("groups bars per series and adds a legend for several series", () => {
    const svg = chartSvg({
      kind: "bar",
      ...base,
      series: [...base.series, { name: "Costs", values: [5, 9, 7] }],
    });
    expect(count(svg, /class="bar s1"/g)).toBe(3);
    expect(svg).toContain(">Costs<");
    expect(svg).toContain('class="legend-key s1"');
  });

  it("draws lines with points and pies from the first series with percentages", () => {
    const line = chartSvg({ kind: "line", ...base });
    expect(line).toContain('<polyline class="line s0"');
    expect(count(line, /<circle class="dot s0"/g)).toBe(3);
    const pie = chartSvg({ kind: "pie", ...base });
    expect(count(pie, /<path class="slice s\d"/g)).toBe(3);
    expect(pie).toMatch(/19\s?%|19,\d\s?%/);
    expect(sanitizeSvg(pie).ok).toBe(true);
  });

  it("escapes every label and never emits markup, style attributes or links", () => {
    const svg = chartSvg({
      kind: "bar",
      title: '<script>alert(1)</script>"',
      labels: ["<img src=x onerror=1>", "b", "c"],
      series: [{ name: "</text><script>", values: [1, 2, 3] }],
      unit: "<b>%</b>",
    });
    expect(svg).not.toMatch(/<script|<img|<b>|style=|href=/);
    expect(sanitizeSvg(svg).ok).toBe(true);
  });

  it("rejects mismatched lengths, non-finite values, negative pies and out-of-range sizes", () => {
    expect(() =>
      chartSvg({ kind: "bar", labels: ["a"], series: [{ name: "s", values: [1, 2] }] }),
    ).toThrow(/values/);
    expect(() =>
      chartSvg({ kind: "bar", labels: ["a"], series: [{ name: "s", values: [Number.NaN] }] }),
    ).toThrow(/finite/);
    expect(() =>
      chartSvg({ kind: "pie", labels: ["a", "b"], series: [{ name: "s", values: [1, -1] }] }),
    ).toThrow(/pie/);
    expect(() =>
      chartSvg({ kind: "pie", labels: ["a"], series: [{ name: "s", values: [0] }] }),
    ).toThrow(/pie/);
    expect(() => chartSvg({ kind: "bar", labels: [], series: [] })).toThrow();
  });

  it("formats numbers with the document language and the unit", () => {
    const svg = chartSvg({
      kind: "bar",
      ...base,
      series: [{ name: "s", values: [1200, 2500, 1800] }],
      unit: "€",
      lang: "es",
    });
    expect(svg).toContain("€");
    expect(svg).toMatch(/1\.200|1200/);
  });
});
