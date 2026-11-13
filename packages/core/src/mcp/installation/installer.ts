/**
 * The MCP installer service (specs/030 phase 3): plans, install/update jobs with the state machine
 * of §9, uninstall by scope with reference counting, and crash reconciliation. It composes the
 * ports (catalog entries, secret store, npm runner, URL guard, config writer) and knows nothing of
 * HTTP or of a workspace application: the caller passes `JobHooks` that attach an entry to the
 * live connector, connect it and detach it again.
 *
 * Invariants:
 * - install and execution stay distinct (D5): nothing here grants consent; a job that needs it
 *   waits in `awaiting-consent` until the caller has obtained it through the existing flow;
 * - one writer per target: jobs for the same configuration file are serialized and every write
 *   re-reads under the file lock (D16); an alias is created, never replaced;
 * - a job that does not finish leaves nothing behind (rollback) and its journal is enough to undo
 *   it after a crash (`reconcile`); a failed CONNECTION alone keeps the installation (INST-06).
 */
import { existsSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { stateHome } from "../../config.ts";
import { isProcessAlive } from "../../runtime/process.ts";
import type { CatalogEntry } from "../catalog/source.ts";
import {
  McpConfigError,
  readMcpConfigRevision,
  readMcpServers,
  removeMcpServer,
  writeMcpServer,
} from "../config-writer.ts";
import { createUrlGuard, type UrlGuard, UrlRejectedError } from "../net-guard.ts";
import type { RuntimeEnvironment } from "../runtime.ts";
import { MAX_INSTALL_TIMEOUT_MS, readInstallTimeoutMs } from "./config.ts";
import { buildNpmEntry, buildRemoteEntry, collectAnswers, hasPlaceholder } from "./entry.ts";
import { McpInstallError } from "./errors.ts";
import {
  artifactIdFor,
  artifactPath,
  configTarget,
  releaseArtifact,
  removeArtifactDir,
  removeTempDir,
  rollbackJob,
  strayEntries,
} from "./lifecycle.ts";
import { installNpmPackage, type NpmRunner } from "./npm-installer.ts";
import {
  buildPlan,
  type InstallPlan,
  type PlanRequest,
  PlanStore,
  planTarget,
  type StoredPlan,
} from "./planner.ts";
import type { SecretStore } from "./secrets.ts";
import {
  type BindingRecord,
  type BindingTestRecord,
  InstallStore,
  isTerminal,
  type JobRecord,
  type JobState,
} from "./store.ts";

export interface ConnectResult {
  status: "connected" | "failed" | "needs-authentication";
  diagnostic?: string;
  capabilities: string[];
  counts: { tools: number; resources: number; prompts: number };
}

/** What the caller (a workspace application) does for a job; the installer never touches it directly. */
export interface JobHooks {
  runtimePermission(): "granted" | "not-granted" | "read-only";
  /** Adds (or replaces) the entry in the live connector so it can connect without a restart. */
  attach(name: string, entry: unknown, context: AttachContext): Promise<void>;
  detach(name: string): Promise<void>;
  connect(name: string, signal: AbortSignal): Promise<ConnectResult>;
  /** Called once the job reached a terminal state (refresh the UI, reconcile other workspaces). */
  done?(job: InstallJobView): void;
}

/** Which configuration layer an entry was written to. */
export interface AttachContext {
  scope: "global" | "project";
  workspacePath?: string;
}

export interface InstallJobView {
  id: string;
  kind: "install" | "update";
  state: JobState;
  alias: string;
  registryName: string;
  registryVersion: string;
  scope: "global" | "project";
  bindingId?: string;
  error?: { code: string; message: string };
  result?: JobRecord["result"];
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface UninstallResult {
  alias: string;
  /** The configuration entry was removed (false when it was already gone). */
  removedConfig: boolean;
  secretsRemoved: boolean;
  artifact: "none" | "kept" | "deleted" | "orphaned";
}

export interface ReconcileReport {
  interruptedJobs: string[];
  droppedBindings: string[];
  orphanArtifacts: string[];
  removedTemporary: string[];
}

export interface McpInstallerOptions {
  /** Installer database (default `<stateHome>/mcp/installations.sqlite`); `:memory:` works. */
  dbPath?: string;
  artifactsRoot?: string;
  secrets: SecretStore;
  entries: { entry(name: string, version?: string): CatalogEntry | undefined };
  runNpm?: NpmRunner;
  guard?: UrlGuard;
  runtime?: RuntimeEnvironment;
  now?: () => Date;
  /** Deadline of the initial download in ms (default: configuration, 180 s, at most 600 s). */
  deadlineMs?: () => number;
  planTtlMs?: number;
}

export interface StartRequest {
  planId: string;
  digest: string;
  idempotencyKey: string;
  inputs: Record<string, unknown>;
  hooks: JobHooks;
}

class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

interface Running {
  controller: AbortController;
  cancelled: boolean;
  consent?: { resolve: () => void };
  done: Promise<void>;
  hooks: JobHooks;
}

const safeMessage = (error: unknown): { code: string; message: string } => {
  if (error instanceof McpInstallError) return { code: error.code, message: error.message };
  if (error instanceof McpConfigError)
    return {
      code: error.code === "mcp_config_invalid" ? "validation_failed" : error.code,
      message: error.message,
    };
  return { code: "mcp_install_failed", message: "The installation failed unexpectedly" };
};

export class McpInstaller {
  private opened?: InstallStore;
  readonly artifactsRoot: string;
  private readonly dbPath: string;
  private readonly plans = new PlanStore();
  private readonly mutex = new KeyedMutex();
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<InstallJobView>>();
  private readonly now: () => Date;

  constructor(private readonly options: McpInstallerOptions) {
    this.dbPath = options.dbPath ?? join(stateHome(), "mcp", "installations.sqlite");
    this.artifactsRoot = options.artifactsRoot ?? join(stateHome(), "mcp", "artifacts");
    this.now = options.now ?? (() => new Date());
  }

  /** The installer database, opened on first use (a user who never installs gets no file). */
  get store(): InstallStore {
    this.opened ??= InstallStore.open(this.dbPath);
    return this.opened;
  }

  // ---- planning ------------------------------------------------------------------------------

  private plannerDeps() {
    return {
      entries: this.options.entries,
      guard: this.options.guard ?? createUrlGuard(),
      runtime: this.options.runtime ?? {},
      now: this.now,
      ...(this.options.planTtlMs ? { ttlMs: this.options.planTtlMs } : {}),
      takenAliases: async (scope: "global" | "project", workspacePath?: string) => {
        const taken = new Set<string>();
        for (const target of [
          { scope: "global" } as const,
          ...(scope === "project" && workspacePath
            ? [{ scope: "project", workspace: workspacePath } as const]
            : []),
        ])
          for (const name of Object.keys(await readMcpServers(target).catch(() => ({}))))
            taken.add(name);
        for (const binding of this.bindings())
          if (
            binding.scope === scope &&
            (scope === "global" || binding.workspacePath === workspacePath)
          )
            taken.add(binding.alias);
        return taken;
      },
      configRevision: readMcpConfigRevision,
    };
  }

  async plan(request: PlanRequest): Promise<InstallPlan> {
    const stored = await buildPlan(this.plannerDeps(), request);
    this.plans.put(stored, this.now());
    return stored.plan;
  }

  /** Plan to move an installed npm binding to another catalog version (default: the latest). */
  async planUpdate(
    bindingId: string,
    request: {
      workspace?: PlanRequest["workspace"];
      version?: string;
      runtimePermission: PlanRequest["runtimePermission"];
    },
  ): Promise<InstallPlan> {
    const binding = this.binding(bindingId);
    if (!binding) throw new McpInstallError("not_found", "MCP binding not found");
    if (binding.method !== "npm")
      throw new McpInstallError(
        "mcp_method_unsupported",
        "Only installed packages can be updated",
        {
          reason: "other_method",
        },
      );
    const stored = await buildPlan(
      this.plannerDeps(),
      {
        name: binding.registryName,
        ...(request.version ? { version: request.version } : {}),
        scope: binding.scope,
        ...(binding.scope === "project" && binding.workspacePath
          ? {
              workspace: {
                path: binding.workspacePath,
                ...(request.workspace?.sessionTrusted ? { sessionTrusted: true } : {}),
              },
            }
          : {}),
        method: "npm",
        runtimePermission: request.runtimePermission,
      },
      { bindingId, alias: binding.alias, fromVersion: binding.registryVersion },
    );
    // Inputs the binding already holds are not asked again ("empty means keep").
    const current = (await readMcpServers(
      configTarget(binding.scope, binding.workspacePath, !!request.workspace?.sessionTrusted),
    ).catch(() => ({}))) as Record<
      string,
      { raw: { env?: Record<string, string>; secretEnv?: Record<string, unknown> } }
    >;
    const have = new Set([
      ...Object.keys(current[binding.alias]?.raw.env ?? {}),
      ...Object.keys(current[binding.alias]?.raw.secretEnv ?? {}),
    ]);
    stored.plan.requiredInputs = stored.plan.requiredInputs.filter(
      (i) => !(i.kind === "env" && have.has(i.name)),
    );
    this.plans.put(stored, this.now());
    return stored.plan;
  }

  // ---- jobs ----------------------------------------------------------------------------------

  job(id: string): InstallJobView | undefined {
    const record = this.present ? this.store.job(id) : undefined;
    return record ? this.view(record) : undefined;
  }

  private view(r: JobRecord): InstallJobView {
    return {
      id: r.id,
      kind: r.kind,
      state: r.state,
      alias: r.alias,
      registryName: r.registryName,
      registryVersion: r.registryVersion,
      scope: r.scope,
      ...(r.bindingId ? { bindingId: r.bindingId } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.result ? { result: r.result } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    };
  }

  /** Starts a job from a plan. The same idempotency key always answers with the same job. */
  start(request: StartRequest): Promise<InstallJobView> {
    const existing = this.starting.get(request.idempotencyKey);
    if (existing) return existing;
    const started = this.startOnce(request).finally(() =>
      this.starting.delete(request.idempotencyKey),
    );
    this.starting.set(request.idempotencyKey, started);
    return started;
  }

  private async startOnce(request: StartRequest): Promise<InstallJobView> {
    const prior = this.store.jobByKey(request.idempotencyKey);
    if (prior) {
      if (prior.planDigest !== request.digest)
        throw new McpInstallError(
          "validation_failed",
          "That idempotency key belongs to another plan",
          {
            fields: ["idempotencyKey"],
          },
        );
      return this.view(prior);
    }
    const stored = this.plans.take(request.planId, request.digest, this.now());
    const { plan } = stored;
    const all = [...(stored.package?.inputs ?? stored.remote?.inputs ?? [])];
    const answers = collectAnswers(
      plan.kind === "update"
        ? all.filter(
            (i) =>
              plan.requiredInputs.some((r) => r.id === `${i.kind}.${i.name}`) ||
              request.inputs[`${i.kind}.${i.name}`] !== undefined,
          )
        : all,
      request.inputs,
    );
    // The catalog entry or the configuration may have moved since the plan was shown.
    const entry = this.options.entries.entry(plan.registryName, plan.registryVersion);
    if (!entry || entry.provenance.rawDigest !== stored.entryDigest || entry.status !== "active")
      throw new McpInstallError(
        "mcp_config_conflict",
        "The catalog entry changed: review the plan again",
      );
    const target = planTarget({
      scope: plan.scope,
      ...(stored.workspacePath
        ? { workspace: { path: stored.workspacePath, sessionTrusted: stored.sessionTrusted } }
        : {}),
    });
    if ((await readMcpConfigRevision(target)) !== stored.targetRevision)
      throw new McpInstallError(
        "mcp_config_conflict",
        "The configuration changed: review the plan again",
      );
    if (
      plan.kind === "install" &&
      this.store.bindingByAlias(plan.alias, plan.scope, stored.workspacePath)
    )
      throw new McpInstallError(
        "mcp_config_conflict",
        "That integration is already installed here",
      );
    const now = this.now().toISOString();
    const record: JobRecord = {
      id: `job_${crypto.randomUUID()}`,
      idempotencyKey: request.idempotencyKey,
      kind: plan.kind,
      planDigest: plan.digest,
      state: "planned",
      alias: plan.alias,
      registryName: plan.registryName,
      registryVersion: plan.registryVersion,
      scope: plan.scope,
      ...(stored.workspacePath ? { workspacePath: stored.workspacePath } : {}),
      ...(plan.bindingId ? { bindingId: plan.bindingId } : {}),
      journal: { pid: process.pid },
      createdAt: now,
      updatedAt: now,
    };
    this.store.putJob(record);
    // The journal is not a log: finished jobs beyond the newest 200 are dropped.
    this.store.pruneJobs(200);
    this.plans.drop(plan.planId);
    const controller = new AbortController();
    const run: Running = {
      controller,
      cancelled: false,
      hooks: request.hooks,
      done: Promise.resolve(),
    };
    run.done = this.execute(record.id, stored, answers, run)
      .catch(() => {})
      .then(() => {
        const finished = this.job(record.id);
        if (finished && isTerminal(finished.state))
          try {
            run.hooks.done?.(finished);
          } catch {
            /* a UI refresh failing never changes the job */
          }
      });
    this.running.set(record.id, run);
    void run.done.finally(() => this.running.delete(record.id));
    return this.view(record);
  }

  /** Resumes a job that waits for consent once the caller obtained it through the existing flow. */
  provideConsent(jobId: string): InstallJobView {
    const record = this.store.job(jobId);
    const run = this.running.get(jobId);
    if (!record || !run) throw new McpInstallError("not_found", "The install job was not found");
    if (record.state !== "awaiting-consent")
      throw new McpInstallError("validation_failed", "The job is not waiting for consent");
    if (run.hooks.runtimePermission() !== "granted")
      throw new McpInstallError("mcp_not_permitted", "MCP access has not been granted");
    run.consent?.resolve();
    return this.view(this.store.job(jobId) as JobRecord);
  }

  /** Cancels a job and waits until it has rolled back; idempotent. */
  async cancel(jobId: string): Promise<InstallJobView | undefined> {
    const record = this.present ? this.store.job(jobId) : undefined;
    if (!record) return undefined;
    const run = this.running.get(jobId);
    if (run && !isTerminal(record.state)) {
      run.cancelled = true;
      run.controller.abort();
      run.consent?.resolve();
      await run.done;
    } else if (!isTerminal(record.state)) {
      // Not running in this process (it was interrupted): undo it from its journal.
      await this.interrupt(record);
    }
    return this.job(jobId);
  }

  private persist(record: JobRecord, patch: Partial<JobRecord>): JobRecord {
    Object.assign(record, patch, { updatedAt: this.now().toISOString() });
    this.store.putJob(record);
    return record;
  }

  private async execute(
    jobId: string,
    stored: StoredPlan,
    answers: Record<string, string>,
    run: Running,
  ): Promise<void> {
    let record = this.store.job(jobId) as JobRecord;
    const deadlineMs = this.deadlineMs();
    const installSignal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(deadlineMs)]);
    try {
      if (stored.plan.requiresConsent && run.hooks.runtimePermission() !== "granted") {
        record = this.persist(record, { state: "awaiting-consent" });
        await new Promise<void>((resolve) => {
          run.consent = { resolve };
          if (run.cancelled) resolve();
        });
        run.controller.signal.throwIfAborted();
      }
      const artifact = await this.phaseInstall(record, stored, run, installSignal);
      await this.phaseConfigure(record, stored, answers, run, artifact);
      await this.phaseConnect(record, stored, run);
    } catch (error) {
      const cancelled = run.cancelled;
      const timedOut = installSignal.aborted && !run.controller.signal.aborted;
      const failure =
        timedOut && !cancelled
          ? {
              code: "mcp_install_failed",
              message: "The installation took too long and was stopped",
            }
          : safeMessage(error);
      record = this.store.job(jobId) as JobRecord;
      await rollbackJob(
        { store: this.store, secrets: this.options.secrets, artifactsRoot: this.artifactsRoot },
        record,
        { detach: run.hooks.detach, attach: run.hooks.attach },
        stored.sessionTrusted,
      ).catch(() => {});
      if (cancelled)
        this.persist(record, { state: "cancelled", finishedAt: this.now().toISOString() });
      else
        this.persist(record, {
          state: "failed",
          error: failure,
          finishedAt: this.now().toISOString(),
        });
    }
  }

  /** The download deadline: configuration (clamped to 30–600 s) or the injected value (≤ 600 s). */
  private deadlineMs(): number {
    return Math.min(MAX_INSTALL_TIMEOUT_MS, (this.options.deadlineMs ?? readInstallTimeoutMs)());
  }

  private async phaseInstall(
    record: JobRecord,
    stored: StoredPlan,
    run: Running,
    signal: AbortSignal,
  ): Promise<{ artifactId?: string; binPath?: string } | undefined> {
    this.persist(record, { state: "installing" });
    if (!stored.package) return undefined;
    const { identifier, version } = stored.package;
    const id = artifactIdFor(identifier, version);
    await mkdir(this.artifactsRoot, { recursive: true, mode: 0o700 });
    return this.mutex.run(`artifact:${id}`, async () => {
      const existing = this.store.artifact(id);
      if (existing) {
        const bin = join(artifactPath(this.artifactsRoot, id), existing.bin);
        if (
          await stat(bin).then(
            (s) => s.isFile(),
            () => false,
          )
        )
          return { artifactId: id, binPath: bin };
        // A recorded artifact whose files are gone cannot be reused: reinstall it.
        this.store.deleteArtifact(id);
      }
      const tmp = join(this.artifactsRoot, `.tmp-${record.id}`);
      record.journal.tmpDir = tmp;
      this.persist(record, {});
      const installed = await installNpmPackage({
        dir: tmp,
        packageName: identifier,
        version,
        signal,
        ...(this.options.runNpm ? { run: this.options.runNpm } : {}),
        timeoutMs: this.deadlineMs(),
        ...(stored.bin ? { bin: stored.bin } : {}),
      });
      signal.throwIfAborted();
      // Intent first, so an interruption between the rename and the record is still cleaned up.
      record.journal.newArtifactId = id;
      record.journal.tmpDir = undefined;
      this.persist(record, {});
      await removeArtifactDir(this.artifactsRoot, id);
      await rename(tmp, artifactPath(this.artifactsRoot, id));
      this.store.putArtifact({
        id,
        method: "npm",
        packageName: identifier,
        version,
        ...(installed.integrity ? { integrity: installed.integrity } : {}),
        bin: installed.bin,
        createdAt: this.now().toISOString(),
      });
      return { artifactId: id, binPath: join(artifactPath(this.artifactsRoot, id), installed.bin) };
    });
  }

  private async phaseConfigure(
    record: JobRecord,
    stored: StoredPlan,
    answers: Record<string, string>,
    run: Running,
    artifact: { artifactId?: string; binPath?: string } | undefined,
  ): Promise<void> {
    run.controller.signal.throwIfAborted();
    this.persist(record, { state: "configuring" });
    const { plan } = stored;
    const update = plan.kind === "update";
    const bindingId = update ? (plan.bindingId as string) : crypto.randomUUID();
    const target = configTarget(plan.scope, stored.workspacePath, stored.sessionTrusted);
    const previousBinding = update ? this.store.binding(bindingId) : undefined;
    let built: { entry: Record<string, unknown>; secrets: Record<string, string> };
    let origin: string | undefined;
    if (stored.package) {
      built = buildNpmEntry({
        bindingId,
        binPath: artifact?.binPath as string,
        args: stored.package.args,
        inputs: stored.package.inputs,
        answers,
      });
      if (update) {
        // Keep what the binding already has (variables, saved keys); only the program changes.
        const current = (await readMcpServers(target))[plan.alias]?.raw as
          | Record<string, unknown>
          | undefined;
        if (!current)
          throw new McpInstallError("mcp_config_conflict", "The integration no longer exists");
        record.journal.config = {
          scope: plan.scope,
          ...(stored.workspacePath ? { workspace: stored.workspacePath } : {}),
          alias: plan.alias,
          entry: {},
          written: false,
          previousEntry: current,
        };
        built = {
          entry: {
            ...current,
            args: (built.entry.args as string[]) ?? [],
            env: {
              ...((current.env as Record<string, string>) ?? {}),
              ...((built.entry.env as Record<string, string>) ?? {}),
            },
            secretEnv: {
              ...((current.secretEnv as Record<string, unknown>) ?? {}),
              ...((built.entry.secretEnv as Record<string, unknown>) ?? {}),
            },
          },
          secrets: built.secrets,
        };
        for (const key of ["env", "secretEnv"])
          if (!Object.keys(built.entry[key] as object).length) delete built.entry[key];
      }
    } else {
      const remote = stored.remote as NonNullable<StoredPlan["remote"]>;
      const remoteBuilt = buildRemoteEntry({
        bindingId,
        url: remote.url,
        inputs: remote.inputs,
        answers,
      });
      if (hasPlaceholder(remoteBuilt.url))
        throw new McpInstallError("mcp_input_required", "The service address is incomplete", {
          fields: remote.inputs
            .filter((i) => i.kind === "variable")
            .map((i) => `variable.${i.name}`),
        });
      try {
        origin = (await (this.options.guard ?? createUrlGuard()).check(remoteBuilt.url)).origin;
      } catch (error) {
        if (error instanceof UrlRejectedError)
          throw new McpInstallError(
            "mcp_method_unsupported",
            `The service address was refused: ${error.message}`,
            {
              reason: "unsafe_address",
            },
          );
        throw error;
      }
      built = remoteBuilt;
    }
    const secretIds = Object.keys(built.secrets);
    // Only ids that did not exist before are the job's to undo: a replaced key is never deleted.
    const freshSecretIds: string[] = [];
    for (const id of secretIds) if (!(await this.options.secrets.has(id))) freshSecretIds.push(id);
    const previousEntry = record.journal.config?.previousEntry;
    record.journal.bindingId = bindingId;
    record.journal.secretIds = freshSecretIds;
    if (previousBinding)
      record.journal.previous = {
        ...(previousBinding.artifactId ? { artifactId: previousBinding.artifactId } : {}),
        version: previousBinding.registryVersion,
      };
    record.journal.config = {
      scope: plan.scope,
      ...(stored.workspacePath ? { workspace: stored.workspacePath } : {}),
      alias: plan.alias,
      entry: built.entry,
      written: false,
      ...(previousEntry !== undefined ? { previousEntry } : {}),
    };
    this.persist(record, { bindingId });
    if (secretIds.length) await this.options.secrets.setMany(built.secrets);
    run.controller.signal.throwIfAborted();
    await this.mutex.run(`config:${plan.scope}:${stored.workspacePath ?? ""}`, async () => {
      await writeMcpServer({
        target,
        name: plan.alias,
        server: built.entry,
        expectedRevision: stored.targetRevision,
        ...(update ? {} : { create: true }),
      });
      (record.journal.config as { written: boolean }).written = true;
      const now = this.now().toISOString();
      this.store.transaction(() => {
        this.store.putBinding(
          {
            id: bindingId,
            alias: plan.alias,
            registryName: plan.registryName,
            registryVersion: plan.registryVersion,
            sourceId: stored.sourceId,
            method: plan.method,
            execution: plan.execution,
            ...(artifact?.artifactId ? { artifactId: artifact.artifactId } : {}),
            scope: plan.scope,
            ...(stored.workspacePath ? { workspacePath: stored.workspacePath } : {}),
            secretIds: [...new Set([...(previousBinding?.secretIds ?? []), ...secretIds])],
            ...(origin ? { origin } : {}),
            ...(plan.title ? { title: plan.title } : {}),
            createdAt: previousBinding?.createdAt ?? now,
            updatedAt: now,
          },
          { replace: update },
        );
        this.persist(record, {});
      });
    });
    await run.hooks.attach(plan.alias, built.entry, {
      scope: plan.scope,
      ...(stored.workspacePath ? { workspacePath: stored.workspacePath } : {}),
    });
  }

  private async phaseConnect(record: JobRecord, stored: StoredPlan, run: Running): Promise<void> {
    run.controller.signal.throwIfAborted();
    const { plan } = stored;
    this.persist(record, { state: "connecting" });
    const bindingId = record.journal.bindingId as string;
    let result: ConnectResult;
    if (run.hooks.runtimePermission() !== "granted")
      result = {
        status: "failed",
        diagnostic: "Grant MCP access to connect it",
        capabilities: [],
        counts: { tools: 0, resources: 0, prompts: 0 },
      };
    else
      result = await run.hooks
        .connect(plan.alias, run.controller.signal)
        .catch((error: unknown) => {
          if (run.controller.signal.aborted) throw error;
          return {
            status: "failed" as const,
            diagnostic: "The connection could not be completed",
            capabilities: [],
            counts: { tools: 0, resources: 0, prompts: 0 },
          };
        });
    run.controller.signal.throwIfAborted();
    const at = this.now().toISOString();
    const connected = result.status === "connected";
    if (!connected && plan.kind === "update")
      throw new McpInstallError(
        "mcp_install_failed",
        "The new version did not connect: the previous version was restored",
      );
    const test: BindingTestRecord = {
      status: connected
        ? "passed"
        : result.status === "needs-authentication"
          ? "needs-authentication"
          : "failed",
      at,
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      counts: result.counts,
      capabilities: result.capabilities,
    };
    this.store.setBindingTest(bindingId, test);
    const binding = this.store.binding(bindingId);
    if (plan.kind === "update") {
      const old = record.journal.previous?.artifactId;
      if (old && old !== binding?.artifactId)
        await releaseArtifact(this.store, this.artifactsRoot, old);
    }
    this.persist(record, {
      state: "completed",
      finishedAt: at,
      result: {
        connected,
        status: result.status,
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
        // A remote service that refuses without any saved credential probably wants a sign-in,
        // which arrives in a later phase: say so honestly instead of "failed".
        ...(!connected &&
        result.status === "needs-authentication" &&
        plan.method === "remote" &&
        !binding?.secretIds.length
          ? { signIn: "coming-soon" as const }
          : {}),
        counts: result.counts,
        capabilities: result.capabilities,
      },
    });
  }

  // ---- bindings and uninstall ------------------------------------------------------------------

  /** Whether the database exists: reading bindings must not create it for a user who never installed. */
  private get present(): boolean {
    return !!this.opened || this.dbPath === ":memory:" || existsSync(this.dbPath);
  }

  bindings(): BindingRecord[] {
    return this.present ? this.store.bindings() : [];
  }

  binding(id: string): BindingRecord | undefined {
    return this.present ? this.store.binding(id) : undefined;
  }

  recordTest(bindingId: string, test: BindingTestRecord): void {
    if (this.binding(bindingId)) this.store.setBindingTest(bindingId, test);
  }

  /**
   * Removes one binding from its own scope (LIFE-02): its configuration entry, its record, its
   * saved keys when asked, and the shared artifact only when it was the last user (D10).
   */
  async uninstall(input: {
    bindingId: string;
    scope: "global" | "project";
    workspacePath?: string;
    sessionTrusted?: boolean;
    removeSecrets: boolean;
    expectedRevision?: string;
    hooks: Pick<JobHooks, "detach">;
  }): Promise<UninstallResult> {
    const binding = this.binding(input.bindingId);
    if (!binding) throw new McpInstallError("not_found", "MCP binding not found");
    if (binding.scope !== input.scope)
      throw new McpInstallError("validation_failed", "The scope does not match this integration", {
        fields: ["scope"],
      });
    if (binding.scope === "project" && binding.workspacePath !== input.workspacePath)
      throw new McpInstallError("not_found", "MCP binding not found");
    const target = configTarget(binding.scope, binding.workspacePath, input.sessionTrusted);
    const removed = await this.mutex.run(
      `config:${binding.scope}:${binding.workspacePath ?? ""}`,
      () =>
        removeMcpServer({
          target,
          name: binding.alias,
          ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
        }),
    );
    await input.hooks.detach(binding.alias).catch(() => {});
    this.store.deleteBinding(binding.id);
    if (input.removeSecrets) await this.options.secrets.deleteMany(binding.secretIds);
    const artifact = await releaseArtifact(this.store, this.artifactsRoot, binding.artifactId);
    return {
      alias: binding.alias,
      removedConfig: removed.removed,
      secretsRemoved: input.removeSecrets,
      artifact,
    };
  }

  // ---- crash recovery --------------------------------------------------------------------------

  private async interrupt(record: JobRecord): Promise<void> {
    await rollbackJob(
      { store: this.store, secrets: this.options.secrets, artifactsRoot: this.artifactsRoot },
      record,
    ).catch(() => {});
    this.persist(record, {
      state: "failed",
      error: {
        code: "mcp_install_failed",
        message: "The installation was interrupted and was undone",
      },
      finishedAt: this.now().toISOString(),
    });
  }

  /**
   * At startup: undoes jobs that never finished, drops bindings whose configuration entry was
   * removed by hand (their keys are unreachable), removes leftover temporary directories and
   * reports artifacts nothing references. Manual edits are never overwritten.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      interruptedJobs: [],
      droppedBindings: [],
      orphanArtifacts: [],
      removedTemporary: [],
    };
    // Nothing was ever installed: there is nothing to reconcile and no file to create.
    if (!this.opened && this.dbPath !== ":memory:" && !existsSync(this.dbPath)) return report;
    for (const record of this.store.jobs()) {
      if (isTerminal(record.state) || this.running.has(record.id)) continue;
      // Another live Alisio process (the desktop host next to `alisio serve`) may own this job.
      const owner = record.journal.pid;
      if (owner && owner !== process.pid && isProcessAlive(owner)) continue;
      await this.interrupt(record);
      report.interruptedJobs.push(record.id);
    }
    for (const binding of this.bindings()) {
      const target = configTarget(binding.scope, binding.workspacePath, true);
      if (
        binding.scope === "project" &&
        !(await stat(binding.workspacePath ?? "").catch(() => undefined))
      )
        continue;
      let servers: Awaited<ReturnType<typeof readMcpServers>>;
      try {
        servers = await readMcpServers(target);
      } catch {
        continue; // an unreadable file proves nothing
      }
      if (binding.alias in servers) continue;
      this.store.deleteBinding(binding.id);
      await this.options.secrets.deleteMany(binding.secretIds).catch(() => {});
      report.droppedBindings.push(binding.id);
    }
    const live = new Set(
      [...this.running.keys()].flatMap((id) => {
        const tmp = this.store.job(id)?.journal.tmpDir;
        return tmp ? [tmp] : [];
      }),
    );
    const stray = await strayEntries(this.store, this.artifactsRoot, live);
    for (const name of stray.temporary) {
      await removeTempDir(this.artifactsRoot, join(this.artifactsRoot, name));
      report.removedTemporary.push(name);
    }
    for (const name of stray.orphans) report.orphanArtifacts.push(name);
    for (const artifact of this.store.artifacts())
      if (this.store.references(artifact.id) === 0 && !report.orphanArtifacts.includes(artifact.id))
        report.orphanArtifacts.push(artifact.id);
    return report;
  }

  /** Deletes the artifacts `reconcile` reported as unreferenced (user-initiated cleanup). */
  async cleanupOrphans(): Promise<string[]> {
    const report = await this.reconcile();
    const removed: string[] = [];
    for (const id of report.orphanArtifacts) {
      if (this.store.references(id) > 0) continue;
      if (await removeArtifactDir(this.artifactsRoot, id)) {
        this.store.deleteArtifact(id);
        removed.push(id);
      }
    }
    return removed;
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((r) => r.done));
  }

  async close(): Promise<void> {
    for (const run of this.running.values()) {
      run.cancelled = true;
      run.controller.abort();
      run.consent?.resolve();
    }
    await Promise.race([this.idle(), new Promise((r) => setTimeout(r, 3000))]);
    this.opened?.close();
    this.opened = undefined;
  }
}

export function createMcpInstaller(options: McpInstallerOptions): McpInstaller {
  return new McpInstaller(options);
}
