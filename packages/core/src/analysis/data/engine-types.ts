/**
 * Messages between the host and the data engine, a separate process (`node` or `bun`) that runs
 * `node:sqlite` so that a stuck statement can be stopped with a kill (`worker.terminate()` cannot
 * interrupt a native SQLite call; verified on Node 22.19 and Bun 1.4.2). Newline-delimited JSON
 * over stdin/stdout. Types only: no runtime code, safe to import from anywhere.
 */

export interface DataLimits {
  maxRows: number;
  maxColumns: number;
  /** Characters per cell. */
  maxCellChars: number;
}

export interface IngestRequest {
  op: "ingest";
  id: number;
  source: string;
  format: "csv" | "tsv" | "json" | "jsonl";
  /** Temporary database file to create (the host renames it). */
  target: string;
  sourceName: string;
  sourceSha256: string;
  limits: DataLimits;
}

/** Computes the statistics of a database the Python helper wrote. */
export interface FinalizeRequest {
  op: "finalize";
  id: number;
  target: string;
  sourceName: string;
  sourceSha256: string;
}

export interface QueryRequest {
  op: "query";
  id: number;
  db: string;
  sql: string;
  params?: Array<string | number | null>;
  /** Rows returned; one more is read to report truncation. */
  maxRows: number;
  /** Cells longer than this many characters are cut (and marked). */
  cellChars: number;
  /** Apply the lexical guard in the engine too (model-written SQL). */
  guard: boolean;
  /** Soft cap of SQLite's heap, in bytes. */
  heapBytes?: number;
}

export interface CloseRequest {
  op: "close";
  id: number;
  /** A database file to close, or every open one when absent. */
  db?: string;
}

export type EngineRequest = IngestRequest | FinalizeRequest | QueryRequest | CloseRequest;

export interface SheetSummary {
  name: string;
  table: string;
  rows: number;
  columns: number;
}

export interface IngestResult {
  sheets: SheetSummary[];
  encoding: string;
  delimiter?: string;
  irregularRows: number;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Array<string | number | null>>;
  truncated: boolean;
  /** Some cell was cut at `cellChars`. */
  clipped: boolean;
}

export type EngineResponse =
  | { id: number; type: "result"; result: IngestResult | QueryResult | Record<string, never> }
  | { id: number; type: "progress"; rows: number }
  | { id: number; type: "error"; code: string; message: string };
