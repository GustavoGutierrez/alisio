/**
 * Request validation without a schema library (the server adds no runtime dependencies).
 * Failures are 400 `validation_failed` with the offending field paths, never their values.
 */
import { HttpError } from "./http/errors.ts";

type Check = (value: unknown) => boolean;

export interface FieldSpec {
  check: Check;
  required?: boolean;
}

export const is = {
  string:
    (max = 100_000): Check =>
    (v) =>
      typeof v === "string" && v.length <= max,
  nonEmpty:
    (max = 100_000): Check =>
    (v) =>
      typeof v === "string" && v.trim().length > 0 && v.length <= max,
  boolean: (): Check => (v) => typeof v === "boolean",
  nullableString:
    (max = 1_000): Check =>
    (v) =>
      v === null || (typeof v === "string" && v.length <= max),
  oneOf:
    (values: readonly string[]): Check =>
    (v) =>
      typeof v === "string" && values.includes(v),
  requestId: (): Check => (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v),
  integer:
    (min: number, max: number): Check =>
    (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= min && v <= max,
  array:
    (item: Check, max = 100): Check =>
    (v) =>
      Array.isArray(v) && v.length <= max && v.every(item),
  object: (): Check => (v) => !!v && typeof v === "object" && !Array.isArray(v),
  any: (): Check => () => true,
};

/**
 * Validates a JSON object against `fields`: unknown keys and wrong types are rejected. Returns
 * the object typed as `T` (the caller's shape must match `fields`).
 */
export function validate<T>(body: unknown, fields: Record<string, FieldSpec>): T {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError("validation_failed", "Request body must be a JSON object", {
      fields: ["(body)"],
    });
  const record = body as Record<string, unknown>;
  const invalid: string[] = [];
  for (const key of Object.keys(record)) if (!(key in fields)) invalid.push(key);
  for (const [key, spec] of Object.entries(fields)) {
    const value = record[key];
    if (value === undefined) {
      if (spec.required) invalid.push(key);
    } else if (!spec.check(value)) invalid.push(key);
  }
  if (invalid.length)
    throw new HttpError("validation_failed", "Invalid request fields", { fields: invalid });
  return record as T;
}

/** An optional positive integer query parameter, clamped to `max`. */
export function queryInt(
  url: URL,
  name: string,
  fallback: number | undefined,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new HttpError("validation_failed", "Invalid query parameter", { fields: [name] });
  return Math.min(value, max);
}
