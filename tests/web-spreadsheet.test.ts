import type { DatasetRowsPage } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  ariaSort,
  CACHE_PAGES,
  clampColumnWidth,
  columnWidthStep,
  DEFAULT_COLUMN_WIDTH,
  LruCache,
  MAX_COLUMN_WIDTH,
  MAX_OFFSET,
  MIN_COLUMN_WIDTH,
  moveCell,
  nextSort,
  PAGE_SIZE,
  pagesFor,
  planPage,
  ROW_HEIGHT,
  rowText,
  scrollToRow,
  viewKey,
  visibleRange,
} from "../packages/web/src/util/spreadsheet.ts";
import { type DataFixture, dataFixture } from "./data-helpers.ts";

describe("virtual window", () => {
  it("renders only the visible rows plus the margin and never goes out of range", () => {
    expect(visibleRange(0, 280, 5000)).toEqual({ first: 0, last: 20 });
    expect(visibleRange(ROW_HEIGHT * 1000, 280, 5000)).toEqual({ first: 990, last: 1020 });
    expect(visibleRange(ROW_HEIGHT * 4990, 280, 5000)).toEqual({ first: 4980, last: 4999 });
    expect(visibleRange(0, 280, 0)).toEqual({ first: 0, last: -1 });
    expect(visibleRange(0, 280, 3)).toEqual({ first: 0, last: 2 });
  });

  it("maps rows to 200-row pages", () => {
    expect(pagesFor(0, 20)).toEqual([0]);
    expect(pagesFor(190, 410)).toEqual([0, 1, 2]);
    expect(pagesFor(5, 4)).toEqual([]);
  });

  it("keeps its position in the viewport when moving by keyboard", () => {
    expect(scrollToRow(3, 0, 400)).toBe(0);
    expect(scrollToRow(30, 0, 400)).toBe(31 * ROW_HEIGHT - (400 - ROW_HEIGHT));
    expect(scrollToRow(2, 500, 400)).toBe(2 * ROW_HEIGHT);
  });
});

describe("LRU page cache", () => {
  it("evicts the least recently used page beyond 20", () => {
    const cache = new LruCache<number>();
    for (let i = 0; i < CACHE_PAGES; i++) cache.set(i, i);
    cache.get(0);
    cache.set(CACHE_PAGES, 99);
    expect(cache.size).toBe(CACHE_PAGES);
    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
    expect(cache.peek(CACHE_PAGES)).toBe(99);
  });
});

const loaded = (next?: string) => ({ page: { next } as DatasetRowsPage });
const cacheOf = (entries: Array<[number, ReturnType<typeof loaded>]> = []) => {
  const cache = new LruCache<ReturnType<typeof loaded>>();
  for (const [index, value] of entries) cache.set(index, value);
  return cache;
};

describe("how a page is requested", () => {
  const view = { sheet: "data" };
  const sorted = { sheet: "data", sort: { column: "k", dir: "asc" as const } };

  it("continues from the previous page's cursor when it is cached", () => {
    const cache = cacheOf([[2, loaded("c3")]]);
    expect(planPage(3, sorted, true, cache)).toEqual({
      request: { limit: PAGE_SIZE, sort: "k", dir: "asc", after: "c3" },
    });
  });

  it("jumps by offset otherwise: always without sort or filter, up to the limit with them", () => {
    const empty = cacheOf();
    expect(planPage(500, view, true, empty)).toEqual({
      request: { limit: PAGE_SIZE, offset: 500 * PAGE_SIZE },
    });
    expect(planPage(10, sorted, true, empty)).toEqual({
      request: { limit: PAGE_SIZE, sort: "k", dir: "asc", offset: 2000 },
    });
    // Past the server's OFFSET limit while sorted, the previous page must load first.
    const far = Math.floor(MAX_OFFSET / PAGE_SIZE) + 5;
    expect(planPage(far, sorted, true, empty)).toEqual({ need: far - 1 });
    expect(planPage(0, sorted, true, empty)).toEqual({
      request: { limit: PAGE_SIZE, sort: "k", dir: "asc" },
    });
  });

  it("ignores sort and filter when the sheet is not interactive", () => {
    const filtered = { ...sorted, filter: { text: "x", column: "k" } };
    expect(planPage(0, filtered, false, cacheOf())).toEqual({ request: { limit: PAGE_SIZE } });
    expect(planPage(0, filtered, true, cacheOf())).toEqual({
      request: { limit: PAGE_SIZE, sort: "k", dir: "asc", filter: "x", column: "k" },
    });
  });

  it("builds a different cache key for every view", () => {
    expect(viewKey("d", view)).not.toBe(viewKey("d", sorted));
    expect(viewKey("d", view)).toBe(viewKey("d", { sheet: "data", filter: { text: "" } }));
    expect(viewKey("d", view)).not.toBe(viewKey("e", view));
  });
});

