import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, writeBundle } from "../packages/core/src/documents/render-html.ts";
import type { DocumentSpec } from "../packages/core/src/documents/spec.ts";
import {
  ASSETS_ROOT,
  loadBaseCss,
  loadCatalog,
  loadFontsCss,
  loadTheme,
} from "../packages/core/src/documents/themes.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-doc-html-"));
  await mkdir(dir, { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const spec: DocumentSpec = {
  version: 1,
  meta: { title: "T", organization: "Org" },
  blocks: [
    { type: "cover", title: "T <b>x</b>", subtitle: "s" },
    { type: "toc" },
    { type: "heading", level: 1, text: "Intro" },
    {
      type: "paragraph",
      text: "<script>alert(1)</script> <img src=x onerror=alert(1)> [a](javascript:alert(1))",
    },
    { type: "table", columns: [{ label: "A" }], rows: [["<i>1</i>"]] },
    { type: "callout", tone: "info", text: "<iframe src=x>" },
    { type: "code", text: "</pre><script>1</script>" },
  ],
};

describe("render bundle (DOC-AC-02, DOC-AC-08)", () => {
  it("has no script, handler, form or frame from the input, a strict CSP and only virtual-origin URLs", async () => {
    const out = await writeBundle(spec, new Map(), dir, {
      theme: "executive-clean",
      page: { size: "A4", orientation: "portrait" },
    });
    const html = await readFile(join(dir, out.entry), "utf8");
    expect(html).not.toMatch(
      /<script|<iframe|<object|<embed|<form|<[a-z][^>]*\son\w+=|href=\"javascript:/i,
    );
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src 'none'");
    for (const m of html.matchAll(/(?:href|src)="([^"#]+)"/g))
      expect(m[1]).toMatch(/^https:\/\/document\.invalid\//);
    expect(html).toContain("&lt;script&gt;");
    const css = await readFile(join(dir, "css/fonts.css"), "utf8");
    for (const m of css.matchAll(/url\("([^"]+)"\)/g)) {
      expect(m[1]?.startsWith(ORIGIN)).toBe(true);
      const rel = (m[1] as string).slice(ORIGIN.length);
      await expect(readFile(join(dir, rel))).resolves.toBeInstanceOf(Buffer);
    }
    expect((await readdir(join(dir, "fonts"))).sort()).toEqual([
      "inter",
      "jetbrains-mono",
      "source-serif-4",
    ]);
  });

  it("links the table of contents to the heading ids and localizes its title", async () => {
    await writeBundle(spec, new Map(), dir, {
      theme: "technical-spec",
      page: { size: "Letter", orientation: "landscape" },
      lang: "es",
    });
    const html = await readFile(join(dir, "index.html"), "utf8");
    expect(html).toContain('href="#h-2"');
    expect(html).toContain('id="h-2"');
    expect(html).toContain("Índice");
    expect(html).toContain('<html lang="es">');
    const page = await readFile(join(dir, "css/page.css"), "utf8");
    expect(page).toContain("size: 279.4mm 215.9mm");
  });

  it("falls back to the default language for malformed tags", async () => {
    await writeBundle(spec, new Map(), dir, {
      theme: "executive-clean",
      page: { size: "A4", orientation: "portrait" },
      lang: '"><x',
    });
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain('<html lang="en">');
  });
});

describe("numbering, placeholders and brand colors", () => {
  const page = { size: "A4", orientation: "portrait" } as const;
  const doc = (headings: string[]): DocumentSpec => ({
    version: 1,
    blocks: headings.map((text) => ({ type: "heading" as const, level: 2 as const, text })),
  });
  const bodyOf = async (headings: string[], theme = "technical-spec") => {
    await writeBundle(doc(headings), new Map(), dir, { theme, page });
    return readFile(join(dir, "index.html"), "utf8");
  };

  it("numbers headings automatically only when none of them is numbered already", async () => {
    expect(await bodyOf(["Historia", "Origen"])).toContain("auto-number");
    for (const numbered of [
      ["02. Historia", "Origen"],
      ["Historia", "2.1 Origen"],
      ["3. Cierre", "Más"],
    ])
      expect(await bodyOf(numbered)).not.toContain("auto-number");
    expect(await bodyOf(["Historia"], "executive-clean")).not.toContain("auto-number");
  });

  it("prints a small placeholder with the alt text for a skipped image", async () => {
    const spec: DocumentSpec = {
      version: 1,
      blocks: [{ type: "image", asset: "logo", caption: "Fig. 1" }],
    };
    await writeBundle(spec, new Map(), dir, {
      theme: "executive-clean",
      page,
      skippedAssets: new Map([["logo", "Logo <b>"]]),
    });
    const html = await readFile(join(dir, "index.html"), "utf8");
    expect(html).toContain('class="img placeholder"');
    expect(html).toContain("Logo &lt;b&gt;");
    expect(html).not.toMatch(/<img [^>]*src=""/);
  });

  it("applies the brand accent and ink through CSS custom properties, with derived shades", async () => {
    await writeBundle(doc(["A"]), new Map(), dir, {
      theme: "executive-clean",
      page,
      brand: { accent: "#b45309", ink: "#1a1a1a", warnings: [] },
    });
    const tokens = await readFile(join(dir, "css/tokens.css"), "utf8");
    expect(tokens).toContain("--accent: #b45309;");
    expect(tokens).toContain("--ink: #1a1a1a;");
    expect(tokens).toContain("--heading: #1a1a1a;");
    expect(tokens).toMatch(/--accent-dark: #[0-9a-f]{6};/);
    expect(tokens).toMatch(/--accent-tint: #[0-9a-f]{6};/);
    expect(tokens).toContain("--info-bar: #b45309;");
    expect(tokens).toMatch(/--cover-bg: #[0-9a-f]{6};/);
    expect(tokens).not.toContain("--cover-bg: #0f2342");
  });

  it("keeps the theme's own colors without a brand", async () => {
    await writeBundle(doc(["A"]), new Map(), dir, { theme: "executive-clean", page });
    const tokens = await readFile(join(dir, "css/tokens.css"), "utf8");
    expect(tokens).toContain("--accent: #1d4f91;");
    expect(tokens).toContain("--cover-bg: #0f2342;");
  });
});

describe("theme contracts (spec §5.4, D10)", () => {
  const lum = (hex: string) => {
    const c = [1, 3, 5]
      .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return ((hi as number) + 0.05) / ((lo as number) + 0.05);
  };

  it("ships the three Phase 1 themes with 4.5:1 text contrast on paper", async () => {
    const catalog = await loadCatalog();
    expect(catalog.map((t) => t.id)).toEqual(["data-report", "executive-clean", "technical-spec"]);
    for (const t of catalog) {
      const c = t.tokens.colors;
      for (const ink of [c.ink, c.heading, c.muted, c.accent])
        expect(ratio(ink, c.paper)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c.coverInk, c.coverBg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c.coverMuted, c.coverBg)).toBeGreaterThanOrEqual(4.5);
      for (const tone of Object.values(c.tones))
        expect(ratio(c.ink, tone.bg)).toBeGreaterThanOrEqual(4.5);
      expect(t.pageSizes).toEqual(expect.arrayContaining(["A4", "Letter"]));
    }
  });

  it("uses only bundled families and no local() source", async () => {
    const files = [await loadBaseCss(), await loadFontsCss()];
    for (const id of ["executive-clean", "data-report", "technical-spec"]) {
      const t = await loadTheme(id);
      files.push(t.css, JSON.stringify(t.manifest.tokens.type));
    }
    const all = files.join("\n");
    expect(all).not.toMatch(/local\(/);
    const families = new Set(
      [...all.matchAll(/font-family:\s*([^;}]+)/g)]
        .flatMap((m) => (m[1] as string).split(","))
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter((s) => !s.startsWith("var(")),
    );
    for (const f of families)
      expect([
        "Inter",
        "Source Serif 4",
        "JetBrains Mono",
        "sans-serif",
        "serif",
        "monospace",
      ]).toContain(f);
    expect(await readFile(`${ASSETS_ROOT}fonts/inter/OFL.txt`, "utf8")).toMatch(
      /Open Font License/,
    );
  });
});
