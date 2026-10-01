/**
 * Terminal preview of text-like artifacts (spec §16.4), shown in place of the `/artifacts` picker:
 * Markdown (first 256 KiB), CSV/TSV as a table (200 rows × 20 columns, with a legend), JSON
 * pretty-printed (256 KiB) and text/code with highlighting (2 000 lines). Dashboards, PDFs,
 * images and office files never render here: they only open with the system app.
 */
import { open } from "node:fs/promises";
import { CsvParser, decodeTextBytes, detectDelimiter } from "@alisio/core";
import type { ArtifactRef, UiBlock } from "@alisio/sdk";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { terminalCapabilities } from "../banner.ts";
import { renderUiBlock } from "./components.ts";
import { style } from "./theme.ts";

export const PREVIEW_MAX_BYTES = 256 * 1024;
export const PREVIEW_MAX_LINES = 2000;
export const PREVIEW_MAX_ROWS = 200;
export const PREVIEW_MAX_COLUMNS = 20;
/** CSV bytes read to count rows for the legend (beyond: "more than N rows"). */
const TABLE_SCAN_BYTES = 8 * 1024 * 1024;

export type PreviewKind = "markdown" | "table" | "json" | "text";

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/** How an artifact previews in the terminal, or undefined when it only opens externally. */
export function previewKind(artifact: ArtifactRef): PreviewKind | undefined {
  if (artifact.status !== "ready") return undefined;
  const ext = extension(artifact.fileName);
  if (artifact.kind === "document" && (ext === "md" || ext === "markdown")) return "markdown";
  if (artifact.kind === "spreadsheet" && (ext === "csv" || ext === "tsv")) return "table";
  if (artifact.kind === "data") return "json";
  if (artifact.kind === "code") return "text";
  return undefined;
}

const LANGUAGES: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  r: "r",
  json: "json",
  geojson: "json",
};

export interface Preview {
  block: UiBlock;
  truncated: boolean;
  /** Table legend: `showing 200 of 12,480 rows · 20 of 31 columns`. */
  legend?: string;
}

/** Decodes at most `max` bytes as UTF-8 without a broken trailing character. */
const decode = (bytes: Uint8Array, max: number) =>
  Buffer.from(bytes.subarray(0, max)).toString("utf8").replace(/�+$/, "");

/**
 * RFC 4180 rows (quotes, doubled quotes, newlines inside quotes, CRLF/LF/CR), up to `limit`, with
 * the same parser the dataset ingestion uses (so the preview and `data_inspect` agree).
 */
