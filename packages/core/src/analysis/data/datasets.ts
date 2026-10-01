/**
 * Datasets of a session (spec §17): one SQLite file per dataset under
 * `<state>/analysis/datasets/<workspaceKey>/<rootSession>/<datasetId>.sqlite`, the `datasets` rows
 * that describe them, ingestion (Node engine for CSV/TSV/JSON/JSONL, the Python standard-library
 * helper for XLSX), read-only queries, and the pages `SpreadsheetView` reads. Files are
 * regenerable derivations: the original (a blob or a workspace/artifact file) is never altered.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type {
  DatasetColumnWire,
  DatasetDetailWire,
  DatasetFormat,
  DatasetRef,
  DatasetRowsPage,
  SqlDatabase,
} from "@alisio/sdk";
import { newId } from "../../runtime/ids.ts";
import { workspaceKey } from "../../runtime/paths.ts";
import { runProcess } from "../../runtime/process.ts";
import { openReadOnlyDatabase } from "../../runtime/sqlite.ts";
import { ALISIO_RUNTIME_FILES } from "../python/sources.ts";
import type { PythonResolution } from "../runtime-manager.ts";
import { describeDataset, promptSummary, type SampleRows } from "./describe.ts";
import { DataEngine, DataError } from "./engine-client.ts";
import type { IngestResult, SheetSummary } from "./engine-types.ts";
import {
  buildCountQuery,
  buildPageQuery,
  encodeCursor,
  MAX_ALL_COLUMNS_FILTER_ROWS,
  MAX_PAGE_ROWS,
  PageParamError,
} from "./rows.ts";
import { guardSql } from "./sql-guard.ts";
import { INGEST_VERSION } from "./stats.ts";

export { DataError, PageParamError };

export interface DatasetLimits {
  maxUploadBytes: number;
  maxRows: number;
  queryTimeoutMs: number;
  maxInteractiveRows: number;
}

export const DEFAULT_DATASET_LIMITS: DatasetLimits = {
  maxUploadBytes: 200 * 1024 * 1024,
  maxRows: 5_000_000,
  queryTimeoutMs: 5000,
  maxInteractiveRows: 1_000_000,
};

const MAX_COLUMNS = 1000;
const MAX_CELL_CHARS = 1024 * 1024;
const XLSX_TIMEOUT_MS = 10 * 60_000;
export const XLSX_REMEDY = "Export the sheet as CSV, or install Python 3.10+.";
/** Heap soft cap of SQLite in the query process (`PRAGMA hard_heap_limit`). */
const QUERY_HEAP_BYTES = 512 * 1024 * 1024;
const FORMATS: Record<string, DatasetFormat> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".tab": "tsv",
  ".json": "json",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".xlsx": "xlsx",
};

/** The format of a file name, or undefined when it is not a supported dataset. */
export function datasetFormat(name: string): DatasetFormat | undefined {
  return FORMATS[extname(name).toLowerCase()];
}

export interface DatasetRecord {
  id: string;
  /** The session that created it. */
  sessionId: string;
  rootSessionId: string;
  name: string;
  format: DatasetFormat;
  sha256: string;
  bytes: number;
  blobHash?: string;
  sourcePath?: string;
  dbRelPath: string;
  ingestVersion: number;
  sheets: SheetSummary[];
  createdAt: number;
}

interface Row {
  id: string;
  session: string;
  root_session: string;
  name: string;
  format: string;
  sha256: string;
  bytes: number;
  blob_hash: string | null;
  source_path: string | null;
  db_rel_path: string;
  ingest_version: number;
  sheets: string;
  created_at: number;
}

const toRecord = (row: Row): DatasetRecord => ({
  id: row.id,
  sessionId: row.session,
  rootSessionId: row.root_session,
  name: row.name,
  format: row.format as DatasetFormat,
  sha256: row.sha256,
  bytes: row.bytes,
  ...(row.blob_hash ? { blobHash: row.blob_hash } : {}),
  ...(row.source_path ? { sourcePath: row.source_path } : {}),
  dbRelPath: row.db_rel_path,
  ingestVersion: row.ingest_version,
  sheets: JSON.parse(row.sheets) as SheetSummary[],
  createdAt: row.created_at,
});

export const toDatasetRef = (record: DatasetRecord): DatasetRef => ({
  id: record.id,
  name: record.name,
  format: record.format,
  bytes: record.bytes,
  sha256: record.sha256,
  sheets: record.sheets.map((s) => ({ ...s })),
});

