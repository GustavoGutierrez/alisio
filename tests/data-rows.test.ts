import { afterEach, describe, expect, it } from "vitest";
import {
  buildCountQuery,
  buildPageQuery,
  decodeCursor,
  encodeCursor,
  PageParamError,
} from "../packages/core/src/analysis/data/rows.ts";
import { bigCsv, type DataFixture, dataFixture } from "./data-helpers.ts";

let fixture: DataFixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

/** 1 050 rows: many duplicate keys, NULLs, numbers mixed with text. */
function messyCsv(): string {
  const lines = ["id,k,label"];
  for (let i = 1; i <= 1050; i++) {
    const k = i % 11 === 0 ? "" : i % 13 === 0 ? `t${i % 5}` : String((i * 37) % 20);
    lines.push(`${i},${k},row ${i}`);
  }
  return `${lines.join("\n")}\n`;
}

async function collect(
  f: DataFixture,
  id: string,
  query: { sort?: string; dir?: "asc" | "desc"; filter?: string; column?: string },
  limit = 97,
) {
  const record = f.service.getFor(id, "root-1");
  const rowids: number[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await f.service.page(record, { ...query, limit, ...(after ? { after } : {}) });
    rowids.push(...page.rowids);
    if (!page.next) return rowids;
    after = page.next;
  }
  throw new Error("paging never ended");
}

describe("keyset paging for SpreadsheetView", () => {
  it("pages the unsorted sheet in file order without gaps", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("m.csv", messyCsv());
    const ids = await collect(fixture, record.id, {});
    expect(ids).toEqual(Array.from({ length: 1050 }, (_, i) => i + 1));
  });

  it.each(["asc", "desc"] as const)(
    "pages a sort (%s) with ties, NULLs and mixed types exactly once",
    async (dir) => {
      fixture = await dataFixture();
      const { record } = await fixture.ingest("m.csv", messyCsv());
      const paged = await collect(fixture, record.id, { sort: "k", dir });
      expect(new Set(paged).size).toBe(1050);
      const expected = (
        await fixture.service.query(
          fixture.service.getFor(record.id, "root-1"),
          `SELECT rowid FROM data ORDER BY k ${dir === "asc" ? "ASC" : "DESC"}, rowid ASC`,
          { maxRows: 1000 },
        )
      ).rows;
      // The query tool caps at 1000 rows: compare the common prefix, the set check covers the rest.
      expect(paged.slice(0, 1000)).toEqual(expected.map((r) => r[0]));
    },
  );

  it("filters one column (LIKE, escaped) or every column and counts the matches once", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest(
      "f.csv",
      'name,code\n"100% real",a_b\nplain,aXb\n"50%",a_b\nPercent,none\n',
    );
    const stored = fixture.service.getFor(record.id, "root-1");
    const percent = await fixture.service.page(stored, { filter: "%", column: "name" });
    expect(percent.rows.map((r) => r[0])).toEqual(["100% real", "50%"]);
    expect(percent.matched).toBe(2);
    const underscore = await fixture.service.page(stored, { filter: "a_b", column: "code" });
    expect(underscore.rows).toHaveLength(2);
    const all = await fixture.service.page(stored, { filter: "PERCENT" });
    expect(all.rows.map((r) => r[0])).toEqual(["Percent"]);
    const second = await fixture.service.page(stored, { filter: "%", column: "name", limit: 1 });
    expect(second.matched).toBe(2);
    const next = await fixture.service.page(stored, {
      filter: "%",
      column: "name",
      limit: 1,
      after: second.next,
    });
    expect(next.matched).toBeUndefined();
    expect(next.rows).toHaveLength(1);
  });

  it("jumps to a row without sorting and with OFFSET when sorting or filtering", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("m.csv", messyCsv());
    const stored = fixture.service.getFor(record.id, "root-1");
    const plain = await fixture.service.page(stored, { offset: 500, limit: 3 });
    expect(plain.rowids).toEqual([501, 502, 503]);
    const sorted = await fixture.service.page(stored, {
      offset: 500,
      limit: 3,
      sort: "id",
      dir: "asc",
    });
    expect(sorted.rowids).toEqual([501, 502, 503]);
    await expect(
      fixture.service.page(stored, { offset: 200_000, limit: 3, sort: "id" }),
    ).rejects.toBeInstanceOf(PageParamError);
  });

  it("disables sorting and filtering above maxInteractiveRows and says so", async () => {
    fixture = await dataFixture({ limits: { maxInteractiveRows: 100 } });
    const { record } = await fixture.ingest("m.csv", messyCsv());
    const stored = fixture.service.getFor(record.id, "root-1");
    const page = await fixture.service.page(stored, {
      sort: "k",
      dir: "desc",
      filter: "row 5",
      limit: 4,
    });
    expect(page.interactive).toBe(false);
    expect(page.rowids).toEqual([1, 2, 3, 4]);
    expect(page.total).toBe(1050);
    expect(fixture.service.detail(stored).maxInteractiveRows).toBe(100);
  });

  it("rejects unknown columns, sheets and malformed cursors", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("a.csv", "x\n1\n");
    const stored = fixture.service.getFor(record.id, "root-1");
    await expect(fixture.service.page(stored, { sort: "nope" })).rejects.toBeInstanceOf(
      PageParamError,
    );
    await expect(
      fixture.service.page(stored, { filter: "a", column: "nope" }),
    ).rejects.toBeInstanceOf(PageParamError);
    await expect(fixture.service.page(stored, { sheet: "nope" })).rejects.toBeInstanceOf(
      PageParamError,
    );
    await expect(fixture.service.page(stored, { after: "!!" })).rejects.toBeInstanceOf(
      PageParamError,
    );
  });

  it("requires a column to filter sheets over 100 000 rows", async () => {
    fixture = await dataFixture();
    const { record } = await fixture.ingest("big.csv", bigCsv(100_001));
    const stored = fixture.service.getFor(record.id, "root-1");
    await expect(fixture.service.page(stored, { filter: "West" })).rejects.toBeInstanceOf(
      PageParamError,
    );
    const page = await fixture.service.page(stored, { filter: "West", column: "region", limit: 2 });
    expect(page.matched).toBe(25_000);
    expect(page.rows[0]?.[1]).toBe("West");
  });
});

describe("page SQL builder", () => {
  it("round-trips cursors and never embeds user text in the statement", () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    const built = buildPageQuery({
      table: "data",
      columns: ["a", 'b"c'],
      limit: 10,
      sort: { column: 'b"c', dir: "desc" },
      filter: { text: "'; DROP TABLE data; --" },
      after: encodeCursor(5),
    });
    expect(built.sql).not.toMatch(/DROP TABLE/);
    expect(built.sql).toContain('"b""c"');
    expect(built.params).toContain("%'; DROP TABLE data; --%");
    expect(
      buildCountQuery({ table: "data", columns: ["a"], filter: { text: "x", column: "a" } }).params,
    ).toEqual(["%x%"]);
  });
});
