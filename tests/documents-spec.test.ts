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
