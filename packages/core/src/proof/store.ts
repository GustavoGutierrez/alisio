/**
 * Persistence of the Proof ledger (tables `proof_criteria` and `proof_evidence`, schema v11).
 *
 * Evidence is append-only: there is no update path here and a database trigger rejects UPDATE;
 * rows disappear only with their session (`ON DELETE CASCADE`). The status is never stored (D4):
 * `ledger()` derives it on every read.
 */
import type { ProofEvidence, ProofLedger, SqlDatabase, SqlRow } from "@alisio/sdk";
import { newId } from "../runtime/ids.ts";
import { buildLedger } from "./ledger.ts";
import { scopeMatches } from "./scope.ts";
import type { CriterionRecord, NewCriterion, NewEvidence } from "./types.ts";

const str = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value);

function json<T>(raw: unknown): T | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function criterionFromRow(row: SqlRow): CriterionRecord {
  const goalId = str(row.goal_id);
  const verifier = json<CriterionRecord["verifier"]>(row.verifier_json);
  const scope = json<string[]>(row.scope_json);
  const notApplicableReason = str(row.na_reason);
  return {
    criterionId: String(row.criterion_id),
    sessionId: String(row.session_id),
    ...(goalId ? { goalId } : {}),
    text: String(row.text),
    required: Number(row.required) === 1,
    origin: String(row.origin) as CriterionRecord["origin"],
    ...(verifier ? { verifier } : {}),
    ...(scope ? { scope } : {}),
    ...(notApplicableReason ? { notApplicableReason } : {}),
  };
}

