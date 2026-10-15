/**
 * The surfaces of Proof (specs/011 phase 5) read ONE ledger and share these pure helpers: the
 * versioned `proof/v1` export, the Markdown report, the CI exit code and the parsing of criteria
 * a user or a CLI flag supplies. Nothing here touches a database or a clock.
 */
import type {
  ArtifactPublisher,
  ArtifactRef,
  ProofCriterion,
  ProofEvidence,
  ProofLedger,
  ProofStatus,
} from "@alisio/sdk";
import { validateCriteriaDrafts } from "../plan/criteria.ts";
import type { NewCriterion } from "./types.ts";

/** The `schema` of the JSON export. A breaking change to the shape is a new version. */
export const PROOF_EXPORT_SCHEMA = "proof/v1";

export interface ProofSummary {
  total: number;
  required: number;
  /** Required criteria that are `failed`, `not_checked` or `manual_review`. */
  requiredUnmet: number;
  verified: number;
  failed: number;
  notChecked: number;
  manualReview: number;
  notApplicable: number;
}

/** The JSON export (`proof.json`): one object, fixed key order, versioned. */
export interface ProofExportV1 {
  schema: typeof PROOF_EXPORT_SCHEMA;
  sessionId: string;
  generatedAt: string;
  summary: ProofSummary;
  criteria: ProofCriterion[];
  evidence: ProofEvidence[];
  divergences: ProofLedger["divergences"];
}

const UNMET: ReadonlySet<ProofStatus> = new Set(["failed", "not_checked", "manual_review"]);

export function proofSummary(ledger: ProofLedger): ProofSummary {
  const count = (status: ProofStatus) => ledger.criteria.filter((c) => c.status === status).length;
  return {
    total: ledger.criteria.length,
    required: ledger.criteria.filter((c) => c.required).length,
    requiredUnmet: ledger.criteria.filter((c) => c.required && UNMET.has(c.status)).length,
    verified: count("verified"),
    failed: count("failed"),
    notChecked: count("not_checked"),
    manualReview: count("manual_review"),
    notApplicable: count("not_applicable"),
  };
}

export function proofExportV1(ledger: ProofLedger): ProofExportV1 {
  return {
    schema: PROOF_EXPORT_SCHEMA,
    sessionId: ledger.sessionId,
    generatedAt: ledger.generatedAt,
    summary: proofSummary(ledger),
    criteria: ledger.criteria,
    evidence: ledger.evidence,
    divergences: ledger.divergences,
  };
}

/** `proof.json`: pretty JSON ending in a newline. */
export const renderProofJson = (ledger: ProofLedger): string =>
  `${JSON.stringify(proofExportV1(ledger), null, 2)}\n`;

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** `proof.md`: the same statuses as the JSON, readable. The output excerpts are not repeated. */
export function renderProofMarkdown(ledger: ProofLedger): string {
  const s = proofSummary(ledger);
  const byId = new Map(ledger.evidence.map((e) => [e.evidenceId, e]));
  const lines = [
    "# Proof",
    "",
    `Session \`${ledger.sessionId}\` · generated ${ledger.generatedAt} · schema \`${PROOF_EXPORT_SCHEMA}\``,
    "",
    `${s.total} criteria · ${s.verified} verified · ${s.failed} failed · ${s.notChecked} not checked · ` +
      `${s.manualReview} manual review · ${s.notApplicable} not applicable · ` +
      `${s.requiredUnmet} required not verified`,
    "",
  ];
  if (!ledger.criteria.length) lines.push("_No criteria._", "");
  else {
    lines.push("| Status | Required | Criterion | Evidence |", "| --- | --- | --- | --- |");
    for (const c of ledger.criteria) {
      const latest = [...c.evidenceIds]
        .map((id) => byId.get(id))
        .filter((e): e is ProofEvidence => !!e)
        .at(-1);
      const status = c.stale ? `${c.status} (stale)` : c.status;
      const evidence = latest
        ? `${latest.callId} · exit ${latest.exitCode ?? "-"} · ${latest.capturedAt}`
        : c.notApplicableReason
          ? `n/a: ${c.notApplicableReason}`
          : "-";
      lines.push(
        `| ${status} | ${c.required ? "yes" : "no"} | ${cell(c.text)} | ${cell(evidence)} |`,
      );
    }
    lines.push("");
  }
  if (ledger.divergences.length) {
    lines.push("## Claims without evidence", "");
    for (const d of ledger.divergences) lines.push(`- "${cell(d.claim)}" (${d.actual})`);
    lines.push("");
  }
  lines.push(
    "_Proof records operational evidence; it does not prove that the code is correct._",
    "",
  );
  return lines.join("\n");
}

