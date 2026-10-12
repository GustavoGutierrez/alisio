/**
 * The SQLite adapter of the cross-execution state (spec §9.2). The rules (limits, revisions,
 * conflicts) are the pure functions of `state-delta.ts`; this file only reads the rows and applies
 * the plan in one immediate transaction, so a conflicting delta writes nothing.
 *
 * The host takes `snapshot()` when an execution starts, feeds the script's `state.set` and
 * `state.delete` into a `StateDelta`, and calls `commit()` only when the execution succeeds. A
 * failed execution simply never commits: its delta is dropped (FJ-AC-17).
 */
import type { SqlDatabase } from "@alisio/sdk";
import {
  DEFAULT_STATE_TOTAL_BYTES,
  planCommit,
  type StateEntry,
  type StateOp,
  type StateSnapshot,
} from "./state-delta.ts";

export class SqliteStateStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #maxTotalBytes: () => number;

  constructor(
    db: SqlDatabase,
    options: { maxTotalBytes?: number | (() => number); now?: () => number } = {},
  ) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    const max = options.maxTotalBytes ?? DEFAULT_STATE_TOTAL_BYTES;
    this.#maxTotalBytes = typeof max === "function" ? max : () => max;
  }

  /** Live values and every revision (tombstones included) of a root session. */
  snapshot(rootSessionId: string): StateSnapshot {
    const snapshot: StateSnapshot = { values: {}, revisions: {} };
    for (const [key, entry] of this.#read(rootSessionId)) {
      snapshot.revisions[key] = entry.revision;
      if (entry.valueJson !== "") snapshot.values[key] = JSON.parse(entry.valueJson) as unknown;
    }
    return snapshot;
  }

  /**
   * Applies a delta against the snapshot it was built from. Throws `STATE_CONFLICT` or
   * `BUDGET_EXCEEDED` without writing anything. Returns the number of rows written.
   */
  commit(rootSessionId: string, snapshot: StateSnapshot, ops: readonly StateOp[]): number {
    return this.#db.transaction(() => {
      const plan = planCommit({
        current: this.#read(rootSessionId),
        snapshot,
        ops,
        maxTotalBytes: this.#maxTotalBytes(),
      });
      const upsert = this.#db.prepare(
        `INSERT INTO forge_state(root_session_id,key,value_json,revision,updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(root_session_id,key) DO UPDATE SET
           value_json=excluded.value_json, revision=excluded.revision, updated_at=excluded.updated_at`,
      );
      const now = this.#now();
      for (const write of plan.writes)
        upsert.run(rootSessionId, write.key, write.valueJson, write.revision, now);
      return plan.writes.length;
    });
  }

  #read(rootSessionId: string): Map<string, StateEntry> {
    const rows = this.#db
      .prepare("SELECT key, value_json, revision FROM forge_state WHERE root_session_id=?")
      .all(rootSessionId) as Array<{ key: string; value_json: string; revision: number }>;
    return new Map(
      rows.map((row) => [row.key, { valueJson: row.value_json, revision: Number(row.revision) }]),
    );
  }
}
