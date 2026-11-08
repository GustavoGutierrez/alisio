/**
 * Host side of the print protocol (spec 026 D7): a `DocumentEngine` that asks the Electron main
 * process to print a render bundle in a hidden window. The bundle is copied under the print root
 * that main created (main only ever reads inside it), and the PDF comes back as a file there.
 */
import { randomUUID } from "node:crypto";
import { cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type DocumentEngine,
  DocumentError,
  type EngineCapabilities,
  type Readiness,
  type RenderJob,
  type RenderOutput,
} from "@alisio/core";
import { type PrintRequest, type PrintResult, parsePrintResult } from "./print-protocol.ts";

export interface PrintChannel {
  send(message: PrintRequest | { type: "print-cancel"; id: string }): void;
  /** Subscribes to raw messages from main; returns the unsubscribe function. */
  onMessage(callback: (raw: unknown) => void): () => void;
}

export interface PrintEngineOptions {
  channel: PrintChannel;
  /** Directory main created for print jobs (`ALISIO_PRINT_ROOT`). */
  printRoot: string;
  /** Shown in the status, e.g. "Electron 45.2.3 (Chromium 156.0.8078.80)". */
  version: string;
  /** Extra time main gets beyond the job timeout before the host gives up (default 5 s). */
  graceMs?: number;
}

const CAPABILITIES: EngineCapabilities = {
  runningHeaders: false,
  footnotes: false,
  tocPageNumbers: "two-pass",
  outline: false,
  tagged: true,
  domMeasurements: true,
};

export class ElectronPrintEngine implements DocumentEngine {
  readonly id = "electron" as const;
  readonly capabilities = CAPABILITIES;
  private readonly options: PrintEngineOptions;

  constructor(options: PrintEngineOptions) {
    this.options = options;
  }

  async readiness(): Promise<Readiness> {
    return { ready: true, version: this.options.version };
  }

  async render(job: RenderJob, signal: AbortSignal): Promise<RenderOutput> {
    if (signal.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    const { channel, printRoot } = this.options;
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    const dir = join(printRoot, id);
    try {
      await cp(job.bundleDir, dir, { recursive: true });
      const request: PrintRequest = {
        type: "print",
        id,
        bundleDir: dir,
        entry: job.entry,
        options: {
          contentWidthMm: job.contentWidthMm,
          tagged: job.wantTagged,
          measure: job.measure,
          timeoutMs: job.timeoutMs,
        },
      };
      const result = await new Promise<PrintResult>((resolve, reject) => {
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          off();
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        const off = channel.onMessage((raw) => {
          const parsed = parsePrintResult(raw);
          if (parsed && parsed.id === id) finish(() => resolve(parsed));
        });
        const timer = setTimeout(
          () =>
            finish(() => {
              channel.send({ type: "print-cancel", id });
              reject(
                new DocumentError(
                  "DOCUMENT_RENDER_TIMEOUT",
                  `Render exceeded ${Math.round(job.timeoutMs / 1000)} s`,
                ),
              );
            }),
          job.timeoutMs + (this.options.graceMs ?? 5_000),
        );
        const onAbort = () =>
          finish(() => {
            channel.send({ type: "print-cancel", id });
            reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
          });
        signal.addEventListener("abort", onAbort, { once: true });
        channel.send(request);
      });
      if (!result.ok)
        throw new DocumentError(
          result.error.startsWith("timeout") ? "DOCUMENT_RENDER_TIMEOUT" : "DOCUMENT_RENDER_FAILED",
          `The desktop engine failed to render the document: ${result.error}`,
        );
      const pdf = new Uint8Array(await readFile(join(dir, "out.pdf")));
      return {
        pdf,
        ...(result.measurements ? { measurements: result.measurements } : {}),
        engineVersion: this.options.version,
        log: [],
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async dispose(): Promise<void> {}
}
