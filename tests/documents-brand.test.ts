import { describe, expect, it } from "vitest";
import {
  contrast,
  ensureContrast,
  mix,
  normalizeHex,
  resolveBrand,
} from "../packages/core/src/documents/brand.ts";
import { loadManifest, themeIds, tokensCss } from "../packages/core/src/documents/themes.ts";

describe("brand colors", () => {
  it("normalizes 3 and 6 digit hex values and rejects anything else", () => {
    expect(normalizeHex("#ABC", "accent")).toBe("#aabbcc");
    expect(normalizeHex("1D4F91", "accent")).toBe("#1d4f91");
    for (const bad of ["red", "#12", "#12345g", "url(x)", "#1d4f91;}"])
      expect(() => normalizeHex(bad, "accent")).toThrow(/hex color/);
  });

  it("keeps a colour that already has 4.5:1 and darkens one that does not, with a warning", () => {
    const good = resolveBrand({ accent: "#1d4f91" }, "#ffffff");
    expect(good).toMatchObject({ accent: "#1d4f91", accentText: "#1d4f91", warnings: [] });
    const weak = resolveBrand({ accent: "#ffcc00", ink: "#999999" }, "#ffffff");
    expect(weak.warnings.map((w) => w.code)).toEqual(["accent_adjusted", "ink_adjusted"]);
    expect(weak.accent).toBe("#ffcc00");
    expect(contrast(weak.accentText as string, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(weak.ink as string, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("returns nothing for inputs that were not given and mixes colours", () => {
    expect(resolveBrand({}, "#ffffff")).toEqual({ warnings: [] });
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(ensureContrast("#ffffff", "#ffffff").adjusted).toBe(true);
  });
});

describe("tokensCss readable pairs (table heads, tones)", () => {
  const vars = (css: string) =>
    Object.fromEntries([...css.matchAll(/--([\w-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]));
  const accents = ["#ffd400", "#f2a900", "#80b5ff", "#0b6e6a", "#1d4f91", "#7a7a7a", "#ffffff"];

  it("keeps header text, header fill and tone labels at 4.5:1 for any accent in every theme", async () => {
    for (const id of await themeIds()) {
      const manifest = await loadManifest(id);
      for (const accent of [undefined, ...accents]) {
        const brand = accent ? resolveBrand({ accent }, manifest.tokens.colors.paper) : undefined;
        const v = vars(tokensCss(manifest, { size: "A4", orientation: "portrait" }, brand));
        const at = `${id} ${accent ?? "default"}`;
        expect(
          contrast(v["th-solid-fg"] as string, v["th-solid-bg"] as string),
          at,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(v["th-tint-fg"] as string, v["th-tint-bg"] as string),
          at,
        ).toBeGreaterThanOrEqual(4.5);
        for (const tone of ["info", "success", "warning", "danger"])
          expect(
            contrast(v[`${tone}-text`] as string, v[`${tone}-bg`] as string),
            `${at} ${tone}`,
          ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("uses dark text on a light accent header instead of white", async () => {
    const manifest = await loadManifest("data-report");
    const brand = resolveBrand({ accent: "#ffd400" }, manifest.tokens.colors.paper);
    const v = vars(tokensCss(manifest, { size: "A4", orientation: "portrait" }, brand));
    expect(v["th-solid-bg"]).toBe("#ffd400");
    expect(v["th-solid-fg"]).not.toBe("#ffffff");
  });
});
