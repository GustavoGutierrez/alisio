import { spawnSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataError } from "../packages/core/src/analysis/data/engine-client.ts";
import { type DataFixture, dataFixture, pythonCommand } from "./data-helpers.ts";

let fixture: DataFixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

const rowsOf = async (f: DataFixture, id: string, sql: string) => {
  const record = f.service.getFor(id, "root-1");
  return (await f.service.query(record, sql)).rows;
};

describe("dataset ingestion (CSV, TSV, JSON, JSONL)", () => {
  it("stores values without loss and counts the text fallbacks", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest(
      "sales.csv",
      'code,amount,note\r\n007,10,"a, b"\r\n1,"1,234",x\r\n2,$12,"two\nlines"\r\n3,N/A,\r\n4,5.50,y\r\n',
    );
    expect(record.format).toBe("csv");
    expect(record.sheets).toEqual([{ name: "data", table: "data", rows: 5, columns: 3 }]);
    const q = (sql: string) => rowsOf(fixture as DataFixture, record.id, sql);
    expect((await q("SELECT code FROM data ORDER BY rowid")).map((r) => r[0])).toEqual([
      "007",
      1,
      2,
      3,
      4,
    ]);
    expect((await q("SELECT amount FROM data ORDER BY rowid")).map((r) => r[0])).toEqual([
      10,
      "1,234",
      "$12",
      "N/A",
      5.5,
    ]);
    expect((await q("SELECT note FROM data WHERE rowid=3"))[0]?.[0]).toBe("two\nlines");
    expect((await q("SELECT note FROM data WHERE rowid=4"))[0]?.[0]).toBeNull();
    const detail = fixture.service.detail(record);
    const amount = detail.sheetDetails[0]?.columns.find((c) => c.name === "amount");
    expect(amount).toMatchObject({ type: "text", nulls: 0, textFallbacks: 3, distinct: 5 });
    expect(amount?.top.length).toBeGreaterThan(0);
  });

  it("keeps clean numeric columns numeric so SUM and AVG work", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("n.csv", "id,price\n1,10\n2,20.5\n3,30\n");
    const [row] = await rowsOf(
      fixture,
      record.id,
      "SELECT sum(price), avg(price), typeof(id) FROM data",
    );
    expect(row).toEqual([60.5, 60.5 / 3, "integer"]);
    const detail = fixture.service.detail(record).sheetDetails[0]?.columns;
    expect(detail?.map((c) => c.type)).toEqual(["integer", "real"]);
    expect(detail?.[1]).toMatchObject({ min: "10", max: "30", mean: 60.5 / 3 });
  });

  it("reads UTF-8 and UTF-16 BOMs, CRLF, semicolons and windows-1252", async () => {
    fixture = await dataFixture();
    const cases: Array<[string, Uint8Array | string, string]> = [
      ["bom8.csv", "﻿a,b\r\n1,2\r\n", "a"],
      [
        "u16.csv",
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\r\n1,2\r\n", "utf16le")]),
        "a",
      ],
      ["semi.csv", "a;b\n1;2\n3;4\n", "a"],
      ["tabs.tsv", "a\tb\n1\t2\n", "a"],
    ];
    for (const [name, content, column] of cases) {
      const { record } = await fixture.ingest(name, content);
      const detail = fixture.service.detail(record);
      expect(
        detail.sheetDetails[0]?.columns.map((c) => c.name),
        name,
      ).toEqual(["a", "b"]);
      expect(
        (await rowsOf(fixture, record.id, `SELECT ${column} FROM data ORDER BY rowid`))[0]?.[0],
      ).toBe(1);
    }
    const latin = await fixture.ingest("latin.csv", Buffer.from("name\ncaf\xe9\n", "latin1"));
    expect(fixture.service.detail(latin.record).encoding).toBe("windows-1252");
    expect((await rowsOf(fixture, latin.record.id, "SELECT name FROM data"))[0]?.[0]).toBe("café");
    const semi = fixture.service.detail((await fixture.ingest("semi.csv", "a;b\n1;2\n")).record);
    expect(semi.delimiter).toBe(";");
  });

  it("builds safe column names and treats a numeric first row as data", async () => {
    fixture = await dataFixture();
    const named = await fixture.ingest(
      "h.csv",
      "Año de Venta,Total ($),Total ($),rowid,\n1,2,3,4,5\n",
    );
    const columns = fixture.service.detail(named.record).sheetDetails[0]?.columns ?? [];
    expect(columns.map((c) => c.name)).toEqual([
      "ano_de_venta",
      "total",
      "total_2",
      "rowid_2",
      "column_5",
    ]);
    expect(columns[0]?.label).toBe("Año de Venta");
    const bare = await fixture.ingest("bare.csv", "1,2\n3,4\n");
    expect(fixture.service.detail(bare.record).sheetDetails[0]).toMatchObject({
      rows: 2,
      columns: [{ name: "column_1" }, { name: "column_2" }],
    });
  });

  it("pads and trims irregular rows", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("irr.csv", "a,b\n1\n2,3,4\n5,6\n");
    expect(await rowsOf(fixture, record.id, "SELECT a, b FROM data ORDER BY rowid")).toEqual([
      [1, null],
      [2, 3],
      [5, 6],
    ]);
  });

  it("ingests JSON Lines with keys that appear later, and nested values as text", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest(
      "events.jsonl",
      '{"id":1,"name":"a"}\n{"id":2,"extra":{"k":[1,2]},"ok":true}\n\n{"id":"007"}\n',
    );
    const detail = fixture.service.detail(record).sheetDetails[0];
    expect(detail?.columns.map((c) => c.name)).toEqual(["id", "name", "extra", "ok"]);
    expect(
      await rowsOf(fixture, record.id, "SELECT id, name, extra, ok FROM data ORDER BY rowid"),
    ).toEqual([
      [1, "a", null, null],
      [2, null, '{"k":[1,2]}', "true"],
      ["007", null, null, null],
    ]);
  });

  it("ingests a JSON array and a JSON file that is really JSON Lines", async () => {
    fixture = await dataFixture();
    const array = await fixture.ingest("a.json", '[{"x":1.5},{"x":2},{"y":"s"}]');
    expect(await rowsOf(fixture, array.record.id, "SELECT x, y FROM data ORDER BY rowid")).toEqual([
      [1.5, null],
      [2, null],
      [null, "s"],
    ]);
    const lines = await fixture.ingest("b.json", '{"x":1}\n{"x":2}\n');
    expect((await rowsOf(fixture, lines.record.id, "SELECT count(*) FROM data"))[0]?.[0]).toBe(2);
    await expect(fixture.ingest("bad.json", "{not json")).rejects.toThrow(DataError);
  });

  it("leaves no dataset behind when a limit is exceeded", async () => {
    fixture = await dataFixture({ limits: { maxRows: 5, maxUploadBytes: 2000 } });
    await expect(fixture.ingest("many.csv", "a\n1\n2\n3\n4\n5\n6\n7\n")).rejects.toMatchObject({
      code: "ingest_limit",
    });
    await expect(fixture.ingest("huge.csv", `a\n${"x".repeat(3000)}\n`)).rejects.toMatchObject({
      code: "ingest_limit",
    });
    expect(fixture.service.list("root-1")).toEqual([]);
    const dir = join(fixture.root, "analysis", "datasets");
    const files = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
    expect(files.filter((f) => f.endsWith(".sqlite") || f.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects unsupported and empty files with a clear code", async () => {
    fixture = await dataFixture();
    await expect(fixture.ingest("a.parquet", "x")).rejects.toMatchObject({
      code: "dataset_unsupported",
    });
    await expect(fixture.ingest("a.csv", "")).rejects.toMatchObject({ code: "ingest_invalid" });
    await expect(fixture.ingest("a.csv", "\n\n")).rejects.toMatchObject({ code: "ingest_invalid" });
  });

  it("reuses a dataset with the same content within a session only", async () => {
    fixture = await dataFixture();
    const first = await fixture.ingest("a.csv", "x\n1\n");
    const again = await fixture.ingest("copy.csv", "x\n1\n");
    expect(again.reused).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    const other = await fixture.ingest("a.csv", "x\n1\n", { root: "root-2" });
    expect(other.reused).toBe(false);
    expect(other.record.id).not.toBe(first.record.id);
  });

  it("shares one ingestion between concurrent calls and keeps the file read-only on disk", async () => {
    fixture = await dataFixture();
    const path = await fixture.write("c.csv", "x\n1\n2\n");
    const input = { rootSessionId: "root-1", sessionId: "root-1", workspace: "/w", path };
    const [a, b] = await Promise.all([
      fixture.service.ingest(input),
      fixture.service.ingest(input),
    ]);
    expect(a.record.id).toBe(b.record.id);
    const info = await stat(fixture.service.file(a.record));
    if (process.platform !== "win32") expect(info.mode & 0o222).toBe(0);
  });

  it("can delete and replace dataset files while the query engine is running", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("a.csv", "x\n1\n");
    await rowsOf(fixture, record.id, "SELECT * FROM data");
    await fixture.service.remove(record);
    expect(fixture.service.get(record.id)).toBeUndefined();
    const again = await fixture.ingest("a.csv", "x\n1\n");
    expect(await rowsOf(fixture, again.record.id, "SELECT x FROM data")).toEqual([[1]]);
  });
});

describe.skipIf(!pythonCommand)("Python reads the same dataset file (stdlib sqlite3)", () => {
  it("opens it read-only and sees the exact values and the metadata", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("p.csv", "code,n\n007,1\n8,2\n");
    const script = [
      "import sqlite3, sys, json",
      `db = sqlite3.connect('file:${fixture.service.file(record).replaceAll("\\", "/")}?mode=ro&immutable=1', uri=True)`,
      "rows = db.execute('SELECT code, n, typeof(code) FROM data ORDER BY rowid').fetchall()",
      "cols = db.execute('SELECT name, inferred_type FROM _alisio_columns ORDER BY ordinal').fetchall()",
      "try:",
      "    db.execute('CREATE TABLE x(a)')",
      "    writable = True",
      "except sqlite3.OperationalError:",
      "    writable = False",
      "print(json.dumps([rows, cols, writable]))",
    ].join("\n");
    const run = spawnSync(
      pythonCommand as string,
      [...(pythonCommand === "py" ? ["-3"] : []), "-c", script],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      [
        ["007", 1, "text"],
        [8, 2, "integer"],
      ],
      [
        ["code", "text"],
        ["n", "integer"],
      ],
      false,
    ]);
  });
});
