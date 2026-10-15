/**
 * Proof evidence capture (specs/011 3.3, D3, D6, D7). The runner hands the recorder the RAW
 * result of a tool call right after it executed, before the model-facing bound. Only the
 * recorder writes evidence: nothing the model says or a tool prints can create, edit or mark a
 * criterion, because the only input that counts is the structured result of the four command
 * tools below and the journal of the call that produced it.
 *
 * Without `command`, `file` or `data-check` criteria in the session `capture` returns before doing
 * anything but one indexed read, and only for the command tools, `read_file`, `data_query` and
 * `write_file`/`edit_file` (D7).
 *
 * A successful `write_file`/`edit_file` is noted per path (D5); the ledger derives from those
 * times on every read, so evaluation stays pure. `divergences` checks a final answer's claims.
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ProofEvidence,
  ProofVerifierSpec,
  RunEventDataMap,
  SqlDatabase,
  ToolResult,
} from "@alisio/sdk";
import { redactOutput } from "../eval/secrets.ts";
import {
  type CommandTool,
  callFingerprint,
  criterionFingerprints,
  normalizeCwd,
  relativeCwd,
} from "./command.ts";
import { judgeCoverage } from "./coverage.ts";
import { type Divergence, detectDivergence } from "./divergence.ts";
import { ProofStore } from "./store.ts";
import { treeFingerprint } from "./tree.ts";
import type { CriterionRecord } from "./types.ts";
import {
  type FileSpec,
  judgeDataCheck,
  judgeFile,
  judgeMissingFile,
  readsFile,
  runsCanonicalQuery,
} from "./verifiers.ts";

export type ProofUpdate = RunEventDataMap["proof_updated"];

/** A tool call that already executed, as the runner reports it. */
export interface ExecutedCall {
  sessionId: string;
  runId: string;
  callId: string;
  name: string;
  input: Record<string, unknown>;
  /** The result exactly as the tool returned it. */
  result: ToolResult;
  workspace: string;
  durationMs: number;
}

type CommandCriterion = CriterionRecord & {
  verifier: Extract<ProofVerifierSpec, { kind: "command" }>;
};
type CoverageCriterion = CriterionRecord & {
  verifier: Extract<ProofVerifierSpec, { kind: "coverage" }>;
};
type FileCriterion = CriterionRecord & { verifier: FileSpec };

/** The verdict of one criterion on a call, ready to become evidence. */
interface Finding {
  criterion: CriterionRecord;
  verifierKind: ProofEvidence["verifierKind"];
  ok: boolean;
  outputHash: string;
  excerpt?: string;
  exitCode?: number;
  fingerprint?: string;
  durationMs: number;
}

/** What a command call proved: the exit code and the text the verifier looks at. */
interface Outcome {
  exitCode: number;
  output: string;
  durationMs: number;
  fingerprint: string;
}

