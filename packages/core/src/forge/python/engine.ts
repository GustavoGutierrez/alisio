/**
 * `PythonEngine` (Python spec §4, PD1): the `ExecutionEngine` that runs a `python_run` script
 * through a `PythonBackend`. It reuses what `python_run` always did, only moved behind the kernel's
 * lifecycle: `prepare` creates the job folders and copies the authorized inputs, `run` launches the
 * script and reads its stdout frames, `collect` publishes the files it left (before the shared
 * state is committed), `terminate` stops the process.
 *
 * One instance per backend (`python-managed`, `python-oci`). Everything that belongs to ONE call
 * (the code, the inputs, the publisher, where output goes) travels in the request payload as a
 * `PythonRunPlan`; the engine keeps nothing between calls. `PythonRunReport` is how the tool gets
 * back what the kernel's `ForgeResult` does not carry (the raw process result, the artifacts).
 */
import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type { EngineDescriptor, EngineId } from "@alisio/sdk";
import type { DatasetService } from "../../analysis/data/datasets.ts";
import type { AnalysisJobs, JobInput, JobPaths } from "../../analysis/jobs.ts";
import type { RerunPlan } from "../../analysis/rerun.ts";
import { ArtifactRejected } from "../../artifacts/store.ts";
import type { CoreArtifactPublisher, PublishedArtifactInfo } from "../../core/contracts.ts";
import type { ProcessResult } from "../../runtime/process.ts";
import { FORGE_ERROR_CODES, ForgeError, type ForgeErrorCode } from "../errors.ts";
import type {
  EngineOutcome,
  ExecutionEngine,
  ExecutionRequest,
  KernelChannel,
  PreparedExecution,
  TerminationReason,
  TerminationReport,
  TrustedExecutionContext,
} from "../ports.ts";
import type { PreparedJob, PythonBackend, RunningProcess } from "./backend.ts";
import { stripFrames } from "./frame-parser.ts";
import { StdoutFrameTransport } from "./frame-transport.ts";

/** Key of the plan in `ExecutionRequest.payload`. */
export const PYTHON_PLAN_KEY = "python";

/** The terminal text the model and the UI read is bounded to this many bytes. */
export const TERMINAL_BYTES = 256 * 1024;

/** A process that ignores the kernel's stop is killed by its own backstop this much later. */
const BACKSTOP_SLACK_MS = 15_000;

/** What the tool learns about a run besides the kernel's result. Filled by the engine. */
export interface PythonRunReport {
  job?: JobPaths & { scriptSha256: string };
  inputs: JobInput[];
  /** The frame nonce of this run, to clean captured output. */
  nonce?: string;
  /** Raw result of the process (stdout already without frames). */
  process?: ProcessResult;
  /** The process could not run at all (spawn failure), or crashed outside the script's own exit. */
  crash?: unknown;
  /** Why `prepare` failed, as the original error (the tool rethrows it). */
  prepareError?: unknown;
  published: PublishedArtifactInfo[];
  publishError?: string;
  warnings: string[];
  /** Wall time of the process, for the head line. */
  durationMs?: number;
  /** The public runtime facts of the backend that ran it (`runtime` in the provenance). */
  runtime?: Record<string, unknown>;
}

export const newPythonRunReport = (): PythonRunReport => ({
  inputs: [],
  published: [],
  warnings: [],
});

/** Everything one `python_run` call hands to the engine. Built by the tool; never by the model. */
export interface PythonRunPlan {
  code: string;
  rerun?: RerunPlan;
  inputs: Array<{ path?: string; datasetId?: string }>;
  /** Extras the run asked for (also recorded for reruns). */
  extrasAsked: string[];
  resolvePath: (path: string) => Promise<string>;
  datasets?: DatasetService;
  rootSessionId: string;
  sessionId: string;
  workspace: string;
  runId?: string;
  callId?: string;
  publisher: CoreArtifactPublisher;
  title?: string;
  publishOnError: boolean;
  /** Live text of the script (frames removed), for the terminal view. */
  onText: (text: string) => void;
  /** The Forja scratchpad to expose read-only, when there is one. */
  scratch?: string;
  maxLogBytes: number;
  /** Engine, isolation and reason go to the artifacts' provenance (PD12). */
  engine: { id: EngineId; isolation: string; selectionReason: string };
  report: PythonRunReport;
}

interface PreparedPython extends PreparedExecution {
  readonly plan: PythonRunPlan;
  readonly job: JobPaths & { scriptSha256: string };
  readonly nonce: string;
  readonly abort: AbortController;
  running?: RunningProcess;
  /** The script ended by itself (its own exit) and the transport saw nothing wrong. */
  finished: boolean;
}

