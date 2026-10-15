/**
 * Claim/evidence divergence (specs/011 3.5, D7, D8). `detectDivergence` is pure: it reads closed
 * EN/ES claim patterns in a final answer ("tests pass", "typecheck ok", "lint clean", "los tests
 * pasan"...), cross-references them with the criteria of an equivalent kind and reports the ones
 * the ledger does not back. It never edits text or statuses; it is a heuristic signal, not a
 * guarantee, and claims inside quotes and code are ignored to limit false positives.
 */
import type { ProofCriterion, ProofLedger, ProofStatus } from "@alisio/sdk";

export type ClaimKind = "test" | "typecheck" | "lint";

export interface Divergence {
  /** The matched wording, whitespace-collapsed and capped. */
  claim: string;
  kind: ClaimKind;
  /** What would have backed the claim. */
  expected: "verified";
  /** The status of the equivalent criterion (`not_checked` when there is none). */
  actualState: ProofStatus;
  criterionId?: string;
}

/** Only this much of the answer is read: the cost is bounded whatever the model writes. */
const MAX_TEXT = 100_000;
const MAX_CLAIM = 200;

const H = "[ \\t]+";
const SUBJECTS: Record<ClaimKind, string> = {
  test: `(?:(?:unit|integration|e2e)${H})?tests?(?:${H}suite)?(?:${H}(?:unitarios|unitarias|e2e|de${H}integración))?|(?:suite${H}de${H})?(?:tests|pruebas)(?:${H}(?:unitarias|de${H}integración))?`,
  typecheck: `type${H}?check(?:ing|s)?|typecheck(?:ing)?|(?:verificación|chequeo|comprobación)${H}de${H}tipos|tsc`,
  lint: "lint(?:ing|er)?",
};
const ARTICLE = `(?:(?:the|el|la|los|las)${H})?`;
const SUBJECT = `${ARTICLE}(?:${Object.values(SUBJECTS).join("|")})`;
const SEPARATOR = `[ \\t]*,[ \\t]*(?:(?:and|y)${H})?|${H}(?:and|y)${H}|[ \\t]*&[ \\t]*`;
const FILLER = `(?:is|are|now|also|all|both|still|were|have|has|been|ya|ahora|todos|todas|están|está|esta|siguen)`;
const VERDICT = `(?:passe[sd]|pass(?:ing)?|ok|okay|clean|green|succeed(?:s|ed)?|successful|fine|pasan|pasa|pasó|pasaron|pasando|limpi[oa]s?|verdes?|en${H}verde|correct[oa]s?|bien)`;
const CLAIM = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:all|todos|todas)${H})?(?:(?:the|los|las|el|la)${H})?` +
    `((${SUBJECT}(?:(?:${SEPARATOR})${SUBJECT}){0,4})(?:${H}${FILLER})*${H}${VERDICT})` +
    "(?![\\p{L}\\p{N}])",
  "giu",
);
const KIND_IN_LIST: Array<[ClaimKind, RegExp]> = (
  Object.entries(SUBJECTS) as Array<[ClaimKind, string]>
).map(([kind, source]) => [
  kind,
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "iu"),
]);

const WORD = (alternatives: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])|\\p{L}+n['’]t`, "iu");
/** Words that make a following "tests pass" a wish, a condition, an instruction or a denial. */
const HEDGE = WORD(
  [
    "not|never|no|cannot|unable|if|once|until|unless|whether|when|whenever|should|shall|would|could|might|may",
    "hope|hoping|expect|expecting|need|needs|want|ensure|ensuring|make|makes|making|get|gets|getting",
    "verify|confirm|check|let's|lets",
    "nunca|jamás|sin|si|cuando|hasta|salvo|debe|deben|debería|deberían|espero|esperamos|quiero",
    "necesito|necesitamos|asegura|asegúrate|asegurar|verifica|verificar|comprueba|comprobar",
    "confirma|confirmar|hacer|haz",
  ].join("|"),
);
const CLAUSE_BOUNDARY =
  /[.!?;:\n]|(?<![\p{L}\p{N}])(?:but|however|pero|aunque|sin embargo)(?![\p{L}\p{N}])/giu;
const CLAUSE_WINDOW = 60;

