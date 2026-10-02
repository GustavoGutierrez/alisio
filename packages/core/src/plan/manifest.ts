/**
 * The `plan.json` manifest of a plan folder, generated deterministically from the plan Markdown
 * and its accepted diagrams (never by the model). The viewer reads it instead of parsing free
 * Markdown. Sections that the plan does not have simply come out empty: the viewer then falls back
 * to the rendered `plan.md`.
 *
 * Pure functions: no I/O.
 */
import { createHash } from "node:crypto";
import type { PlanDiagramStatus, PlanManifest } from "@alisio/sdk";
import { diagramHash, type PlanDiagram } from "./diagrams.ts";

export interface PlanHeading {
  id: string;
  title: string;
  level: number;
  /** Zero-based line of the heading. */
  line: number;
}

/** What `PlanState` remembers about the diagrams of a revision (enough to diff the next one). */
export interface DiagramRecord {
  id: string;
  title: string;
  hash: string;
}

export const MANIFEST_VERSION = 1;
const SUMMARY_MAX = 400;
const ITEM_MAX = 160;
const DETAIL_MAX = 600;
const LIST_MAX = 30;

/** Heading text → anchor id (lowercase letters and digits joined by hyphens). */
export function slugifyHeading(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "section";
}

/** ATX headings outside fenced code, with unique ids (`steps`, `steps-2`). */
export function parsePlanHeadings(markdown: string): PlanHeading[] {
  const headings: PlanHeading[] = [];
  const used = new Map<string, number>();
  let fence: string | undefined;
  markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, index) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker[0]?.repeat(marker.length);
        else if (line.trim().startsWith(fence)) fence = undefined;
        return;
      }
      if (fence) return;
      const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (!match?.[1] || !match[2]) return;
      const title = plainText(match[2]);
      if (!title) return;
      const base = slugifyHeading(title);
      const count = (used.get(base) ?? 0) + 1;
      used.set(base, count);
      headings.push({
        id: count === 1 ? base : `${base}-${count}`,
        title,
        level: match[1].length,
        line: index,
      });
    });
  return headings;
}

/** The heading a diagram's `section` names (by id or title), or undefined when none matches. */
export function resolveSection(
  headings: PlanHeading[],
  section: string | undefined,
): string | undefined {
  const wanted = section?.trim().replace(/^#+\s*/, "");
  if (!wanted) return undefined;
  const lower = wanted.toLowerCase();
  const slug = slugifyHeading(wanted);
  return (
    headings.find((h) => h.id === lower || h.id === slug)?.id ??
    headings.find((h) => h.title.toLowerCase() === lower)?.id ??
    headings.find((h) => h.title.toLowerCase().startsWith(lower))?.id
  );
}

/** Inline Markdown → plain text (emphasis, code, links and list markers removed). */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^\w*])([*_])(?!\s)(.+?)\2(?!\w)/g, "$1$3")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

type Role = "goal" | "context" | "steps" | "risks" | "verification" | "decisions";
const ROLES: Array<[Role, RegExp]> = [
  ["goal", /^(goals?|objectives?|purpose|objetivos?|meta|metas)$/],
  ["context", /^(context|background|findings|contexto|antecedentes)$/],
  [
    "steps",
    /^(steps|implementation steps|implementation|plan|stages|phases|approach|pasos|etapas|fases|implementacion|enfoque)$/,
  ],
  ["risks", /^(risks?|risks and (open )?questions|considerations|riesgos?|consideraciones)$/],
  ["verification", /^(verification|testing|validation|tests?|verificacion|pruebas|validacion)$/],
  ["decisions", /^(decisions?|key decisions|design decisions|decisiones)$/],
];

function roleOf(title: string): Role | undefined {
  const normalized = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^[\d.\s)-]+/, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ROLES.find(([, pattern]) => pattern.test(normalized))?.[0];
}

interface Block {
  heading: PlanHeading;
  /** The lines between this heading and the next heading of any level. */
  lines: string[];
}

