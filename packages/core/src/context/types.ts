/**
 * Context Governor internal types (spec 012, phase 1). Core-internal on purpose: nothing here is
 * exported from `@alisio/sdk` or wired into the runner yet.
 */

export type ContextSegmentKind =
  | "system"
  | "instructions"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "checkpoint"
  | "invariant"
  | "memory"
  | "other";

/** How protected a segment is: `pinned` is never dropped, `low` is the first elision candidate. */
export type Criticality = "pinned" | "high" | "normal" | "low";

export interface ContextSegment {
  /** Stable id: sha256 prefix of (kind/role, call id or position, content hash). */
  id: string;
  kind: ContextSegmentKind;
  /** File path, tool name, or the message role when neither applies. */
  origin: string;
  /** Token ESTIMATE (the shared `estimateTokens` heuristic), never provider-reported usage. */
  tokens: number;
  criticality: Criticality;
  /** Human-readable explanation of the criticality. Always set by `buildInventory`. */
  reason?: string;
}

export interface InventoryTotal {
  count: number;
  /** Estimated tokens. */
  tokens: number;
}

export interface ContextInventory {
  segments: ContextSegment[];
  /** Sum of the estimated tokens of every segment. */
  totalTokens: number;
  byKind: Record<ContextSegmentKind, InventoryTotal>;
  byCriticality: Record<Criticality, InventoryTotal>;
}

/** Optional pinned material the caller knows about; each entry becomes a `pinned` segment. */
export interface InventoryContext {
  /** Invariants that must survive every compaction (kind `invariant`). */
  invariants?: string[];
  /** Instructions carried by the latest checkpoint (kind `checkpoint`). */
  checkpointInstructions?: string[];
  /** Text of the active goal (kind `instructions`). */
  goal?: string;
}
