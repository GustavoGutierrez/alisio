/**
 * Ingestion side of the data engine (spec §17.2): streams a CSV/TSV/JSON/JSONL file into one
 * SQLite file with batched inserts in transactions, then computes the statistics. Runs inside the
 * engine process, never in the host. Values are stored without loss (see `infer.ts`).
 */
import {
  closeSync,
  createReadStream,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { CsvError, CsvParser, detectDelimiter } from "./csv.ts";
import type { IngestRequest, IngestResult, SheetSummary } from "./engine-types.ts";
import {
  convertCell,
  convertJson,
  looksLikeData,
  newTakenNames,
  quoteIdent,
  type StoredValue,
  sanitizeIdentifier,
  uniqueName,
} from "./infer.ts";
import { jsonDocumentRecords, LineSplitter, toRecord } from "./json.ts";
import { type Db, finalizeDatabase, INGEST_VERSION, META_SCHEMA } from "./stats.ts";

const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/** Largest JSON document (not JSON Lines) parsed in memory. */
export const MAX_JSON_BYTES = 50 * 1024 * 1024;
const BATCH_ROWS = 500;
const MAX_PARAMS = 32_766;
const COMMIT_ROWS = 5_000;

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Opens a writable database for ingestion (a temporary file, journal off). */
export function openWritable(path: string): InstanceType<typeof sqlite.DatabaseSync> {
  rmSync(path, { force: true });
  const db = new sqlite.DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-65536; PRAGMA temp_store=FILE;",
  );
  return db;
}

function head(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

async function* chunks(path: string): AsyncGenerator<Buffer> {
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }))
    yield chunk as Buffer;
}

/** UTF-8 (with or without BOM), UTF-16 by BOM, or windows-1252 when the bytes are not UTF-8. */
export async function detectEncoding(path: string): Promise<string> {
  const start = head(path, 3);
  if (start[0] === 0xef && start[1] === 0xbb && start[2] === 0xbf) return "utf-8";
  if (start[0] === 0xff && start[1] === 0xfe) return "utf-16le";
  if (start[0] === 0xfe && start[1] === 0xff) return "utf-16be";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of chunks(path)) decoder.decode(chunk, { stream: true });
    decoder.decode();
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

async function* textChunks(path: string, encoding: string): AsyncGenerator<string> {
  const decoder = new TextDecoder(encoding);
  for await (const chunk of chunks(path)) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const rest = decoder.decode();
  if (rest) yield rest;
}

/** Batched multi-row inserts into one table, committing every few thousand rows. */
class TableWriter {
  private pending: StoredValue[][] = [];
  private statements = new Map<number, ReturnType<Db["prepare"]>>();
  private sinceCommit = 0;
  rows = 0;

  constructor(
    private readonly db: InstanceType<typeof sqlite.DatabaseSync>,
    private readonly table: string,
    public columns: string[],
    private readonly maxRows: number,
    private readonly onRows: (rows: number) => void,
  ) {
    db.exec("BEGIN");
    db.exec(`CREATE TABLE ${quoteIdent(table)}(${columns.map(quoteIdent).join(", ")})`);
  }

  private statement(count: number) {
    let statement = this.statements.get(count);
    if (!statement) {
      const group = `(${this.columns.map(() => "?").join(",")})`;
      statement = this.db.prepare(
        `INSERT INTO ${quoteIdent(this.table)} VALUES ${Array(count).fill(group).join(",")}`,
      ) as unknown as ReturnType<Db["prepare"]>;
      this.statements.set(count, statement);
    }
    return statement;
  }

  add(row: StoredValue[]): void {
    if (this.rows >= this.maxRows)
      throw new EngineError("ingest_limit", `The file has more than ${this.maxRows} rows`);
    this.pending.push(row);
    this.rows++;
    if (this.pending.length >= Math.min(BATCH_ROWS, Math.floor(MAX_PARAMS / this.columns.length)))
      this.flush();
  }

  flush(): void {
    if (!this.pending.length) return;
    const width = this.columns.length;
    const params: StoredValue[] = [];
    for (const row of this.pending) {
      for (let i = 0; i < width; i++) params.push(row[i] ?? null);
    }
    this.statement(this.pending.length).run(...params);
    this.sinceCommit += this.pending.length;
    this.pending = [];
    if (this.sinceCommit >= COMMIT_ROWS) {
      this.db.exec("COMMIT");
      this.db.exec("BEGIN");
      this.sinceCommit = 0;
      this.onRows(this.rows);
    }
  }

