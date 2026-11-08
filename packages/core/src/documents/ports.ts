/** Ports of the document engine (spec 026 D2, §5.6.1). */

export type EngineId = "electron" | "chromium" | "weasyprint";
export type PageSize = "A4" | "Letter" | "Legal" | "A5";
export type Orientation = "portrait" | "landscape";

export interface PageSetup {
  size: PageSize;
  orientation: Orientation;
}

export interface EngineCapabilities {
  runningHeaders: boolean;
  footnotes: boolean;
  tocPageNumbers: "two-pass" | "native" | "none";
  outline: boolean;
  tagged: boolean;
  domMeasurements: boolean;
}

export type Readiness =
  | { ready: true; version: string }
  | { ready: false; reason: string; fix?: string };

export interface RenderJob {
  /** Directory holding the bundle (served as `https://document.invalid/`). */
  bundleDir: string;
  entry: string;
  page: PageSetup;
  timeoutMs: number;
  wantTagged: boolean;
  measure: boolean;
  /** Width of the page content box in mm (viewport for DOM measurements). */
  contentWidthMm: number;
}

export interface DomMeasurements {
  overflow: Array<{ block: number; tag: string; overflowPx: number }>;
  lowDpi: Array<{ src: string; dpi: number }>;
}

export interface RenderOutput {
  pdf: Uint8Array;
  measurements?: DomMeasurements;
  engineVersion: string;
  log: string[];
}

export interface DocumentEngine {
  id: EngineId;
  capabilities: EngineCapabilities;
  readiness(signal: AbortSignal): Promise<Readiness>;
  render(job: RenderJob, signal: AbortSignal): Promise<RenderOutput>;
  dispose(): Promise<void>;
}
