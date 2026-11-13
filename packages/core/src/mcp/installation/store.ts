/**
 * Ownership and provenance records of the installer (specs/030 §7, D2): which artifacts Alisio
 * downloaded, which bindings (scope + alias) use them, and the journal of installation jobs. The
 * configuration JSON stays the authority for what connects; this database says what the installer
 * owns, so a removal only ever deletes what Alisio itself put on disk, and a crash can be
 * reconciled. Secrets never enter this database: it only knows their ids.
 */
import type { SqlDatabase } from "@alisio/sdk";
import { openDatabase } from "../../runtime/sqlite.ts";

export type JobState =
  | "planned"
  | "awaiting-input"
  | "awaiting-consent"
  | "installing"
  | "configuring"
  | "connecting"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_STATES: readonly JobState[] = ["completed", "failed", "cancelled"];
export const isTerminal = (state: JobState): boolean => TERMINAL_STATES.includes(state);

export interface ArtifactRecord {
  id: string;
  method: string;
  packageName: string;
  version: string;
  integrity?: string;
  /** Path of the entry script relative to the artifact directory. */
  bin: string;
  createdAt: string;
}

/** One step of a connection test, as stored (specs/030 UX-07). */
export interface TestStepRecord {
  id: "prepare" | "connect" | "authenticate" | "discover";
  status: "passed" | "failed" | "skipped";
}

export interface BindingTestRecord {
  status: "passed" | "failed" | "cancelled" | "needs-authentication";
  at: string;
  diagnostic?: string;
  counts?: { tools: number; resources: number; prompts: number };
  capabilities?: string[];
  /** Phase 4: identity of the run, its steps, what to do next and what it proved. */
  testId?: string;
  startedAt?: string;
  steps?: TestStepRecord[];
  recoveryAction?: "retry" | "sign-in" | "change-key" | "install-runtime" | "configure" | "turn-on";
  /** Hash of the settings, version and credential revision this result was obtained with. */
  fingerprint?: string;
  /** The last time a test passed (kept when a later one fails). */
  lastPassedAt?: string;
}

export interface BindingRecord {
  id: string;
  alias: string;
  registryName: string;
  registryVersion: string;
  sourceId: string;
  method: "npm" | "remote";
  execution: "local" | "remote";
  artifactId?: string;
  scope: "global" | "project";
  /** Canonical workspace path; present for project bindings only. */
  workspacePath?: string;
  /** Ids of the secrets that belong to this binding (never their values). */
  secretIds: string[];
  /** Origin (scheme and host) of a remote service. */
  origin?: string;
  title?: string;
  lastTest?: BindingTestRecord;
  /** Bumped when a saved key is replaced, so an earlier test no longer counts as current. */
  credentialRevision: number;
  createdAt: string;
  updatedAt: string;
}

/** What a job has done so far: enough to undo it after a crash. */
export interface JobJournal {
  /** Process that runs the job, so another process never mistakes it for an interrupted one. */
  pid?: number;
  tmpDir?: string;
  /** Artifact this job created (and may delete again on rollback). */
  newArtifactId?: string;
  bindingId?: string;
  secretIds?: string[];
  /** The entry the job intends to write, and whether the write is confirmed. */
  config?: {
    scope: "global" | "project";
    workspace?: string;
    alias: string;
    entry: unknown;
    written: boolean;
    /** Update jobs: the entry to put back. */
    previousEntry?: unknown;
  };
  previous?: { artifactId?: string; version: string };
}

