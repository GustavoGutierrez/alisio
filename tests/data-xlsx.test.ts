import { afterEach, describe, expect, it } from "vitest";
import { XLSX_REMEDY } from "../packages/core/src/analysis/data/datasets.ts";
import { type DataFixture, dataFixture, pythonCommand, realPython } from "./data-helpers.ts";
import { buildXlsx } from "./xlsx-helpers.ts";

let fixture: DataFixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

const withPython = realPython;

describe("XLSX without Python", () => {
  it("answers dataset_unsupported with the remedy", async () => {
    fixture = await dataFixture();
    const bytes = await buildXlsx([{ name: "S", rows: [["a"], [1]] }]);
    await expect(fixture.ingest("book.xlsx", bytes)).rejects.toMatchObject({
      code: "dataset_unsupported",
      message: expect.stringContaining(XLSX_REMEDY),
    });
    expect(fixture.service.list("root-1")).toEqual([]);
  });

  it("also fails cleanly when the interpreter is unusable", async () => {
    fixture = await dataFixture({
      python: { interpreter: async () => ({ ok: false as const, reason: "none" }) },
    });
    const bytes = await buildXlsx([{ name: "S", rows: [["a"], [1]] }]);
    await expect(fixture.ingest("book.xlsx", bytes)).rejects.toMatchObject({
      code: "dataset_unsupported",
    });
  });
});

describe.skipIf(!pythonCommand)("XLSX through the Python standard-library helper", () => {
  it("reads sheets, shared and inline strings, numbers, dates, booleans and formulas", async () => {
    fixture = await dataFixture({ python: withPython });
    const bytes = await buildXlsx([
      {
        name: "Sales 2024",
        rows: [
          ["code", "amount", "day", "flag", "calc", "note"],
          ["007", 10, { date: 45292 }, true, { formula: "B2*2", value: 20 }, { inline: "x & y" }],
          ["1,234", 5.5, { date: 45292.5 }, false, { formula: "B3*2", value: 11 }, null],
          ["$12", "N/A", null, null, null, "tail"],
        ],
      },
      { name: "Notes", rows: [["k"], ["v1"], ["v2"]] },
    ]);
    const { record } = await fixture.ingest("book.xlsx", bytes);
    expect(record.format).toBe("xlsx");
    expect(record.sheets).toEqual([
      { name: "Sales 2024", table: "s_sales_2024", rows: 3, columns: 6 },
      { name: "Notes", table: "s_notes", rows: 2, columns: 1 },
    ]);
    const q = async (sql: string) => (await fixture?.service.query(record, sql))?.rows;
    expect(
      await q("SELECT code, amount, day, flag, calc, note FROM s_sales_2024 ORDER BY rowid"),
    ).toEqual([
      ["007", 10, "2024-01-01", "TRUE", 20, "x & y"],
      ["1,234", 5.5, "2024-01-01T12:00:00", "FALSE", 11, null],
      ["$12", "N/A", null, null, null, "tail"],
    ]);
    expect(await q("SELECT typeof(amount) FROM s_sales_2024 ORDER BY rowid")).toEqual([
      ["integer"],
      ["real"],
      ["text"],
    ]);
    expect(await q("SELECT k FROM s_notes ORDER BY rowid")).toEqual([["v1"], ["v2"]]);
    const columns = fixture.service.detail(record).sheetDetails[0]?.columns ?? [];
    expect(columns.find((c) => c.name === "day")?.type).toBe("date");
  });

  it("honours the 1904 date epoch", async () => {
    fixture = await dataFixture({ python: withPython });
    const bytes = await buildXlsx([{ name: "S", rows: [["d"], [{ date: 0 }], [{ date: 1 }]] }], {
      date1904: true,
    });
    const { record } = await fixture.ingest("d.xlsx", bytes);
    expect((await fixture.service.query(record, "SELECT d FROM s_s ORDER BY rowid")).rows).toEqual([
      ["1904-01-01"],
      ["1904-01-02"],
    ]);
  });

  it("produces the same columns, types and statistics as the CSV export of the sheet", async () => {
    fixture = await dataFixture({ python: withPython });
    const header = ["id", "region", "revenue", "code", "note"];
    const body: Array<Array<string | number | null>> = [];
    const regions = ["West", "East", "North", "South"];
    for (let i = 1; i <= 120; i++)
      body.push([
        i,
        regions[i % 4] as string,
        i % 7 === 0 ? "N/A" : i * 2.5,
        i % 5 === 0 ? `00${i}` : `${i}`,
        i % 3 === 0 ? null : `n${i % 9}`,
      ]);
    const xlsx = await buildXlsx([{ name: "Data", rows: [header, ...body] }]);
    const csv = [
      header.join(","),
      ...body.map((r) => r.map((v) => (v === null ? "" : String(v))).join(",")),
    ].join("\n");
    const fromXlsx = await fixture.ingest("t.xlsx", xlsx);
    const fromCsv = await fixture.ingest("t.csv", `${csv}\n`);
    const summary = (record: typeof fromXlsx.record) =>
      fixture?.service
        .detail(record)
        .sheetDetails[0]?.columns.map(
          ({ name, label, type, nulls, distinct, min, max, mean, textFallbacks, top }) => ({
            name,
            label,
            type,
            nulls,
            distinct,
            min,
            max,
            mean,
            textFallbacks,
            top,
          }),
        );
    expect(summary(fromXlsx.record)).toEqual(summary(fromCsv.record));
    expect(fromXlsx.record.sheets[0]?.rows).toBe(fromCsv.record.sheets[0]?.rows);
  });

  it("rejects a workbook that compresses suspiciously well (zip bomb)", async () => {
    fixture = await dataFixture({ python: withPython });
    const filler = Buffer.alloc(70 * 1024 * 1024, 0x20);
    const bytes = await buildXlsx([{ name: "S", rows: [["a"], [1]] }], {
      extraParts: [{ name: "xl/junk.bin", data: filler }],
    });
    await expect(fixture.ingest("bomb.xlsx", bytes)).rejects.toMatchObject({
      code: "ingest_invalid",
      message: expect.stringMatching(/zip bomb/i),
    });
  });

  it("rejects XML with a DOCTYPE and files that are not workbooks", async () => {
    fixture = await dataFixture({ python: withPython });
    const evil = await buildXlsx([{ name: "S", rows: [["a"]] }], {
      extraParts: [
        {
          name: "xl/sharedStrings.xml",
          data: Buffer.from('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><sst/>'),
        },
      ],
    });
    // The later duplicate entry wins in zipfile; the helper must refuse the DOCTYPE either way.
    await expect(fixture.ingest("evil.xlsx", evil)).rejects.toMatchObject({
      code: "ingest_invalid",
    });
    await expect(fixture.ingest("fake.xlsx", "not a zip")).rejects.toMatchObject({
      code: "ingest_invalid",
    });
  });

  it("stops at maxRows without leaving a dataset", async () => {
    fixture = await dataFixture({ python: withPython, limits: { maxRows: 3 } });
    const rows = [["a"], ...Array.from({ length: 6 }, (_, i) => [i + 1])];
    await expect(
      fixture.ingest("many.xlsx", await buildXlsx([{ name: "S", rows }])),
    ).rejects.toMatchObject({
      code: "ingest_invalid",
    });
    expect(fixture.service.list("root-1")).toEqual([]);
  });
});