  /** Adds a column (JSON keys can appear late); queued rows are written first. */
  addColumn(name: string): void {
    this.flush();
    this.db.exec(`ALTER TABLE ${quoteIdent(this.table)} ADD COLUMN ${quoteIdent(name)}`);
    this.columns = [...this.columns, name];
    this.statements.clear();
  }

  finish(): void {
    this.flush();
    this.db.exec("COMMIT");
  }
}

interface Registered {
  table: string;
  names: string[];
  labels: string[];
  rows: number;
}

function register(
  db: InstanceType<typeof sqlite.DatabaseSync>,
  sheetName: string,
  ordinal: number,
  table: string,
  names: string[],
  labels: string[],
): void {
  db.prepare(
    "INSERT INTO _alisio_sheets(ordinal,name,table_name,rows,columns) VALUES(?,?,?,0,?)",
  ).run(ordinal, sheetName, table, names.length);
  const insert = db.prepare(
    "INSERT INTO _alisio_columns(table_name,ordinal,name,label,inferred_type) VALUES(?,?,?,?,'text')",
  );
  names.forEach((name, i) => {
    insert.run(table, i + 1, name, labels[i] ?? name);
  });
}

async function ingestDelimited(
  db: InstanceType<typeof sqlite.DatabaseSync>,
  req: IngestRequest,
  encoding: string,
  onRows: (rows: number) => void,
): Promise<{ registered: Registered; delimiter: string; irregular: number }> {
  let sample = "";
  for await (const text of textChunks(req.source, encoding)) {
    sample = text.slice(0, 64 * 1024);
    break;
  }
  const delimiter = req.format === "tsv" ? "\t" : detectDelimiter(sample);
  let writer: TableWriter | undefined;
  let names: string[] = [];
  let labels: string[] = [];
  let irregular = 0;
  const addRow = (fields: string[]) => {
    if (fields.length !== names.length) irregular++;
    const values: StoredValue[] = [];
    for (let i = 0; i < names.length; i++) values.push(convertCell(fields[i] ?? ""));
    (writer as TableWriter).add(values);
  };
  const parser = new CsvParser(
    delimiter,
    (fields) => {
      if (!writer) {
        if (fields.length > req.limits.maxColumns)
          throw new EngineError(
            "ingest_limit",
            `The file has ${fields.length} columns; the limit is ${req.limits.maxColumns}`,
          );
        const header = !looksLikeData(fields);
        const taken = newTakenNames();
        labels = fields.map((cell, i) => (header && cell !== "" ? cell : `column_${i + 1}`));
        names = labels.map((label, i) =>
          uniqueName(sanitizeIdentifier(label, `column_${i + 1}`), taken),
        );
        writer = new TableWriter(db, "data", names, req.limits.maxRows, onRows);
        if (!header) addRow(fields);
        return;
      }
      addRow(fields);
    },
    req.limits.maxCellChars,
  );
  try {
    for await (const text of textChunks(req.source, encoding)) parser.write(text);
    parser.end();
  } catch (error) {
    if (error instanceof CsvError) throw new EngineError("ingest_limit", error.message);
    throw error;
  }
  if (!writer) throw new EngineError("ingest_invalid", "The file has no rows");
  (writer as TableWriter).finish();
  return {
    registered: { table: "data", names, labels, rows: (writer as TableWriter).rows },
    delimiter,
    irregular,
  };
}