export function parseDelimited(
  text: string,
  delimiter: string,
  limit = Number.POSITIVE_INFINITY,
): { rows: string[][]; total: number; complete: boolean } {
  const rows: string[][] = [];
  let total = 0;
  const parser = new CsvParser(delimiter, (row) => {
    total++;
    if (rows.length < limit) rows.push(row);
  });
  parser.write(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  parser.end();
  return { rows, total, complete: true };
}

const thousands = (n: number) => n.toLocaleString("en-US");

/** The preview of an artifact from its leading bytes (the caller reads them, bounded). */
export function buildPreview(
  artifact: ArtifactRef,
  bytes: Uint8Array,
  fileBytes?: number,
): Preview {
  const size = fileBytes ?? bytes.length;
  const kind = previewKind(artifact) ?? "text";
  const ext = extension(artifact.fileName);
  if (kind === "markdown")
    return {
      block: { kind: "markdown", text: decode(bytes, PREVIEW_MAX_BYTES) },
      truncated: size > PREVIEW_MAX_BYTES || bytes.length > PREVIEW_MAX_BYTES,
    };
  if (kind === "table") {
    const scanned = bytes.length >= TABLE_SCAN_BYTES || size > bytes.length;
    // UTF-8, UTF-16 (BOM) or windows-1252, and `;` or `|` as well as `,` and TAB, like ingestion.
    const { text } = decodeTextBytes(bytes.subarray(0, TABLE_SCAN_BYTES), scanned);
    const parsed = parseDelimited(
      text,
      ext === "tsv" ? "\t" : detectDelimiter(text.slice(0, 64 * 1024)),
      PREVIEW_MAX_ROWS + 1,
    );
    const [header = [], ...body] = parsed.rows;
    const columns = header.length;
    const rows = body.slice(0, PREVIEW_MAX_ROWS);
    const dataRows = Math.max(0, parsed.total - 1);
    const shownColumns = Math.min(columns, PREVIEW_MAX_COLUMNS);
    const truncated = dataRows > rows.length || columns > shownColumns || scanned;
    return {
      block: {
        kind: "table",
        columns: header.slice(0, PREVIEW_MAX_COLUMNS),
        rows: rows.map((row) => row.slice(0, PREVIEW_MAX_COLUMNS)),
      },
      truncated,
      ...(truncated
        ? {
            legend: `showing ${thousands(rows.length)} of ${scanned ? "more than " : ""}${thousands(dataRows)} rows · ${shownColumns} of ${columns} columns`,
          }
        : {}),
    };
  }
  const text = decode(bytes, PREVIEW_MAX_BYTES);
  const cutBytes = size > PREVIEW_MAX_BYTES || bytes.length > PREVIEW_MAX_BYTES;
  if (kind === "json") {
    let code = text;
    if (!cutBytes)
      try {
        code = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* Invalid JSON is shown as it is. */
      }
    return { block: { kind: "code", lang: "json", code }, truncated: cutBytes };
  }
  const lines = text.split(/\r?\n/);
  const lang = LANGUAGES[ext];
  return {
    block: {
      kind: "code",
      code: lines.slice(0, PREVIEW_MAX_LINES).join("\n"),
      ...(lang ? { lang } : {}),
    },
    truncated: cutBytes || lines.length > PREVIEW_MAX_LINES,
  };
}

/** Reads the bytes a preview needs (never the whole of a large file). */
export async function loadPreview(artifact: ArtifactRef, path: string): Promise<Preview> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const want = Math.min(
      size,
      (previewKind(artifact) === "table" ? TABLE_SCAN_BYTES : PREVIEW_MAX_BYTES) + 4,
    );
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, 0);
    return buildPreview(artifact, buffer.subarray(0, bytesRead), size);
  } finally {
    await handle.close();
  }
}

/**
 * A bounded, scrollable preview panel: ↑/↓, PgUp/PgDn, Home/End scroll; `o` opens with the
 * system app, `c` copies the path, `Esc` or `q` closes. The footer says `truncated` when cut.
 */
export class ArtifactPreview implements Component {
  private offset = 0;
  private lines: string[] = [];
  private renderedWidth = 0;

  constructor(
    private readonly artifact: ArtifactRef,
    private readonly preview: Preview,
    private readonly options: {
      /** Rows available for the body (the panel adds a title and a footer). */
      height: () => number;
      open: () => void;
      copy: () => void;
      close: () => void;
    },
  ) {}

  invalidate(): void {
    this.renderedWidth = 0;
  }

  private page(): number {
    return Math.max(3, this.options.height());
  }

  private clamp(): void {
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.lines.length - this.page())));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") return this.options.close();
    if (data === "o") return this.options.open();
    if (data === "c") return this.options.copy();
    if (matchesKey(data, Key.down)) this.offset++;
    else if (matchesKey(data, Key.up)) this.offset--;
    else if (matchesKey(data, Key.pageDown)) this.offset += this.page() - 1;
    else if (matchesKey(data, Key.pageUp)) this.offset -= this.page() - 1;
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
    this.clamp();
  }

  render(width: number): string[] {
    if (width !== this.renderedWidth) {
      const { unicode } = terminalCapabilities({ env: process.env, columns: width, tty: true });
      this.lines = renderUiBlock(this.preview.block, width, unicode).map((line) =>
        truncateToWidth(line, width),
      );
      this.renderedWidth = width;
    }
    this.clamp();
    const page = this.page();
    const end = Math.min(this.lines.length, this.offset + page);
    const position = this.lines.length
      ? `${this.offset + 1}–${end} of ${this.lines.length}`
      : "empty";
    const notes = [
      position,
      ...(this.preview.legend ? [this.preview.legend] : []),
      ...(this.preview.truncated ? ["truncated"] : []),
    ].join(" · ");
    return [
      truncateToWidth(style.bold(style.yellow(`Preview · ${this.artifact.fileName}`)), width),
      ...this.lines.slice(this.offset, end),
      truncateToWidth(style.dim(`  ${notes}`), width),
      truncateToWidth(
        style.dim("  ↑↓ PgUp/PgDn Home/End · o open · c copy path · Esc close"),
        width,
      ),
    ];
  }
}