/** Heading blocks: each heading with the lines up to the next heading. */
function blocksOf(markdown: string, headings: PlanHeading[]): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  return headings.map((heading, index) => ({
    heading,
    lines: lines.slice(heading.line + 1, headings[index + 1]?.line ?? lines.length),
  }));
}

/**
 * The role of a heading. A level-1 heading is the plan's title ("# Plan"), not a section, unless
 * the plan has no section headings at all (everything written with `#`).
 */
function headingRole(headings: PlanHeading[], heading: PlanHeading): Role | undefined {
  if (heading.level === 1 && headings.some((h) => h.level >= 2 && roleOf(h.title)))
    return undefined;
  return roleOf(heading.title);
}

/** The lines of a role's section including its sub-sections (until a heading of the same level). */
function sectionLines(markdown: string, headings: PlanHeading[], role: Role): string[][] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[][] = [];
  headings.forEach((heading, index) => {
    if (headingRole(headings, heading) !== role) return;
    const end =
      headings.slice(index + 1).find((next) => next.level <= heading.level)?.line ?? lines.length;
    out.push(lines.slice(heading.line + 1, end));
  });
  return out;
}

const LIST_ITEM = /^(\s{0,3})(?:\d+[.)]|[-*+])\s+(.*)$/;

interface Item {
  title: string;
  detail: string;
}

/** Top-level list items of some lines; indented continuation lines become the detail. */
function listItems(lines: string[]): Item[] {
  const items: Item[] = [];
  let current: { head: string; rest: string[] } | undefined;
  let fence = false;
  const flush = () => {
    if (!current) return;
    const title = plainText(current.head);
    if (title) items.push({ title, detail: plainText(current.rest.join(" ")) });
    current = undefined;
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const match = LIST_ITEM.exec(line);
    if (match && (match[1]?.length ?? 0) <= 1) {
      flush();
      current = { head: match[2] ?? "", rest: [] };
    } else if (current && line.trim()) {
      current.rest.push(line.trim().replace(/^(?:\d+[.)]|[-*+])\s+/, ""));
    } else if (!line.trim() && current && current.rest.length === 0) {
      // A blank line right after the item head: keep collecting until the next item.
    }
  }
  flush();
  return items;
}

/** The first paragraph of some lines as plain text. */
function firstParagraph(lines: string[]): string {
  const paragraph: string[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (!line.trim()) {
      if (paragraph.length) break;
      continue;
    }
    if (LIST_ITEM.test(line) || /^\s*(>|\||---)/.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.trim());
  }
  return plainText(paragraph.join(" "));
}

/** Paragraphs and list items of some lines, as plain text entries. */
function entries(lines: string[]): string[] {
  const items = listItems(lines);
  if (items.length)
    return items.map((item) => (item.detail ? `${item.title}: ${item.detail}` : item.title));
  const text = firstParagraph(lines);
  return text ? [text] : [];
}

export interface ManifestInput {
  planId: string;
  revision: number;
  title: string;
  hash: string;
  markdown: string;
  diagrams: PlanDiagram[];
  /** Diagrams of the previous revision (from the plan state), when there was one. */
  previous?: DiagramRecord[];
}

/** The diff of this revision's diagrams against the previous one. */
export function diffDiagrams(
  diagrams: Array<{ id: string; title: string; hash: string }>,
  previous: DiagramRecord[] | undefined,
): { status: Map<string, PlanDiagramStatus>; removed: Array<{ id: string; title: string }> } {
  const before = new Map((previous ?? []).map((d) => [d.id, d]));
  const status = new Map<string, PlanDiagramStatus>();
  for (const diagram of diagrams) {
    const old = before.get(diagram.id);
    status.set(diagram.id, !old ? "new" : old.hash === diagram.hash ? "unchanged" : "updated");
  }
  const now = new Set(diagrams.map((d) => d.id));
  const removed = (previous ?? [])
    .filter((d) => !now.has(d.id))
    .map((d) => ({ id: d.id, title: d.title }));
  return { status, removed };
}

