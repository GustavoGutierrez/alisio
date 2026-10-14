// Hidden verifier of off-by-one-among-passing: suite.json embeds this file verbatim as the argument
// of `node -e`, so the agent never sees it in the workspace. It checks only what the JSDoc
// comments under src/ promise.
import assert from "node:assert/strict";
import { getPage, hasNextPage, pageRange, totalPages } from "./src/paginate.ts";
import { pagesRemaining } from "./src/summary.ts";

const items = Array.from({ length: 11 }, (_, index) => index + 1);
const first = [1, 2, 3, 4, 5];

assert.equal(totalPages(10, 5), 2);
assert.equal(totalPages(11, 5), 3);
assert.equal(totalPages(0, 5), 1, "an empty list still has one page");

assert.deepEqual(getPage(items, 0, 5), first, "page 0 is treated as page 1");
assert.deepEqual(getPage(items, -3, 5), first, "negative pages are treated as page 1");
assert.deepEqual(getPage(items, 3, 5), [11]);
assert.deepEqual(getPage(items, 4, 5), []);

assert.equal(hasNextPage(10, 1, 5), true);
assert.equal(hasNextPage(10, 2, 5), false);
assert.equal(hasNextPage(11, 3, 5), false);
assert.equal(hasNextPage(0, 1, 5), false);

assert.deepEqual(pageRange(11, 1, 5), { from: 1, to: 5 });
assert.deepEqual(pageRange(11, 3, 5), { from: 11, to: 11 });
assert.deepEqual(pageRange(10, 2, 5), { from: 6, to: 10 });
assert.deepEqual(pageRange(0, 1, 5), { from: 0, to: 0 });

assert.equal(pagesRemaining(10, 1, 5), 1);
assert.equal(pagesRemaining(10, 2, 5), 0);
assert.equal(pagesRemaining(10, 5, 5), 0, "never negative");
assert.equal(pagesRemaining(0, 1, 5), 0);
assert.equal(pagesRemaining(11, 1, 5), 2);