/** Tools whose raw result can back a `command` criterion. */
const COMMAND_TOOLS = new Set(["run_process", "shell", "bg_run", "bg_output"]);
/** Tools whose raw result can back a `file` (`read_file`) or `data-check` (`data_query`) criterion. */
const VERIFIER_TOOLS = new Set(["read_file", "data_query"]);
/** Criteria bound to these verifier kinds are the ones the recorder captures evidence for. */
const CAPTURING = new Set(["command", "coverage", "file", "data-check"]);
/** Tools whose success edits workspace files and so expires evidence (D5). */
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);
const EXCERPT_BYTES = 4096;
/** Background tasks remembered per recorder (oldest dropped first). */
const MAX_BACKGROUND = 256;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function textOf(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The last `EXCERPT_BYTES` bytes of the redacted output (the end holds the summary and errors). */
export function excerptOf(output: string): string {
  const redacted = redactOutput(output);
  const bytes = Buffer.from(redacted);
  if (bytes.length <= EXCERPT_BYTES) return redacted;
  let start = bytes.length - EXCERPT_BYTES;
  // Never start inside a multi-byte character: it would decode to a longer replacement char.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

function passes(verifier: CommandCriterion["verifier"], outcome: Outcome): boolean {
  if (!(verifier.successExitCodes ?? [0]).includes(outcome.exitCode)) return false;
  if (verifier.outputPattern === undefined) return true;
  try {
    return new RegExp(verifier.outputPattern).test(outcome.output);
  } catch {
    return false; // an unusable pattern never verifies anything
  }
}

export class ProofRecorder {
  private readonly store: ProofStore;
  /** `bg_run` calls whose exit code has not been seen yet, by session and task id. */
  private readonly background = new Map<
    string,
    { fingerprint: string; startedAt: number; recorded: boolean }
  >();

  constructor(
    private readonly db: SqlDatabase,
    private readonly options: {
      now?: () => Date;
      /** `proof.coverage.enabled`, read on every call so a config reload applies at once. */
      coverage?: () => boolean;
    } = {},
  ) {
    this.store = new ProofStore(db);
  }

  /** Records the evidence a just-executed call yields; returns the ledger changes to announce. */
  capture(call: ExecutedCall): ProofUpdate[] {
    const edit = EDIT_TOOLS.has(call.name);
    const command = COMMAND_TOOLS.has(call.name);
    if (!edit && !command && !VERIFIER_TOOLS.has(call.name)) return [];
    const criteria = this.tracked(call.sessionId);
    if (criteria.length === 0) return [];
    if (edit) return this.captureEdit(call);
    const findings = command
      ? this.commandFindings(call, criteria)
      : call.name === "read_file"
        ? this.fileFindings(call, criteria)
        : this.dataFindings(call, criteria);
    return this.persist(call, findings);
  }

  /**
   * A `read_file` that threw because the file is not there (the runner reports it here: a throw
   * never reaches `capture`). It refutes every `file` criterion on that path; any other failure
   * proves nothing.
   */
  captureFailure(call: ExecutedCall): ProofUpdate[] {
    if (call.name !== "read_file" || !call.result.isError) return [];
    const judged = judgeMissingFile(textOf(call.result));
    if (!judged) return [];
    const matching = this.tracked(call.sessionId).filter(
      (c): c is FileCriterion =>
        c.verifier?.kind === "file" && readsFile(c.verifier, call.input.path, call.workspace),
    );
    return this.persist(
      call,
      matching.map((criterion) =>
        this.finding(call, criterion, "file", judged, textOf(call.result)),
      ),
    );
  }

  /** The criteria of the session the recorder can capture evidence for (not marked N/A). */
  private tracked(sessionId: string): CriterionRecord[] {
    return this.store.criteria(sessionId).filter(
      (c) =>
        c.verifier &&
        CAPTURING.has(c.verifier.kind) &&
        !c.notApplicableReason &&
        // Opt-in: with `proof.coverage.enabled` off a coverage criterion is never captured.
        (c.verifier.kind !== "coverage" || this.options.coverage?.() === true),
    );
  }

  private finding(
    call: ExecutedCall,
    criterion: CriterionRecord,
    verifierKind: Finding["verifierKind"],
    judged: { ok: boolean; summary: string },
    rawOutput: string,
  ): Finding {
    return {
      criterion,
      verifierKind,
      ok: judged.ok,
      outputHash: sha256(rawOutput),
      excerpt: excerptOf(judged.summary),
      durationMs: call.durationMs,
    };
  }

  private fileFindings(call: ExecutedCall, criteria: CriterionRecord[]): Finding[] {
    if (call.result.isError) return [];
    const text = textOf(call.result);
    const body = jsonObject(text);
    if (!body) return [];
    return criteria.flatMap((c) => {
      if (c.verifier?.kind !== "file" || !readsFile(c.verifier, call.input.path, call.workspace))
        return [];
      const judged = judgeFile(c.verifier, body);
      return judged ? [this.finding(call, c, "file", judged, text)] : [];
    });
  }

  private dataFindings(call: ExecutedCall, criteria: CriterionRecord[]): Finding[] {
    if (call.result.isError) return [];
    const text = textOf(call.result);
    return criteria.flatMap((c) => {
      if (c.verifier?.kind !== "data-check" || !runsCanonicalQuery(c.verifier, call.input))
        return [];
      const judged = judgeDataCheck(c.verifier, text);
      return judged ? [this.finding(call, c, "data-check", judged, text)] : [];
    });
  }

  private commandFindings(call: ExecutedCall, criteria: CriterionRecord[]): Finding[] {
    const commands = criteria.filter((c): c is CommandCriterion => c.verifier?.kind === "command");
    const coverages = criteria.filter(
      (c): c is CoverageCriterion => c.verifier?.kind === "coverage",
    );
    if (commands.length === 0 && coverages.length === 0) return [];
    const outcome = this.outcome(call);
    if (!outcome) return [];
    const coverage: Finding[] = coverages
      .filter((c) => criterionFingerprints(c.verifier.command, ".").includes(outcome.fingerprint))
      .map((c) => {
        const judged = judgeCoverage(c.verifier, outcome);
        return {
          criterion: c,
          verifierKind: "coverage" as const,
          ok: judged.ok,
          outputHash: sha256(outcome.output),
          // The verdict goes last: the excerpt keeps the END of the text (see `excerptOf`).
          excerpt: excerptOf(`${outcome.output ? `${outcome.output}\n` : ""}${judged.summary}`),
          exitCode: outcome.exitCode,
          fingerprint: outcome.fingerprint,
          durationMs: outcome.durationMs,
        };
      });
    return [
      ...coverage,
      ...commands
        .filter((c) =>
          criterionFingerprints(c.verifier.command, normalizeCwd(c.verifier.cwd ?? ".")).includes(
            outcome.fingerprint,
          ),
        )
        .map((c) => ({
          criterion: c,
          verifierKind: "command" as const,
          ok: passes(c.verifier, outcome),
          outputHash: sha256(outcome.output),
          ...(outcome.output ? { excerpt: excerptOf(outcome.output) } : {}),
          exitCode: outcome.exitCode,
          fingerprint: outcome.fingerprint,
          durationMs: outcome.durationMs,
        })),
    ];
  }

  /** Appends one evidence per finding, once the call is proven to be in the session journal. */
  private persist(call: ExecutedCall, findings: Finding[]): ProofUpdate[] {
    if (findings.length === 0 || !this.executed(call)) return [];
    const capturedAt = this.clock();
    const filesTouched = this.store.edits(call.sessionId).map((e) => e.path);
    const tree = treeFingerprint(call.workspace, filesTouched);
    const appended: ProofEvidence[] = findings.map((f) =>
      this.store.appendEvidence({
        criterionId: f.criterion.criterionId,
        verifierKind: f.verifierKind,
        runId: call.runId,
        callId: call.callId,
        ok: f.ok,
        ...(f.fingerprint ? { commandFingerprint: f.fingerprint } : {}),
        ...(f.exitCode !== undefined ? { exitCode: f.exitCode } : {}),
        durationMs: f.durationMs,
        outputHash: f.outputHash,
        ...(f.excerpt ? { excerpt: f.excerpt } : {}),
        treeFingerprint: tree,
        filesTouched,
        capturedAt,
      }),
    );
    const ledger = this.store.ledger(call.sessionId, capturedAt);
    return appended.flatMap((evidence) => {
      const criterion = ledger.criteria.find((c) => c.criterionId === evidence.criterionId);
      return criterion
        ? [
            {
              criterionId: criterion.criterionId,
              status: criterion.status,
              stale: criterion.stale ?? false,
              evidenceId: evidence.evidenceId,
            },
          ]
        : [];
    });
  }

  private clock(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /**
   * Notes a successful write/edit of a workspace file (D5) and announces the criteria whose
   * derived status or staleness changed because of it. Edits outside the workspace cannot touch
   * a workspace criterion and are ignored.
   */
  private captureEdit(call: ExecutedCall): ProofUpdate[] {
    if (call.result.isError || typeof call.input.path !== "string" || !this.executed(call))
      return [];
    const path = relative(call.workspace, resolve(call.workspace, call.input.path));
    if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return [];
    const at = this.clock();
    const before = this.store.ledger(call.sessionId, at).criteria;
    this.store.recordEdit(call.sessionId, path.split(sep).join("/"), at);
    const after = this.store.ledger(call.sessionId, at).criteria;
    return after.flatMap((criterion) => {
      const previous = before.find((c) => c.criterionId === criterion.criterionId);
      const stale = criterion.stale ?? false;
      if (previous && previous.status === criterion.status && (previous.stale ?? false) === stale)
        return [];
      return [{ criterionId: criterion.criterionId, status: criterion.status, stale }];
    });
  }

  /**
   * The claims of a final answer that the ledger does not back (D8: shown, never acted on). Empty
   * without criteria, after one indexed read (D7).
   */
  divergences(sessionId: string, finalText: string): Divergence[] {
    if (this.store.criteria(sessionId).length === 0) return [];
    return detectDivergence(finalText, this.store.ledger(sessionId, this.clock()));
  }

  /** Reads what a command call proved, or undefined when it proved nothing (yet). */
  private outcome(call: ExecutedCall): Outcome | undefined {
    const body = jsonObject(textOf(call.result));
    if (!body) return undefined;
    if (call.name === "run_process" || call.name === "shell")
      return this.processOutcome(call, body);
    if (call.name === "bg_run") {
      this.startedBackground(call, body);
      return undefined;
    }
    return this.backgroundOutcome(call, body);
  }

  private processOutcome(call: ExecutedCall, body: Record<string, unknown>): Outcome | undefined {
    if (typeof body.exitCode !== "number" || !Number.isFinite(body.exitCode)) return undefined;
    const command = call.input.command;
    if (typeof command !== "string") return undefined;
    const args = Array.isArray(call.input.args) ? call.input.args.map(String) : [];
    const stdout = typeof body.stdout === "string" ? body.stdout : "";
    const stderr = typeof body.stderr === "string" ? body.stderr : "";
    return {
      exitCode: body.exitCode,
      output: [stdout, stderr].filter(Boolean).join("\n"),
      durationMs: call.durationMs,
      fingerprint: callFingerprint(call.name as CommandTool, { command, args }, "."),
    };
  }

  private startedBackground(call: ExecutedCall, body: Record<string, unknown>): void {
    const command = call.input.command;
    if (typeof body.id !== "string" || typeof command !== "string") return;
    const cwd = typeof call.input.cwd === "string" ? call.input.cwd : undefined;
    this.background.set(this.key(call.sessionId, body.id), {
      fingerprint: callFingerprint("shell", { command }, relativeCwd(call.workspace, cwd)),
      startedAt: Date.now() - call.durationMs,
      recorded: false,
    });
    while (this.background.size > MAX_BACKGROUND) {
      const oldest = this.background.keys().next().value;
      if (oldest === undefined) break;
      this.background.delete(oldest);
    }
  }

  /** `bg_output` carries the exit code of a task this recorder saw start; once per task. */
  private backgroundOutcome(
    call: ExecutedCall,
    body: Record<string, unknown>,
  ): Outcome | undefined {
    const id = typeof body.id === "string" ? body.id : undefined;
    const task = id ? this.background.get(this.key(call.sessionId, id)) : undefined;
    if (!task || task.recorded) return undefined;
    if (typeof body.exit_code !== "number" || !Number.isFinite(body.exit_code)) return undefined;
    task.recorded = true;
    return {
      exitCode: body.exit_code,
      output: typeof body.text === "string" ? body.text : "",
      durationMs: Math.max(0, Date.now() - task.startedAt),
      fingerprint: task.fingerprint,
    };
  }

  private key(sessionId: string, taskId: string): string {
    return `${sessionId}\u0000${taskId}`;
  }

  /**
   * D2/D3: the call must exist in the session's tool-call journal under this run and name, which
   * the runner writes before the tool executes. A forged or foreign `runId`/`callId` fails here.
   */
  private executed(call: ExecutedCall): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS ok FROM tool_calls WHERE session=? AND call_id=? AND run_id=? AND name=?",
      )
      .get(call.sessionId, call.callId, call.runId, call.name);
    return row !== undefined && row !== null;
  }
}
