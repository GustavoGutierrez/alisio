/**
 * `chromium` adapter (spec 026 §5.6.2): a system Chromium-family browser driven over CDP. The
 * network is off: every request is intercepted; only `https://document.invalid/<path>` is served,
 * from the render bundle (path normalized and contained). One browser is kept alive for
 * `idleBrowserMs` (D19) and killed on abort or timeout.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { DOCUMENT_LIMITS, DocumentError } from "../../limits.ts";
import type {
  DocumentEngine,
  DomMeasurements,
  EngineCapabilities,
  Readiness,
  RenderJob,
  RenderOutput,
} from "../../ports.ts";
import { type BrowserProcess, type CdpEvent, launchBrowser } from "./cdp.ts";
import { type DetectDeps, detectBrowser, installAdvice } from "./detect.ts";

const ORIGIN = "https://document.invalid/";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export const MIN_CHROME_MAJOR = 131;

export const CHROMIUM_CAPABILITIES: EngineCapabilities = {
  runningHeaders: false,
  footnotes: false,
  tocPageNumbers: "two-pass",
  outline: false,
  tagged: true,
  domMeasurements: true,
};

/** Runs in an isolated world (works under a CSP without script-src, D-27). */
const MEASURE_SCRIPT = `(() => {
  const main = document.querySelector('main');
  const out = { overflow: [], lowDpi: [] };
  if (!main) return JSON.stringify(out);
  const box = main.getBoundingClientRect();
  for (const el of main.querySelectorAll('[data-b]')) {
    if (el.parentElement !== main) continue;
    let worst = 0;
    for (const n of [el, ...el.querySelectorAll('*')]) worst = Math.max(worst, n.getBoundingClientRect().right - box.right);
    const sw = el.scrollWidth - el.clientWidth;
    if (worst > 1 || sw > 1) out.overflow.push({ block: Number(el.getAttribute('data-b')), tag: el.tagName.toLowerCase(), overflowPx: Math.round(Math.max(worst, sw)) });
  }
  for (const img of document.images) {
    const w = img.getBoundingClientRect().width / 96;
    if (w > 0 && img.naturalWidth > 0) { const dpi = Math.round(img.naturalWidth / w); if (dpi < 150) out.lowDpi.push({ src: img.getAttribute('src') || '', dpi }); }
  }
  return JSON.stringify(out);
})()`;

export interface ChromiumOptions {
  /** `documents.chromiumPath`. */
  explicitPath?: string | undefined;
  /** Parent of the browser profile directories (`<state>/documents/tmp`). */
  tmpRoot: string;
  transport?: "auto" | "pipe" | "port";
  idleMs?: number;
  detect?: Partial<DetectDeps>;
}

const withDeadline = <T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

export class ChromiumEngine implements DocumentEngine {
  readonly id = "chromium" as const;
  readonly capabilities = CHROMIUM_CAPABILITIES;
  private browser: Promise<BrowserProcess> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private active = 0;
  private cachedReadiness: Readiness | undefined;
  private executable: string | undefined;

  private readonly options: ChromiumOptions;

  constructor(options: ChromiumOptions) {
    this.options = options;
  }

  async readiness(signal: AbortSignal): Promise<Readiness> {
    if (this.cachedReadiness?.ready) return this.cachedReadiness;
    const found = await detectBrowser({
      ...this.options.detect,
      explicit: this.options.explicitPath,
    });
    if (!found.path) {
      return {
        ready: false,
        reason: found.detail ?? "No Chromium-family browser was found",
        fix: installAdvice(this.options.detect?.platform),
      };
    }
    const version = await new Promise<string>((resolve) => {
      const child = execFile(
        found.path as string,
        ["--version"],
        { timeout: 15_000 },
        (err, stdout) => resolve(err ? "" : stdout.trim()),
      );
      signal.addEventListener("abort", () => child.kill(), { once: true });
    });
    const major = Number(/(\d+)\.\d+\.\d+\.\d+/.exec(version)?.[1] ?? 0);
    if (!version || major < MIN_CHROME_MAJOR)
      return {
        ready: false,
        reason: version
          ? `${version} is older than Chromium ${MIN_CHROME_MAJOR} (page margin boxes are required)`
          : "The browser did not report its version",
        fix: `Update the browser to version ${MIN_CHROME_MAJOR} or newer. ${installAdvice(this.options.detect?.platform)}`,
      };
    this.executable = found.path;
    this.cachedReadiness = { ready: true, version };
    return this.cachedReadiness;
  }

  private async getBrowser(): Promise<BrowserProcess> {
    clearTimeout(this.idle);
    if (!this.browser) {
      if (!this.executable) {
        const found = await detectBrowser({
          ...this.options.detect,
          explicit: this.options.explicitPath,
        });
        this.executable = found.path;
      }
      if (!this.executable)
        throw new DocumentError(
          "DOCUMENT_ENGINE_UNAVAILABLE",
          "No Chromium-family browser was found",
        );
      await mkdir(this.options.tmpRoot, { recursive: true, mode: 0o700 });
      const profileDir = join(
        this.options.tmpRoot,
        `browser-${process.pid}-${Date.now().toString(36)}`,
      );
      const launching = launchBrowser({
        executable: this.executable,
        profileDir,
        transport: this.options.transport ?? "auto",
      });
      this.browser = launching;
      launching
        .then(
          (b) => void b.exited.then(() => this.browser === launching && (this.browser = undefined)),
        )
        .catch(() => this.browser === launching && (this.browser = undefined));
    }
    return this.browser;
  }

  private async killBrowser() {
    clearTimeout(this.idle);
    const current = this.browser;
    this.browser = undefined;
    if (current) await current.then((b) => b.kill()).catch(() => {});
  }

