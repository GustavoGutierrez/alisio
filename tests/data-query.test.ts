import { afterEach, describe, expect, it } from "vitest";
import { type DataFixture, dataFixture } from "./data-helpers.ts";

let fixture: DataFixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

const setup = async (limits = {}) => {
  fixture = await dataFixture({ limits });
  const { record } = await fixture.ingest("t.csv", "region,revenue\nWest,10\nEast,20\nWest,5\n");
  return { f: fixture, record };
};

describe("data_query on a dataset", () => {
  it("runs a read-only SELECT and a WITH query", async () => {
    const { f, record } = await setup();
    const grouped = await f.service.query(
      record,
      "SELECT region, sum(revenue) AS total FROM data GROUP BY region ORDER BY region",
    );
    expect(grouped).toMatchObject({
      columns: ["region", "total"],
      rows: [
        ["East", 20],
        ["West", 15],
      ],
      truncated: false,
    });
    const cte = await f.service.query(
      record,
      "WITH x AS (SELECT count(*) n FROM data) SELECT n FROM x;",
    );
    expect(cte.rows).toEqual([[3]]);
  });

  it("rejects writes, extra statements, ATTACH, PRAGMA and extensions before touching the file", async () => {
    const { f, record } = await setup();
    for (const sql of [
      "SELECT 1; DROP TABLE data",
      "ATTACH 'x' AS y",
      "PRAGMA writable_schema=1",
      "WITH x AS (DELETE FROM data RETURNING *) SELECT * FROM x",
      "SELECT load_extension('x')",
    ])
      await expect(f.service.query(record, sql), sql).rejects.toMatchObject({
        code: "query_rejected",
      });
    expect((await f.service.query(record, "SELECT count(*) FROM data")).rows).toEqual([[3]]);
  });

  it("is read-only at the connection level even without the lexical guard", async () => {
    const { f, record } = await setup();
    await expect(
      f.service.engine.runQuery(
        {
          db: f.service.file(record),
          sql: "INSERT INTO data VALUES ('x', 1)",
          maxRows: 1,
          cellChars: 10,
          guard: false,
        },
        { timeoutMs: 5000 },
      ),
    ).rejects.toMatchObject({ code: "sql_error", message: expect.stringMatching(/readonly/i) });
  });

  it("truncates at maxRows and reports it", async () => {
    const { f, record } = await setup();
    const result = await f.service.query(record, "SELECT * FROM data", { maxRows: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("shortens very long cells", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("long.csv", `a\n${"x".repeat(5000)}\n`);
    const result = await fixture.service.query(record, "SELECT a FROM data");
    expect(String(result.rows[0]?.[0])).toHaveLength(2049);
    expect(result.clipped).toBe(true);
  });

  it("reports SQL errors with the SQLite message", async () => {
    const { f, record } = await setup();
    await expect(f.service.query(record, "SELECT nope FROM data")).rejects.toMatchObject({
      code: "sql_error",
      message: expect.stringMatching(/no such column: nope/),
    });
  });

  it("stops a runaway recursive query within the time limit and keeps working", async () => {
    const { f, record } = await setup({ queryTimeoutMs: 500 });
    const started = Date.now();
    await expect(
      f.service.query(
        record,
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
      ),
    ).rejects.toMatchObject({ code: "query_timeout" });
    expect(Date.now() - started).toBeLessThanOrEqual(500 + 1000);
    const next = await f.service.query(record, "SELECT count(*) FROM data");
    expect(next.rows).toEqual([[3]]);
  });

  it("treats a dataset of another session as not found", async () => {
    const { f, record } = await setup();
    expect(() => f.service.getFor(record.id, "root-2")).toThrowError(/not found/);
    expect(() => f.service.getFor(record.id, "root-2")).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});
