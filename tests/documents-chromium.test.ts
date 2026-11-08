/**
 * Real system browser (env flag ALISIO_TEST_CHROMIUM=1, optional ALISIO_TEST_CHROMIUM_PATH):
 * DOC-AC-11 (corpus on the three themes and page variants), DOC-AC-12 (network off), DOC-AC-17.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDocument } from "../packages/core/src/documents/create.ts";
import { ChromiumEngine } from "../packages/core/src/documents/engines/chromium/adapter.ts";
import { scan } from "../packages/core/src/documents/pdf-scan.ts";

const enabled = process.env.ALISIO_TEST_CHROMIUM === "1";
const MD = [
  "---\ntitle: Informe de prueba\nsubtitle: Corpus del motor\nauthor: QA\ndate: 2026\ntoc: true\nlang: es\n---",
  "# Introducción\n\nTexto con acentos, ñ, € y **negrita**.\n\n> [!NOTE]\n> Una nota.\n",
  "## Datos\n\n| a | b | c |\n|:--|--:|--:|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n",
  "```js\nconst x = 1;\n```\n\n- uno\n  - dos\n- tres\n\n---pagebreak---\n\n# Cierre\n\nFin.",
].join("\n");

describe.skipIf(!enabled)("chromium adapter", () => {
  let root: string;
  let engine: ChromiumEngine;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "alisio-doc-chrome-"));
    engine = new ChromiumEngine({
      tmpRoot: join(root, "tmp"),
      explicitPath: process.env.ALISIO_TEST_CHROMIUM_PATH,
    });
  });
  afterEach(async () => {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const deps = (signal = new AbortController().signal) => ({
    tmpRoot: join(root, "tmp"),
    engines: () => [engine],
    settings: { engine: "auto" as const, defaultPageSize: "A4" as const },
    assets: { workspaceRoot: root, trusted: true },
    publishFile: async (source: string) => {
      await copyFile(source, join(root, "out.pdf"));
      return {
        artifact: { id: "a", fileName: "o.pdf", title: "t", bytes: 1 } as never,
        path: source,
        warnings: [],
      };
    },
    publishHtml: async () => {
      throw new Error("unexpected");
    },
    signal,
  });

  it.each(["executive-clean", "data-report", "technical-spec"])(
    "DOC-AC-11: %s renders with no QA error on every page variant",
    async (theme) => {
      for (const page of [
        { size: "A4" },
        { size: "Letter" },
        { size: "A4", orientation: "landscape" },
        { size: "Letter", orientation: "landscape" },
      ] as const) {
        const r = await createDocument({ markdown: MD, theme, page }, deps());
        expect(r.info.qa.passed, JSON.stringify(r.info.qa.warnings)).toBe(true);
        const buffer = readFileSync(join(root, "out.pdf"));
        expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
        const s = scan(buffer);
        expect(s.pages).toBe(r.info.qa.pageCount);
        expect(r.info.qa.warnings.map((w) => w.code)).not.toContain("font_not_bundled");
        expect(r.info.engine.id).toBe("chromium");
      }
    },
    60_000,
  );

  it("DOC-AC-23: the contents carry the real page of every heading", async () => {
    const filler = "Texto de relleno. ".repeat(60);
    const md = [
      "---\ntitle: Informe\ntoc: true\n---",
      ...Array.from({ length: 6 }, (_, i) => `# Sección ${i + 1}\n\n${`${filler}\n\n`.repeat(7)}`),
    ].join("\n");
    const r = await createDocument({ markdown: md }, deps());
    expect(r.info.degraded.map((d) => d.feature)).not.toContain("toc_page_numbers");
    const s = scan(readFileSync(join(root, "out.pdf")));
    const pages = s.links.map((l) => l.page);
    expect(pages.length).toBe(6);
    expect(pages.every((p) => typeof p === "number" && p >= 3)).toBe(true);
    const text = execFileSync("pdftotext", ["-layout", join(root, "out.pdf"), "-"], {
      encoding: "utf8",
    }).split("\f");
    const toc = text[1] ?? "";
    for (const [i, p] of pages.entries())
      expect(toc, `section ${i + 1}`).toMatch(new RegExp(`Sección ${i + 1}\\s+${p}\\b`));
    expect(text[(pages[0] as number) - 1]).toContain("Sección 1");
  }, 60_000);

  it("DOC-AC-24: a sanitized SVG logo renders on the cover with the network off", async () => {
    await writeFile(
      join(root, "mark.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10" fill="#cc5500"/></svg>',
    );
    const r = await createDocument(
      {
        markdown: "---\ntitle: Informe\nlogo: mark.svg\n---\n# Uno\n\nTexto",
        theme: { accent: "#cc5500", ink: "#223355" },
      },
      deps(),
    );
    expect(r.info.qa.warnings.map((w) => w.code)).not.toContain("image_skipped");
    expect(r.info.qa.warnings.map((w) => w.code)).not.toContain("low_resolution_image");
    expect(r.info.qa.passed).toBe(true);
  }, 60_000);

  it("DOC-AC-26: charts, svg blocks and appendices render with bundled fonts only", async () => {
    await writeFile(
      join(root, "d.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#336699"/></svg>',
    );
    const spec = {
      version: 1,
      meta: { title: "Informe" },
      blocks: [
        { type: "cover", title: "Informe" },
        { type: "toc" },
        { type: "heading", level: 1, text: "Resultados" },
        {
          type: "chart",
          kind: "bar",
          title: "Ventas",
          labels: ["Ene", "Feb", "Mar"],
          series: [
            { name: "2026", values: [10, 25, 18] },
            { name: "2025", values: [8, 20, 21] },
          ],
          unit: "k€",
        },
        {
          type: "chart",
          kind: "line",
          labels: ["a", "b", "c", "d"],
          series: [{ name: "s", values: [1, 3, 2, 5] }],
        },
        {
          type: "chart",
          kind: "pie",
          title: "Reparto",
          labels: ["A", "B", "C"],
          series: [{ name: "s", values: [5, 3, 2] }],
        },
        { type: "svg", asset: "d", caption: "Diagrama" },
        {
          type: "appendix",
          title: "Anexo A",
          blocks: [
            { type: "heading", level: 2, text: "Detalle" },
            { type: "paragraph", text: "Texto del anexo." },
          ],
        },
      ],
    };
    const r = await createDocument(
      { spec, assets: [{ id: "d", path: "d.svg" }], lang: "es" },
      deps(),
    );
    expect(r.info.qa.passed, JSON.stringify(r.info.qa.warnings)).toBe(true);
    expect(r.info.qa.warnings.map((w) => w.code)).not.toContain("font_not_bundled");
    expect(r.info.degraded.map((d) => d.feature)).not.toContain("toc_page_numbers");
    const text = execFileSync("pdftotext", [join(root, "out.pdf"), "-"], { encoding: "utf8" });
    expect(text).toContain("Anexo A");
    expect(text).toContain("Ene");
  }, 60_000);

  it("DOC-AC-12: external requests fail and no connection is attempted", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end("x");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const bundle = join(root, "bundle");
    await mkdir(bundle, { recursive: true });
    await writeFile(
      join(bundle, "index.html"),
      `<!doctype html><html><head><link rel="stylesheet" href="http://127.0.0.1:${port}/a.css"></head><body><img src="http://127.0.0.1:${port}/i.png"><img src="https://example.com/i.png"><p>hello</p><img src="file:///etc/hostname"></body></html>`,
    );
    const out = await engine.render(
      {
        bundleDir: bundle,
        entry: "index.html",
        page: { size: "A4", orientation: "portrait" },
        timeoutMs: 30_000,
        wantTagged: false,
        measure: false,
        contentWidthMm: 160,
      },
      new AbortController().signal,
    );
    server.close();
    expect(hits).toBe(0);
    expect(out.log.filter((l) => l.startsWith("blocked")).length).toBeGreaterThanOrEqual(3);
    expect(Buffer.from(out.pdf).subarray(0, 5).toString()).toBe("%PDF-");
  }, 60_000);

  it("DOC-AC-17: abort and timeout kill the browser and remove its profile", async () => {
    const controller = new AbortController();
    const pending = createDocument({ markdown: MD }, deps(controller.signal));
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 500));
    expect(await readdir(join(root, "tmp")).catch(() => [])).toEqual([]);
    const bundle = join(root, "b2");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, "index.html"), "<html><body>x</body></html>");
    await expect(
      engine.render(
        {
          bundleDir: bundle,
          entry: "index.html",
          page: { size: "A4", orientation: "portrait" },
          timeoutMs: 1,
          wantTagged: false,
          measure: false,
          contentWidthMm: 160,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_RENDER_TIMEOUT" });
  }, 60_000);
});
