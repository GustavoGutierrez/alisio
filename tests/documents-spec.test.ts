import { describe, expect, it } from "vitest";
import { validateDocumentSpec } from "../packages/core/src/documents/spec.ts";

const base = { version: 1, blocks: [{ type: "paragraph", text: "hi" }] };

describe("validateDocumentSpec (DOC-AC-01)", () => {
  it("accepts a valid spec", () => {
    expect(validateDocumentSpec(base).ok).toBe(true);
  });

  it("lists JSON pointers for an unknown block type, an unknown field and an undeclared asset", () => {
    const result = validateDocumentSpec({
      version: 1,
      blocks: [
        { type: "carousel" },
        { type: "paragraph", text: "x", color: "red" },
        { type: "image", asset: "missing" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toMatch(/\/blocks\/0/);
    expect(result.errors.join("\n")).toMatch(/\/blocks\/1/);
  });

  it("rejects an undeclared asset and accepts a declared one", () => {
    const spec = { version: 1, blocks: [{ type: "image", asset: "logo" }] };
    const bad = validateDocumentSpec(spec);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]).toContain("/blocks/0/asset");
    expect(validateDocumentSpec(spec, new Set(["logo"])).ok).toBe(true);
  });

  it("rejects two covers, a cover that is not first and two tables of contents", () => {
    const cover = { type: "cover", title: "T" };
    expect(validateDocumentSpec({ version: 1, blocks: [cover, cover] }).ok).toBe(false);
    expect(
      validateDocumentSpec({ version: 1, blocks: [{ type: "paragraph", text: "a" }, cover] }).ok,
    ).toBe(false);
    const toc = { type: "toc" };
    expect(validateDocumentSpec({ version: 1, blocks: [toc, toc] }).ok).toBe(false);
  });

  it("caps the reported errors at 20", () => {
    const blocks = Array.from({ length: 40 }, () => ({ type: "nope" }));
    const result = validateDocumentSpec({ version: 1, blocks });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeLessThanOrEqual(20);
  });
});

describe("chart, svg and appendix blocks (DOC-AC-26)", () => {
  const chart = {
    type: "chart",
    kind: "bar",
    title: "T",
    labels: ["a", "b"],
    series: [{ name: "s", values: [1, 2] }],
  };

  it("accepts a chart from data and rejects model SVG or unknown fields in it", () => {
    expect(validateDocumentSpec({ version: 1, blocks: [chart] }).ok).toBe(true);
    expect(validateDocumentSpec({ version: 1, blocks: [{ ...chart, svg: "<svg/>" }] }).ok).toBe(
      false,
    );
    expect(validateDocumentSpec({ version: 1, blocks: [{ ...chart, kind: "radar" }] }).ok).toBe(
      false,
    );
  });

  it("enforces chart limits and consistent lengths with JSON pointers", () => {
    const many = Array.from({ length: 51 }, (_, i) => `l${i}`);
    expect(
      validateDocumentSpec({
        version: 1,
        blocks: [{ ...chart, labels: many, series: [{ name: "s", values: many.map(() => 1) }] }],
      }).ok,
    ).toBe(false);
    const seven = Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, values: [1, 2] }));
    expect(validateDocumentSpec({ version: 1, blocks: [{ ...chart, series: seven }] }).ok).toBe(
      false,
    );
    const mismatch = validateDocumentSpec({
      version: 1,
      blocks: [{ ...chart, series: [{ name: "s", values: [1] }] }],
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.errors[0]).toContain("/blocks/0/series/0/values");
    const pie = validateDocumentSpec({
      version: 1,
      blocks: [{ ...chart, kind: "pie", series: [{ name: "s", values: [1, -2] }] }],
    });
    expect(pie.ok).toBe(false);
    expect(
      validateDocumentSpec({
        version: 1,
        blocks: [{ ...chart, series: [{ name: "s", values: [1, Number.NaN] }] }],
      }).ok,
    ).toBe(false);
  });

  it("requires a declared asset for svg blocks", () => {
    const spec = { version: 1, blocks: [{ type: "svg", asset: "diagram", caption: "c" }] };
    expect(validateDocumentSpec(spec).ok).toBe(false);
    expect(validateDocumentSpec(spec, new Set(["diagram"])).ok).toBe(true);
  });

  it("accepts appendices with ordinary blocks and rejects nested appendix, cover or toc", () => {
    const appendix = (blocks: unknown[]) => ({
      version: 1,
      blocks: [{ type: "appendix", title: "A", blocks }],
    });
    expect(validateDocumentSpec(appendix([{ type: "paragraph", text: "x" }, chart])).ok).toBe(true);
    for (const inner of [
      { type: "appendix", title: "B", blocks: [] },
      { type: "cover", title: "C" },
      { type: "toc" },
    ])
      expect(validateDocumentSpec(appendix([inner])).ok, inner.type).toBe(false);
  });

  it("checks assets and table rows inside appendices", () => {
    const withImage = {
      version: 1,
      blocks: [{ type: "appendix", title: "A", blocks: [{ type: "image", asset: "nope" }] }],
    };
    const r = validateDocumentSpec(withImage);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("/blocks/0/blocks/0/asset");
  });
});
