import { describe, expect, it } from "vitest";
import {
  CsvError,
  CsvParser,
  decodeTextBytes,
  detectDelimiter,
  parseCsv,
} from "../packages/core/src/analysis/data/csv.ts";
import {
  convertCell,
  convertJson,
  inferType,
  looksLikeData,
  sanitizeIdentifier,
  uniqueName,
} from "../packages/core/src/analysis/data/infer.ts";

describe("CSV parser (RFC 4180)", () => {
  it("handles quotes, doubled quotes and line breaks inside fields", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",z\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["two\nlines", "z"],
    ]);
  });

  it("accepts CRLF, LF and lone CR and skips blank lines", () => {
    expect(parseCsv("a,b\r\n1,2\r\n\r\n3,4\r5,6")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("keeps empty values, including a quoted empty field", () => {
    expect(parseCsv('a,,c\n"",x,\n')).toEqual([
      ["a", "", "c"],
      ["", "x", ""],
    ]);
  });

  it("gives the same rows however the input is split into chunks", () => {
    const text = 'id;name\r\n1;"Ana ""Q"""\r\n2;"multi\r\nline"\r\n3;x';
    const whole = parseCsv(text, ";");
    for (let size = 1; size <= 7; size++) {
      const rows: string[][] = [];
      const parser = new CsvParser(";", (row) => rows.push(row));
      for (let i = 0; i < text.length; i += size) parser.write(text.slice(i, i + size));
      parser.end();
      expect(rows).toEqual(whole);
    }
  });

  it("rejects a cell larger than the limit", () => {
    const parser = new CsvParser(",", () => undefined, 10);
    expect(() => parser.write(`a,${"x".repeat(11)}\n`)).toThrow(CsvError);
  });

  it("is lenient with a stray quote inside an unquoted field", () => {
    expect(parseCsv('5" pipe,ok\n')).toEqual([['5" pipe', "ok"]]);
  });
});

describe("delimiter and encoding", () => {
  it.each([
    ["a,b,c\n1,2,3\n4,5,6\n", ","],
    ["a;b;c\n1;2;3\n4;5;6\n", ";"],
    ["a\tb\tc\n1\t2\t3\n", "\t"],
    ["a|b\n1|2\n3|4\n", "|"],
    ['"a,b";c\n"1,2";3\n"4,5";6\n', ";"],
    ["single\nvalue\n", ","],
  ])("detects the delimiter of %j", (sample, expected) => {
    expect(detectDelimiter(sample)).toBe(expected);
  });

  it("removes the UTF-8 BOM and decodes UTF-16 by BOM", () => {
    expect(decodeTextBytes(Buffer.from("﻿a,b")).text).toBe("a,b");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,ñ", "utf16le")]);
    expect(decodeTextBytes(utf16)).toEqual({ text: "a,ñ", encoding: "utf-16le" });
  });

  it("falls back to windows-1252 when the bytes are not UTF-8", () => {
    expect(decodeTextBytes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toEqual({
      text: "café",
      encoding: "windows-1252",
    });
  });
});

describe("lossless cell conversion", () => {
  it("stores plain numbers as numbers and everything else as the exact text", () => {
    expect(convertCell("42")).toBe(42n);
    expect(convertCell("-7")).toBe(-7n);
    expect(convertCell("1.50")).toBe(1.5);
    expect(convertCell("2e3")).toBe(2000);
    expect(convertCell("")).toBeNull();
    for (const text of [
      "007",
      "1,234",
      "$12",
      "N/A",
      "+5",
      ".5",
      "5.",
      "-0",
      "12 ",
      "9007199254740993",
    ])
      expect(convertCell(text)).toBe(text);
  });

  it("converts JSON values: numbers stay numbers, booleans and nested values become text", () => {
    expect(convertJson(5)).toBe(5n);
    expect(convertJson(2.5)).toBe(2.5);
    expect(convertJson("007")).toBe("007");
    expect(convertJson(true)).toBe("true");
    expect(convertJson({ a: [1] })).toBe('{"a":[1]}');
    expect(convertJson(null)).toBeNull();
  });

  it("treats a first row of numbers as data, not as a header", () => {
    expect(looksLikeData(["1", "2.5", ""])).toBe(true);
    expect(looksLikeData(["id", "1"])).toBe(false);
    expect(looksLikeData(["", ""])).toBe(false);
  });

  it("builds safe, unique, ASCII identifiers", () => {
    expect(sanitizeIdentifier("Año de Venta", "c")).toBe("ano_de_venta");
    expect(sanitizeIdentifier("2024 total ($)", "c")).toBe("_2024_total");
    expect(sanitizeIdentifier("???", "column_3")).toBe("column_3");
    const taken = new Set<string>();
    expect([uniqueName("x", taken), uniqueName("x", taken), uniqueName("x", taken)]).toEqual([
      "x",
      "x_2",
      "x_3",
    ]);
  });

  it("infers a type hint from the stored cells", () => {
    const cells = (kind: string, values: unknown[]) => values.map((value) => ({ kind, value }));
    expect(inferType(cells("integer", [1, 2]))).toBe("integer");
    expect(inferType([...cells("integer", [1]), ...cells("real", [1.5])])).toBe("real");
    expect(inferType(cells("text", ["2024-01-05", "2024-02-01T10:00:00Z"]))).toBe("date");
    expect(inferType(cells("text", ["TRUE", "false"]))).toBe("boolean");
    expect(inferType([...cells("integer", [1]), ...cells("text", ["N/A"])])).toBe("text");
    expect(inferType(cells("null", [null]))).toBe("text");
  });
});
