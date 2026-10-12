/**
 * The Forja execution journal (spec §9.1, §9.3) over the shared SQLite store.
 *
 * One `forge_executions` row per execution whose status follows the Phase 1 state machine, one
 * `forge_calls` row per nested call, and a restart reconciliation for rows a dead process left
 * non-terminal. Only hashes of inputs are stored, never inputs or results. Every status change is
 * a compare-and-set on the previous status, so a terminal state is reached exactly once even with
 * several processes sharing the database.
 */
import type { EngineId, IsolationLevel, SqlDatabase } from "@alisio/sdk";
import { isProcessAlive } from "../runtime/process.ts";
import type { ForgeErrorCode } from "./errors.ts";
import { canTransition, type ExecutionState, InvalidTransitionError } from "./state-machine.ts";

export type TerminalExecutionState = "succeeded" | "failed" | "cancelled" | "timed_out";
const TERMINAL: readonly ExecutionState[] = ["succeeded", "failed", "cancelled", "timed_out"];
const isTerminal = (state: ExecutionState): state is TerminalExecutionState =>
  TERMINAL.includes(state);

/** Effect class of a nested call, as the gate classifies it. */
export type CallEffect = "read" | "write" | "process" | "external" | "internal";
export type CallStatus = "started" | "succeeded" | "failed";

export interface OpenExecutionInput {
  id: string;
  rootSessionId: string;
  sessionId: string;
  toolCallId: string;
  engine: EngineId;
  isolation: IsolationLevel;
  selectionReason: string;
  codeSha256: string;
  analysisExecutionId?: string | undefined;
}

export interface ExecutionRecord extends Omit<OpenExecutionInput, "analysisExecutionId"> {
  status: ExecutionState;
  startedAt: number;
  endedAt?: number;
  metrics?: Record<string, unknown>;
  errorCode?: ForgeErrorCode;
  terminationUnconfirmed: boolean;
  analysisExecutionId?: string;
  ownerPid?: number;
}

export interface CloseOutcome {
  status: TerminalExecutionState;
  errorCode?: ForgeErrorCode;
  metrics?: Record<string, unknown>;
  /** The host could not verify that the guest stopped (D-21). */
  terminationUnconfirmed?: boolean;
}

export interface StartCallInput {
  executionId: string;
  /** 1-based position of the call within its execution. */
  n: number;
  toolName: string;
  effect: CallEffect;
  inputSha256: string;
  /** Only kept for the `write` effect (D-31). */
  paths?: string[];
}

export interface CallRecord {
  executionId: string;
  callId: string;
  toolName: string;
  effect: CallEffect;
  status: CallStatus;
  durationMs?: number;
  inputSha256: string;
  errorCode?: ForgeErrorCode;
  paths?: string[];
}

export interface EndCallOutcome {
  status: "succeeded" | "failed";
  durationMs?: number;
  errorCode?: ForgeErrorCode;
}

/** The id of the n-th nested call of a tool call (D-24). It never enters `tool_calls`. */
export const forgeCallId = (toolCallId: string, n: number): string => `${toolCallId}:forge:${n}`;

type Row = Record<string, unknown>;

function toRecord(row: Row): ExecutionRecord {
  return {
    id: String(row.id),
    rootSessionId: String(row.root_session_id),
    sessionId: String(row.session_id),
    toolCallId: String(row.tool_call_id),
    engine: row.engine as EngineId,
    isolation: row.isolation as IsolationLevel,
    selectionReason: String(row.selection_reason),
    status: row.status as ExecutionState,
    codeSha256: String(row.code_sha256),
    startedAt: Number(row.started_at),
    ...(row.ended_at != null ? { endedAt: Number(row.ended_at) } : {}),
    ...(row.metrics_json != null
      ? { metrics: JSON.parse(String(row.metrics_json)) as Record<string, unknown> }
      : {}),
    ...(row.error_code != null ? { errorCode: row.error_code as ForgeErrorCode } : {}),
    terminationUnconfirmed: Number(row.termination_unconfirmed) === 1,
    ...(row.analysis_execution_id != null
      ? { analysisExecutionId: String(row.analysis_execution_id) }
      : {}),
    ...(row.owner_pid != null ? { ownerPid: Number(row.owner_pid) } : {}),
  };
}

function toCall(row: Row): CallRecord {
  return {
    executionId: String(row.execution_id),
    callId: String(row.call_id),
    toolName: String(row.tool_name),
    effect: row.effect as CallEffect,
    status: row.status as CallStatus,
    ...(row.duration_ms != null ? { durationMs: Number(row.duration_ms) } : {}),
    inputSha256: String(row.input_sha256),
    ...(row.error_code != null ? { errorCode: row.error_code as ForgeErrorCode } : {}),
    ...(row.paths_json != null ? { paths: JSON.parse(String(row.paths_json)) as string[] } : {}),
  };
}

export class SqliteExecutionJournal {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #ownerPid: number;