  private scheduleIdle() {
    clearTimeout(this.idle);
    if (this.active > 0 || !this.browser) return;
    this.idle = setTimeout(
      () => void this.killBrowser(),
      this.options.idleMs ?? DOCUMENT_LIMITS.idleBrowserMs,
    );
    this.idle.unref?.();
  }

  async render(job: RenderJob, signal: AbortSignal): Promise<RenderOutput> {
    if (signal.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    this.active++;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void this.killBrowser();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await withDeadline(this.renderInner(job), job.timeoutMs, () => {
        void this.killBrowser();
        return new DocumentError(
          "DOCUMENT_RENDER_TIMEOUT",
          `Render exceeded ${job.timeoutMs / 1000} s`,
        );
      });
    } catch (error) {
      if (aborted || signal.aborted)
        throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
      if (error instanceof DocumentError) throw error;
      // A dead browser (crash) is dropped so the next render starts a fresh one.
      void this.killBrowser();
      throw new DocumentError(
        "DOCUMENT_RENDER_FAILED",
        `The browser failed to render the document: ${(error as Error).message}`,
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.active--;
      this.scheduleIdle();
    }
  }

  private async renderInner(job: RenderJob): Promise<RenderOutput> {
    const browser = await this.getBrowser();
    const conn = browser.connection;
    const log: string[] = [];
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    try {
      const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const send = <T = any>(m: string, p: Record<string, unknown> = {}) =>
        conn.send<T>(m, p, sessionId);
      const root = normalize(job.bundleDir);
      let loadFired: () => void = () => {};
      const loaded = new Promise<void>((r) => {
        loadFired = r;
      });
      conn.on((e: CdpEvent) => {
        if (e.sessionId !== sessionId) return;
        if (e.method === "Page.loadEventFired") loadFired();
        if (e.method !== "Fetch.requestPaused") return;
        const { requestId, request } = e.params as { requestId: string; request: { url: string } };
        void (async () => {
          const fail = (why: string) => {
            log.push(`blocked ${why}`);
            return send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(
              () => {},
            );
          };
          if (!request.url.startsWith(ORIGIN)) return fail(request.url.slice(0, 80));
          let rel: string;
          try {
            rel = normalize(decodeURIComponent(new URL(request.url).pathname.slice(1)));
          } catch {
            return fail("malformed url");
          }
          const full = join(root, rel);
          if (rel.startsWith("..") || !full.startsWith(root + sep)) return fail(`path ${rel}`);
          try {
            if (!(await stat(full)).isFile()) return fail(`path ${rel}`);
            const body = (await readFile(full)).toString("base64");
            await send("Fetch.fulfillRequest", {
              requestId,
              responseCode: 200,
              responseHeaders: [
                {
                  name: "Content-Type",
                  value: MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
                },
              ],
              body,
            }).catch(() => {});
          } catch {
            await fail(`missing ${rel}`);
          }
        })();
      });
      await send("Page.enable");
      await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await send("Emulation.setEmulatedMedia", { media: "print" });
      await send("Page.navigate", { url: `${ORIGIN}${job.entry}` });
      await loaded;
      await send("Runtime.evaluate", {
        expression:
          "Promise.all([document.fonts.ready, ...Array.from(document.images).map((i) => i.decode().catch(() => {}))]).then(() => true)",
        awaitPromise: true,
      });

      let measurements: DomMeasurements | undefined;
      if (job.measure) {
        try {
          const widthPx = Math.max(300, Math.round((job.contentWidthMm * 96) / 25.4));
          await send("Emulation.setDeviceMetricsOverride", {
            width: widthPx,
            height: 1400,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const frame = await send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
          const world = await send<{ executionContextId: number }>("Page.createIsolatedWorld", {
            frameId: frame.frameTree.frame.id,
            worldName: "alisio-measure",
          });
          const res = await send<{ result?: { value?: string } }>("Runtime.evaluate", {
            expression: MEASURE_SCRIPT,
            contextId: world.executionContextId,
            returnByValue: true,
          });
          if (res.result?.value) measurements = JSON.parse(res.result.value) as DomMeasurements;
        } catch (error) {
          log.push(`measurement skipped: ${(error as Error).message}`);
        } finally {
          await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
        }
      }

      const print = async (tagged: boolean) => {
        const r = await send<{ stream: string }>("Page.printToPDF", {
          preferCSSPageSize: true,
          printBackground: true,
          generateTaggedPDF: tagged,
          transferMode: "ReturnAsStream",
        });
        const chunks: Buffer[] = [];
        for (;;) {
          const c = await send<{ data: string; base64Encoded?: boolean; eof: boolean }>("IO.read", {
            handle: r.stream,
            size: 4 << 20,
          });
          chunks.push(Buffer.from(c.data, c.base64Encoded ? "base64" : "utf8"));
          if (c.eof) break;
        }
        await send("IO.close", { handle: r.stream }).catch(() => {});
        return Buffer.concat(chunks);
      };
      let pdf: Buffer;
      try {
        pdf = await print(job.wantTagged);
      } catch (error) {
        if (!job.wantTagged || !/param|invalid|unknown/i.test((error as Error).message))
          throw error;
        log.push("tagged PDF not supported by this browser; printed untagged");
        pdf = await print(false);
      }
      const version = await conn
        .send<{ product?: string }>("Browser.getVersion")
        .catch(() => ({}) as { product?: string });
      return {
        pdf,
        ...(measurements ? { measurements } : {}),
        engineVersion: version.product ?? "Chromium",
        log,
      };
    } finally {
      await conn.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    await this.killBrowser();
  }
}
