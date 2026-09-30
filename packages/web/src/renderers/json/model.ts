/** Pure helpers of the `json` tree renderer (spec §10.4): children, previews and JSONPath. */

export type JsonKey = string | number;

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `$.a[0]["b c"]` for a path of keys (strings) and indexes (numbers). */
export function jsonPath(path: JsonKey[]): string {
  return path.reduce<string>(
    (out, key) =>
      typeof key === "number"
        ? `${out}[${key}]`
        : IDENT.test(key)
          ? `${out}.${key}`
          : `${out}[${JSON.stringify(key)}]`,
    "$",
  );
}

export const isContainer = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

/** Children of an object/array, capped at `limit` (spec: nodes > 1 000 children truncate). */
export function childEntries(
  value: unknown,
  limit = 1000,
): { entries: Array<[JsonKey, unknown]>; more: number } {
  if (!isContainer(value)) return { entries: [], more: 0 };
  const all: Array<[JsonKey, unknown]> = Array.isArray(value)
    ? value.map((v, i): [JsonKey, unknown] => [i, v])
    : Object.entries(value as Record<string, unknown>);
  return { entries: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One-line summary of a value: collapsed containers show their size, strings are clipped. */
export function jsonPreview(value: unknown, max = 80): string {
  if (Array.isArray(value)) return `[…] ${plural(value.length, "item", "items")}`;
  if (isContainer(value)) return `{…} ${plural(Object.keys(value).length, "key", "keys")}`;
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
