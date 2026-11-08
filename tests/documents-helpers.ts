/** Shared helpers of the document engine tests: a tiny valid PDF and a fake engine. */
import type {
  DocumentEngine,
  DomMeasurements,
  EngineCapabilities,
  RenderJob,
  RenderOutput,
} from "../packages/core/src/documents/ports.ts";

/** A classic-xref PDF with `pages` pages, the given embedded font names and text operators per page. */
export function makePdf(
  options: { pages?: number; fonts?: string[]; textOps?: number[] } = {},
): Uint8Array {
  const pages = options.pages ?? 1;
  const fonts = options.fonts ?? ["AAAAAA+Inter-Regular"];
  const objects: string[] = [];
  const fontRefs = fonts.map((_, i) => 4 + pages * 2 + i);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] >>`;
  for (let i = 0; i < pages; i++) {
    const body = `BT ${"(x) Tj ".repeat(options.textOps?.[i] ?? 40)} ET`;
    objects[3 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R /Resources << /Font << ${fontRefs.map((r, k) => `/F${k} ${r} 0 R`).join(" ")} >> >> >>`;
    objects[4 + i * 2] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  }
  fonts.forEach((name, i) => {
    objects[fontRefs[i] as number] =
      `<< /Type /Font /Subtype /TrueType /BaseFont /${name} /FontDescriptor ${(fontRefs[i] as number) + fonts.length} 0 R >>`;
  });
  fonts.forEach((_, i) => {
    objects[(fontRefs[i] as number) + fonts.length] =
      "<< /Type /FontDescriptor /FontFile2 1 0 R >>";
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++)
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

export const FULL: EngineCapabilities = {
  runningHeaders: false,
  footnotes: false,
  tocPageNumbers: "two-pass",
  outline: false,
  tagged: true,
  domMeasurements: true,
};

export interface FakeEngineOptions {
  id?: DocumentEngine["id"];
  ready?: boolean;
  /** One entry per render call; the last repeats. */
  measurements?: Array<DomMeasurements | undefined>;
  pdf?: (call: number) => Uint8Array;
  delayMs?: number;
}

export class FakeEngine implements DocumentEngine {
  id: DocumentEngine["id"];
  capabilities = FULL;
  jobs: RenderJob[] = [];
  concurrent = 0;
  peak = 0;
  private readonly options: FakeEngineOptions;
  constructor(options: FakeEngineOptions = {}) {
    this.options = options;
    this.id = options.id ?? "chromium";
  }
  async readiness() {
    return this.options.ready === false
      ? ({ ready: false, reason: "no browser", fix: "install one" } as const)
      : ({ ready: true, version: "Fake/1" } as const);
  }
  async render(job: RenderJob, signal: AbortSignal): Promise<RenderOutput> {
    this.jobs.push(job);
    const call = this.jobs.length - 1;
    this.concurrent++;
    this.peak = Math.max(this.peak, this.concurrent);
    try {
      if (this.options.delayMs)
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, this.options.delayMs);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
          });
        });
      const list = this.options.measurements ?? [];
      return {
        pdf: this.options.pdf?.(call) ?? makePdf({ pages: 2 }),
        ...(list.length ? { measurements: list[Math.min(call, list.length - 1)] } : {}),
        engineVersion: "Fake/1",
        log: [],
      } as RenderOutput;
    } finally {
      this.concurrent--;
    }
  }
  async dispose() {}
}
