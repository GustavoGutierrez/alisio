import assert from "node:assert/strict";
import * as strings from "./src/strings.ts";

const { capitalize, slugify } = strings as Record<string, (s: string) => string>;
assert.equal(capitalize("alisio"), "Alisio");
assert.equal(slugify("  Hello, World!  "), "hello-world");
assert.equal(slugify("a--b"), "a-b");
