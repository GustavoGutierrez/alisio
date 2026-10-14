import assert from "node:assert/strict";
import { formatTotal } from "./src/order.ts";

assert.equal(formatTotal(19.99, 3), "$59.97");
assert.equal(formatTotal(0.57, 100), "$57.00");
assert.equal(formatTotal(4.35, 2), "$8.70");
assert.equal(formatTotal(10, 1), "$10.00");
assert.equal(formatTotal(0, 5), "$0.00");
