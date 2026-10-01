/**
 * Cell conversion, identifier sanitising and type hints of the dataset ingestion (spec §17.2).
 * Pure functions with no imports, shared by the ingestion engine (a separate process) and the
 * tests. Values are stored without loss: a cell becomes a number only when its text is a plain
 * number (no leading zeros, no separators, safe range); otherwise the exact text is kept.
 */

/** Plain decimal number: optional minus, no leading zeros, optional fraction and exponent. */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const INTEGER = /^-?(?:0|[1-9]\d*)$/;
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const BOOLEAN = /^(?:true|false)$/i;

/** A value ready to bind: `bigint` (stored as INTEGER), `number` (REAL), text or `null`. */
export type StoredValue = bigint | number | string | null;

export interface ConvertedCell {
  value: StoredValue;
}

/**
 * Converts one CSV/XLSX text cell. Empty → `null`; plain integers in the safe range → INTEGER
 * (`bigint`, because node:sqlite binds JS numbers as REAL); plain decimals → REAL; anything else
 * (`007`, `1,234`, `$12`, `N/A`, `-0`, `1e999`, unsafe integers) keeps its exact text. The only
 * documented normalisation is `1.50` → `1.5`.
 */
export function convertCell(raw: string): StoredValue {
  if (raw === "") return null;
  if (!NUMBER.test(raw)) return raw;
  if (INTEGER.test(raw)) {
    if (raw === "-0") return raw;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? BigInt(raw) : raw;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

/** A JSON value stored without loss: numbers stay numbers, nested values become JSON text. */
export function convertJson(value: unknown): StoredValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return Number.isSafeInteger(value) && !Object.is(value, -0) ? BigInt(value) : value;
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

/** Whether every non-empty cell of a row is a plain number (then the row is data, not a header). */
export function looksLikeData(row: string[]): boolean {
  const cells = row.filter((cell) => cell !== "");
  return cells.length > 0 && cells.every((cell) => NUMBER.test(cell));
}

/** `region`, `año` → `ano`, `Total ($)` → `total`; never empty, never starts with a digit. */
export function sanitizeIdentifier(label: string, fallback: string): string {
  let id = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!id) return fallback;
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** Deduplicates names in order (`x`, `x_2`, `x_3`); `taken` carries names across calls. */
export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}_${n}`;
  taken.add(candidate);
  return candidate;
}

export type InferredType = "integer" | "real" | "date" | "boolean" | "text";

/**
 * Type hint of a column from the storage class and value of its first cells (`kind` is SQLite's
 * `typeof`). All integers → `integer`; all numbers → `real`; all dates / booleans → those;
 * anything mixed or empty → `text`.
 */
export function inferType(sample: Array<{ kind: string; value: unknown }>): InferredType {
  let integers = 0,
    reals = 0,
    texts = 0,
    dates = 0,
    booleans = 0;
  for (const { kind, value } of sample) {
    if (kind === "null") continue;
    if (kind === "integer") integers++;
    else if (kind === "real") reals++;
    else if (kind === "text") {
      texts++;
      const text = String(value);
      if (ISO_DATE.test(text)) dates++;
      else if (BOOLEAN.test(text)) booleans++;
    } else return "text";
  }
  const total = integers + reals + texts;
  if (!total) return "text";
  if (texts === 0) return reals === 0 ? "integer" : "real";
  if (integers + reals > 0) return "text";
  if (dates === texts) return "date";
  if (booleans === texts) return "boolean";
  return "text";
}

/** Names SQLite reserves for the row id: a column named so would shadow it. */
export const RESERVED_NAMES = ["rowid", "oid", "_rowid_"] as const;

/** A fresh set of taken column names, pre-seeded with the reserved ones. */
export const newTakenNames = (): Set<string> => new Set<string>(RESERVED_NAMES);

/** Double-quotes an SQL identifier. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
