/**
 * Plan diagrams: the lightweight, render-free validation of the Mermaid diagrams the plan agent
 * passes to `exit_plan`. Mermaid cannot render without a DOM, so the server only checks what it
 * can see in the text: a size limit, an allowlist of diagram types, a node estimate and the
 * constructs that would run code, open links, fetch resources or relax Mermaid's security
 * settings. A diagram that fails is DROPPED with a reason (the plan is still published); a
 * diagram that only fails to draw is shown as source by the web renderer.
 *
 * Pure functions: no I/O, no Mermaid import.
 */
import { createHash } from "node:crypto";
import type { PlanDiagramType } from "@alisio/sdk";

/** Largest Mermaid source of one diagram (UTF-8 bytes). */
export const DIAGRAM_MAX_BYTES = 8 * 1024;
/** Most nodes (participants, entities, states, tasks...) of one diagram, estimated from the text. */
export const DIAGRAM_MAX_NODES = 40;
/** Hard ceiling of `plan.maxDiagrams`. */
export const DIAGRAMS_MAX_ALLOWED = 8;
export const DIAGRAM_ID_MAX = 40;
export const DIAGRAM_TITLE_MAX = 80;
export const DIAGRAM_EXPLANATION_MAX = 400;
export const DIAGRAM_SECTION_MAX = 120;

/** Mermaid diagram keywords a plan may use (the first statement of the source). */
export const DIAGRAM_SYNTAXES: readonly string[] = [
  "flowchart",
  "graph",
  "sequenceDiagram",
  "stateDiagram-v2",
  "stateDiagram",
  "erDiagram",
  "classDiagram",
  "gantt",
  "mindmap",
  "timeline",
  "journey",
];

export const DIAGRAM_TYPES: readonly PlanDiagramType[] = [
  "overview",
  "flow",
  "components",
  "architecture",
  "sequence",
  "data",
  "state",
  "other",
];

/**
 * The semantic classes of the style guide. The web applies the same names as a `classDef` block
 * at render time when a diagram uses a class without defining it (colors live in the web).
 */
export const DIAGRAM_CLASSES: readonly string[] = [
  "input",
  "process",
  "data",
  "system",
  "external",
  "decision",
  "risk",
];

export interface PlanDiagram {
  id: string;
  title: string;
  explanation: string;
  /** As the model wrote it; the manifest resolves it against the plan headings. */
  section?: string;
  type: PlanDiagramType;
  syntax: string;
  mermaid: string;
  nodes: number;
}

export interface DroppedDiagram {
  /** The id as given (or `#<position>` when it has none). */
  id: string;
  reason: string;
}

export interface DiagramValidation {
  accepted: PlanDiagram[];
  dropped: DroppedDiagram[];
}

export interface DiagramLimits {
  /** Most diagrams of one plan (0 accepts none). */
  max: number;
  maxBytes?: number;
  maxNodes?: number;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Security settings a directive or the front matter may not touch. */
const FORBIDDEN_CONFIG =
  /(securityLevel|htmlLabels|\bsecure\b|dompurify|themeCSS|maxTextSize|maxEdges|startOnLoad|callback|logLevel|deterministicIds)/i;

/** Normalizes line endings and trims: what is stored and hashed. */
export const normalizeMermaid = (source: string): string =>
  source
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** Removes a leading YAML front matter block (`---` ... `---`). */
function splitFrontMatter(source: string): { front: string; body: string } {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  return match
    ? { front: match[1] ?? "", body: source.slice(match[0].length) }
    : { front: "", body: source };
}

/** Directives `%%{ ... }%%` (possibly several lines) and plain `%%` comments. */
function directives(body: string): string[] {
  return [...body.matchAll(/%%\{[\s\S]*?\}%%/g)].map((m) => m[0]);
}

/** The body without directives and comments (what the statement scan reads). */
function statements(body: string): string[] {
  return body
    .replace(/%%\{[\s\S]*?\}%%/g, "")
    .split("\n")
    .map((line) => line.replace(/%%.*$/, ""))
    .filter((line) => line.trim());
}

/** The diagram keyword of a source (its first statement), or undefined when it has none. */
export function diagramSyntax(source: string): string | undefined {
  const { body } = splitFrontMatter(normalizeMermaid(source));
  const first = statements(body)[0]?.trim();
  if (!first) return undefined;
  const word = /^([A-Za-z][\w-]*)/.exec(first)?.[1];
  return word && DIAGRAM_SYNTAXES.includes(word) ? word : (word ?? undefined);
}

/** The purpose a syntax implies when the model gave none. */
export function defaultDiagramType(syntax: string): PlanDiagramType {
  switch (syntax) {
    case "sequenceDiagram":
      return "sequence";
    case "stateDiagram":
    case "stateDiagram-v2":
      return "state";
    case "erDiagram":
    case "classDiagram":
      return "data";
    default:
      return "flow";
  }
}

const uniqueCount = (items: Iterable<string>): number => new Set(items).size;

/** Words of a line without bracketed labels, quoted text and edge labels. */
function bareLine(line: string): string {
  return line
    .replace(/"[^"]*"/g, " ")
    .replace(/\[\[[^\]]*\]\]|\[[^\]]*\]|\(\([^)]*\)\)|\([^)]*\)|\{\{[^}]*\}\}|\{[^}]*\}/g, " ")
    .replace(/\|[^|]*\|/g, " ")
    .replace(/:::[\w-]+/g, " ");
}

