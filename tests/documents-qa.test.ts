import { describe, expect, it } from "vitest";
import { scan } from "../packages/core/src/documents/pdf-scan.ts";
import { analyzeOutput, checkText } from "../packages/core/src/documents/qa.ts";
import { nextRepair } from "../packages/core/src/documents/repair.ts";
import { makePdf } from "./documents-helpers.ts";

describe("checkText (DOC-AC-14)", () => {
  it("reports uncovered codepoints with sample characters and the unsupported script", async () => {
    const { findings } = await checkText({ text: "Hola 你好 مرحبا" });
    const f = findings.find((x) => x.code === "glyphs_missing");
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("你");
    expect(f?.message).toMatch(/CJK/);
    expect(f?.message).toMatch(/Arabic/);
  });

  it("accepts Spanish, Greek and Cyrillic text", async () => {
    const { findings } = await checkText({ a: "Año, niño, ¿qué? éÉñÑ ü € “ ” — α β Привет" });
    expect(findings.map((f) => f.code)).not.toContain("glyphs_missing");
  });

  it("returns the uncovered scripts and a sample for the later font warning", async () => {
    const r = await checkText({ text: "Hola 你好" });
    expect(r.uncovered?.scripts.join()).toMatch(/CJK/);
    expect(r.uncovered?.sample).toContain("你");
    expect((await checkText({ text: "Hola" })).uncovered).toBeUndefined();
  });

  it("removes emoji with a warning and substitutes symbols missing from the fonts", async () => {
    const { value, findings } = await checkText({ text: "Listo 😀 → ≤ ✓ ‑" });
    expect(value.text).toBe("Listo  -> <= OK -");
    expect(findings.map((f) => f.code).sort()).toEqual(["emoji_removed", "symbols_substituted"]);
  });
});

describe("font_not_bundled message", () => {
  const scanOf = (o: Parameters<typeof makePdf>[0]) => scan(Buffer.from(makePdf(o)));
  const finding = (fonts: string[], uncovered?: { scripts: string[]; sample: string }) =>
    analyzeOutput(scanOf({ fonts }), undefined, {
      overflowChecked: true,
      ...(uncovered ? { uncovered } : {}),
    }).find((f) => f.code === "font_not_bundled");

  it("names the uncovered script and says a system fallback font was used", () => {
    const f = finding(["AAAAAA+NotoSansCJK"], {
      scripts: ["CJK (Chinese, Japanese, Korean)"],
      sample: "你 好",
    });
    expect(f?.severity).toBe("error");
    expect(f?.message).toContain("CJK");
    expect(f?.message).toContain("你 好");
    expect(f?.message).toMatch(/system fallback font/);
    expect(f?.message).toContain("NotoSansCJK");
  });

  it("says 'a system fallback font' instead of an empty name for nameless fallbacks", () => {
    const base = scanOf({});
    for (const name of ["(none)", "  "]) {
      const nameless = { ...base, fonts: [{ name, embedded: true }] };
      const f = analyzeOutput(nameless, undefined, { overflowChecked: true }).find(
        (x) => x.code === "font_not_bundled",
      );
      expect(f?.message).toContain("a system fallback font");
      expect(f?.message).not.toContain("(none)");
      expect(f?.message).not.toMatch(/: \.|, \.|, ,/);
    }
  });
});

describe("analyzeOutput and repair (DOC-AC-15)", () => {
  const scanOf = (o: Parameters<typeof makePdf>[0]) => scan(Buffer.from(makePdf(o)));

  it("flags fonts that are not bundled, a blank last page and the page limit", () => {
    const codes = (o: Parameters<typeof makePdf>[0]) =>
      analyzeOutput(scanOf(o), undefined, { overflowChecked: true }).map((f) => f.code);
    expect(codes({ fonts: ["AAAAAA+DejaVuSans"] })).toContain("font_not_bundled");
    expect(codes({ pages: 3, textOps: [40, 40, 4] })).toContain("blank_trailing_page");
    expect(codes({ pages: 201 })).toContain("page_limit");
    expect(codes({ pages: 2 })).toEqual([]);
  });

  it("maps overflow to landscape, then compact density, then nothing; never rotates a locked page", () => {
    const spec = {
      version: 1 as const,
      blocks: [{ type: "table" as const, columns: [{ label: "a" }], rows: [["1"]] }],
    };
    const findings = analyzeOutput(
      scanOf({}),
      { overflow: [{ block: 0, tag: "div", overflowPx: 80 }], lowDpi: [] },
      { overflowChecked: true },
    );
    const state = {
      spec,
      hints: {},
      page: { size: "A4" as const, orientation: "portrait" as const },
      orientationLocked: false,
    };
    const first = nextRepair(findings, state);
    expect(first?.action).toBe("page switched to landscape");
    const second = first && nextRepair(findings, first.state);
    expect(second?.action).toBe("tables set to compact density");
    expect(second && nextRepair(findings, second.state)).toBeUndefined();
    const locked = nextRepair(findings, { ...state, orientationLocked: true });
    expect(locked?.action).toBe("tables set to compact density");
  });

  it("removes trailing page breaks for a blank last page", () => {
    const spec = {
      version: 1 as const,
      blocks: [{ type: "paragraph" as const, text: "a" }, { type: "page_break" as const }],
    };
    const findings = [{ code: "blank_trailing_page", severity: "warning" as const, message: "" }];
    const step = nextRepair(findings, {
      spec,
      hints: {},
      page: { size: "A4", orientation: "portrait" },
      orientationLocked: false,
    });
    expect(step?.state.spec.blocks).toHaveLength(1);
  });
});
