import assert from "node:assert/strict";
import { test } from "node:test";
import { getPage, hasNextPage, pageRange, totalPages } from "../src/paginate.ts";
import { pagesRemaining } from "../src/summary.ts";

const items = Array.from({ length: 11 }, (_, index) => index + 1);

test("first page", () => {
  assert.deepEqual(getPage(items, 1, 5), [1, 2, 3, 4, 5]);
});

test("middle page", () => {
  assert.deepEqual(getPage(items, 2, 5), [6, 7, 8, 9, 10]);
});

test("last partial page", () => {
  assert.deepEqual(getPage(items, 3, 5), [11]);
});

test("page past the end is empty", () => {
  assert.deepEqual(getPage(items, 4, 5), []);
});

test("page size of one", () => {
  assert.deepEqual(getPage(items, 7, 1), [7]);
});

test("empty input", () => {
  assert.deepEqual(getPage([], 1, 5), []);
});

test("total pages with a partial last page", () => {
  assert.equal(totalPages(11, 5), 3);
});

test("total pages with a single item", () => {
  assert.equal(totalPages(1, 5), 1);
});

test("total pages when the count divides evenly", () => {
  assert.equal(totalPages(10, 5), 2);
});

test("hasNextPage is true before the last page", () => {
  assert.equal(hasNextPage(11, 2, 5), true);
});

test("hasNextPage is false on the last page", () => {
  assert.equal(hasNextPage(11, 3, 5), false);
});

test("page range of the last page is clamped to the item count", () => {
  assert.deepEqual(pageRange(10, 2, 5), { from: 6, to: 10 });
});

test("page range of a middle page", () => {
  assert.deepEqual(pageRange(11, 2, 5), { from: 6, to: 10 });
});

test("pagesRemaining never goes below zero", () => {
  assert.equal(pagesRemaining(11, 3, 5), 0);
});

test("pagesRemaining counts the pages after the current one", () => {
  assert.equal(pagesRemaining(11, 1, 5), 2);
});
