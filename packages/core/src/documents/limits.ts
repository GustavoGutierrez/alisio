/** Hard limits of the document engine (spec 026 §5.7.4). */
export const DOCUMENT_LIMITS = {
  specBytes: 1024 * 1024,
  markdownBytes: 400 * 1024,
  blocks: 2000,
  tableRows: 500,
  chartLabels: 50,
  chartSeries: 6,
  totalTableRows: 5000,
  pages: 200,
  assetBytes: 10 * 1024 * 1024,
  totalAssetBytes: 50 * 1024 * 1024,
  assets: 50,
  pdfBytes: 50 * 1024 * 1024,
  renderTimeoutMs: 60_000,
  callTimeoutMs: 180_000,
  concurrentRenders: 2,
  queuedRenders: 8,
  idleBrowserMs: 60_000,
  tmpMaxAgeMs: 60 * 60_000,
} as const;

/** Error codes the tool reports (spec §5.1). */
export type DocumentErrorCode =
  | "DOCUMENT_INPUT_INVALID"
  | "DOCUMENT_ASSET_DENIED"
  | "DOCUMENT_LIMIT_EXCEEDED"
  | "DOCUMENT_ENGINE_UNAVAILABLE"
  | "DOCUMENT_RENDER_FAILED"
  | "DOCUMENT_RENDER_TIMEOUT"
  | "DOCUMENT_BUSY";

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  constructor(code: DocumentErrorCode, message: string) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
  }
}
