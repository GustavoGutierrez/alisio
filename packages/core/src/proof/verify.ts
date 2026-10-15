/**
 * Running a verifier on demand (specs/011 3.1, 3.8). This is a USER-side entry point: no tool
 * exposes it to the model, so the model can neither start a verification nor choose its verdict.
 *
 * - `file`, `data-check` and (opt-in) `coverage` run their canonical core tool call (`verifierCall`) as a real run
 *   under the normal gate; the recorder captures the evidence from the raw result like it does
 *   for a call the model made (D3, D6).
 * - `plugin` runs the registered verifier. Its calls go through `callTool` (the same gate), the
 *   result must carry referenceable evidence, and anything else degrades the criterion to
 *   `manual_review` (an evidence of kind `manual`). A verifier that throws or hangs proves
 *   nothing: the criterion stays as it was and the outcome says why.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  ProofResult,
  ProofStatus,
  ProofVerifierContext,
  SqlDatabase,
  ToolResult,
} from "@alisio/sdk";
import { redactOutput } from "../eval/secrets.ts";
import type { ProofVerifierRegistry } from "./plugin-verifiers.ts";
import { excerptOf } from "./recorder.ts";
import type { ProofStore } from "./store.ts";
import { treeFingerprint } from "./tree.ts";
import { verifierCall } from "./verifiers.ts";

export interface VerifyDeps {
  store: ProofStore;
  registry: ProofVerifierRegistry;
  db: SqlDatabase;
  /** Runs one core tool call as a run of the session, through the same gate as a model call. */
  callTool(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ callId: string; runId: string; result: ToolResult }>;
  /** `proof.coverage.enabled`: without it a `coverage` verifier never runs its command. */
  coverage?: () => boolean;
  /** Time a plugin verifier may take; 60 s by default. */
  timeoutMs?: number;
  now?: () => Date;
}

export interface VerifyRequest {
  sessionId: string;
  criterionId: string;
  workspace: string;
  signal?: AbortSignal;
}

export interface VerifyOutcome {
  criterionId: string;
  /** The criterion's derived status after the attempt. */
  status: ProofStatus;
  evidenceId?: string;
  /** Why nothing (or only a degradation) was recorded; absent when evidence was captured. */
  reason?:
    | "unknown_criterion"
    | "not_applicable"
    | "no_verifier"
    | "unsupported_verifier"
    | "unverifiable_spec"
    | "coverage_disabled"
    | "no_evidence"
    | "verifier_unavailable"
    | "verifier_failed"
    | "no_referenceable_evidence";
  /** Redacted, bounded detail of a failure. */
  detail?: string;
}

const PLUGIN_TIMEOUT_MS = 60_000;
const HEX_SHA256 = /^[0-9a-f]{64}$/i;
const DETAIL_MAX = 200;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactOutput(text).slice(0, DETAIL_MAX);
}