/**
 * An estimate of the diagram's nodes from its text (participants, entities, states, tasks, topics
 * or flowchart node ids). It errs on the high side: it is a guard against walls of boxes, not a
 * parser.
 */
export function estimateNodes(source: string, syntax: string): number {
  const { body } = splitFrontMatter(normalizeMermaid(source));
  const lines = statements(body).map((line) => line.trim());
  const content = lines.slice(1);
  switch (syntax) {
    case "flowchart":
    case "graph": {
      const ids = new Set<string>();
      for (const line of content) {
        if (
          /^(subgraph|end|classDef|class|style|linkStyle|direction|click|accTitle|accDescr)\b/.test(
            line,
          )
        )
          continue;
        for (const part of bareLine(line).split(/<?[-=.~]+[ox>]?|&|;|\s+/)) {
          const id = /^[A-Za-z_][\w]*$/.exec(part.trim())?.[0];
          if (id) ids.add(id);
        }
      }
      return ids.size;
    }
    case "sequenceDiagram": {
      const names = new Set<string>();
      for (const line of content) {
        const declared = /^(?:participant|actor)\s+(\S+)/.exec(line)?.[1];
        if (declared) {
          names.add(declared);
          continue;
        }
        const message = /^([^\s:]+?)\s*(?:-->>|->>|--x|-x|--\)|-\)|-->|->)\s*[+-]?([^\s:]+)/.exec(
          line,
        );
        if (message?.[1] && message[2]) {
          names.add(message[1]);
          names.add(message[2]);
        }
      }
      return names.size;
    }
    case "stateDiagram":
    case "stateDiagram-v2": {
      const states = new Set<string>();
      for (const line of content) {
        const transition = /^(\S+)\s*-->\s*(\S+)/.exec(line);
        if (transition?.[1] && transition[2])
          for (const state of [transition[1], transition[2]])
            if (state !== "[*]") states.add(state);
        const declared = /^state\s+(?:"[^"]*"\s+as\s+)?(\w+)/.exec(line)?.[1];
        if (declared) states.add(declared);
      }
      return states.size;
    }
    case "erDiagram": {
      const entities = new Set<string>();
      for (const line of content) {
        const relation = /^(\S+)\s+[|}o{.-]+\s*[|}o{.-]*\s+(\S+)\s*:/.exec(line);
        if (relation?.[1] && relation[2]) {
          entities.add(relation[1]);
          entities.add(relation[2]);
        }
        const block = /^(\w+)\s*\{/.exec(line)?.[1];
        if (block) entities.add(block);
      }
      return entities.size;
    }
    case "classDiagram": {
      const classes = new Set<string>();
      for (const line of content) {
        const declared = /^class\s+(\w+)/.exec(line)?.[1];
        if (declared) classes.add(declared);
        const relation = /^(\w+)\s+(?:"[^"]*"\s+)?[<|*o.\-\\/>]+\s+(?:"[^"]*"\s+)?(\w+)/.exec(line);
        if (relation?.[1] && relation[2]) {
          classes.add(relation[1]);
          classes.add(relation[2]);
        }
      }
      return classes.size;
    }
    case "gantt":
      return content.filter(
        (line) =>
          line.includes(":") &&
          !/^(title|dateFormat|axisFormat|section|excludes|includes|todayMarker|tickInterval|weekday|accTitle|accDescr|inclusiveEndDates|topAxis)\b/.test(
            line,
          ),
      ).length;
    case "journey":
      return content.filter((line) => !/^(title|section|accTitle|accDescr)\b/.test(line)).length;
    default:
      // mindmap, timeline and anything else: one node per line.
      return uniqueCount(
        content.filter((line) => !/^(title|section|accTitle|accDescr)\b/.test(line)),
      );
  }
}

