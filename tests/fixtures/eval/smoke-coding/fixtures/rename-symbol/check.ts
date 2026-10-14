import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as api from "./src/api.ts";
import { fetchUserCacheSize, fetchUserCached } from "./src/cache.ts";
import { describe } from "./src/cli.ts";
import * as barrel from "./src/index.ts";
import { lazyId, lazyName } from "./src/lazy.ts";
import { LegacyClient, legacyDescribe } from "./src/legacy.ts";
import { counters, greet, METRIC } from "./src/service.ts";

const exported = (module: object) => module as Record<string, unknown>;

// The function is renamed where it is defined and where it is re-exported.
assert.equal(typeof exported(api).loadUser, "function");
assert.equal(exported(api).fetchUser, undefined);
assert.equal(typeof exported(barrel).loadUser, "function");
assert.equal(exported(barrel).fetchUser, undefined);
assert.equal(exported(barrel).getUser, exported(api).loadUser, "the alias getUser must survive");

// Every other symbol keeps its name and its behavior.
for (const name of ["fetchUserByName", "fetchUsers", "fetchUserCached", "fetchUserCacheSize"]) {
  assert.equal(typeof exported(barrel)[name], "function", `${name} must keep its name`);
}
for (const name of ["loadUserByName", "loadUsers", "loadUserCached", "loadUserCacheSize"]) {
  assert.equal(exported(barrel)[name], undefined, `${name} must not exist`);
}
assert.equal(api.fetchUserByName("Grace")?.id, 3);
assert.equal(api.fetchUsers().length, 3);
assert.equal(fetchUserCached(2)?.name, "Linus");
assert.equal(fetchUserCacheSize(), 1);

// Callers behave as before, whatever way they reach the function.
assert.equal(greet(1), "Hello, Ada");
assert.equal(greet(9), "Hello, stranger");
assert.equal(describe(2), "2:Linus");
assert.equal(await lazyName(3), "Grace");
assert.equal(await lazyId(1), 1);

// The metric key is data, not a reference to the function.
assert.equal(METRIC, "fetchUser.calls");
assert.equal(counters["fetchUser.calls"], 2);

// A method of an unrelated class that happens to share the old name is not the function.
assert.equal(new LegacyClient().fetchUser(4), "legacy:4");
assert.equal(legacyDescribe(5), "legacy:5");

// Type-only references leave no trace at runtime, so the sources are scanned too: the old name may
// remain only in the unrelated method and in the metric key.
const remaining: Record<string, number> = {};
for (const file of readdirSync("src")) {
  const count = readFileSync(`src/${file}`, "utf8").match(/\bfetchUser\b/g)?.length ?? 0;
  if (count > 0) remaining[file] = count;
}
assert.deepEqual(remaining, { "legacy.ts": 2, "service.ts": 1 });
