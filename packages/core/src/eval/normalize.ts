/**
 * Run-scoped normalization of what a request carries (specs/010 D10), so the same logical request
 * hashes the same in two fresh run directories, sessions and processes while a real regression
 * (a relative path becoming absolute, an extra or missing id) still changes the hash.
 *
 * It rewrites string LEAVES only, never object keys, in three passes:
 *  1. literal replacements computed by the engine at run start (run directory, workspace, slug,
 *     workspace key, per-user scratch folder, home, tmp) and the known session/run ids, longest
 *     literal first, each with a typed placeholder (`<WS>`, `<RUN>`, `<SESSION#1>`...);
 *  2. generated ids found by pattern (`task_<ULID>`, `fx_<uuid>`, bare UUIDs...) become
 *     `<id:kind#n>` where n is the order of first appearance of that exact id;
 *  3. the suite's own `replayNormalize` rules (fixture output noise), versioned with the suite.
 *
 * Tool-call ids and token counts are NOT normalized: the cassette supplies them verbatim.
 */

import { workspaceSlug } from "../forge/session-path.ts";
import { workspaceKey as keyOf } from "../runtime/paths.ts";

export interface ReplayNormalizeRule {
  pattern: string;
  replace: string;
}

export interface NormalizerOptions {
  literals?: Array<{ literal: string; placeholder: string }>;
  replay?: ReplayNormalizeRule[];
}

const ULID_PREFIXED = "[a-z][a-z0-9]{1,9}_[0-9A-HJKMNP-TV-Z]{26}";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GENERATED = new RegExp(`\\b(?:${ULID_PREFIXED}|fx_${UUID}|${UUID})\\b`, "gi");

/** Smallest literal worth replacing: a one- or two-character literal would corrupt unrelated text. */
const MIN_LITERAL = 3;

export class Normalizer {
  private literals: Array<{ literal: string; placeholder: string }> = [];
  /** One alternation of every literal (longest first): a single pass never rescans a placeholder. */
  private literalRegex: RegExp | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly runs = new Map<string, string>();
  private readonly generated = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly rules: Array<{ regex: RegExp; replace: string }>;

  constructor(options: NormalizerOptions = {}) {
    for (const entry of options.literals ?? []) this.addLiteral(entry.literal, entry.placeholder);
    this.rules = (options.replay ?? []).map((rule, index) => {
      try {
        return { regex: new RegExp(rule.pattern, "g"), replace: rule.replace };
      } catch (error) {
        throw new Error(
          `replayNormalize rule ${index} has an invalid pattern "${rule.pattern}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

  private addLiteral(literal: string, placeholder: string): void {
    if (literal.length < MIN_LITERAL) return;
    if (this.literals.some((l) => l.literal === literal)) return;
    this.literals.push({ literal, placeholder });
    this.literals.sort((a, b) => b.literal.length - a.literal.length);
    this.literalRegex = new RegExp(
      this.literals.map((l) => l.literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "g",
    );
  }

  /** `<SESSION#n>`, numbered in order of registration. */
  registerSession(id: string): string {
    let placeholder = this.sessions.get(id);
    if (!placeholder) {
      placeholder = `<SESSION#${this.sessions.size + 1}>`;
      this.sessions.set(id, placeholder);
      this.addLiteral(id, placeholder);
    }
    return placeholder;
  }

  registerRun(id: string): string {
    let placeholder = this.runs.get(id);
    if (!placeholder) {
      placeholder = `<RUN#${this.runs.size + 1}>`;
      this.runs.set(id, placeholder);
      this.addLiteral(id, placeholder);
    }
    return placeholder;
  }

  /** The placeholder of a REGISTERED session id (child sessions are not registered). */
  sessionLabel(id: string | undefined): string | undefined {
    return id === undefined ? undefined : this.sessions.get(id);
  }

  text(input: string): string {
    let out = input;
    if (this.literalRegex) {
      const byLiteral = new Map(this.literals.map((l) => [l.literal, l.placeholder]));
      out = out.replace(this.literalRegex, (match) => byLiteral.get(match) ?? match);
    }
    out = out.replace(GENERATED, (match) => this.generatedId(match));
    for (const { regex, replace } of this.rules) out = out.replace(regex, replace);
    return out;
  }

  private generatedId(match: string): string {
    const known = this.generated.get(match);
    if (known) return known;
    const kind = match.startsWith("fx_")
      ? "fx"
      : match.includes("-") && !match.includes("_")
        ? "uuid"
        : match.slice(0, match.indexOf("_"));
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const placeholder = `<id:${kind}#${n}>`;
    this.generated.set(match, placeholder);
    return placeholder;
  }

  /** A copy of `value` with every string leaf normalized (keys untouched). */
  value<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.walk(item));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(value as Record<string, unknown>))
        out[key] = this.walk(member);
      return out;
    }
    return value;
  }
}

export interface RunLiteralsInput {
  /** Real path of the run directory (the engine realpaths it). */
  runDir: string;
  /** The workspace copy (`<runDir>/ws`). */
  workspace: string;
  home: string;
  osTmp: string;
  /** `process.getuid()`; absent where the platform has none. */
  uid?: number;
  /** Defaults to the runtime's `workspaceKey(workspace)`. */
  workspaceKey?: string;
}

/**
 * The literal replacements of one run: everything whose value depends on where or as whom the run
 * happens. Typed placeholders keep different kinds of path apart (see the module comment).
 */
export function runLiterals(
  input: RunLiteralsInput,
): Array<{ literal: string; placeholder: string }> {
  const key = input.workspaceKey ?? keyOf(input.workspace);
  const literals: Array<{ literal: string; placeholder: string }> = [
    { literal: input.workspace, placeholder: "<WS>" },
    { literal: input.runDir, placeholder: "<RUN>" },
    { literal: workspaceSlug(input.workspace, key), placeholder: "<WS_SLUG>" },
    { literal: key, placeholder: "<WS_KEY>" },
    { literal: key.slice(0, 8), placeholder: "<WS_KEY8>" },
    { literal: input.home, placeholder: "<HOME>" },
    { literal: input.osTmp, placeholder: "<TMP>" },
  ];
  if (input.uid !== undefined)
    literals.push({ literal: `alisio-${input.uid}`, placeholder: "alisio-<UID>" });
  return literals;
}