/** The first problem that makes a Mermaid source unsafe or unsupported, or undefined when fine. */
export function mermaidProblem(
  source: string,
  limits: { maxBytes?: number; maxNodes?: number } = {},
): string | undefined {
  const maxBytes = limits.maxBytes ?? DIAGRAM_MAX_BYTES;
  const maxNodes = limits.maxNodes ?? DIAGRAM_MAX_NODES;
  const text = normalizeMermaid(source);
  if (!text) return "the diagram is empty";
  if (byteLength(text) > maxBytes) return `the diagram is larger than ${maxBytes} bytes`;
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))
    return "the diagram has control characters";
  const { front, body } = splitFrontMatter(text);
  const syntax = diagramSyntax(text);
  if (!syntax) return "the diagram does not start with a Mermaid diagram keyword";
  if (!DIAGRAM_SYNTAXES.includes(syntax))
    return `the diagram type "${syntax}" is not allowed (use ${DIAGRAM_SYNTAXES.join(", ")})`;
  if (FORBIDDEN_CONFIG.test(front))
    return "the front matter changes Mermaid security settings, which plans may not do";
  for (const directive of directives(body))
    if (FORBIDDEN_CONFIG.test(directive))
      return "an init directive changes Mermaid security settings, which plans may not do";
  // The scan below ignores comments and directives, which were checked above.
  const code = statements(body).join("\n");
  if (/(?:javascript|vbscript)\s*:|data\s*:\s*(?:text|image|application)\//i.test(code))
    return "the diagram contains a javascript:, vbscript: or data: URL";
  if (/\bhref\b/i.test(code)) return "the diagram contains a link (href)";
  if (/url\s*\(|@import/i.test(code)) return "the diagram references an external resource (url())";
  // `<<choice>>` and `<<interface>>` are Mermaid annotations, not tags.
  if (/<\s*\/?\s*[A-Za-z!][^>]*>/.test(code.replace(/<<[^<>\n]*>>/g, " ")))
    return "labels are text: HTML tags (<br/>, <b>, <script>) are not allowed";
  const interactive = !["mindmap", "timeline", "journey"].includes(syntax);
  if (interactive && /^\s*(?:click|links?|callback)\s/m.test(code))
    return "click, link and callback statements are not allowed";
  if (estimateNodes(text, syntax) > maxNodes)
    return `the diagram has more than ${maxNodes} nodes: split it or keep only the main parts`;
  return undefined;
}

/** SHA-256 of what makes a diagram "the same" across revisions. */
export function diagramHash(diagram: {
  title: string;
  explanation: string;
  section?: string;
  type: string;
  mermaid: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        diagram.title,
        diagram.explanation,
        diagram.section ?? "",
        diagram.type,
        normalizeMermaid(diagram.mermaid),
      ]),
      "utf8",
    )
    .digest("hex");
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * Validates the `diagrams` argument of `exit_plan`. Never throws: every problem becomes a dropped
 * diagram with the reason the model needs to fix it. Order is kept; the first diagram with an id
 * wins; only `limits.max` are accepted.
 */
export function validateDiagrams(input: unknown, limits: DiagramLimits): DiagramValidation {
  const accepted: PlanDiagram[] = [];
  const dropped: DroppedDiagram[] = [];
  if (input === undefined || input === null) return { accepted, dropped };
  if (!Array.isArray(input)) {
    dropped.push({ id: "diagrams", reason: "`diagrams` must be an array" });
    return { accepted, dropped };
  }
  const seen = new Set<string>();
  input.forEach((raw, index) => {
    const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const given = typeof item.id === "string" ? item.id.trim() : "";
    const label = given || `#${index + 1}`;
    const drop = (reason: string) => dropped.push({ id: label, reason });
    if (!raw || typeof raw !== "object") return drop("the diagram must be an object");
    if (!ID.test(given) || given.length > DIAGRAM_ID_MAX)
      return drop(
        `the id must be kebab-case, at most ${DIAGRAM_ID_MAX} characters (like "request-flow")`,
      );
    if (seen.has(given)) return drop("the id is already used by another diagram of this plan");
    const title = text(item.title, DIAGRAM_TITLE_MAX);
    if (!title) return drop("the title is missing");
    const explanation = text(item.explanation, DIAGRAM_EXPLANATION_MAX);
    if (!explanation) return drop("the explanation is missing (one short sentence)");
    if (typeof item.mermaid !== "string") return drop("the `mermaid` source is missing");
    if (accepted.length >= limits.max)
      return drop(
        limits.max === 0
          ? "diagrams are turned off (plan.maxDiagrams is 0)"
          : `only ${limits.max} diagrams are accepted per plan (plan.maxDiagrams)`,
      );
    const problem = mermaidProblem(item.mermaid, limits);
    if (problem) return drop(problem);
    const mermaid = normalizeMermaid(item.mermaid);
    const syntax = diagramSyntax(mermaid) as string;
    const type = DIAGRAM_TYPES.includes(item.type as PlanDiagramType)
      ? (item.type as PlanDiagramType)
      : defaultDiagramType(syntax);
    const section = text(item.section, DIAGRAM_SECTION_MAX);
    seen.add(given);
    accepted.push({
      id: given,
      title,
      explanation,
      ...(section ? { section } : {}),
      type,
      syntax,
      mermaid,
      nodes: estimateNodes(mermaid, syntax),
    });
  });
  return { accepted, dropped };
}
