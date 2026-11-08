import { describe, expect, it } from "vitest";
import {
  contrast,
  ensureContrast,
  mix,
  normalizeHex,
  resolveBrand,
} from "../packages/core/src/documents/brand.ts";

describe("brand colors", () => {
  it("normalizes 3 and 6 digit hex values and rejects anything else", () => {
    expect(normalizeHex("#ABC", "accent")).toBe("#aabbcc");
    expect(normalizeHex("1D4F91", "accent")).toBe("#1d4f91");
    for (const bad of ["red", "#12", "#12345g", "url(x)", "#1d4f91;}"])
      expect(() => normalizeHex(bad, "accent")).toThrow(/hex color/);
  });

  it("keeps a colour that already has 4.5:1 and darkens one that does not, with a warning", () => {
    const good = resolveBrand({ accent: "#1d4f91" }, "#ffffff");
    expect(good).toMatchObject({ accent: "#1d4f91", warnings: [] });
    const weak = resolveBrand({ accent: "#ffcc00", ink: "#999999" }, "#ffffff");
    expect(weak.warnings.map((w) => w.code)).toEqual(["accent_adjusted", "ink_adjusted"]);
    expect(contrast(weak.accent as string, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(weak.ink as string, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("returns nothing for inputs that were not given and mixes colours", () => {
    expect(resolveBrand({}, "#ffffff")).toEqual({ warnings: [] });
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(ensureContrast("#ffffff", "#ffffff").adjusted).toBe(true);
  });
});
