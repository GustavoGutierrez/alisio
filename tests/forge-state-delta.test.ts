/**
 * The pure rules of the cross-execution state (spec §9.2, D11): snapshot in, delta out, size
 * limits, and a revision compare that never applies a stale delta. No SQLite here.
 */
import { describe, expect, it } from "vitest";
import type { ForgeError } from "../packages/core/src/forge/errors.ts";
import {
  MAX_STATE_KEY_CHARS,
  MAX_STATE_VALUE_BYTES,
  planCommit,
  StateDelta,
  type StateEntry,
  type StateSnapshot,
} from "../packages/core/src/forge/state-delta.ts";

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as ForgeError).code;
  }
  return undefined;
}

const snapshot = (entries: Record<string, [unknown, number]> = {}): StateSnapshot => ({
  values: Object.fromEntries(Object.entries(entries).map(([k, [v]]) => [k, v])),
  revisions: Object.fromEntries(Object.entries(entries).map(([k, [, r]]) => [k, r])),
});
const stored = (entries: Record<string, [string, number]>): Map<string, StateEntry> =>
  new Map(
    Object.entries(entries).map(([k, [valueJson, revision]]) => [k, { valueJson, revision }]),
  );
const LIMIT = 512 * 1024;

describe("state delta (what a script sees and leaves behind)", () => {
  it("reads the snapshot and its own writes, and a delete hides the key", () => {
    const delta = new StateDelta(snapshot({ a: [1, 1], b: [2, 1] }));
    expect(delta.get("a")).toBe(1);
    delta.set("a", { nested: true });
    expect(delta.get("a")).toEqual({ nested: true });
    delta.delete("b");
    expect(delta.get("b")).toBeUndefined();
    expect(delta.get("never")).toBeUndefined();
  });

  it("keeps only the last operation per key, in first-touched order", () => {
    const delta = new StateDelta(snapshot());
    delta.set("a", 1);
    delta.set("b", 2);
    delta.set("a", 3);
    delta.delete("b");
    expect(delta.ops()).toEqual([
      { op: "set", key: "a", value: 3 },
      { op: "delete", key: "b" },
    ]);
  });

  it("does not mutate the snapshot it was given", () => {
    const base = snapshot({ a: [1, 1] });
    const delta = new StateDelta(base);
    delta.set("a", 2);
    expect(base.values.a).toBe(1);
  });

  it("rejects an empty key, a key over 128 characters and a value that is not JSON", () => {
    const delta = new StateDelta(snapshot());
    expect(codeOf(() => delta.set("", 1))).toBe("INVALID_INPUT");
    expect(codeOf(() => delta.set("k".repeat(MAX_STATE_KEY_CHARS), 1))).toBeUndefined();
    expect(codeOf(() => delta.set("k".repeat(MAX_STATE_KEY_CHARS + 1), 1))).toBe("INVALID_INPUT");
    expect(codeOf(() => delta.set("k", undefined))).toBe("INVALID_INPUT");
    expect(codeOf(() => delta.set("k", () => 1))).toBe("INVALID_INPUT");
    expect(codeOf(() => delta.set("k", 10n))).toBe("INVALID_INPUT");
    expect(codeOf(() => delta.delete(""))).toBe("INVALID_INPUT");
  });

  it("counts a value in UTF-8 bytes of its JSON: 64 KiB passes, one byte more does not", () => {
    const delta = new StateDelta(snapshot());
    // The JSON of a string adds two quote characters.
    expect(codeOf(() => delta.set("k", "x".repeat(MAX_STATE_VALUE_BYTES - 2)))).toBeUndefined();
    expect(codeOf(() => delta.set("k", "x".repeat(MAX_STATE_VALUE_BYTES - 1)))).toBe(
      "INVALID_INPUT",
    );
    // Multi-byte characters count as bytes, not characters.
    expect(codeOf(() => delta.set("m", "é".repeat(MAX_STATE_VALUE_BYTES / 2)))).toBe(
      "INVALID_INPUT",
    );
  });
});

