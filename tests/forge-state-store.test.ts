/**
 * The state store over the real SQLite database (spec §9.2, FJ-AC-16/17): snapshot in, delta out,
 * revision compare-and-set in one transaction, per-root isolation and the shared total.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeError } from "../packages/core/src/forge/errors.ts";
import { StateDelta } from "../packages/core/src/forge/state-delta.ts";
import { SqliteStateStore } from "../packages/core/src/forge/state-store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(maxTotalBytes = 512 * 1024) {
  const root = await mkdtemp(join(tmpdir(), "alisio-forge-state-"));
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const clock = { now: 100 };
  return {
    store,
    state: new SqliteStateStore(store.db, { maxTotalBytes, now: () => clock.now }),
    clock,
  };
}

/** One execution: take the snapshot, run `script` against the local copy, return both. */
function run(
  state: SqliteStateStore,
  root: string,
  script: (delta: StateDelta) => void,
): { snapshot: ReturnType<SqliteStateStore["snapshot"]>; ops: ReturnType<StateDelta["ops"]> } {
  const snapshot = state.snapshot(root);
  const delta = new StateDelta(snapshot);
  script(delta);
  return { snapshot, ops: delta.ops() };
}

async function rejection(action: () => unknown): Promise<string | undefined> {
  try {
    action();
  } catch (error) {
    return (error as ForgeError).code;
  }
  return undefined;
}

describe("forge state store", () => {
  it("shows a committed delta to the next execution, JS and Python alike", async () => {
    const { state } = await setup();
    const first = run(state, "root", (d) => {
      d.set("lastDatasetId", "ds_1");
      d.set("counts", { a: 1 });
    });
    state.commit("root", first.snapshot, first.ops);

    const second = state.snapshot("root");
    expect(second.values).toEqual({ lastDatasetId: "ds_1", counts: { a: 1 } });
    expect(second.revisions).toEqual({ lastDatasetId: 1, counts: 1 });
  });

  it("lets exactly one of two executions with the same revision commit (FJ-AC-16)", async () => {
    const { state } = await setup();
    const seed = run(state, "root", (d) => d.set("n", 0));
    state.commit("root", seed.snapshot, seed.ops);

    const a = run(state, "root", (d) => d.set("n", 1));
    const b = run(state, "root", (d) => d.set("n", 2));
    state.commit("root", a.snapshot, a.ops);
    expect(await rejection(() => state.commit("root", b.snapshot, b.ops))).toBe("STATE_CONFLICT");
    expect(state.snapshot("root").values).toEqual({ n: 1 });
    // The loser is not retried in silence: a fresh execution can write on top.
    const retry = run(state, "root", (d) => d.set("n", 2));
    state.commit("root", retry.snapshot, retry.ops);
    expect(state.snapshot("root").values).toEqual({ n: 2 });
  });

  it("applies nothing of a conflicting delta, not even its untouched-by-conflict keys", async () => {
    const { state } = await setup();
    const seed = run(state, "root", (d) => d.set("shared", 0));
    state.commit("root", seed.snapshot, seed.ops);
    const slow = run(state, "root", (d) => {
      d.set("own", "mine");
      d.set("shared", 9);
    });
    const fast = run(state, "root", (d) => d.set("shared", 1));
    state.commit("root", fast.snapshot, fast.ops);
    expect(await rejection(() => state.commit("root", slow.snapshot, slow.ops))).toBe(
      "STATE_CONFLICT",
    );
    expect(state.snapshot("root").values).toEqual({ shared: 1 });
  });

  it("discards the delta when the script fails: nothing is committed (FJ-AC-17)", async () => {
    const { state } = await setup();
    const seed = run(state, "root", (d) => d.set("keep", 1));
    state.commit("root", seed.snapshot, seed.ops);
    // The host calls commit() only on success; a failed script leaves its delta unapplied.
    run(state, "root", (d) => {
      d.set("keep", 2);
      d.set("extra", true);
    });
    expect(state.snapshot("root").values).toEqual({ keep: 1 });
  });

  it("keeps root sessions apart", async () => {
    const { state } = await setup();
    const a = run(state, "root-a", (d) => d.set("k", "a"));
    state.commit("root-a", a.snapshot, a.ops);
    expect(state.snapshot("root-b").values).toEqual({});
    const b = run(state, "root-b", (d) => d.set("k", "b"));
    state.commit("root-b", b.snapshot, b.ops);
    expect(state.snapshot("root-a").values).toEqual({ k: "a" });
  });

  it("removes a deleted key from the snapshot but remembers its revision", async () => {
    const { state } = await setup();
    const seed = run(state, "root", (d) => d.set("k", 1));
    state.commit("root", seed.snapshot, seed.ops);
    const del = run(state, "root", (d) => d.delete("k"));
    state.commit("root", del.snapshot, del.ops);
    expect(state.snapshot("root")).toEqual({ values: {}, revisions: { k: 2 } });
    // A script that started before the delete cannot resurrect the key.
    expect(await rejection(() => state.commit("root", seed.snapshot, seed.ops))).toBe(
      "STATE_CONFLICT",
    );
    const again = run(state, "root", (d) => d.set("k", 3));
    state.commit("root", again.snapshot, again.ops);
    expect(state.snapshot("root")).toEqual({ values: { k: 3 }, revisions: { k: 3 } });
  });

  it("enforces the total per root session across executions and writes nothing on refusal", async () => {
    const { state } = await setup(20);
    const first = run(state, "root", (d) => d.set("aaaa", "bbbbbbbb")); // 4 + 10
    state.commit("root", first.snapshot, first.ops);
    const second = run(state, "root", (d) => d.set("cc", "dddd")); // 2 + 6 -> 22 > 20
    expect(await rejection(() => state.commit("root", second.snapshot, second.ops))).toBe(
      "BUDGET_EXCEEDED",
    );
    expect(state.snapshot("root").values).toEqual({ aaaa: "bbbbbbbb" });
    // Another root has its own allowance.
    const other = run(state, "other", (d) => d.set("cc", "dddd"));
    state.commit("other", other.snapshot, other.ops);
  });

  it("stamps updated_at with the clock", async () => {
    const { state, store, clock } = await setup();
    clock.now = 4_242;
    const seed = run(state, "root", (d) => d.set("k", 1));
    state.commit("root", seed.snapshot, seed.ops);
    const row = store.db.prepare("SELECT updated_at FROM forge_state WHERE key='k'").get() as {
      updated_at: number;
    };
    expect(row.updated_at).toBe(4_242);
  });
});
