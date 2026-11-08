import { describe, expect, it } from "vitest";
import { markdownToSpec } from "../packages/core/src/documents/markdown.ts";
import { inline, plain } from "../packages/core/src/documents/render-html.ts";

describe("markdownToSpec (DOC-AC-06)", () => {
  it("maps headings, lists, tables, quotes, code and images; h4+ become level 3", () => {
    const r = markdownToSpec(
      [
        "# One",
        "#### Deep",
        "- a",
        "  - nested",
        "- b",
        "",
        "| x | y |",
        "|:--|--:|",
        "| 1 | 2 |",
        "",
        "> quoted",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "",
        "![chart](img/c.png)",
        "",
        "---pagebreak---",
      ].join("\n"),
      { cover: false },
    );
    const types = r.spec.blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading",
      "heading",
      "bullets",
      "table",
      "quote",
      "code",
      "image",
      "page_break",
    ]);
    expect(r.spec.blocks[1]).toMatchObject({ level: 3 });
    expect(r.spec.blocks[2]).toMatchObject({ items: [{ text: "a", items: ["nested"] }, "b"] });
    expect(r.spec.blocks[3]).toMatchObject({
      columns: [
        { label: "x", align: "left" },
        { label: "y", align: "right" },
      ],
      rows: [["1", "2"]],
    });
    expect(r.spec.blocks[5]).toMatchObject({ language: "ts" });
    expect(r.assets).toEqual([{ id: "img1", href: "img/c.png", alt: "chart" }]);
  });

  it("builds a cover and a toc from front matter and reads theme and lang", () => {
    const r = markdownToSpec(
      "---\ntitle: Report\nauthor: Ana\ntheme: data-report\nlang: es\ntoc: true\n---\n# H",
    );
    expect(r.spec.blocks.map((b) => b.type)).toEqual(["cover", "toc", "heading"]);
    expect(r.spec.blocks[0]).toMatchObject({ title: "Report", meta: ["Ana"] });
    expect(r.theme).toBe("data-report");
    expect(r.lang).toBe("es");
  });

  it("turns GitHub alerts into callouts", () => {
    const r = markdownToSpec("> [!WARNING]\n> careful");
    expect(r.spec.blocks[0]).toMatchObject({ type: "callout", tone: "warning", text: "careful" });
  });

  it("skips remote images with a warning and keeps the alt text (DOC-AC-07)", () => {
    const r = markdownToSpec("![logo](https://evil.test/a.png)\n\n![x](file:///etc/passwd)");
    expect(r.assets).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(["remote_image_skipped", "remote_image_skipped"]);
    expect(r.spec.blocks[0]).toMatchObject({ type: "paragraph", text: "logo" });
  });

  it("rejects Markdown above the size limit", () => {
    expect(() => markdownToSpec("a".repeat(400 * 1024 + 1))).toThrow(/DOCUMENT_LIMIT|larger/);
  });
});