export interface PythonEngineDeps {
  backend: PythonBackend;
  jobs: AnalysisJobs;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(FORGE_ERROR_CODES);

export class PythonEngine implements ExecutionEngine {
  readonly id: EngineId;
  readonly #backend: PythonBackend;
  readonly #jobs: AnalysisJobs;

  constructor(deps: PythonEngineDeps) {
    this.#backend = deps.backend;
    this.#jobs = deps.jobs;
    this.id = `python-${deps.backend.id}`;
  }

  describe(): Promise<EngineDescriptor> {
    return this.#backend.describe();
  }

  async prepare(
    request: ExecutionRequest,
    ctx: TrustedExecutionContext,
  ): Promise<PreparedExecution> {
    const plan = request.payload?.[PYTHON_PLAN_KEY] as PythonRunPlan | undefined;
    if (!plan) throw new ForgeError("INVALID_INPUT", "python_run did not provide its run plan");
    const { report } = plan;
    const jobs = this.#jobs;
    const rerun = plan.rerun;
    let job: (JobPaths & { scriptSha256: string }) | undefined;
    try {
      job = await jobs.create({
        sessionId: plan.sessionId,
        rootSessionId: plan.rootSessionId,
        workspace: plan.workspace,
        ...(plan.runId ? { runId: plan.runId } : {}),
        ...(plan.callId ? { callId: plan.callId } : {}),
        code: plan.code,
        runtime: this.#backend.id,
        ...(rerun ? { rerunOf: rerun.executionId } : {}),
      });
      report.job = job;
      const inputs: JobInput[] = report.inputs;
      let manifest: unknown[] = [];
      if (rerun) {
        // The verified copies of the original run, under the same names.
        for (const item of rerun.inputs) {
          const added = await jobs.addInput(job, item.source, item.name);
          if (added.sha256 !== (item.copySha256 ?? item.sha256) && !item.datasetId)
            throw new Error(`Input ${item.name} changed while the rerun started`);
          inputs.push({
            ...added,
            sha256: item.sha256,
            copySha256: added.sha256,
            ...(item.datasetId ? { datasetId: item.datasetId } : {}),
          });
        }
        manifest = rerun.manifest;
      } else
        for (const item of plan.inputs) {
          if ((item.path === undefined) === (item.datasetId === undefined))
            throw new Error("Each input needs exactly one of path or datasetId");
          if (item.datasetId !== undefined) {
            if (!plan.datasets) throw new Error("Datasets are not available here");
            const record = plan.datasets.getFor(item.datasetId, plan.rootSessionId);
            const added = await jobs.addInput(
              job,
              plan.datasets.file(record),
              `${
                basename(record.name)
                  .replace(/\.[^.]*$/, "")
                  .replace(/[^\w.-]+/g, "_") || "dataset"
              }.sqlite`,
            );
            // Provenance names the original content, so a rerun can verify it by hash.
            inputs.push({
              ...added,
              sha256: record.sha256,
              copySha256: added.sha256,
              datasetId: record.id,
            });
            manifest.push({
              name: added.name,
              kind: "dataset",
              datasetId: record.id,
              source: record.name,
              format: record.format,
              sheets: record.sheets,
            });
            continue;
          }
          const resolved = await plan.resolvePath(item.path as string);
          const added = await jobs.addInput(job, resolved);
          inputs.push({ ...added, copySha256: added.sha256 });
          manifest.push({ name: added.name, kind: "file", bytes: added.bytes });
        }
      if (manifest.length) await jobs.writeInputsManifest(job, manifest);
      await jobs.recordInputs(job, {
        inputs,
        manifest,
        ...(plan.extrasAsked.length ? { extras: plan.extrasAsked } : {}),
      });
      const state = request.payload?.state;
      await jobs.writeForgeState(job, (state as Record<string, unknown> | undefined) ?? {});
    } catch (error) {
      report.prepareError = error;
      if (job)
        jobs.finish(job.id, "failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      throw error;
    }
    const nonce = randomBytes(16).toString("hex");
    report.nonce = nonce;
    const prepared: PreparedPython = {
      executionId: ctx.executionId,
      engine: this.id,
      limits: ctx.limits,
      analysisExecutionId: job.id,
      plan,
      job,
      nonce,
      abort: new AbortController(),
      finished: false,
    };
    return prepared;
  }

  async run(prepared: PreparedExecution, channel: KernelChannel): Promise<EngineOutcome> {
    const p = prepared as PreparedPython;
    const { plan, job } = p;
    const { report } = plan;
    let failure: ForgeError | undefined;
    const transport = new StdoutFrameTransport({
      nonce: p.nonce,
      receive: (message) => channel.receive(message),
      onText: plan.onText,
      onFailure: (error) => {
        failure = error;
        p.abort.abort();
      },
    });
    const signal = AbortSignal.any([channel.signal, p.abort.signal]);
    const started = Date.now();
    const launchJob: PreparedJob = {
      executionId: job.id,
      paths: job,
      env: { ALISIO_FORGE_NONCE: p.nonce, ALISIO_FORGE_ENGINE: this.id },
      ...(plan.scratch ? { scratch: plan.scratch } : {}),
      signal,
      backstopMs: p.limits.timeoutMs + BACKSTOP_SLACK_MS,
      maxBytes: TERMINAL_BYTES,
      maxLogBytes: plan.maxLogBytes,
      logFiles: {
        stdout: `${job.logs}/stdout.log`,
        stderr: `${job.logs}/stderr.log`,
      },
    };
    try {
      const running = await this.#backend.launch(launchJob, {
        onData: (chunk, stream) =>
          stream === "stdout" ? transport.feed(chunk) : plan.onText(chunk),
      });
      p.running = running;
      report.runtime = running.runtime;
      const result = await running.result;
      report.process = { ...result, stdout: stripFrames(result.stdout, p.nonce) };
    } catch (error) {
      if (!signal.aborted) report.crash = error;
    } finally {
      report.durationMs = Date.now() - started;
      await transport.end();
      report.warnings.push(...transport.warnings);
    }
    if (failure) return { kind: "failed", code: failure.code, message: failure.message };
    // A limit the backend enforced by killing the process (the wasm memory watchdog).
    const limit = p.running?.limit?.();
    if (limit && !signal.aborted)
      return { kind: "failed", code: limit.code, message: limit.message };
    if (signal.aborted)
      return { kind: "failed", code: "ISOLATE_FAILURE", message: "the script was stopped" };
    if (report.crash)
      return {
        kind: "failed",
        code: "ISOLATE_FAILURE",
        message: report.crash instanceof Error ? report.crash.message : String(report.crash),
      };
    const exitCode = report.process?.exitCode ?? 1;
    p.finished = true;
    const fatal = transport.fatal;
    if (fatal)
      return {
        kind: "failed",
        code: (KNOWN_CODES.has(fatal.code) ? fatal.code : "SCRIPT_RUNTIME") as ForgeErrorCode,
        message: fatal.message,
      };
    if (exitCode !== 0)
      return {
        kind: "failed",
        code: "SCRIPT_RUNTIME",
        message: `the script exited with code ${exitCode}`,
      };
    const value = transport.completion?.value;
    return { kind: "completed", ...(value !== undefined ? { value } : {}) };
  }

