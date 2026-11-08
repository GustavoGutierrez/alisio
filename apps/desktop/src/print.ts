/**
 * Print service of the Electron main process (spec 026 D7, D-27): prints a render bundle to PDF in
 * a hidden offscreen window. Each job has its own in-memory session whose `https` protocol serves
 * only `https://document.invalid/` from the job's bundle directory and whose request filter cancels
 * everything else, so the network is off. The page has no script (CSP); measurements run in an
 * isolated world.
 */
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { BrowserWindow, session } from "electron";
import { MEASURE_SCRIPT } from "./print-measure.ts";
import {
  PRINT_ORIGIN,
  type PrintMeasurements,
  type PrintRequest,
  type PrintResult,
  resolveBundleFile,
} from "./print-protocol.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};
const ISOLATED_WORLD = 1000;
const mmToPx = (mm: number) => Math.max(300, Math.round((mm * 96) / 25.4));

const WAIT_RESOURCES =
  "Promise.all([document.fonts.ready, ...Array.from(document.images).map((i) => i.decode().catch(() => {}))]).then(() => true)";

export interface Printer {
  print(request: PrintRequest): Promise<PrintResult>;
  cancel(id: string): void;
}

export function createPrinter(): Printer {
  const windows = new Map<string, BrowserWindow>();

  async function run(request: PrintRequest): Promise<PrintResult> {
    const { bundleDir, entry, options } = request;
    // A fresh non-persistent partition per job: handlers are bound to this bundle only.
    const ses = session.fromPartition(`alisio-print-${request.id}`);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.protocol.handle("https", async (req) => {
      const file = resolveBundleFile(bundleDir, req.url);
      if (!file) return new Response("", { status: 403 });
      try {
        return new Response(await readFile(file), {
          headers: {
            "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          },
        });
      } catch {
        return new Response("", { status: 404 });
      }
    });
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(PRINT_ORIGIN) }),
    );
    const widthPx = mmToPx(options.contentWidthMm);
    const win = new BrowserWindow({
      show: false,
      width: widthPx,
      height: 1400,
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: ses,
      },
    });
    windows.set(request.id, win);
    try {
      // Headless Electron reports innerWidth 1 until the content size is set explicitly (D-27).
      win.setContentSize(widthPx, 1400);
      await win.loadURL(`${PRINT_ORIGIN}${entry}`);
      const isolated = (code: string) =>
        win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]);
      await isolated(WAIT_RESOURCES);
      let measurements: PrintMeasurements | undefined;
      if (options.measure) {
        try {
          measurements = JSON.parse(String(await isolated(MEASURE_SCRIPT))) as PrintMeasurements;
        } catch {
          // Measurements are optional: the technical QA reports `overflow_not_checked`.
        }
      }
      const pdf = await win.webContents.printToPDF({
        preferCSSPageSize: true,
        printBackground: true,
        generateTaggedPDF: options.tagged,
      });
      await writeFile(join(bundleDir, "out.pdf"), pdf);
      return {
        type: "print-result",
        id: request.id,
        ok: true,
        pdfPath: join(bundleDir, "out.pdf"),
        ...(measurements ? { measurements } : {}),
      };
    } finally {
      windows.delete(request.id);
      if (!win.isDestroyed()) win.destroy();
      void ses.clearStorageData().catch(() => {});
    }
  }

  return {
    async print(request) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run(request),
          new Promise<PrintResult>((resolve) => {
            timer = setTimeout(() => {
              const win = windows.get(request.id);
              if (win && !win.isDestroyed()) win.destroy();
              resolve({ type: "print-result", id: request.id, ok: false, error: "timeout" });
            }, request.options.timeoutMs);
          }),
        ]);
      } catch (error) {
        return {
          type: "print-result",
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 500) : "print failed",
        };
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(id) {
      const win = windows.get(id);
      if (win && !win.isDestroyed()) win.destroy();
    },
  };
}
