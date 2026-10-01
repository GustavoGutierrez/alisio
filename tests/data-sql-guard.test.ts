import { describe, expect, it } from "vitest";
import { guardSql } from "../packages/core/src/analysis/data/sql-guard.ts";

const accepted = [
  "SELECT 1",
  "select * from data;",
  "SELECT region, sum(revenue) FROM data GROUP BY region ORDER BY 2 DESC LIMIT 5",
  "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c LIMIT 10) SELECT count(*) FROM c",
  "SELECT 'DROP TABLE data; --' AS note",
  `SELECT "delete" FROM data`,
  "SELECT replace(name, 'a', 'b') FROM data",
  "SELECT 1 -- ; DROP TABLE data",
  "SELECT /* ; INSERT */ 1",
  "SELECT [update] FROM data",
  "SELECT `attach` FROM data",
  "SELECT * FROM pragma_table_info('data')",
  "SELECT 1;  ",
  "SELECT * FROM data WHERE note = 'it''s; fine'",
];

const rejected: Array<[string, RegExp]> = [
  ["SELECT 1; DROP TABLE data", /one statement/i],
  ["SELECT 1; SELECT 2", /one statement/i],
  ["ATTACH 'x' AS y", /SELECT and WITH/],
  ["PRAGMA writable_schema=1", /SELECT and WITH/],
  ["WITH x AS (DELETE FROM data RETURNING *) SELECT * FROM x", /DELETE/],
  ["SELECT load_extension('x')", /load_extension/i],
  ["INSERT INTO data VALUES (1)", /SELECT and WITH/],
  ["UPDATE data SET a = 1", /SELECT and WITH/],
  ["REPLACE INTO data VALUES (1)", /SELECT and WITH/],
  ["SELECT 1 FROM data; VACUUM", /one statement/i],
  ["WITH x AS (SELECT 1) INSERT INTO data SELECT * FROM x", /INSERT/],
  ["", /empty/i],
  ["-- just a comment", /empty/i],
  ["SELECT 'open", /Unterminated/],
  ["SELECT /* open", /Unterminated/],
  ["CREATE TABLE t(a)", /SELECT and WITH/],
  ["  begin; select 1", /one statement|SELECT and WITH/],
  ["SELECT 1 UNION SELECT release FROM data", /release/i],
];

describe("data_query SQL guard", () => {
  it.each(accepted)("accepts %s", (sql) => {
    expect(guardSql(sql)).toMatchObject({ ok: true });
  });

  it.each(rejected)("rejects %s", (sql, reason) => {
    const result = guardSql(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});
