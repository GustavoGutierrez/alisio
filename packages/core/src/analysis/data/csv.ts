/**
 * Streaming CSV/TSV parser (RFC 4180, spec §17.2): quoted fields, doubled quotes, line breaks
 * inside quotes, CRLF/LF/CR rows. No dependencies and no I/O: callers push decoded text chunks
 * (any split, even inside a quote or between CR and LF) and receive rows through a callback.
 * Blank lines are skipped. Lenient on purpose: a stray quote inside an unquoted field is literal
 * and text after a closing quote is appended.
 */

const QUOTE = 34;
const CR = 13;
const LF = 10;

const enum State {
  /** Before the first character of a field. */
  Start,
  Unquoted,
  Quoted,
  /** Right after a `"` inside a quoted field: either an escaped quote or the closing one. */
  QuoteInQuoted,
}

export class CsvError extends Error {
  constructor(
    message: string,
    readonly code: "cell_too_large",
  ) {
    super(message);
  }
}

export class CsvParser {
  private state: State = State.Start;
  private field = "";
  private fields: string[] = [];
  private skipLineFeed = false;
  /** The current field was opened with a quote (so `""` is a value, not a blank line). */
  private quotedField = false;
  private readonly delimiter: number;
  /** Rows delivered so far (blank lines excluded). */
  rows = 0;

  constructor(
    delimiter: string,
    private readonly onRow: (fields: string[]) => void,
    private readonly maxCellChars = 1024 * 1024,
  ) {
    if (delimiter.length !== 1) throw new Error("The CSV delimiter must be one character");
    this.delimiter = delimiter.charCodeAt(0);
  }

  private add(text: string): void {
    this.field += text;
    if (this.field.length > this.maxCellChars)
      throw new CsvError(
        `A cell in row ${this.rows + 1} exceeds ${this.maxCellChars} characters`,
        "cell_too_large",
      );
  }

  private endField(): void {
    this.fields.push(this.field);
    this.field = "";
    this.quotedField = false;
  }

  private endRow(): void {
    const blank = this.fields.length === 0 && this.field === "" && !this.quotedField;
    if (!blank) {
      this.endField();
      this.rows++;
      const row = this.fields;
      this.fields = [];
      this.state = State.Start;
      this.onRow(row);
      return;
    }
    this.state = State.Start;
    this.quotedField = false;
  }

  write(chunk: string): void {
    const n = chunk.length;
    let i = 0;
    if (this.skipLineFeed && n > 0) {
      if (chunk.charCodeAt(0) === LF) i = 1;
      this.skipLineFeed = false;
    }
    while (i < n) {
      switch (this.state) {
        case State.Start: {
          if (chunk.charCodeAt(i) === QUOTE) {
            this.state = State.Quoted;
            this.quotedField = true;
            i++;
          } else this.state = State.Unquoted;
          break;
        }
        case State.Unquoted: {
          let j = i;
          let c = 0;
          while (j < n) {
            c = chunk.charCodeAt(j);
            if (c === this.delimiter || c === LF || c === CR) break;
            j++;
          }
          if (j > i) this.add(chunk.slice(i, j));
          i = j;
          if (j >= n) break;
          if (c === this.delimiter) {
            this.endField();
            this.state = State.Start;
            i++;
          } else {
            i++;
            if (c === CR) {
              if (i < n && chunk.charCodeAt(i) === LF) i++;
              else if (i >= n) this.skipLineFeed = true;
            }
            this.endRow();
          }
          break;
        }
        case State.Quoted: {
          const quote = chunk.indexOf('"', i);
          if (quote < 0) {
            this.add(chunk.slice(i));
            i = n;
          } else {
            if (quote > i) this.add(chunk.slice(i, quote));
            i = quote + 1;
            this.state = State.QuoteInQuoted;
          }
          break;
        }
        case State.QuoteInQuoted: {
          const c = chunk.charCodeAt(i);
          if (c === QUOTE) {
            this.add('"');
            this.state = State.Quoted;
            i++;
          } else if (c === this.delimiter) {
            this.endField();
            this.state = State.Start;
            i++;
          } else if (c === LF || c === CR) {
            i++;
            if (c === CR) {
              if (i < n && chunk.charCodeAt(i) === LF) i++;
              else if (i >= n) this.skipLineFeed = true;
            }
            // A quoted-empty field ("") is a real, empty value: the row is not blank.
            this.state = State.Unquoted;
            this.endRow();
          } else {
            // Text after the closing quote: keep it (lenient).
            this.state = State.Unquoted;
          }
          break;
        }
      }
    }
  }

  /** Flushes the last row when the input has no final line break. */
  end(): void {
    if (this.fields.length === 0 && this.field === "" && !this.quotedField) return;
    this.endRow();
  }
}

/** Parses a whole string (tests and small inputs). */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  const parser = new CsvParser(delimiter, (row) => rows.push(row));
  parser.write(text);
  parser.end();
  return rows;
}

const CANDIDATES = [",", ";", "\t", "|"] as const;

/**
 * Detects the delimiter from a text sample (the first 64 KiB): the candidate that splits most
 * rows into the same number (> 1) of fields wins; ties keep the order `,` `;` TAB `|`.
 */
export function detectDelimiter(sample: string): string {
  let best = ",";
  let bestScore = 0;
  for (const candidate of CANDIDATES) {
    const counts = new Map<number, number>();
    let rows = 0;
    const parser = new CsvParser(candidate, (row) => {
      rows++;
      counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    });
    try {
      parser.write(sample);
    } catch {
      continue;
    }
    // The last row may be cut by the sample boundary: it is never flushed (no end()).
    if (rows < 1) continue;
    let width = 0;
    let frequency = 0;
    for (const [w, count] of counts)
      if (w > 1 && (count > frequency || (count === frequency && w > width))) {
        width = w;
        frequency = count;
      }
    const score = frequency * 1000 + width;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Decodes a byte sample as the ingestion does: UTF-8 (BOM removed), UTF-16 by BOM, or
 * windows-1252 when the bytes are not valid UTF-8. A sample cut inside a character is tolerated.
 */
export function decodeTextBytes(
  bytes: Uint8Array,
  truncated = false,
): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }),
      encoding: "utf-8",
    };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}
