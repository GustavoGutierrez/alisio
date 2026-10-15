/**
 * `alisio run --proof` (specs/011 3.7, O4, O5). The ledger is judged after the run with the same
 * pure functions every surface uses (`@alisio/core` `proof/export`); this file only wires flags,
 * files and output. Functions take an injected environment so they run without a subprocess.
 */
import { readFile as readFileFs } from "node:fs/promises";
import {
  type ArtifactStore,
  createArtifactPublisher,
  DEFAULT_PROOF_EXIT_CODES,
  type NewCriterion,
  PROOF_EXPORT_SCHEMA,
  type ProofExitCodes,
  type ProofStore,
  parseCriteriaInput,
  proofExitCode,
  proofExportV1,
  publishProofExport,
  renderProofText,
  verifierCall,
} from "@alisio/core";
import type { ArtifactPublisher } from "@alisio/sdk";

export interface ProofFlags {
  proof?: boolean;
  /** Repeatable `--criterion "text"`. */
  criterion?: string[];
  /** Repeatable `--verify "cmd"`: the n-th pairs with the n-th `--criterion`. */
  verify?: string[];
  proofFile?: string;
  json?: boolean;
  /** `proof.exitCodes` of the configuration. */
  codes?: ProofExitCodes;
}

export type CliCriterion = Omit<NewCriterion, "sessionId">;

/** Whether the run produces a ledger report: a flag, a criteria source, or `proof.ci`. */
export function proofRequested(flags: ProofFlags, config: { ci: boolean }): boolean {
  return !!(
    flags.proof ||
    config.ci ||
    flags.criterion?.length ||
    flags.verify?.length ||
    flags.proofFile
  );
}

/**
 * The criteria of the run (O4): the proof file first, then the flags. Every one is `origin: "cli"`
 * and required unless the file says otherwise. Throws a readable error on anything invalid.
 */
export async function collectProofCriteria(
  flags: Pick<ProofFlags, "criterion" | "verify" | "proofFile">,
  env: { readFile?: (path: string) => Promise<string> } = {},
): Promise<CliCriterion[]> {
  const read = env.readFile ?? ((path: string) => readFileFs(path, "utf8"));
  const out: CliCriterion[] = [];
  if (flags.proofFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await read(flags.proofFile));
    } catch (error) {
      throw new Error(
        `--proof-file ${flags.proofFile}: ${error instanceof Error ? error.message : "unreadable"}`,
      );
    }
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { criteria?: unknown } | null)?.criteria;
    const checked = parseCriteriaInput(list, { origin: "cli" });
    const first = checked.errors[0];
    if (first) throw new Error(`--proof-file: criterion ${first.index + 1}: ${first.reason}`);
    out.push(...checked.criteria);
  }
  const texts = flags.criterion ?? [];
  const commands = flags.verify ?? [];
  if (commands.length > texts.length)
    throw new Error("--verify needs a --criterion before it (they pair by position)");
  const entries = texts.map((text, i) => ({
    text,
    ...(commands[i] ? { verify: commands[i] } : {}),
  }));
  const checked = parseCriteriaInput(entries, { origin: "cli" });
  const first = checked.errors[0];
  if (first) throw new Error(`--criterion ${first.index + 1}: ${first.reason}`);
  out.push(...checked.criteria);
  return out;
}

export interface ProofFinishEnv {
  proof: Pick<ProofStore, "view">;
  write: (text: string) => void;
  writeErr: (text: string) => void;
  /** Publishes `proof.md` and `proof.json` into the session; absent when it cannot. */
  publisher?: Pick<ArtifactPublisher, "publishText">;
}

/**
 * Reports the ledger of the session after the run and returns the exit code: 0, or the code of
 * `proof.exitCodes` (10/11 by default). With `--json` the report is ONE final JSONL line
 * (`type: "proof_ledger"`); otherwise a plain table on stdout. A failure to publish the
 * artifacts never changes the exit code.
 */
export async function finishProof(
  env: ProofFinishEnv,
  sessionId: string,
  flags: Pick<ProofFlags, "json" | "codes">,
): Promise<number> {
  const ledger = env.proof.view(sessionId);
  const code = proofExitCode(ledger, flags.codes ?? DEFAULT_PROOF_EXIT_CODES);
  if (env.publisher) {
    try {
      await publishProofExport(env.publisher, ledger);
      env.writeErr("proof: proof.md and proof.json were published as session artifacts\n");
    } catch (error) {
      env.writeErr(
        `proof: the export was not published (${error instanceof Error ? error.message : "error"})\n`,
      );
    }
  }
  if (flags.json)
    env.write(
      `${JSON.stringify({
        type: "proof_ledger",
        schema: PROOF_EXPORT_SCHEMA,
        sessionId,
        exitCode: code,
        ledger: proofExportV1(ledger),
      })}\n`,
    );
  else env.write(`\n${renderProofText(ledger)}\n`);
  return code;
}

/** The one call that counts as evidence for a criterion, said to the agent (empty when none). */
function hint(verifier: CliCriterion["verifier"], coverageEnabled: boolean): string {
  if (verifier?.kind === "command") return ` Run \`${verifier.command}\`.`;
  if (verifier?.kind === "coverage")
    return coverageEnabled
      ? ` Run \`${verifier.command}\` (at least ${verifier.minPercent}% coverage).`
      : " Coverage verification is disabled (proof.coverage.enabled is false): this criterion stays not_checked.";
  const call = verifier ? verifierCall(verifier) : undefined;
  if (!call) return "";
  if (call.name === "read_file")
    return ` Read \`${verifier?.kind === "file" ? verifier.path : ""}\` with read_file.`;
  return ` Run data_query on dataset ${String(call.input.datasetId)} with exactly \`${String(call.input.sql)}\`.`;
}

/**
 * The prompt of a run with criteria: the original text, then the criteria and the exact commands
 * whose execution (or file read, or dataset query) Alisio records as evidence (D3: the agent cannot declare a criterion met).
 * Without criteria the prompt is returned untouched (D7).
 */
export function withProofBrief(
  prompt: string,
  criteria: readonly CliCriterion[],
  options: { coverageEnabled?: boolean } = {},
): string {
  if (!criteria.length) return prompt;
  const lines = criteria.map((c) => {
    return `- ${c.text}${c.required ? " (required)" : ""}.${hint(c.verifier, options.coverageEnabled === true)}`;
  });
  return [
    prompt,
    "",
    "Acceptance criteria. Alisio checks them from the commands you actually run, not from what you say; a criterion with a command is verified only when you run exactly that command and it succeeds:",
    ...lines,
  ].join("\n");
}

/** The publisher of a session's artifacts (`proof.md`, `proof.json`) for a headless run. */
export function sessionPublisher(
  app: { artifacts: ArtifactStore; workspace: string },
  sessionId: string,
): Pick<ArtifactPublisher, "publishText"> {
  return createArtifactPublisher(
    app.artifacts,
    { sessionId, rootSessionId: sessionId, workspace: app.workspace },
    () => undefined,
  );
}