export interface JobRecord {
  id: string;
  idempotencyKey: string;
  kind: "install" | "update";
  planDigest: string;
  state: JobState;
  alias: string;
  registryName: string;
  registryVersion: string;
  scope: "global" | "project";
  workspacePath?: string;
  bindingId?: string;
  error?: { code: string; message: string };
  result?: {
    connected: boolean;
    status?: string;
    diagnostic?: string;
    signIn?: "available";
    counts?: { tools: number; resources: number; prompts: number };
    capabilities?: string[];
  };
  journal: JobJournal;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

type Row = Record<string, unknown>;

const MIGRATIONS = [
  `
  CREATE TABLE artifacts(
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    package_name TEXT NOT NULL,
    version TEXT NOT NULL,
    integrity TEXT,
    bin TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE bindings(
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    registry_name TEXT NOT NULL,
    registry_version TEXT NOT NULL,
    source_id TEXT NOT NULL,
    method TEXT NOT NULL,
    execution TEXT NOT NULL,
    artifact_id TEXT,
    scope TEXT NOT NULL,
    workspace_path TEXT NOT NULL DEFAULT '',
    secret_ids TEXT NOT NULL,
    origin TEXT,
    title TEXT,
    last_test TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(alias, scope, workspace_path)
  );
  CREATE INDEX bindings_artifact ON bindings(artifact_id);
  CREATE TABLE jobs(
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    plan_digest TEXT NOT NULL,
    state TEXT NOT NULL,
    alias TEXT NOT NULL,
    registry_name TEXT NOT NULL,
    registry_version TEXT NOT NULL,
    scope TEXT NOT NULL,
    workspace_path TEXT NOT NULL DEFAULT '',
    binding_id TEXT,
    error TEXT,
    result TEXT,
    journal TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  `,
  // Phase 4: connection-test history (at most 20 per binding, 30 days) and the credential revision.
  `
  ALTER TABLE bindings ADD COLUMN credential_rev INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE connection_tests(
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL,
    at TEXT NOT NULL,
    result TEXT NOT NULL
  );
  CREATE INDEX connection_tests_binding ON connection_tests(binding_id, at);
  `,
];

const json = <T>(value: unknown): T | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

function artifactOf(r: Row): ArtifactRecord {
  return {
    id: String(r.id),
    method: String(r.method),
    packageName: String(r.package_name),
    version: String(r.version),
    ...(text(r.integrity) ? { integrity: text(r.integrity) as string } : {}),
    bin: String(r.bin),
    createdAt: String(r.created_at),
  };
}

function bindingOf(r: Row): BindingRecord {
  const test = json<BindingTestRecord>(r.last_test);
  return {
    id: String(r.id),
    alias: String(r.alias),
    registryName: String(r.registry_name),
    registryVersion: String(r.registry_version),
    sourceId: String(r.source_id),
    method: r.method === "npm" ? "npm" : "remote",
    execution: r.execution === "local" ? "local" : "remote",
    ...(text(r.artifact_id) ? { artifactId: text(r.artifact_id) as string } : {}),
    scope: r.scope === "project" ? "project" : "global",
    ...(text(r.workspace_path) ? { workspacePath: text(r.workspace_path) as string } : {}),
    secretIds: json<string[]>(r.secret_ids) ?? [],
    ...(text(r.origin) ? { origin: text(r.origin) as string } : {}),
    ...(text(r.title) ? { title: text(r.title) as string } : {}),
    ...(test ? { lastTest: test } : {}),
    credentialRevision: Number(r.credential_rev ?? 0),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function jobOf(r: Row): JobRecord {
  return {
    id: String(r.id),
    idempotencyKey: String(r.idempotency_key),
    kind: r.kind === "update" ? "update" : "install",
    planDigest: String(r.plan_digest),
    state: String(r.state) as JobState,
    alias: String(r.alias),
    registryName: String(r.registry_name),
    registryVersion: String(r.registry_version),
    scope: r.scope === "project" ? "project" : "global",
    ...(text(r.workspace_path) ? { workspacePath: text(r.workspace_path) as string } : {}),
    ...(text(r.binding_id) ? { bindingId: text(r.binding_id) as string } : {}),
    ...(json<JobRecord["error"]>(r.error) ? { error: json<JobRecord["error"]>(r.error) } : {}),
    ...(json<JobRecord["result"]>(r.result) ? { result: json<JobRecord["result"]>(r.result) } : {}),
    journal: json<JobJournal>(r.journal) ?? {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    ...(text(r.finished_at) ? { finishedAt: text(r.finished_at) as string } : {}),
  };
}

export class InstallStore {
  constructor(private db: SqlDatabase) {
    this.migrate();
  }

  static open(path: string): InstallStore {
    return new InstallStore(openDatabase(path));
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)");
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (this.db.prepare("SELECT 1 AS ok FROM schema_migrations WHERE version=?").get(version))
        return;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(version);
      });
    });
  }

  // ---- artifacts -----------------------------------------------------------------------------

  artifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id);
    return row ? artifactOf(row) : undefined;
  }

  artifacts(): ArtifactRecord[] {
    return this.db.prepare("SELECT * FROM artifacts ORDER BY created_at, id").all().map(artifactOf);
  }

  putArtifact(a: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO artifacts(id, method, package_name, version, integrity, bin, created_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(a.id, a.method, a.packageName, a.version, a.integrity ?? null, a.bin, a.createdAt);
  }

  deleteArtifact(id: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE id=?").run(id);
  }

  /** How many bindings use an artifact (the reference count of D10). */
  references(artifactId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM bindings WHERE artifact_id=?")
      .get(artifactId);
    return Number(row?.n ?? 0);
  }

  // ---- bindings ------------------------------------------------------------------------------

  binding(id: string): BindingRecord | undefined {
    const row = this.db.prepare("SELECT * FROM bindings WHERE id=?").get(id);
    return row ? bindingOf(row) : undefined;
  }

  bindingByAlias(
    alias: string,
    scope: "global" | "project",
    workspacePath?: string,
  ): BindingRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM bindings WHERE alias=? AND scope=? AND workspace_path=?")
      .get(alias, scope, scope === "project" ? (workspacePath ?? "") : "");
    return row ? bindingOf(row) : undefined;
  }

  bindings(): BindingRecord[] {
    return this.db.prepare("SELECT * FROM bindings ORDER BY created_at, id").all().map(bindingOf);
  }

  /** Inserts or updates; the unique (alias, scope, workspace) key makes a duplicate throw. */
  putBinding(b: BindingRecord, options: { replace?: boolean } = {}): void {
    this.db
      .prepare(
        `${options.replace ? "INSERT OR REPLACE" : "INSERT"} INTO bindings(id, alias, registry_name, registry_version,
           source_id, method, execution, artifact_id, scope, workspace_path, secret_ids, origin, title,
           last_test, credential_rev, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        b.id,
        b.alias,
        b.registryName,
        b.registryVersion,
        b.sourceId,
        b.method,
        b.execution,
        b.artifactId ?? null,
        b.scope,
        b.scope === "project" ? (b.workspacePath ?? "") : "",
        JSON.stringify(b.secretIds),
        b.origin ?? null,
        b.title ?? null,
        b.lastTest ? JSON.stringify(b.lastTest) : null,
        b.credentialRevision,
        b.createdAt,
        b.updatedAt,
      );
  }

  setBindingTest(id: string, test: BindingTestRecord): void {
    this.db
      .prepare("UPDATE bindings SET last_test=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(test), test.at, id);
  }

  bumpCredentialRevision(id: string): void {
    this.db
      .prepare("UPDATE bindings SET credential_rev = credential_rev + 1, updated_at=? WHERE id=?")
      .run(new Date().toISOString(), id);
  }

  /** Stores a result, keeping the last 20 per binding and nothing older than 30 days. */
  addTest(bindingId: string, test: BindingTestRecord, keep = 20, days = 30): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO connection_tests(id, binding_id, at, result) VALUES(?,?,?,?)",
      )
      .run(test.testId ?? crypto.randomUUID(), bindingId, test.at, JSON.stringify(test));
    this.db
      .prepare(
        `DELETE FROM connection_tests WHERE binding_id=? AND (at < ? OR id NOT IN
           (SELECT id FROM connection_tests WHERE binding_id=? ORDER BY at DESC, id DESC LIMIT ?))`,
      )
      .run(bindingId, new Date(Date.now() - days * 86_400_000).toISOString(), bindingId, keep);
  }

  /** Newest first. */
  tests(bindingId: string): BindingTestRecord[] {
    return this.db
      .prepare("SELECT result FROM connection_tests WHERE binding_id=? ORDER BY at DESC, id DESC")
      .all(bindingId)
      .flatMap((row) => {
        const parsed = json<BindingTestRecord>(row.result);
        return parsed ? [parsed] : [];
      });
  }

  deleteBinding(id: string): void {
    this.db.prepare("DELETE FROM connection_tests WHERE binding_id=?").run(id);
    this.db.prepare("DELETE FROM bindings WHERE id=?").run(id);
  }

  // ---- jobs ----------------------------------------------------------------------------------

  job(id: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    return row ? jobOf(row) : undefined;
  }

  jobByKey(key: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key=?").get(key);
    return row ? jobOf(row) : undefined;
  }

  jobs(): JobRecord[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at, id").all().map(jobOf);
  }

  putJob(j: JobRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO jobs(id, idempotency_key, kind, plan_digest, state, alias, registry_name,
           registry_version, scope, workspace_path, binding_id, error, result, journal, created_at,
           updated_at, finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        j.id,
        j.idempotencyKey,
        j.kind,
        j.planDigest,
        j.state,
        j.alias,
        j.registryName,
        j.registryVersion,
        j.scope,
        j.scope === "project" ? (j.workspacePath ?? "") : "",
        j.bindingId ?? null,
        j.error ? JSON.stringify(j.error) : null,
        j.result ? JSON.stringify(j.result) : null,
        JSON.stringify(j.journal),
        j.createdAt,
        j.updatedAt,
        j.finishedAt ?? null,
      );
  }

  /** Drops finished jobs beyond the newest `keep` (the journal is not a log). */
  pruneJobs(keep: number): void {
    this.db
      .prepare(
        `DELETE FROM jobs WHERE state IN ('completed','failed','cancelled') AND id NOT IN
           (SELECT id FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?)`,
      )
      .run(keep);
  }
}