describe("sorting, navigation and column widths", () => {
  it("cycles ascending → descending → none and reports aria-sort", () => {
    const first = nextSort(undefined, "a");
    expect(first).toEqual({ column: "a", dir: "asc" });
    const second = nextSort(first, "a");
    expect(second).toEqual({ column: "a", dir: "desc" });
    expect(nextSort(second, "a")).toBeUndefined();
    expect(nextSort(second, "b")).toEqual({ column: "b", dir: "asc" });
    expect(ariaSort(first, "a")).toBe("ascending");
    expect(ariaSort(second, "a")).toBe("descending");
    expect(ariaSort(second, "b")).toBe("none");
  });

  it("moves between cells with the arrows, Home/End and PageUp/PageDown, within bounds", () => {
    const size = { rows: 100, cols: 5 };
    const at = { row: 10, col: 2 };
    expect(moveCell("ArrowDown", false, at, size, 10)).toEqual({ row: 11, col: 2 });
    expect(moveCell("ArrowLeft", false, { row: 0, col: 0 }, size, 10)).toEqual({ row: 0, col: 0 });
    expect(moveCell("ArrowRight", false, { row: 0, col: 4 }, size, 10)).toEqual({ row: 0, col: 4 });
    expect(moveCell("PageDown", false, at, size, 10)).toEqual({ row: 19, col: 2 });
    expect(moveCell("PageUp", false, at, size, 10)).toEqual({ row: 1, col: 2 });
    expect(moveCell("Home", false, at, size, 10)).toEqual({ row: 10, col: 0 });
    expect(moveCell("End", true, at, size, 10)).toEqual({ row: 99, col: 4 });
    expect(moveCell("a", false, at, size, 10)).toBeUndefined();
  });

  it("resizes columns by keyboard within bounds", () => {
    expect(columnWidthStep("ArrowRight", false, 100)).toBe(116);
    expect(columnWidthStep("ArrowLeft", true, 100)).toBe(
      36 < MIN_COLUMN_WIDTH ? MIN_COLUMN_WIDTH : 36,
    );
    expect(columnWidthStep("End", false, 100)).toBe(MAX_COLUMN_WIDTH);
    expect(columnWidthStep("Enter", false, 400)).toBe(DEFAULT_COLUMN_WIDTH);
    expect(columnWidthStep("x", false, 100)).toBeUndefined();
    expect(clampColumnWidth(5000)).toBe(MAX_COLUMN_WIDTH);
  });

  it("copies a row as tab-separated text with NULLs empty", () => {
    expect(rowText(["a", 1.5, null, "x\ty\nz"])).toBe("a\t1.5\t\tx y z");
  });
});

/** The server's pages walked the way the grid does it: nothing duplicated, nothing skipped. */
describe("paging a real dataset with the grid's plan", () => {
  let fixture: DataFixture | undefined;
  it("covers every row exactly once when scrolling a sorted view page by page", async () => {
    fixture = await dataFixture();
    const lines = ["id,k"];
    for (let i = 1; i <= 1234; i++) lines.push(`${i},${i % 7 === 0 ? "" : (i * 13) % 9}`);
    const { record } = await fixture.ingest("g.csv", `${lines.join("\n")}\n`);
    const stored = fixture.service.getFor(record.id, "root-1");
    const sort = { column: "k", dir: "asc" as const };
    const view = { sheet: "data", sort };
    const cache = new LruCache<{ page: DatasetRowsPage }>();
    const seen: number[] = [];
    for (let index = 0; index < Math.ceil(1234 / PAGE_SIZE); index++) {
      const plan = planPage(index, view, true, cache);
      if ("need" in plan) throw new Error("unexpected dependency");
      const page = await fixture.service.page(stored, {
        sheet: "data",
        sort: sort.column,
        dir: sort.dir,
        ...plan.request,
      });
      cache.set(index, { page });
      seen.push(...page.rowids);
    }
    expect(seen).toHaveLength(1234);
    expect(new Set(seen).size).toBe(1234);
    // A page reached by jumping (offset) equals the same page reached by cursor.
    const jumped = await fixture.service.page(stored, {
      sheet: "data",
      sort: "k",
      dir: "asc",
      offset: 3 * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    expect(jumped.rowids).toEqual(seen.slice(3 * PAGE_SIZE, 4 * PAGE_SIZE));
    await fixture.dispose();
  });
});
