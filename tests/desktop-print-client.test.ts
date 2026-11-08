import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElectronPrintEngine, type PrintChannel } from "../apps/desktop/src/print-client.ts";
import type { PrintRequest, PrintResult } from "../apps/desktop/src/print-protocol.ts";

let root: string;
let printRoot: string;
let bundle: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-print-client-"));
  printRoot = join(root, "print");
  bundle = join(root, "bundle");
  await mkdir(join(bundle, "css"), { recursive: true });
  await mkdir(printRoot, { recursive: true });
  await writeFile(join(bundle, "index.html"), "<html></html>");
  await writeFile(join(bundle, "css", "a.css"), "x");
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** A channel whose "main process" answers with `reply(request)`. */
function fakeChannel(
  reply: (r: PrintRequest) => PrintResult | undefined | Promise<PrintResult | undefined>,
) {
  const listeners = new Set<(raw: unknown) => void>();
  const sent: unknown[] = [];
  const channel: PrintChannel = {
    send(message) {
      sent.push(message);
      const request = message as PrintRequest;
      if (request.type !== "print") return;
      void Promise.resolve(reply(request)).then((answer) => {
        if (answer) for_(listeners, answer);
      });
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return { channel, sent, listeners };
}
const for_ = (set: Set<(raw: unknown) => void>, value: unknown) => {
  for (const cb of [...set]) cb(value);
};

const job = (over = {}) => ({
  bundleDir: bundle,
  entry: "index.html",
  page: { size: "A4" as const, orientation: "portrait" as const },
  timeoutMs: 5_000,
  wantTagged: true,
  measure: true,
  contentWidthMm: 158,
  ...over,
});

describe("ElectronPrintEngine (host side of the print protocol)", () => {
  it("is ready with the Chromium version main reported and exposes the engine capabilities", async () => {
    const { channel } = fakeChannel(() => undefined);
    const engine = new ElectronPrintEngine({
      channel,
      printRoot,
      version: "Electron 45 (Chromium 156)",
    });
    expect(engine.id).toBe("electron");
    expect(engine.capabilities).toMatchObject({
      tocPageNumbers: "two-pass",
      tagged: true,
      domMeasurements: true,
    });
    expect(await engine.readiness()).toEqual({
      ready: true,
      version: "Electron 45 (Chromium 156)",
    });
  });

  it("copies the bundle under the print root, asks main to print it and returns the PDF and measurements", async () => {
    let seen: PrintRequest | undefined;
    const { channel } = fakeChannel(async (request) => {
      seen = request;
      await writeFile(join(request.bundleDir, "out.pdf"), "%PDF-1.4 fake");
      return {
        type: "print-result",
        id: request.id,
        ok: true,
        pdfPath: join(request.bundleDir, "out.pdf"),
        measurements: { overflow: [{ block: 2, tag: "table", overflowPx: 40 }], lowDpi: [] },
      };
    });
    const engine = new ElectronPrintEngine({ channel, printRoot, version: "E" });
    const out = await engine.render(job(), new AbortController().signal);
    expect(Buffer.from(out.pdf).toString()).toBe("%PDF-1.4 fake");
    expect(out.measurements?.overflow[0]?.overflowPx).toBe(40);
    expect(out.engineVersion).toBe("E");
    expect(seen?.bundleDir.startsWith(printRoot)).toBe(true);
    expect(seen?.options).toMatchObject({
      contentWidthMm: 158,
      tagged: true,
      measure: true,
      timeoutMs: 5_000,
    });
    // the copy is removed afterwards
    await expect(stat(seen?.bundleDir as string)).rejects.toThrow();
    expect(await readFile(join(bundle, "index.html"), "utf8")).toBe("<html></html>");
  });

  it("maps an error answer, a missing channel answer (timeout) and an abort to document errors", async () => {
    const failing = fakeChannel((r) => ({
      type: "print-result",
      id: r.id,
      ok: false,
      error: "boom",
    }));
    const e1 = new ElectronPrintEngine({ channel: failing.channel, printRoot, version: "E" });
    await expect(e1.render(job(), new AbortController().signal)).rejects.toMatchObject({
      code: "DOCUMENT_RENDER_FAILED",
      message: expect.stringContaining("boom"),
    });

    const silent = fakeChannel(() => undefined);
    const e2 = new ElectronPrintEngine({
      channel: silent.channel,
      printRoot,
      version: "E",
      graceMs: 20,
    });
    await expect(
      e2.render(job({ timeoutMs: 30 }), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "DOCUMENT_RENDER_TIMEOUT",
    });
    expect(silent.listeners.size).toBe(0);

    const controller = new AbortController();
    const e3 = new ElectronPrintEngine({ channel: silent.channel, printRoot, version: "E" });
    const pending = e3.render(job(), controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(silent.sent.some((m) => (m as { type: string }).type === "print-cancel")).toBe(true);
  });

  it("ignores answers for other requests", async () => {
    const { channel, listeners } = fakeChannel(() => undefined);
    const engine = new ElectronPrintEngine({ channel, printRoot, version: "E", graceMs: 10 });
    const pending = engine.render(job({ timeoutMs: 80 }), new AbortController().signal);
    setTimeout(
      () => for_(listeners, { type: "print-result", id: "someone-else", ok: false, error: "no" }),
      10,
    );
    await expect(pending).rejects.toMatchObject({ code: "DOCUMENT_RENDER_TIMEOUT" });
  });
});