  constructor(db: SqlDatabase, options: { now?: () => number; ownerPid?: number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#ownerPid = options.ownerPid ?? process.pid;
  }

  /** Records a new execution in `validating`. */
  open(input: OpenExecutionInput): ExecutionRecord {
    this.#db
      .prepare(
        `INSERT INTO forge_executions(id,root_session_id,session_id,tool_call_id,engine,isolation,
           selection_reason,status,code_sha256,started_at,analysis_execution_id,owner_pid)
         VALUES(?,?,?,?,?,?,?,'validating',?,?,?,?)`,
      )
      .run(
        input.id,
        input.rootSessionId,
        input.sessionId,
        input.toolCallId,
        input.engine,
        input.isolation,
        input.selectionReason,
        input.codeSha256,
        this.#now(),
        input.analysisExecutionId ?? null,
        this.#ownerPid,
      );
    return this.#required(input.id);
  }

  /** Links the execution to the `analysis_executions` row its engine created while preparing. */
  linkAnalysisExecution(id: string, analysisExecutionId: string): void {
    const result = this.#db
      .prepare("UPDATE forge_executions SET analysis_execution_id=? WHERE id=?")
      .run(analysisExecutionId, id);
    if (Number(result.changes) === 0) throw new Error(`Unknown Forja execution: ${id}`);
  }

  get(id: string): ExecutionRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM forge_executions WHERE id=?").get(id) as
      | Row
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  listByRoot(rootSessionId: string): ExecutionRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM forge_executions WHERE root_session_id=? ORDER BY started_at, id")
        .all(rootSessionId) as Row[]
    ).map(toRecord);
  }

  /** Moves to a non-terminal state the diagram allows. Terminal states go through `close()`. */
  transition(id: string, to: ExecutionState): void {
    if (isTerminal(to))
      throw new Error(`Terminal state ${to} is reached through close(), not transition()`);
    this.#advance(id, to, {});
  }

  /** Reaches a terminal state, once. A second close throws and changes nothing. */
  close(id: string, outcome: CloseOutcome): void {
    if (!isTerminal(outcome.status))
      throw new Error(`close() needs a terminal state, got ${String(outcome.status)}`);
    this.#advance(id, outcome.status, {
      endedAt: this.#now(),
      errorCode: outcome.errorCode ?? null,
      metrics: outcome.metrics ? JSON.stringify(outcome.metrics) : null,
      unconfirmed: outcome.terminationUnconfirmed ? 1 : 0,
    });
  }

  #advance(
    id: string,
    to: ExecutionState,
    terminal: {
      endedAt?: number;
      errorCode?: string | null;
      metrics?: string | null;
      unconfirmed?: number;
    },
  ): void {
    this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT status FROM forge_executions WHERE id=?").get(id) as
        | { status: ExecutionState }
        | undefined;
      if (!row) throw new Error(`Unknown Forja execution: ${id}`);
      if (!canTransition(row.status, to)) throw new InvalidTransitionError(row.status, to);
      if (terminal.endedAt === undefined) {
        this.#db
          .prepare("UPDATE forge_executions SET status=? WHERE id=? AND status=?")
          .run(to, id, row.status);
        return;
      }
      this.#db
        .prepare(
          `UPDATE forge_executions SET status=?, ended_at=?, error_code=?, metrics_json=?,
             termination_unconfirmed=? WHERE id=? AND status=?`,
        )
        .run(
          to,
          terminal.endedAt,
          terminal.errorCode ?? null,
          terminal.metrics ?? null,
          terminal.unconfirmed ?? 0,
          id,
          row.status,
        );
    });
  }

  /** Records the start of a nested call and returns its id. */
  startCall(input: StartCallInput): string {
    const execution = this.#required(input.executionId);
    const callId = forgeCallId(execution.toolCallId, input.n);
    this.#db
      .prepare(
        `INSERT INTO forge_calls(execution_id,call_id,tool_name,effect,status,input_sha256,paths_json)
         VALUES(?,?,?,?,'started',?,?)`,
      )
      .run(
        input.executionId,
        callId,
        input.toolName,
        input.effect,
        input.inputSha256,
        input.effect === "write" && input.paths ? JSON.stringify(input.paths) : null,
      );
    return callId;
  }

  /** Ends a call that is still `started`; false when it already ended (or does not exist). */
  endCall(executionId: string, callId: string, outcome: EndCallOutcome): boolean {
    const result = this.#db
      .prepare(
        `UPDATE forge_calls SET status=?, duration_ms=?, error_code=?
         WHERE execution_id=? AND call_id=? AND status='started'`,
      )
      .run(
        outcome.status,
        outcome.durationMs ?? null,
        outcome.errorCode ?? null,
        executionId,
        callId,
      );
    return Number(result.changes) > 0;
  }

  calls(executionId: string): CallRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM forge_calls WHERE execution_id=?")
      .all(executionId) as Row[];
    const position = (callId: string) => Number(callId.slice(callId.lastIndexOf(":") + 1));
    return rows.map(toCall).sort((a, b) => position(a.callId) - position(b.callId));
  }

  #required(id: string): ExecutionRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Unknown Forja execution: ${id}`);
    return record;
  }
}

/**
 * Restart reconciliation (§9.3, FJ-AC-25): every non-terminal execution whose owner process is
 * gone (or unknown) becomes `failed` with `ISOLATE_FAILURE` and reason `interrupted`. Nothing is
 * relaunched. Executions of another live process are left alone. Returns the rows reconciled.
 *
 * Call it once when the application opens the store (Phase 3 wires it next to the runner).
 */
export function reconcileInterruptedExecutions(
  db: SqlDatabase,
  options: { now?: () => number; isAlive?: (pid: number) => boolean } = {},
): number {
  const now = (options.now ?? Date.now)();
  const isAlive = options.isAlive ?? isProcessAlive;
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, status, owner_pid FROM forge_executions
         WHERE status NOT IN ('succeeded','failed','cancelled','timed_out')`,
      )
      .all() as Array<{ id: string; status: string; owner_pid: number | null }>;
    const update = db.prepare(
      `UPDATE forge_executions SET status='failed', error_code='ISOLATE_FAILURE', ended_at=?,
         metrics_json=? WHERE id=? AND status=?`,
    );
    let reconciled = 0;
    for (const row of rows) {
      if (row.owner_pid != null && isAlive(row.owner_pid)) continue;
      const result = update.run(now, JSON.stringify({ reason: "interrupted" }), row.id, row.status);
      if (Number(result.changes) > 0) reconciled++;
    }
    return reconciled;
  });
}