function evidenceFromRow(row: SqlRow): ProofEvidence {
  const commandFingerprint = str(row.fingerprint);
  const exitCode =
    row.exit_code === null || row.exit_code === undefined ? undefined : Number(row.exit_code);
  const excerpt = str(row.excerpt);
  return {
    evidenceId: String(row.evidence_id),
    criterionId: String(row.criterion_id),
    verifierKind: String(row.verifier_kind) as ProofEvidence["verifierKind"],
    runId: String(row.run_id),
    callId: String(row.call_id),
    ok: Number(row.ok) === 1,
    ...(commandFingerprint ? { commandFingerprint } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    durationMs: Number(row.duration_ms),
    outputHash: String(row.output_hash),
    ...(excerpt !== undefined ? { excerpt } : {}),
    treeFingerprint: String(row.tree_fingerprint),
    filesTouched: json<string[]>(row.files_json) ?? [],
    capturedAt: String(row.captured_at),
  };
}

export class ProofStore {
  constructor(private readonly db: SqlDatabase) {}

  addCriterion(input: NewCriterion): CriterionRecord {
    const criterionId = newId("crit");
    this.db
      .prepare(
        `INSERT INTO proof_criteria(criterion_id,session_id,goal_id,text,required,origin,verifier_json,scope_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        criterionId,
        input.sessionId,
        input.goalId ?? null,
        input.text,
        input.required ? 1 : 0,
        input.origin,
        input.verifier ? JSON.stringify(input.verifier) : null,
        input.scope ? JSON.stringify(input.scope) : null,
        Date.now(),
      );
    return this.criterion(criterionId) as CriterionRecord;
  }

  criterion(criterionId: string): CriterionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM proof_criteria WHERE criterion_id=?")
      .get(criterionId);
    return row ? criterionFromRow(row) : undefined;
  }

  /** The criteria of a session in creation order, without any derived field. */
  criteria(sessionId: string): CriterionRecord[] {
    return this.db
      .prepare("SELECT * FROM proof_criteria WHERE session_id=? ORDER BY created_at, rowid")
      .all(sessionId)
      .map(criterionFromRow);
  }

  /** How many criteria a session has (one indexed count; the stream snapshot uses it). */
  criteriaCount(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM proof_criteria WHERE session_id=?")
      .get(sessionId);
    return Number(row?.n ?? 0);
  }

  /** Marks a criterion not applicable. Callers must be the user, never a tool result (O2). */
  markNotApplicable(criterionId: string, reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) throw new Error("not_applicable requires a reason");
    const result = this.db
      .prepare("UPDATE proof_criteria SET na_reason=? WHERE criterion_id=?")
      .run(trimmed, criterionId);
    if (Number(result.changes) === 0) throw new Error(`unknown criterion: ${criterionId}`);
  }

  /**
   * The user edits a criterion. Only the wording and the required flag change: the verifier and
   * the scope stay, so the evidence already captured keeps meaning what it meant (add a new
   * criterion to check something else). Callers must be the user, never a tool result (O2).
   */
  updateCriterion(
    criterionId: string,
    change: { text?: string; required?: boolean },
  ): CriterionRecord | undefined {
    const text = change.text === undefined ? undefined : change.text.replace(/\s+/g, " ").trim();
    if (text !== undefined && !text) throw new Error("a criterion needs text");
    if (!this.criterion(criterionId)) return undefined;
    if (text !== undefined)
      this.db
        .prepare("UPDATE proof_criteria SET text=? WHERE criterion_id=?")
        .run(text, criterionId);
    if (change.required !== undefined)
      this.db
        .prepare("UPDATE proof_criteria SET required=? WHERE criterion_id=?")
        .run(change.required ? 1 : 0, criterionId);
    return this.criterion(criterionId);
  }

  /**
   * The unbacked claims the last COMPLETED run of the session warned about (`proof_divergence`
   * events of the event journal). A later run that completes without a warning clears them.
   * Display only (D8): nothing here changes a status.
   */
  divergences(sessionId: string): ProofLedger["divergences"] {
    const last = this.db
      .prepare(
        "SELECT run_id FROM events WHERE session=? AND type='run_completed' ORDER BY seq DESC LIMIT 1",
      )
      .get(sessionId);
    if (!last) return [];
    return this.db
      .prepare(
        "SELECT body FROM events WHERE session=? AND run_id=? AND type='proof_divergence' ORDER BY seq",
      )
      .all(sessionId, String(last.run_id))
      .flatMap((row) => {
        const body = json<ProofLedger["divergences"][number]>(row.body);
        return body ? [body] : [];
      });
  }

  /** Appends one immutable evidence (D2: it must name its run and its call). */
  appendEvidence(input: NewEvidence): ProofEvidence {
    if (!input.runId || !input.callId) throw new Error("evidence requires runId and callId");
    const evidenceId = newId("ev");
    this.db
      .prepare(
        `INSERT INTO proof_evidence(evidence_id,criterion_id,run_id,call_id,ok,verifier_kind,fingerprint,exit_code,
           duration_ms,output_hash,excerpt,tree_fingerprint,files_json,captured_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        evidenceId,
        input.criterionId,
        input.runId,
        input.callId,
        input.ok ? 1 : 0,
        input.verifierKind,
        input.commandFingerprint ?? null,
        input.exitCode ?? null,
        input.durationMs,
        input.outputHash,
        input.excerpt ?? null,
        input.treeFingerprint,
        JSON.stringify(input.filesTouched),
        input.capturedAt,
      );
    return { ...input, evidenceId };
  }

  /**
   * Notes a successful edit of a workspace-relative path (D5). One row per path keeps the newest
   * time, so the table is bounded by the files touched and an older time never rewinds it.
   */
  recordEdit(sessionId: string, path: string, editedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO proof_edits(session_id,path,edited_at) VALUES(?,?,?)
         ON CONFLICT(session_id,path) DO UPDATE SET edited_at=excluded.edited_at
         WHERE excluded.edited_at > proof_edits.edited_at`,
      )
      .run(sessionId, path, editedAt);
  }

  /** The files edited in a session with the time of their latest edit, sorted by path. */
  edits(sessionId: string): Array<{ path: string; editedAt: string }> {
    return this.db
      .prepare("SELECT path,edited_at FROM proof_edits WHERE session_id=? ORDER BY path")
      .all(sessionId)
      .map((row) => ({ path: String(row.path), editedAt: String(row.edited_at) }));
  }

  /** The ledger of a session with every status derived now (D4). */
  ledger(sessionId: string, now: string = new Date().toISOString()): ProofLedger {
    const criteria = this.criteria(sessionId);
    const evidence = this.db
      .prepare(
        `SELECT e.* FROM proof_evidence e JOIN proof_criteria c ON c.criterion_id=e.criterion_id
         WHERE c.session_id=? ORDER BY e.rowid`,
      )
      .all(sessionId)
      .map(evidenceFromRow);
    const edits = this.edits(sessionId);
    const lastEditAt = (criterion: CriterionRecord): string | undefined => {
      let latest: string | undefined;
      for (const edit of edits) {
        if (!scopeMatches(criterion.scope, edit.path)) continue;
        if (latest === undefined || Date.parse(edit.editedAt) > Date.parse(latest))
          latest = edit.editedAt;
      }
      return latest;
    };
    return buildLedger(sessionId, criteria, evidence, { now, lastEditAt });
  }

  /** The ledger every surface shows: `ledger()` plus the divergences of the last completed run. */
  view(sessionId: string, now?: string): ProofLedger {
    return { ...this.ledger(sessionId, now), divergences: this.divergences(sessionId) };
  }
}