async function ingestJson(
  db: InstanceType<typeof sqlite.DatabaseSync>,
  req: IngestRequest,
  encoding: string,
  onRows: (rows: number) => void,
): Promise<{ registered: Registered; irregular: number }> {
  const names: string[] = [];
  const labels: string[] = [];
  const taken = newTakenNames();
  const index = new Map<string, number>();
  let writer: TableWriter | undefined;
  const addRecord = (record: Record<string, unknown>) => {
    const keys = Object.keys(record);
    const fresh = keys.filter((key) => !index.has(key));
    if (fresh.length && names.length + fresh.length > req.limits.maxColumns)
      throw new EngineError(
        "ingest_limit",
        `The file has more than ${req.limits.maxColumns} distinct keys`,
      );
    for (const key of fresh) {
      const name = uniqueName(sanitizeIdentifier(key, `column_${names.length + 1}`), taken);
      index.set(key, names.length);
      names.push(name);
      labels.push(key);
      if (writer) writer.addColumn(name);
    }
    if (!writer) {
      if (!names.length) {
        // An empty object is still a row: keep one placeholder-free table of zero columns? Not
        // representable in SQLite, so skip it.
        return;
      }
      writer = new TableWriter(db, "data", [...names], req.limits.maxRows, onRows);
    }
    const values: StoredValue[] = Array(names.length).fill(null);
    for (const key of keys) values[index.get(key) as number] = convertJson(record[key]);
    writer.add(values);
  };
  const lineHandler = () => {
    let n = 0;
    return (line: string) => {
      n++;
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new EngineError("ingest_invalid", `Line ${n} is not valid JSON`);
      }
      addRecord(toRecord(value));
    };
  };
  if (req.format === "jsonl") {
    const splitter = new LineSplitter(lineHandler());
    for await (const text of textChunks(req.source, encoding)) splitter.write(text);
    splitter.end();
  } else {
    if (statSync(req.source).size > MAX_JSON_BYTES)
      throw new EngineError(
        "ingest_limit",
        `A JSON document is read in memory up to ${MAX_JSON_BYTES / (1024 * 1024)} MiB; use JSON Lines for larger files`,
      );
    const text = new TextDecoder(encoding).decode(readFileSync(req.source));
    let records: Array<Record<string, unknown>>;
    try {
      records = jsonDocumentRecords(text);
    } catch {
      // Several objects on separate lines: JSON Lines with a .json name.
      const splitter = new LineSplitter(lineHandler());
      splitter.write(text);
      splitter.end();
      records = [];
    }
    for (const record of records) addRecord(record);
  }
  if (!writer) throw new EngineError("ingest_invalid", "The file has no records");
  (writer as TableWriter).finish();
  return {
    registered: { table: "data", names, labels, rows: (writer as TableWriter).rows },
    irregular: 0,
  };
}

/** Builds `req.target` from `req.source` and returns what was ingested. */
export async function runIngest(
  req: IngestRequest,
  progress: (rows: number) => void,
): Promise<IngestResult> {
  const encoding = await detectEncoding(req.source);
  const db = openWritable(req.target);
  let lastProgress = 0;
  const onRows = (rows: number) => {
    const now = Date.now();
    if (now - lastProgress >= 250) {
      lastProgress = now;
      progress(rows);
    }
  };
  try {
    db.exec(META_SCHEMA);
    let delimiter: string | undefined;
    let irregular = 0;
    let registered: Registered;
    if (req.format === "csv" || req.format === "tsv") {
      const done = await ingestDelimited(db, req, encoding, onRows);
      registered = done.registered;
      delimiter = done.delimiter;
      irregular = done.irregular;
    } else {
      const done = await ingestJson(db, req, encoding, onRows);
      registered = done.registered;
    }
    register(db, "data", 1, registered.table, registered.names, registered.labels);
    const meta = db.prepare("INSERT OR REPLACE INTO _alisio_meta(key,value) VALUES(?,?)");
    for (const [key, value] of Object.entries({
      ingest_version: String(INGEST_VERSION),
      format: req.format,
      source_name: req.sourceName,
      source_sha256: req.sourceSha256,
      encoding,
      ...(delimiter ? { delimiter } : {}),
      irregular_rows: String(irregular),
      created_at: new Date().toISOString(),
    }))
      meta.run(key, value);
    finalizeDatabase(db as unknown as Db);
    const sheets = db
      .prepare(
        'SELECT name, table_name AS "table", rows, columns FROM _alisio_sheets ORDER BY ordinal',
      )
      .all() as unknown as SheetSummary[];
    return {
      sheets: sheets.map((s) => ({ ...s })),
      encoding,
      ...(delimiter ? { delimiter } : {}),
      irregularRows: irregular,
    };
  } finally {
    db.close();
  }
}

/** Statistics for a database the Python helper wrote (XLSX), plus the metadata keys. */
export function runFinalize(
  target: string,
  sourceName: string,
  sourceSha256: string,
): IngestResult {
  const db = new sqlite.DatabaseSync(target);
  try {
    db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;");
    db.exec(META_SCHEMA);
    const meta = db.prepare("INSERT OR REPLACE INTO _alisio_meta(key,value) VALUES(?,?)");
    for (const [key, value] of Object.entries({
      ingest_version: String(INGEST_VERSION),
      format: "xlsx",
      source_name: sourceName,
      source_sha256: sourceSha256,
      encoding: "utf-8",
      created_at: new Date().toISOString(),
    }))
      meta.run(key, value);
    finalizeDatabase(db as unknown as Db);
    const sheets = db
      .prepare(
        'SELECT name, table_name AS "table", rows, columns FROM _alisio_sheets ORDER BY ordinal',
      )
      .all() as unknown as SheetSummary[];
    return { sheets: sheets.map((s) => ({ ...s })), encoding: "utf-8", irregularRows: 0 };
  } finally {
    db.close();
  }
}