describe("cover without front matter", () => {
  const manual = [
    "# Manual de Marca",
    "",
    "**Versión:** 2.1",
    "**Fecha**: 8 de noviembre de 2026",
    "**Subtítulo:** Identidad visual y verbal",
    "",
    "## 01. Resumen ejecutivo",
    "",
    "Texto.",
  ].join("\n");

  it("derives the cover from the first H1 and the bold Key: value lines under it", () => {
    const r = markdownToSpec(manual);
    expect(r.spec.blocks.map((b) => b.type)).toEqual(["cover", "heading", "paragraph"]);
    expect(r.spec.blocks[0]).toEqual({
      type: "cover",
      title: "Manual de Marca",
      subtitle: "Identidad visual y verbal",
      meta: ["Versión: 2.1", "Fecha: 8 de noviembre de 2026"],
    });
    expect(r.spec.meta?.title).toBe("Manual de Marca");
    expect(r.spec.blocks[1]).toMatchObject({
      type: "heading",
      level: 2,
      text: "01. Resumen ejecutivo",
    });
  });

  it("makes a cover from the H1 alone and treats a lone bold line as the subtitle", () => {
    expect(markdownToSpec("# Solo título\n\nTexto").spec.blocks[0]).toEqual({
      type: "cover",
      title: "Solo título",
    });
    expect(markdownToSpec("# T\n\n**Un lema**\n\nTexto").spec.blocks[0]).toMatchObject({
      subtitle: "Un lema",
    });
  });

  it("takes the logo from front matter or from the first image right after the H1 (or its details)", () => {
    const fm = markdownToSpec("---\ntitle: T\nlogo: assets/mark.svg\n---\n# H\n\nTexto");
    expect(fm.assets).toEqual([{ id: "logo", href: "assets/mark.svg", alt: "" }]);
    expect(fm.spec.blocks[0]).toMatchObject({ type: "cover", logoAsset: "logo" });
    const afterH1 = markdownToSpec("# T\n\n![Mark](a/m.svg)\n\n**Versión:** 1\n\nTexto");
    expect(afterH1.assets).toEqual([{ id: "logo", href: "a/m.svg", alt: "Mark" }]);
    expect(afterH1.spec.blocks.map((b) => b.type)).toEqual(["cover", "paragraph"]);
    expect(afterH1.spec.blocks[0]).toMatchObject({ logoAsset: "logo", meta: ["Versión: 1"] });
    const afterMeta = markdownToSpec("# T\n\n**Versión:** 1\n\n![Mark](m.png)\n\nTexto");
    expect(afterMeta.spec.blocks[0]).toMatchObject({ logoAsset: "logo" });
    const late = markdownToSpec("# T\n\nUn párrafo.\n\n![Mark](m.png)");
    expect(late.spec.blocks.map((b) => b.type)).toEqual(["cover", "paragraph", "image"]);
  });

  it("keeps ordinary paragraphs under the title as body", () => {
    const r = markdownToSpec("# T\n\nUn párrafo normal con **énfasis**.\n");
    expect(r.spec.blocks.map((b) => b.type)).toEqual(["cover", "paragraph"]);
  });

  it("makes no cover when the document does not start with an H1, or when cover is disabled", () => {
    expect(markdownToSpec("Intro\n\n# T").spec.blocks[0]?.type).toBe("paragraph");
    expect(markdownToSpec(manual, { cover: false }).spec.blocks[0]).toMatchObject({
      type: "heading",
      level: 1,
    });
    expect(
      markdownToSpec("---\ntitle: X\ncover: false\n---\n# H").spec.blocks.map((b) => b.type),
    ).toEqual(["heading"]);
    expect(
      markdownToSpec("---\ntitle: X\n---\n# H", { cover: false }).spec.blocks.map((b) => b.type),
    ).toEqual(["heading"]);
  });

  it("reads brand colors from front matter", () => {
    const r = markdownToSpec("---\ntitle: X\naccent: '#c2410c'\nink: '#222222'\n---\n# H");
    expect(r).toMatchObject({ accent: "#c2410c", ink: "#222222" });
  });
});

describe("inline rendering (DOC-AC-02, DOC-AC-03)", () => {
  it("escapes raw HTML and never emits a tag from the input", () => {
    const html = inline("<script>alert(1)</script> <img src=x onerror=alert(1)> **ok**");
    expect(html).not.toMatch(/<script|<img|onerror=[^&]*>/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>ok</strong>");
  });

  it("renders only http, https and mailto links as links", () => {
    expect(inline("[a](https://x.test)")).toContain('<a href="https://x.test">');
    expect(inline("[a](mailto:a@b.co)")).toContain("<a ");
    for (const href of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "vbscript:x",
    ])
      expect(inline(`[a](${href})`)).toBe("a");
  });

  it("flattens inline Markdown to plain text", () => {
    expect(plain("**Bold** and `code` [link](https://x.test)")).toBe("Bold and code link");
  });
});