  /** Publishes the files the script left, when the run earned it (exit 0, or `publishOnError`). */
  async collect(prepared: PreparedExecution, outcome: EngineOutcome): Promise<EngineOutcome> {
    const p = prepared as PreparedPython;
    const { plan, job } = p;
    const { report } = plan;
    if (!p.finished || !p.running) return outcome;
    const failed = outcome.kind === "failed";
    if (failed && !plan.publishOnError) return outcome;
    try {
      report.published = await plan.publisher.publishOutputs(job.staging, {
        executionId: job.id,
        ...(plan.title ? { title: plan.title } : {}),
        ...(failed ? { partial: true } : {}),
        provenance: {
          runtime: p.running.runtime,
          scriptSha256: job.scriptSha256,
          inputs: report.inputs.map((i) => ({
            name: i.name,
            sha256: i.sha256,
            ...(i.datasetId ? { datasetId: i.datasetId } : {}),
          })),
          ...(plan.rerun
            ? {
                rerunOf: plan.rerun.executionId,
                ...(plan.rerun.artifactId ? { rerunOfArtifact: plan.rerun.artifactId } : {}),
              }
            : {}),
          engine: plan.engine.id,
          isolation: plan.engine.isolation,
          selectionReason: plan.engine.selectionReason,
        },
      });
    } catch (error) {
      if (!(error instanceof ArtifactRejected)) throw error;
      report.publishError = error.message;
      return { kind: "failed", code: "PUBLICATION_REJECTED", message: error.message };
    }
    return outcome;
  }

  async terminate(
    prepared: PreparedExecution,
    reason: TerminationReason,
  ): Promise<TerminationReport> {
    const p = prepared as PreparedPython;
    p.abort.abort();
    if (!p.running) return { confirmed: true, method: "kill", elapsedMs: 0 };
    return this.#backend.terminate(p.running, reason);
  }

  async dispose(prepared: PreparedExecution): Promise<void> {
    (prepared as PreparedPython).abort.abort();
  }
}