/** The plan manifest (`plan.json`). Deterministic: the same input gives the same manifest. */
export function buildPlanManifest(input: ManifestInput): PlanManifest {
  const headings = parsePlanHeadings(input.markdown);
  const goalBlocks = sectionLines(input.markdown, headings, "goal");
  const goalLines = goalBlocks.flat();
  const preface = (() => {
    const first = headings[0];
    const lines = input.markdown.replace(/\r\n?/g, "\n").split("\n");
    // Text after the title and before the first sub-heading, or the whole text with no headings.
    if (!first) return lines;
    const second = headings[1];
    return first.level === 1
      ? lines.slice(first.line + 1, second?.line ?? lines.length)
      : lines.slice(0, first.line);
  })();
  const summary = cut(
    firstParagraph(goalLines) ||
      firstParagraph(preface) ||
      firstParagraph(blocksOf(input.markdown, headings).flatMap((b) => b.lines)),
    SUMMARY_MAX,
  );
  const goals = listItems(goalLines)
    .map((item) => cut(item.detail ? `${item.title}: ${item.detail}` : item.title, ITEM_MAX))
    .slice(0, LIST_MAX);

  const stepBlocks = sectionLines(input.markdown, headings, "steps");
  const stepHeadings = headings.filter((heading, index) => {
    const parent = headings
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.level < heading.level);
    return !!parent && headingRole(headings, parent) === "steps";
  });
  let stages: Array<{ title: string; detail?: string }> = listItems(stepBlocks.flat()).map(
    (item) => ({
      title: cut(item.title, ITEM_MAX),
      ...(item.detail ? { detail: cut(item.detail, DETAIL_MAX) } : {}),
    }),
  );
  if (!stages.length && stepHeadings.length) {
    const blocks = blocksOf(input.markdown, headings);
    stages = stepHeadings.map((heading) => {
      const body = blocks.find((block) => block.heading.id === heading.id)?.lines ?? [];
      const detail = firstParagraph(body);
      return {
        title: cut(heading.title, ITEM_MAX),
        ...(detail ? { detail: cut(detail, DETAIL_MAX) } : {}),
      };
    });
  }
  stages = stages.slice(0, LIST_MAX);

  const considerations: PlanManifest["considerations"] = [];
  for (const [role, kind] of [
    ["decisions", "decision"],
    ["risks", "risk"],
    ["verification", "verification"],
  ] as const)
    for (const lines of sectionLines(input.markdown, headings, role))
      for (const text of entries(lines))
        if (considerations.length < LIST_MAX * 2)
          considerations.push({ kind, text: cut(text, DETAIL_MAX) });

  const hashes = input.diagrams.map((diagram) => ({
    id: diagram.id,
    title: diagram.title,
    hash: diagramHash(diagram),
  }));
  const { status, removed } = diffDiagrams(hashes, input.previous);
  return {
    version: MANIFEST_VERSION,
    planId: input.planId,
    revision: input.revision,
    title: input.title,
    hash: input.hash,
    summary,
    goals,
    stages,
    considerations,
    sections: headings.map(({ id, title, level }) => ({ id, title, level })),
    diagrams: input.diagrams.map((diagram, index) => {
      const section = resolveSection(headings, diagram.section);
      return {
        id: diagram.id,
        title: diagram.title,
        explanation: diagram.explanation,
        ...(section ? { section } : {}),
        type: diagram.type,
        syntax: diagram.syntax,
        file: `diagrams/${diagram.id}.mmd`,
        hash: hashes[index]?.hash ?? "",
        status: status.get(diagram.id) ?? "new",
      };
    }),
    removed,
  };
}

/** The hash of a plan revision: the Markdown alone, or the Markdown plus its diagrams. */
export function planContentHash(
  markdown: string,
  diagrams: Array<{ id: string; hash: string }>,
): string {
  const hash = createHash("sha256").update(markdown, "utf8");
  if (diagrams.length)
    hash.update(`\n--diagrams--\n${diagrams.map((d) => `${d.id}:${d.hash}`).join("\n")}`, "utf8");
  return hash.digest("hex");
}