describe("planCommit (revision compare-and-set)", () => {
  it("applies a set against the revision the script saw and bumps it", () => {
    const plan = planCommit({
      current: stored({ a: ["1", 3] }),
      snapshot: snapshot({ a: [1, 3] }),
      ops: [{ op: "set", key: "a", value: 2 }],
      maxTotalBytes: LIMIT,
    });
    expect(plan.writes).toEqual([{ key: "a", valueJson: "2", revision: 4 }]);
  });

  it("creates a key unseen by both sides at revision 1", () => {
    const plan = planCommit({
      current: stored({}),
      snapshot: snapshot(),
      ops: [{ op: "set", key: "new", value: "v" }],
      maxTotalBytes: LIMIT,
    });
    expect(plan.writes).toEqual([{ key: "new", valueJson: '"v"', revision: 1 }]);
  });

  it("reports STATE_CONFLICT when another execution committed the key first", () => {
    const conflict = (current: Map<string, StateEntry>, seen: StateSnapshot) =>
      codeOf(() =>
        planCommit({
          current,
          snapshot: seen,
          ops: [{ op: "set", key: "a", value: 9 }],
          maxTotalBytes: LIMIT,
        }),
      );
    expect(conflict(stored({ a: ["1", 4] }), snapshot({ a: [1, 3] }))).toBe("STATE_CONFLICT");
    // The key appeared after the snapshot was taken.
    expect(conflict(stored({ a: ["1", 1] }), snapshot())).toBe("STATE_CONFLICT");
    // The snapshot saw a revision that no longer exists.
    expect(conflict(stored({}), snapshot({ a: [1, 2] }))).toBe("STATE_CONFLICT");
  });

  it("checks only the keys the delta touches", () => {
    const plan = planCommit({
      current: stored({ a: ["1", 5], b: ["2", 1] }),
      snapshot: snapshot({ a: [1, 1], b: [2, 1] }),
      ops: [{ op: "set", key: "b", value: 3 }],
      maxTotalBytes: LIMIT,
    });
    expect(plan.writes.map((w) => w.key)).toEqual(["b"]);
  });

  it("turns a delete into a tombstone that keeps counting revisions", () => {
    const plan = planCommit({
      current: stored({ a: ["1", 2] }),
      snapshot: snapshot({ a: [1, 2] }),
      ops: [{ op: "delete", key: "a" }],
      maxTotalBytes: LIMIT,
    });
    expect(plan.writes).toEqual([{ key: "a", valueJson: "", revision: 3 }]);
  });

  it("ignores a delete of a key that does not exist", () => {
    const plan = planCommit({
      current: stored({}),
      snapshot: snapshot(),
      ops: [{ op: "delete", key: "ghost" }],
      maxTotalBytes: LIMIT,
    });
    expect(plan.writes).toEqual([]);
  });

  it("sees a tombstone as an absent value but a taken revision", () => {
    const current = stored({ a: ["", 4] });
    const set = (seen: StateSnapshot) =>
      planCommit({
        current,
        snapshot: seen,
        ops: [{ op: "set", key: "a", value: 1 }],
        maxTotalBytes: LIMIT,
      });
    expect(set({ values: {}, revisions: { a: 4 } }).writes).toEqual([
      { key: "a", valueJson: "1", revision: 5 },
    ]);
    expect(codeOf(() => set(snapshot()))).toBe("STATE_CONFLICT");
    // Deleting a tombstone again changes nothing.
    expect(
      planCommit({
        current,
        snapshot: { values: {}, revisions: { a: 4 } },
        ops: [{ op: "delete", key: "a" }],
        maxTotalBytes: LIMIT,
      }).writes,
    ).toEqual([]);
  });

  it("limits the live total of the root session (keys plus values), counting what is replaced", () => {
    const plan = (maxTotalBytes: number) =>
      planCommit({
        current: stored({ big: ['"xxxxxxxxxx"', 1], keep: ["1", 1] }),
        snapshot: snapshot({ big: ["xxxxxxxxxx", 1], keep: [1, 1] }),
        ops: [{ op: "set", key: "big", value: "yy" }],
        maxTotalBytes,
      });
    // After the write: "big"(3) + '"yy"'(4) + "keep"(4) + "1"(1) = 12 bytes.
    expect(plan(12).totalBytes).toBe(12);
    expect(codeOf(() => plan(11))).toBe("BUDGET_EXCEEDED");
  });

  it("does not count a tombstone, and a delete frees room", () => {
    const result = planCommit({
      current: stored({ a: ["", 2], big: ['"xxxxxxxxxx"', 1] }),
      snapshot: snapshot({ big: ["xxxxxxxxxx", 1], a: [undefined, 2] }),
      ops: [{ op: "delete", key: "big" }],
      maxTotalBytes: 1,
    });
    expect(result.totalBytes).toBe(0);
  });
});
