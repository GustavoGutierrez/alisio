/**
 * The pure rules of the state shared across executions (spec §9.2, D11): a script gets a snapshot,
 * its writes accumulate into a delta, and the delta is applied only if every key it touches still
 * has the revision the script saw. No I/O: the SQLite adapter lives in `state-store.ts`.
 *
 * A delete leaves a tombstone (empty `valueJson`) that keeps counting revisions, so a key that is
 * deleted and re-created by another execution never repeats a revision a stale snapshot holds.
 */
import { ForgeError } from "./errors.ts";

export const MAX_STATE_KEY_CHARS = 128;
export const MAX_STATE_VALUE_BYTES = 64 * 1024;
export const DEFAULT_STATE_TOTAL_BYTES = 512 * 1024;

/** What `start.state` carries (values) plus the revisions the host keeps to compare later. */
export interface StateSnapshot {
  values: Record<string, unknown>;
  /** Includes tombstoned keys; a key absent here was never written (revision 0). */
  revisions: Record<string, number>;
}

/** A stored row. An empty `valueJson` is a tombstone. */
export interface StateEntry {
  valueJson: string;
  revision: number;
}

export type StateOp = { op: "set"; key: string; value: unknown } | { op: "delete"; key: string };

export interface StateWrite {
  key: string;
  /** Empty for a tombstone. */
  valueJson: string;
  revision: number;
}

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

function checkKey(key: string): void {
  if (key.length === 0 || key.length > MAX_STATE_KEY_CHARS)
    throw new ForgeError(
      "INVALID_INPUT",
      `state key must be 1 to ${MAX_STATE_KEY_CHARS} characters`,
    );
}

/** The JSON of a value, or INVALID_INPUT when it is not JSON or is over the per-value limit. */
function encodeValue(key: string, value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined)
    throw new ForgeError("INVALID_INPUT", `state value for "${key}" is not JSON-serializable`);
  if (bytes(json) > MAX_STATE_VALUE_BYTES)
    throw new ForgeError(
      "INVALID_INPUT",
      `state value for "${key}" exceeds ${MAX_STATE_VALUE_BYTES} bytes`,
    );
  return json;
}

/** The local copy a running script reads and writes. Writes accumulate; nothing is persisted. */
export class StateDelta {
  readonly #values: Map<string, unknown>;
  readonly #ops = new Map<string, StateOp>();

  constructor(snapshot: StateSnapshot) {
    this.#values = new Map(Object.entries(snapshot.values));
  }

  get(key: string): unknown {
    return this.#values.get(key);
  }

  set(key: string, value: unknown): void {
    checkKey(key);
    const json = encodeValue(key, value);
    const stored = JSON.parse(json) as unknown;
    this.#values.set(key, stored);
    this.#record({ op: "set", key, value: stored });
  }

  delete(key: string): void {
    checkKey(key);
    this.#values.delete(key);
    this.#record({ op: "delete", key });
  }

  /** The last operation per key, in the order each key was first touched. */
  ops(): StateOp[] {
    return [...this.#ops.values()];
  }

  #record(op: StateOp): void {
    this.#ops.set(op.key, op);
  }
}

export interface CommitPlan {
  writes: StateWrite[];
  /** Live bytes (keys plus values) of the root session after the writes. */
  totalBytes: number;
}

/**
 * Decides what a delta writes. Throws `STATE_CONFLICT` when a touched key changed since the
 * snapshot (nothing is applied, nothing retried) and `BUDGET_EXCEEDED` when the live total would
 * pass `maxTotalBytes`.
 */
export function planCommit(input: {
  current: ReadonlyMap<string, StateEntry>;
  snapshot: StateSnapshot;
  ops: readonly StateOp[];
  maxTotalBytes: number;
}): CommitPlan {
  const writes: StateWrite[] = [];
  const next = new Map(input.current);
  for (const op of input.ops) {
    const existing = input.current.get(op.key);
    const seen = input.snapshot.revisions[op.key] ?? 0;
    if (seen !== (existing?.revision ?? 0))
      throw new ForgeError(
        "STATE_CONFLICT",
        `state key "${op.key}" changed since this execution started; nothing was applied`,
      );
    if (op.op === "delete") {
      if (!existing || existing.valueJson === "") continue;
      const write = { key: op.key, valueJson: "", revision: existing.revision + 1 };
      writes.push(write);
      next.set(op.key, { valueJson: write.valueJson, revision: write.revision });
      continue;
    }
    const write = {
      key: op.key,
      valueJson: encodeValue(op.key, op.value),
      revision: (existing?.revision ?? 0) + 1,
    };
    writes.push(write);
    next.set(op.key, { valueJson: write.valueJson, revision: write.revision });
  }
  let totalBytes = 0;
  for (const [key, entry] of next)
    if (entry.valueJson !== "") totalBytes += bytes(key) + bytes(entry.valueJson);
  if (totalBytes > input.maxTotalBytes)
    throw new ForgeError(
      "BUDGET_EXCEEDED",
      `state would use ${totalBytes} bytes; the limit per session is ${input.maxTotalBytes}`,
    );
  return { writes, totalBytes };
}