/** Removes what quotes rather than asserts: code (fenced, inline), block quotes and quoted text. */
function unquoted(text: string): string {
  return text
    .slice(0, MAX_TEXT)
    .replace(/(```|~~~)[\s\S]*?\1/g, "\n")
    .replace(/(```|~~~)[\s\S]*$/, "\n")
    .replace(/^[ \t]*>.*$/gm, "")
    .replace(/`[^`\n]{0,300}`/g, " ")
    .replace(/"[^"\n]{0,300}"|“[^”\n]{0,300}”|«[^»\n]{0,300}»|‘[^’\n]{0,300}’/g, " ");
}

/** Whether the words just before `index`, inside its clause, hedge or deny the claim. */
function hedged(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 200), index);
  let start = 0;
  for (const boundary of before.matchAll(CLAUSE_BOUNDARY))
    start = boundary.index + boundary[0].length;
  return HEDGE.test(before.slice(start).slice(-CLAUSE_WINDOW));
}

interface Claim {
  claim: string;
  kind: ClaimKind;
}

function claimsIn(finalText: string): Claim[] {
  const text = unquoted(finalText);
  const found: Claim[] = [];
  const seen = new Set<ClaimKind>();
  for (const match of text.matchAll(CLAIM)) {
    if (hedged(text, match.index)) continue;
    const wording = (match[1] ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CLAIM);
    for (const [kind, pattern] of KIND_IN_LIST) {
      if (seen.has(kind) || !pattern.test(match[2] ?? "")) continue;
      seen.add(kind);
      found.push({ claim: wording, kind });
    }
  }
  return found;
}

const TYPECHECK_CMD = /(?<![\w-])(?:tsc|typecheck|type-check|check-types|mypy|pyright)(?![\w-])/i;
const LINT_CMD =
  /(?<![\w-])(?:lint|eslint|biome|ruff|flake8|pylint|clippy|golangci-lint|stylelint|oxlint)(?![\w-])/i;
const TEST_CMD = /(?<![\w-])(?:tests?|vitest|jest|pytest|mocha|rspec)(?![\w-])/i;
const TYPECHECK_TEXT = /(?<![\p{L}\p{N}])type[ -]?check|tipos(?![\p{L}\p{N}])/iu;
const LINT_TEXT = /(?<![\p{L}\p{N}])lint(?:ing|er)?(?![\p{L}\p{N}])/iu;
const TEST_TEXT = /(?<![\p{L}\p{N}])(?:tests?|pruebas)(?![\p{L}\p{N}])/iu;

/** The kind of check a criterion stands for: its command when it has one, else its text. */
function kindOf(criterion: ProofCriterion): ClaimKind | undefined {
  const verifier = criterion.verifier;
  if (verifier && (verifier.kind === "command" || verifier.kind === "coverage")) {
    if (TYPECHECK_CMD.test(verifier.command)) return "typecheck";
    if (LINT_CMD.test(verifier.command)) return "lint";
    if (TEST_CMD.test(verifier.command)) return "test";
    return undefined;
  }
  if (TYPECHECK_TEXT.test(criterion.text)) return "typecheck";
  if (LINT_TEXT.test(criterion.text)) return "lint";
  if (TEST_TEXT.test(criterion.text)) return "test";
  return undefined;
}

/**
 * The claims of `finalText` that `ledger` does not back, in order of appearance. An empty ledger
 * yields nothing (D7: without criteria Proof stays out of the way).
 */
export function detectDivergence(finalText: string, ledger: ProofLedger): Divergence[] {
  if (ledger.criteria.length === 0) return [];
  const out: Divergence[] = [];
  for (const { claim, kind } of claimsIn(finalText)) {
    const equivalent = ledger.criteria.filter(
      (c) => c.status !== "not_applicable" && kindOf(c) === kind,
    );
    if (equivalent.length === 0) {
      out.push({ claim, kind, expected: "verified", actualState: "not_checked" });
      continue;
    }
    for (const c of equivalent)
      if (c.status !== "verified")
        out.push({
          claim,
          kind,
          expected: "verified",
          actualState: c.status,
          criterionId: c.criterionId,
        });
  }
  return out;
}
