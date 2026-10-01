/**
 * SQLite adapter over `node:sqlite`, which both Node (>=22.16 for FTS5) and Bun provide.
 * Implements the SDK storage port so plugins never import a driver.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SqlDatabase, SqlStatement, SqlValue } from "@alisio/sdk";

export function isSqliteExperimentalWarning(message: string, type?: string): boolean {
  return type === "ExperimentalWarning" && /^SQLite is an experimental feature/.test(message);
}
type Sqlite = typeof import("node:sqlite");
let module: Sqlite | undefined;
/** Loads node:sqlite once, dropping only its ExperimentalWarning; other warnings pass through. */
function sqlite(): Sqlite {
  if (module) return module;
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const message = typeof warning === "string" ? warning : warning.message;
    const option = rest[0];
    const type =
      typeof option === "string"
        ? option
        : typeof warning !== "string"
          ? warning.name
          : ((option as { type?: string } | undefined)?.type ?? undefined);
    if (isSqliteExperimentalWarning(message, type)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    module = process.getBuiltinModule("node:sqlite") as Sqlite;
  } finally {
    process.emitWarning = original;
  }
  return module;
}
const plain = (row: unknown) =>
  row === undefined || row === null ? undefined : { ...(row as Record<string, unknown>) };

/** Opens an existing database file read-only (no directory or file is created). */
export function openReadOnlyDatabase(path: string): SqlDatabase {
  const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
  db.exec("PRAGMA query_only=ON;");
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const raw = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => raw.run(...params),
        get: (...params: SqlValue[]) => plain(raw.get(...params)),
        all: (...params: SqlValue[]) => raw.all(...params).map((r) => ({ ...r })),
      };
    },
    transaction: <T>(fn: () => T): T => fn(),
    close: () => db.close(),
  };
}

export function openDatabase(path: string): SqlDatabase {
  const memory = path === ":memory:";
  const fresh = !memory && !existsSync(path);
  if (!memory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new (sqlite().DatabaseSync)(path);
  if (fresh) chmodSync(path, 0o600);
  const cache = new Map<string, SqlStatement>();
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      let statement = cache.get(sql);
      if (!statement) {
        const raw = db.prepare(sql);
        statement = {
          run: (...params: SqlValue[]) => raw.run(...params),
          get: (...params: SqlValue[]) => plain(raw.get(...params)),
          all: (...params: SqlValue[]) => raw.all(...params).map((r) => ({ ...r })),
        };
        cache.set(sql, statement);
      }
      return statement;
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    close: () => {
      cache.clear();
      db.close();
    },
  };
}
