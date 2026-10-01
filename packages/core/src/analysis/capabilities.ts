/**
 * Persisted capability decisions (`capability_grants`). A `session` allow of the ROOT session is
 * the only state that grants anything; `once` allows and every `deny` are audit rows only (a deny
 * is never sticky: the next call asks again). Revoking stamps `revoked_at`; nothing is deleted.
 */
import type { AnalysisCapability, CapabilityGrantWire, SqlDatabase } from "@alisio/sdk";
import { newId } from "../runtime/ids.ts";

export type GrantSource = CapabilityGrantWire["source"];

export interface GrantRecord extends CapabilityGrantWire {
  workspace: string;
  callId?: string;
  runId?: string;
  correlationId?: string;
  revokedBy?: string;
}

const toRecord = (r: Record<string, unknown>): GrantRecord => ({
  id: String(r.id),
  capability: String(r.capability) as AnalysisCapability,
  sessionId: String(r.session),
  workspace: String(r.workspace),
  scope: String(r.scope) as GrantRecord["scope"],
  decision: String(r.decision) as GrantRecord["decision"],
  source: String(r.source) as GrantSource,
  createdAt: Number(r.created_at),
  ...(r.revoked_at != null ? { revokedAt: Number(r.revoked_at) } : {}),
  ...(r.revoked_by != null ? { revokedBy: String(r.revoked_by) } : {}),
  ...(r.call_id != null ? { callId: String(r.call_id) } : {}),
  ...(r.run_id != null ? { runId: String(r.run_id) } : {}),
  ...(r.correlation_id != null ? { correlationId: String(r.correlation_id) } : {}),
});

/** Wire shape (no workspace path or call ids). */
export const toGrantWire = (record: GrantRecord): CapabilityGrantWire => ({
  id: record.id,
  capability: record.capability,
  sessionId: record.sessionId,
  scope: record.scope,
  decision: record.decision,
  source: record.source,
  createdAt: record.createdAt,
  ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
});

export class CapabilityGrants {
  constructor(
    private options: {
      db: SqlDatabase;
      /** Root of a session (grants always belong to the root). */
      rootOf: (sessionId: string) => string;
      now?: () => number;
    },
  ) {}

  rootOf(sessionId: string): string {
    return this.options.rootOf(sessionId);
  }

  /** The live `session` allow of `capability` for the root of `sessionId`, if any. */
  active(capability: AnalysisCapability, sessionId: string): GrantRecord | undefined {
    const row = this.options.db
      .prepare(
        `SELECT * FROM capability_grants WHERE capability=? AND session=? AND scope='session'
           AND decision='allow' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .get(capability, this.rootOf(sessionId)) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  granted(capability: AnalysisCapability, sessionId: string): boolean {
    return !!this.active(capability, sessionId);
  }

  /** Records one decision (audit row; a `session` allow is also the live grant). */
  record(input: {
    capability: AnalysisCapability;
    sessionId: string;
    workspace: string;
    scope: "once" | "session";
    decision: "allow" | "deny";
    source: GrantSource;
    callId?: string;
    runId?: string;
    correlationId?: string;
  }): GrantRecord {
    const id = newId("grant");
    const createdAt = (this.options.now ?? Date.now)();
    this.options.db
      .prepare(
        `INSERT INTO capability_grants(id,capability,session,workspace,scope,decision,source,call_id,
           run_id,correlation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.capability,
        this.rootOf(input.sessionId),
        input.workspace,
        input.scope,
        input.decision,
        input.source,
        input.callId ?? null,
        input.runId ?? null,
        input.correlationId ?? null,
        createdAt,
      );
    return this.get(id) as GrantRecord;
  }

  get(id: string): GrantRecord | undefined {
    const row = this.options.db.prepare("SELECT * FROM capability_grants WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Live session grants first, then the latest `limit` audit rows of the root session. */
  list(sessionId: string, limit = 50): GrantRecord[] {
    const root = this.rootOf(sessionId);
    const live = (
      this.options.db
        .prepare(
          `SELECT * FROM capability_grants WHERE session=? AND scope='session' AND decision='allow'
             AND revoked_at IS NULL ORDER BY created_at DESC`,
        )
        .all(root) as Record<string, unknown>[]
    ).map(toRecord);
    const ids = new Set(live.map((g) => g.id));
    const audit = (
      this.options.db
        .prepare("SELECT * FROM capability_grants WHERE session=? ORDER BY created_at DESC LIMIT ?")
        .all(root, limit) as Record<string, unknown>[]
    )
      .map(toRecord)
      .filter((g) => !ids.has(g.id));
    return [...live, ...audit];
  }

  /** Live grants of the root session only. */
  live(sessionId: string): GrantRecord[] {
    return this.list(sessionId, 0).filter(
      (g) => g.revokedAt === undefined && g.scope === "session",
    );
  }

  /** Revokes a live grant of `sessionId`'s root. False when unknown, foreign or already revoked. */
  revoke(sessionId: string, grantId: string, by: string): boolean {
    const grant = this.get(grantId);
    if (!grant || grant.sessionId !== this.rootOf(sessionId) || grant.revokedAt !== undefined)
      return false;
    this.options.db
      .prepare("UPDATE capability_grants SET revoked_at=?, revoked_by=? WHERE id=?")
      .run((this.options.now ?? Date.now)(), by, grantId);
    return true;
  }
}