export interface IngestInput {
  rootSessionId: string;
  sessionId: string;
  workspace: string;
  /** Absolute path of the file to read (resolved and authorised by the caller). */
  path: string;
  /** Display name; defaults to the file name. */
  name?: string;
  blobHash?: string;
  /** Recorded as `source_path` (a workspace or artifact file); never sent to clients. */
  sourcePath?: string;
  signal?: AbortSignal;
  onProgress?: (rows: number) => void;
}

export interface DatasetServiceOptions {
  /** State folder (`stateHome()` or the folder of `--db`). */
  root: string;
  db: SqlDatabase;
  limits?: Partial<DatasetLimits>;
  /** The Python interpreter (XLSX only); absent means XLSX is unsupported. */
  python?: { interpreter(signal: AbortSignal): Promise<PythonResolution> };
  engine?: DataEngine;
  now?: () => number;
}

async function sha256Of(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DatasetService {
  readonly limits: DatasetLimits;
  readonly engine: DataEngine;
  private inflight = new Map<string, Promise<{ record: DatasetRecord; reused: boolean }>>();

  constructor(private readonly options: DatasetServiceOptions) {
    this.limits = { ...DEFAULT_DATASET_LIMITS, ...options.limits };
    this.engine = options.engine ?? new DataEngine({ root: options.root });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Absolute path of a dataset file. */
  file(record: DatasetRecord): string {
    return join(this.options.root, record.dbRelPath);
  }

  get(id: string): DatasetRecord | undefined {
    const row = this.options.db.prepare("SELECT * FROM datasets WHERE id=?").get(id) as
      | Row
      | undefined;
    const record = row ? toRecord(row) : undefined;
    if (record) this.touch(record);
    return record;
  }

  private touched = new Map<string, number>();

  /**
   * Records that a dataset was used, for the retention sweep ("unused for `jobsDays`"): the
   * modification time of its SQLite file (nothing else changes it after the ingestion), at most
   * once every ten minutes per dataset. Best effort: a failure never affects the caller.
   */
  private touch(record: DatasetRecord): void {
    const now = this.now();
    if (now - (this.touched.get(record.id) ?? 0) < 10 * 60_000) return;
    this.touched.set(record.id, now);
    const when = new Date(now);
    void utimes(this.file(record), when, when).catch(() => undefined);
  }

  /** Every dataset (all sessions), for the retention sweep; does not count as a use. */
  all(): DatasetRecord[] {
    return (this.options.db.prepare("SELECT * FROM datasets").all() as unknown as Row[]).map(
      toRecord,
    );
  }

  /** A dataset of this root session; another session's id is `not_found`. */
  getFor(id: string, rootSessionId: string): DatasetRecord {
    const record = this.get(id);
    if (!record || record.rootSessionId !== rootSessionId)
      throw new DataError("not_found", `Dataset ${id} not found in this session`);
    return record;
  }

  list(rootSessionId: string): DatasetRecord[] {
    return (
      this.options.db
        .prepare("SELECT * FROM datasets WHERE root_session=? ORDER BY created_at DESC, id DESC")
        .all(rootSessionId) as unknown as Row[]
    ).map(toRecord);
  }

  private bySha(rootSessionId: string, sha256: string): DatasetRecord | undefined {
    const row = this.options.db
      .prepare(
        "SELECT * FROM datasets WHERE root_session=? AND sha256=? ORDER BY created_at LIMIT 1",
      )
      .get(rootSessionId, sha256) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  /**
   * Ingests a file into a dataset, or returns the session's existing dataset with the same
   * content (`reused`). Concurrent calls for the same content share one ingestion. A failure
   * leaves no row and no file.
   */
  async ingest(input: IngestInput): Promise<{ record: DatasetRecord; reused: boolean }> {
    const name = input.name ?? basename(input.path);
    const format = datasetFormat(name);
    if (!format)
      throw new DataError(
        "dataset_unsupported",
        `Unsupported file type ${extname(name) || "(none)"}. Supported: CSV, TSV, JSON, JSONL and XLSX.`,
      );
    const info = await stat(input.path).catch(() => undefined);
    if (!info?.isFile()) throw new DataError("not_found", `File not found: ${name}`);
    if (info.size > this.limits.maxUploadBytes)
      throw new DataError(
        "ingest_limit",
        `${name} is ${(info.size / (1024 * 1024)).toFixed(1)} MiB; the limit is ${Math.round(this.limits.maxUploadBytes / (1024 * 1024))} MiB (analysis.data.maxUploadBytes)`,
      );
    if (info.size === 0) throw new DataError("ingest_invalid", `${name} is empty`);
    const sha256 = await sha256Of(input.path, input.signal);
    const existing = this.bySha(input.rootSessionId, sha256);
    if (existing) return { record: existing, reused: true };
    const key = `${input.rootSessionId}:${sha256}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.build(input, name, format, sha256, info.size).finally(() =>
        this.inflight.delete(key),
      );
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async build(
    input: IngestInput,
    name: string,
    format: DatasetFormat,
    sha256: string,
    bytes: number,
  ): Promise<{ record: DatasetRecord; reused: boolean }> {
    const id = newId("ds", this.now());
    const dir = join(
      this.options.root,
      "analysis",
      "datasets",
      workspaceKey(input.workspace),
      input.rootSessionId,
    );
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, `${id}.sqlite`);
    const temp = `${target}.tmp`;
    try {
      let result: IngestResult;
      if (format === "xlsx") result = await this.ingestXlsx(input, name, sha256, temp);
      else
        result = await this.engine.ingest(
          {
            source: input.path,
            format,
            target: temp,
            sourceName: name,
            sourceSha256: sha256,
            limits: {
              maxRows: this.limits.maxRows,
              maxColumns: MAX_COLUMNS,
              maxCellChars: MAX_CELL_CHARS,
            },
          },
          {
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          },
        );
      // Windows cannot rename over an existing file; nothing else holds this fresh path.
      await rm(target, { force: true });
      await rename(temp, target);
      await chmod(target, 0o400).catch(() => undefined);
      const record: DatasetRecord = {
        id,
        sessionId: input.sessionId,
        rootSessionId: input.rootSessionId,
        name,
        format,
        sha256,
        bytes,
        ...(input.blobHash ? { blobHash: input.blobHash } : {}),
        ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
        dbRelPath: relative(this.options.root, target),
        ingestVersion: INGEST_VERSION,
        sheets: result.sheets,
        createdAt: this.now(),
      };
      this.options.db
        .prepare(
          `INSERT INTO datasets(id,session,root_session,name,format,sha256,bytes,blob_hash,source_path,
             db_rel_path,ingest_version,sheets,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.id,
          record.sessionId,
          record.rootSessionId,
          record.name,
          record.format,
          record.sha256,
          record.bytes,
          record.blobHash ?? null,
          record.sourcePath ?? null,
          record.dbRelPath,
          record.ingestVersion,
          JSON.stringify(record.sheets),
          record.createdAt,
        );
      return { record, reused: false };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** The XLSX route (spec §17.6, option B): the Python standard-library helper, then statistics. */
  private async ingestXlsx(
    input: IngestInput,
    name: string,
    sha256: string,
    temp: string,
  ): Promise<IngestResult> {
    const python = this.options.python;
    const signal = input.signal ?? new AbortController().signal;
    const runtime = python ? await python.interpreter(signal) : undefined;
    if (!runtime?.ok)
      throw new DataError(
        "dataset_unsupported",
        `${name} is an Excel workbook, which needs Python 3.10+ to be read. ${XLSX_REMEDY}`,
      );
    const helper = await this.helperDir();
    await rm(temp, { force: true });
    let run: Awaited<ReturnType<typeof runProcess>>;
    try {
      run = await runProcess(
        runtime.executable,
        [
          ...(runtime.prefixArgs ?? []),
          "-E",
          "-s",
          "-B",
          "-u",
          "-X",
          "utf8",
          "-m",
          "alisio_runtime.xlsx_to_sqlite",
          input.path,
          temp,
          "--max-rows",
          String(this.limits.maxRows),
          "--max-columns",
          String(MAX_COLUMNS),
          "--max-cell-chars",
          String(MAX_CELL_CHARS),
        ],
        { cwd: helper, signal, timeoutMs: XLSX_TIMEOUT_MS, maxBytes: 16 * 1024 },
      );
    } catch (error) {
      if (signal.aborted) throw new DataError("cancelled", "Cancelled");
      throw new DataError("engine_error", `The XLSX helper failed: ${message(error)}`);
    }
    if (run.exitCode !== 0) {
      const line =
        run.stderr
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.startsWith("alisio-xlsx:")) ?? "";
      throw new DataError(
        "ingest_invalid",
        line
          ? line.replace(/^alisio-xlsx:\s*/, "")
          : `The XLSX helper failed (exit ${run.exitCode})`,
      );
    }
    return this.engine.finalize(
      { target: temp, sourceName: name, sourceSha256: sha256 },
      {
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
  }

  /** The `alisio_runtime` package on disk for `python -m` (content-addressed, written once). */
  private async helperDir(): Promise<string> {
    const hash = createHash("sha256")
      .update(JSON.stringify(ALISIO_RUNTIME_FILES))
      .digest("hex")
      .slice(0, 12);
    const dir = join(this.options.root, "runtimes", "python", "helper", hash);
    const marker = join(dir, ".complete");
    if (
      await stat(marker).then(
        () => true,
        () => false,
      )
    )
      return dir;
    const package_ = join(dir, "alisio_runtime");
    await mkdir(package_, { recursive: true, mode: 0o700 });
    for (const [file, text] of Object.entries(ALISIO_RUNTIME_FILES))
      await writeFile(join(package_, file), text);
    await writeFile(marker, "");
    return dir;
  }

  /** Schema and statistics of every sheet (`GET /api/datasets/:did`). */
  detail(record: DatasetRecord): DatasetDetailWire {
    const db = openReadOnlyDatabase(this.file(record));
    try {
      const meta = Object.fromEntries(
        (
          db.prepare("SELECT key, value FROM _alisio_meta").all() as Array<{
            key: string;
            value: string;
          }>
        ).map((r) => [r.key, r.value]),
      );
      const sheets = db
        .prepare("SELECT name, table_name, rows FROM _alisio_sheets ORDER BY ordinal")
        .all() as Array<{ name: string; table_name: string; rows: number }>;
      const columns = db.prepare(
        `SELECT name, label, inferred_type, nulls, distinct_count, distinct_exact, min, max, mean,
           text_fallbacks, top_values FROM _alisio_columns WHERE table_name=? ORDER BY ordinal`,
      );
      return {
        ...toDatasetRef(record),
        ingestVersion: record.ingestVersion,
        ...(meta.encoding ? { encoding: meta.encoding } : {}),
        ...(meta.delimiter ? { delimiter: meta.delimiter } : {}),
        maxInteractiveRows: this.limits.maxInteractiveRows,
        sheetDetails: sheets.map((sheet) => ({
          name: sheet.name,
          table: sheet.table_name,
          rows: Number(sheet.rows),
          columns: (columns.all(sheet.table_name) as unknown as Array<Record<string, unknown>>).map(
            (c): DatasetColumnWire => ({
              name: String(c.name),
              label: String(c.label),
              type: String(c.inferred_type),
              nulls: Number(c.nulls ?? 0),
              distinct: Number(c.distinct_count ?? 0),
              distinctExact: Number(c.distinct_exact ?? 1) === 1,
              ...(c.min !== null && c.min !== undefined ? { min: String(c.min) } : {}),
              ...(c.max !== null && c.max !== undefined ? { max: String(c.max) } : {}),
              ...(c.mean !== null && c.mean !== undefined ? { mean: Number(c.mean) } : {}),
              textFallbacks: Number(c.text_fallbacks ?? 0),
              top: JSON.parse(String(c.top_values ?? "[]")) as Array<{
                value: string;
                count: number;
              }>,
            }),
          ),
        })),
      };
    } finally {
      db.close();
    }
  }

  /** First rows of a table, for `data_inspect` and the prompt summary. */
  async sample(
    record: DatasetRecord,
    table: string,
    rows: number,
    signal?: AbortSignal,
  ): Promise<SampleRows> {
    const result = await this.engine.runQuery(
      {
        db: this.file(record),
        sql: `SELECT * FROM "${table.replaceAll('"', '""')}" LIMIT ${Math.max(0, Math.floor(rows))}`,
        maxRows: rows,
        cellChars: 200,
        guard: false,
      },
      { timeoutMs: this.limits.queryTimeoutMs, ...(signal ? { signal } : {}) },
    );
    return { table, columns: result.columns, rows: result.rows };
  }

  /** The description for the model: `data_inspect` text. */
  async describe(
    record: DatasetRecord,
    sampleRows: number,
    maxChars: number,
    signal?: AbortSignal,
  ) {
    const detail = this.detail(record);
    const samples = new Map<string, SampleRows>();
    for (const sheet of detail.sheetDetails.slice(0, 5))
      samples.set(sheet.table, await this.sample(record, sheet.table, sampleRows, signal));
    return { detail, samples, text: describeDataset(detail, samples, { maxChars }) };
  }

  /** The ≤ 4 KB summary appended to a prompt that attaches the dataset. */
  async summary(record: DatasetRecord, signal?: AbortSignal): Promise<string> {
    const detail = this.detail(record);
    const samples = new Map<string, SampleRows>();
    for (const sheet of detail.sheetDetails.slice(0, 3))
      samples.set(sheet.table, await this.sample(record, sheet.table, 5, signal));
    return promptSummary(detail, samples);
  }

  /**
   * Runs a model-written read-only query (`data_query`): lexical guard, then a read-only
   * connection in the engine process, with a row limit and a time limit.
   */
  async query(
    record: DatasetRecord,
    sql: string,
    options: { maxRows?: number; signal?: AbortSignal } = {},
  ) {
    const guarded = guardSql(sql);
    if (!guarded.ok) throw new DataError("query_rejected", guarded.reason);
    return this.engine.runQuery(
      {
        db: this.file(record),
        sql: guarded.sql,
        maxRows: Math.min(Math.max(1, options.maxRows ?? 200), 1000),
        cellChars: 2048,
        guard: true,
        heapBytes: QUERY_HEAP_BYTES,
      },
      {
        timeoutMs: this.limits.queryTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  /** One page of a sheet for `SpreadsheetView` (spec §17.4). */
  async page(
    record: DatasetRecord,
    request: {
      sheet?: string;
      after?: string;
      offset?: number;
      limit?: number;
      sort?: string;
      dir?: "asc" | "desc";
      filter?: string;
      column?: string;
    },
    signal?: AbortSignal,
  ): Promise<DatasetRowsPage> {
    const detail = this.detail(record);
    const sheet =
      detail.sheetDetails.find((s) => s.name === request.sheet || s.table === request.sheet) ??
      (request.sheet === undefined ? detail.sheetDetails[0] : undefined);
    if (!sheet) throw new PageParamError(`Unknown sheet: ${request.sheet}`);
    const interactive = sheet.rows <= this.limits.maxInteractiveRows;
    const names = sheet.columns.map((c) => c.name);
    const filterText = interactive ? (request.filter ?? "") : "";
    if (filterText && request.column === undefined && sheet.rows > MAX_ALL_COLUMNS_FILTER_ROWS)
      throw new PageParamError(
        `Choose a column to filter: this sheet has more than ${MAX_ALL_COLUMNS_FILTER_ROWS} rows`,
      );
    const params = {
      table: sheet.table,
      columns: names,
      limit: Math.min(Math.max(1, request.limit ?? 200), MAX_PAGE_ROWS),
      ...(interactive && request.sort
        ? { sort: { column: request.sort, dir: request.dir ?? ("asc" as const) } }
        : {}),
      ...(filterText
        ? {
            filter: {
              text: filterText,
              ...(request.column !== undefined ? { column: request.column } : {}),
            },
          }
        : {}),
      ...(request.after ? { after: request.after } : {}),
      ...(request.offset ? { offset: request.offset } : {}),
    };
    const built = buildPageQuery(params);
    const run = (sql: string, values: Array<string | number | null>, maxRows: number) =>
      this.engine.runQuery(
        { db: this.file(record), sql, params: values, maxRows, cellChars: 4096, guard: false },
        { timeoutMs: Math.max(this.limits.queryTimeoutMs, 30_000), ...(signal ? { signal } : {}) },
      );
    const result = await run(built.sql, built.params, params.limit + 1);
    const hasNext = result.rows.length > params.limit;
    const page = hasNext ? result.rows.slice(0, params.limit) : result.rows;
    const rowids = page.map((r) => Number(r[0]));
    let matched: number | undefined;
    if (filterText && !request.after && !request.offset) {
      const count = buildCountQuery({ table: sheet.table, columns: names, filter: params.filter });
      const counted = await run(count.sql, count.params, 1);
      matched = Number(counted.rows[0]?.[0] ?? 0);
    }
    const last = rowids.at(-1);
    return {
      columns: sheet.columns.map((c) => ({ name: c.name, label: c.label, type: c.type })),
      rows: page.map((r) => r.slice(1)),
      rowids,
      ...(hasNext && last !== undefined ? { next: encodeCursor(last) } : {}),
      total: sheet.rows,
      ...(matched !== undefined ? { matched } : {}),
      interactive,
    };
  }

  /** Deletes a dataset file and row (connections are closed first, for Windows). */
  async remove(record: DatasetRecord): Promise<void> {
    await this.engine.closeFile(this.file(record));
    await rm(this.file(record), { force: true });
    this.options.db.prepare("DELETE FROM datasets WHERE id=?").run(record.id);
  }

  close(): void {
    this.engine.close();
  }
}
