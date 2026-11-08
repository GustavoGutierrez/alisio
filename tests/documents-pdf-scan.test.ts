import { describe, expect, it } from "vitest";
import { isBundledFontName, scan } from "../packages/core/src/documents/pdf-scan.ts";
import { makePdf } from "./documents-helpers.ts";

describe("pdf-scan (DOC-AC-13)", () => {
  it("reads page count, embedded font names and text operators", () => {
    const pdf = makePdf({
      pages: 3,
      fonts: ["AAAAAA+Inter-Regular", "BAAAAA+SourceSerif4-Bold"],
      textOps: [40, 25, 2],
    });
    const result = scan(Buffer.from(pdf));
    expect(result.pages).toBe(3);
    expect(result.fonts.map((f) => f.name).sort()).toEqual(["Inter-Regular", "SourceSerif4-Bold"]);
    expect(result.fonts.every((f) => f.embedded)).toBe(true);
    expect(result.textOpsPerPage).toEqual([40, 25, 2]);
    expect(result.tagged).toBe(false);
  });

  it("recognizes the bundled families after normalizing subset prefixes and engine spellings", () => {
    for (const name of [
      "AAAAAA+Inter-SemiBold",
      "Source-Serif-4,",
      "BAAAAA+SourceSerif4-Italic",
      "JetBrains-Mono",
      "JetBrainsMono-Regular",
    ])
      expect(isBundledFontName(name)).toBe(true);
    for (const name of ["DejaVuSans", "AAAAAA+Roboto-Regular", "Type3", "(none)"])
      expect(isBundledFontName(name)).toBe(false);
  });

  it("throws on bytes that are not a PDF", () => {
    expect(() => scan(Buffer.from("hello"))).toThrow();
  });
});
