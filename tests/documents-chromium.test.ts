/**
 * Real system browser (env flag ALISIO_TEST_CHROMIUM=1, optional ALISIO_TEST_CHROMIUM_PATH):
 * DOC-AC-11 (corpus on the three themes and page variants), DOC-AC-12 (network off), DOC-AC-17.
 */

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