export async function verifyCriterion(
  deps: VerifyDeps,
  request: VerifyRequest,
): Promise<VerifyOutcome> {
  const { criterionId, sessionId } = request;
  const statusOf = (): { status: ProofStatus } => {
    const ledger = deps.store.ledger(sessionId, (deps.now?.() ?? new Date()).toISOString());
    const criterion = ledger.criteria.find((c) => c.criterionId === criterionId);
    return { status: criterion?.status ?? "not_checked" };
  };
  const outcome = (reason?: VerifyOutcome["reason"], detail?: string, evidenceId?: string) => ({
    criterionId,
    ...statusOf(),
    ...(evidenceId ? { evidenceId } : {}),
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
  });
  const record = deps.store.criterion(criterionId);
  if (!record || record.sessionId !== sessionId) return outcome("unknown_criterion");
  if (record.notApplicableReason) return outcome("not_applicable");
  const verifier = record.verifier;
  if (!verifier) return outcome("no_verifier");
  const signal = request.signal ?? new AbortController().signal;

  if (verifier.kind === "coverage" && deps.coverage?.() !== true)
    return outcome("coverage_disabled", "proof.coverage.enabled is false");

  if (verifier.kind === "file" || verifier.kind === "data-check" || verifier.kind === "coverage") {
    const call = verifierCall(verifier);
    if (!call) return outcome("unverifiable_spec");
    let done: Awaited<ReturnType<VerifyDeps["callTool"]>>;
    try {
      done = await deps.callTool(sessionId, call.name, call.input, signal);
    } catch (error) {
      return outcome("verifier_failed", describeError(error));
    }
    const evidence = deps.store
      .ledger(sessionId)
      .evidence.find((e) => e.criterionId === criterionId && e.callId === done.callId);
    return evidence ? outcome(undefined, undefined, evidence.evidenceId) : outcome("no_evidence");
  }

  if (verifier.kind === "plugin") {
    const entry = deps.registry.get(verifier.verifierId);
    if (!entry) return outcome("verifier_unavailable");
    const started = Date.now();
    const timeout = AbortSignal.timeout(deps.timeoutMs ?? PLUGIN_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    const context: ProofVerifierContext = {
      sessionId,
      criterionId,
      workspace: request.workspace,
      signal: combined,
      callTool: async (name, input) => {
        const { callId, result } = await deps.callTool(sessionId, name, input, combined);
        return { callId, result };
      },
    };
    let result: unknown;
    try {
      result = await raceAbort(entry.verifier.run(verifier.input, context), combined);
    } catch (error) {
      return outcome("verifier_failed", describeError(error));
    }
    const durationMs = Date.now() - started;
    const checked = referenceable(result, deps.db, sessionId);
    const filesTouched = deps.store.edits(sessionId).map((e) => e.path);
    const base = {
      criterionId,
      durationMs,
      treeFingerprint: treeFingerprint(request.workspace, filesTouched),
      filesTouched,
      capturedAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    if (checked) {
      const excerpt = typeof checked.excerpt === "string" ? excerptOf(checked.excerpt) : undefined;
      const evidence = deps.store.appendEvidence({
        ...base,
        verifierKind: "plugin",
        runId: checked.runId,
        callId: checked.callId,
        ok: checked.ok,
        outputHash: checked.outputHash,
        ...(excerpt ? { excerpt } : {}),
      });
      return outcome(undefined, undefined, evidence.evidenceId);
    }
    const why = `verifier ${verifier.verifierId} returned no traceable evidence`;
    const evidence = deps.store.appendEvidence({
      ...base,
      verifierKind: "manual",
      runId: `verify_${randomUUID()}`,
      callId: `verify_${randomUUID()}`,
      ok: false,
      outputHash: sha256(why),
      excerpt: why,
    });
    return outcome("no_referenceable_evidence", undefined, evidence.evidenceId);
  }

  return outcome("unsupported_verifier");
}

/** Rejects as soon as `signal` aborts, even when the verifier ignores it. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

interface Referenceable extends ProofResult {
  runId: string;
  callId: string;
}

/**
 * A plugin result is evidence only with a boolean verdict and a sha256 `outputHash`; a `callId`
 * must name a call this session journaled (its run id is then the real one). Without a callId the
 * host mints a verification id: the evidence is then the plugin's word plus the hash.
 */
function referenceable(
  result: unknown,
  db: SqlDatabase,
  sessionId: string,
): Referenceable | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.ok !== "boolean") return undefined;
  if (typeof r.outputHash !== "string" || !HEX_SHA256.test(r.outputHash)) return undefined;
  const base = {
    ok: r.ok,
    outputHash: r.outputHash.toLowerCase(),
    ...(typeof r.excerpt === "string" ? { excerpt: r.excerpt } : {}),
  };
  if (r.callId === undefined)
    return { ...base, runId: `verify_${randomUUID()}`, callId: `verify_${randomUUID()}` };
  if (typeof r.callId !== "string" || !r.callId) return undefined;
  const row = db
    .prepare("SELECT run_id FROM tool_calls WHERE session=? AND call_id=?")
    .get(sessionId, r.callId);
  const runId = row ? String(row.run_id ?? "") : "";
  return runId ? { ...base, callId: r.callId, runId } : undefined;
}
