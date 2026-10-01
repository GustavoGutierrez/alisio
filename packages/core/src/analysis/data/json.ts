/**
 * JSON and JSON Lines helpers of the dataset ingestion (spec §17.2). Pure: the ingestion engine
 * feeds decoded text and gets records back. Nested values are stored as JSON text by the caller.
 */

/** Splits streamed text into lines (`\n` or `\r\n`); the last partial line waits for more text. */
export class LineSplitter {
  private rest = "";
  constructor(private readonly onLine: (line: string) => void) {}
  write(chunk: string): void {
    const text = this.rest + chunk;
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      if (end < 0) break;
      const stop = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
      this.onLine(text.slice(start, stop));
      start = end + 1;
    }
    this.rest = start === 0 ? text : text.slice(start);
  }
  end(): void {
    if (this.rest) this.onLine(this.rest.endsWith("\r") ? this.rest.slice(0, -1) : this.rest);
    this.rest = "";
  }
}

/** A plain object stays as it is; any other JSON value becomes `{ value }`. */
export function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

/**
 * The records of a JSON document: an array (each element a record) or a single object (one
 * record). Throws a `SyntaxError` for invalid JSON.
 */
export function jsonDocumentRecords(text: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed.map(toRecord) : [toRecord(parsed)];
}
