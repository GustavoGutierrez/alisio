/**
 * Query side of the data engine (spec §17.3): runs one read-only statement on a dataset file.
 * The connection is opened `readOnly`, then `query_only=ON` and `trusted_schema=OFF`; extension
 * loading stays disabled (the `node:sqlite` default). The host kills the process when a statement
 * exceeds its time limit: `node:sqlite` offers no interrupt, progress handler or authorizer.
 */
import type { QueryRequest, QueryResult } from "./engine-types.ts";
import { guardSql } from "./sql-guard.ts";

const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
type Connection = InstanceType<typeof sqlite.DatabaseSync>;

const connections = new Map<string, Connection>();

function connect(path: string, heapBytes?: number): Connection {
  let db = connections.get(path);
  if (!db) {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    if (heapBytes) db.exec(`PRAGMA hard_heap_limit=${Math.floor(heapBytes)};`);
    connections.set(path, db);
  }
  return db;
}

/** Closes one connection (or all of them): the host does this before deleting a file. */
export function closeConnections(path?: string): void {
  for (const [key, db] of connections) {
    if (path && key !== path) continue;
    try {
      db.close();
    } catch {
      /* already closed */
    }
    connections.delete(key);
  }
}

export class QueryRejected extends Error {}

export function runQuery(req: QueryRequest): QueryResult {
  let sql = req.sql;
  if (req.guard) {
    const guarded = guardSql(sql);
    if (!guarded.ok) throw new QueryRejected(guarded.reason);
    sql = guarded.sql;
  }
  const db = connect(req.db, req.heapBytes);
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  const columns = statement.columns().map((c) => c.name);
  const rows: QueryResult["rows"] = [];
  let truncated = false;
  let clipped = false;
  const cell = (value: unknown): string | number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "bigint") {
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : value.toString();
    }
    if (typeof value === "number") return value;
    if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
    const text = String(value);
    if (text.length > req.cellChars) {
      clipped = true;
      return `${text.slice(0, req.cellChars)}…`;
    }
    return text;
  };
  // JS numbers bind as REAL, which `LIMIT`/`OFFSET` reject: integral values bind as INTEGER.
  const bound = (req.params ?? []).map((value) =>
    typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value,
  );
  for (const row of statement.iterate(...bound) as Iterable<unknown[]>) {
    if (rows.length >= req.maxRows) {
      truncated = true;
      break;
    }
    rows.push(row.map(cell));
  }
  return { columns, rows, truncated, clipped };
}
