/** Real Electron print (env flag ALISIO_TEST_ELECTRON=1; needs the Electron binary of apps/desktop). */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markdownToSpec } from "../packages/core/src/documents/markdown.ts";
import { scan } from "../packages/core/src/documents/pdf-scan.ts";
import { writeBundle } from "../packages/core/src/documents/render-html.ts";

const enabled = process.env.ALISIO_TEST_ELECTRON === "1";
const electron = (): string => {
  const path = createRequire(join(import.meta.dirname, "..", "apps", "desktop", "package.json"))(
    "electron",
  ) as string;
  if (!existsSync(path)) throw new Error("Electron binary is not installed");
  return path;
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-print-electron-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function printBundle(dir: string, entry = "index.html") {
  const job = {
    id: "job1",
    bundleDir: dir,
    entry,
    options: { contentWidthMm: 158, tagged: true, measure: true, timeoutMs: 30_000 },
  };
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      electron(),
      [
        "--ozone-platform=headless",
        "--no-sandbox",
        "--experimental-strip-types",
        join(import.meta.dirname, "fixtures", "desktop-print-main.mjs"),
      ],
      {
        env: { ...process.env, PRINT_JOB: JSON.stringify(job) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let text = "";
    child.stdout.on("data", (d) => {
      text += d;
    });
    child.stderr.on("data", (d) => {
      text += d;
    });
    child.once("error", reject);
    child.once("exit", () => resolve(text));
  });
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`no result:\n${out.slice(-2000)}`);
  return JSON.parse(line.slice(7));
}

describe.skipIf(!enabled)("electron print service", () => {
  it("prints a bundle to a tagged PDF with measurements and a sanitized SVG, network off", async () => {
    let hits = 0;
    const server = createServer((_q, r) => {
      hits++;
      r.end("x");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const dir = join(root, "bundle");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(
      join(dir, "assets", "logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 10"><rect width="40" height="10" fill="#336699"/></svg>',
    );
    const md = markdownToSpec(
      "---\ntitle: Informe\ntoc: true\n---\n# Uno\n\nTexto con ñ y € [x](https://example.com).\n\n| a | b |\n|--|--|\n| 1 | 2 |",
    );
    await writeBundle(md.spec, new Map(), dir, {
      theme: "executive-clean",
      page: { size: "A4", orientation: "portrait" },
      toc: { kind: "placeholder" },
    });
    // an extra page that tries to reach a local listener and a file
    await writeFile(
      join(dir, "probe.html"),
      `<!doctype html><link rel="stylesheet" href="http://127.0.0.1:${port}/a.css"><img src="http://127.0.0.1:${port}/i.png"><img src="file:///etc/hostname"><p>probe</p><img src="assets/logo.svg">`,
    );
    const result = await printBundle(dir);
    expect(result).toMatchObject({ ok: true });
    const pdf = await readFile(join(dir, "out.pdf"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const s = scan(pdf);
    expect(s.pages).toBeGreaterThanOrEqual(3);
    expect(s.tagged).toBe(true);
    expect(s.links.length).toBeGreaterThan(0);
    expect(result.measurements).toBeDefined();
    const probe = await printBundle(dir, "probe.html");
    expect(probe.ok).toBe(true);
    expect(hits).toBe(0);
    server.close();
    await copyFile(join(dir, "out.pdf"), join(root, "last.pdf"));
  }, 90_000);
});