/** The plain-text view of the ledger (terminal and headless report): one line per criterion. */
export function renderProofText(ledger: ProofLedger): string {
  const s = proofSummary(ledger);
  const head = !s.total
    ? "Proof: no criteria"
    : `Proof: ${s.verified} of ${s.total} criteria verified` +
      (s.required ? ` · ${s.requiredUnmet} of ${s.required} required not verified` : "");
  const lines = [head];
  const width = Math.max(0, ...ledger.criteria.map((c) => statusLabel(c).length));
  for (const c of ledger.criteria)
    lines.push(
      `  ${statusLabel(c).padEnd(width)}  ${c.text.replace(/\s+/g, " ").trim()}${c.required ? " (required)" : ""}`,
    );
  for (const d of ledger.divergences)
    lines.push(
      `  ! claim without evidence: "${d.claim.replace(/\s+/g, " ").trim()}" (${d.actual})`,
    );
  return lines.join("\n");
}

const statusLabel = (c: ProofCriterion): string => (c.stale ? `${c.status}(stale)` : c.status);

export interface ProofExitCodes {
  /** At least one required criterion is `failed`. */
  failed: number;
  /** No failure, but a required criterion is `not_checked` or `manual_review`. */
  unverified: number;
}
export const DEFAULT_PROOF_EXIT_CODES: ProofExitCodes = { failed: 10, unverified: 11 };

/** The CI exit code of a ledger (specs/011 3.7): failures win over unchecked criteria. */
export function proofExitCode(
  ledger: ProofLedger,
  codes: ProofExitCodes = DEFAULT_PROOF_EXIT_CODES,
): number {
  const required = ledger.criteria.filter((c) => c.required);
  if (required.some((c) => c.status === "failed")) return codes.failed;
  if (required.some((c) => c.status === "not_checked" || c.status === "manual_review"))
    return codes.unverified;
  return 0;
}

/** Publishes `proof.md` and `proof.json` as artifacts of the calling session. */
export async function publishProofExport(
  publisher: Pick<ArtifactPublisher, "publishText">,
  ledger: ProofLedger,
): Promise<ArtifactRef[]> {
  const md = await publisher.publishText({
    fileName: "proof.md",
    title: "Proof",
    text: renderProofMarkdown(ledger),
  });
  const json = await publisher.publishText({
    fileName: "proof.json",
    title: "Proof (JSON)",
    text: renderProofJson(ledger),
  });
  return [md, json];
}

export interface CriteriaInputError {
  index: number;
  reason: string;
}

/**
 * Turns user-supplied criteria (HTTP body, `--proof-file`, `--criterion/--verify`) into
 * `NewCriterion` values without a session. `verify` is shorthand for a `command` verifier and the
 * default for `required` is true: a criterion the user wrote is one the user wants met.
 */
export function parseCriteriaInput(
  raw: unknown,
  options: { origin: "user" | "cli"; defaultRequired?: boolean },
): { criteria: Array<Omit<NewCriterion, "sessionId">>; errors: CriteriaInputError[] } {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const normalized = list.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
    const e = entry as Record<string, unknown>;
    const { verify, ...rest } = e;
    return {
      ...rest,
      required: e.required === undefined ? (options.defaultRequired ?? true) : e.required,
      ...(typeof verify === "string" && e.verifier === undefined
        ? { verifier: { kind: "command", command: verify } }
        : {}),
    };
  });
  if (!Array.isArray(raw))
    return { criteria: [], errors: [{ index: 0, reason: "criteria must be an array" }] };
  const checked = validateCriteriaDrafts(normalized);
  return {
    criteria: checked.accepted.map(({ origin: _inferred, ...draft }) => ({
      ...draft,
      origin: options.origin,
    })),
    errors: checked.dropped.map((d) => ({ index: d.index, reason: d.reason })),
  };
}
