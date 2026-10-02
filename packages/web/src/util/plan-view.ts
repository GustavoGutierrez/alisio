/**
 * Pure logic of the plan viewer (the web view of a plan folder: `plan.md`, `plan.json` and
 * `diagrams/*.mmd`): recognizing a plan artifact, reading the manifest defensively, splitting the
 * Markdown into sections, grouping the diagrams, the revision badges and the loader that reads a
 * folder through the authenticated artifact files route. No DOM and no signals, so it is tested
 * in Node. Nothing here interprets plan text as HTML.
 */
import type { PlanDiagramStatus, PlanDiagramType, PlanManifest } from "@alisio/sdk";

export const PLAN_ENTRY = "plan.md";
export const PLAN_MANIFEST = "plan.json";
export const DIAGRAM_FILE = /^diagrams\/[a-z0-9]+(?:-[a-z0-9]+)*\.mmd$/;

const DIAGRAM_TYPES: readonly PlanDiagramType[] = [
  "overview",
  "flow",
  "components",
  "architecture",
  "sequence",
  "data",
  "state",
  "other",
];

/** A plan folder: the entry is `plan.md` and the folder carries the manifest. */
export function isPlanArtifact(detail: {
  entry?: string;
  files?: Array<{ path: string }>;
}): boolean {
  return detail.entry === PLAN_ENTRY && !!detail.files?.some((file) => file.path === PLAN_MANIFEST);
}

const str = (value: unknown, max = 2000): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * The manifest of a plan folder, or undefined when the text is not a usable manifest. Unknown
 * fields are ignored, malformed items are dropped, and a diagram whose file is not a plain
 * `diagrams/<id>.mmd` path is dropped (the viewer never fetches an arbitrary path).
 */
export function parsePlanManifest(text: string): PlanManifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const root = obj(raw);
  if (typeof root.version !== "number" || !Number.isFinite(root.version) || root.version < 1)
    return undefined;
  const title = str(root.title, 200);
  if (!title) return undefined;
  const diagrams: PlanManifest["diagrams"] = [];
  const seen = new Set<string>();
  for (const item of list(root.diagrams)) {
    const d = obj(item);
    const id = str(d.id, 60);
    const file = str(d.file, 120);
    const name = str(d.title, 120);
    if (!id || !name || !file || !DIAGRAM_FILE.test(file) || seen.has(id)) continue;
    seen.add(id);
    const type = DIAGRAM_TYPES.includes(d.type as PlanDiagramType)
      ? (d.type as PlanDiagramType)
      : "other";
    const status: PlanDiagramStatus =
      d.status === "new" || d.status === "updated" ? d.status : "unchanged";
    const section = str(d.section, 80);
    diagrams.push({
      id,
      title: name,
      explanation: str(d.explanation, 600) ?? "",
      ...(section ? { section } : {}),
      type,
      syntax: str(d.syntax, 40) ?? "",
      file,
      hash: str(d.hash, 80) ?? "",
      status,
    });
  }
  return {
    version: 1,
    planId: str(root.planId, 80) ?? "",
    revision:
      typeof root.revision === "number" && root.revision >= 1 ? Math.floor(root.revision) : 1,
    title,
    hash: str(root.hash, 80) ?? "",
    summary: str(root.summary, 1000) ?? "",
    goals: list(root.goals)
      .map((goal) => str(goal, 400))
      .filter((goal): goal is string => !!goal),
    stages: list(root.stages).flatMap((stage) => {
      const s = obj(stage);
      const name = str(s.title, 300);
      const detail = str(s.detail, 1000);
      return name ? [{ title: name, ...(detail ? { detail } : {}) }] : [];
    }),
    considerations: list(root.considerations).flatMap((entry) => {
      const c = obj(entry);
      const text = str(c.text, 1000);
      const kind = c.kind === "decision" || c.kind === "risk" ? c.kind : "verification";
      return text ? [{ kind, text }] : [];
    }),
    sections: list(root.sections).flatMap((section) => {
      const s = obj(section);
      const id = str(s.id, 80);
      const name = str(s.title, 200);
      return id && name
        ? [{ id, title: name, level: typeof s.level === "number" ? s.level : 2 }]
        : [];
    }),
    diagrams,
    removed: list(root.removed).flatMap((entry) => {
      const r = obj(entry);
      const id = str(r.id, 60);
      return id ? [{ id, title: str(r.title, 120) ?? id }] : [];
    }),
  };
}

/** Heading text → anchor id. Must stay the same algorithm as `slugifyHeading` in core. */
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

/** Inline Markdown → plain text, as core does for headings (so the ids match). */
function plainHeading(markdown: string): string {
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

export interface PlanSection {
  /** The heading anchor id; empty for the text before the first heading. */
  id: string;
  title: string;
  level: number;
  /** The section's Markdown, heading line included. */
  text: string;
}

/**
 * Splits the plan Markdown at its ATX headings (outside code fences), one section per heading;
 * the ids follow the same rules as the manifest's `sections`. Text before the first heading is a
 * section with an empty id.
 */
export function splitPlanSections(markdown: string): PlanSection[] {
  const sections: PlanSection[] = [];
  const used = new Map<string, number>();
  let fence: string | undefined;
  let current: { section: PlanSection; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    current.section.text = current.lines.join("\n").replace(/\s+$/, "");
    if (current.section.id || current.section.text.trim()) sections.push(current.section);
    current = undefined;
  };
  current = { section: { id: "", title: "", level: 0, text: "" }, lines: [] };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]?.repeat(marker.length);
      else if (line.trim().startsWith(fence)) fence = undefined;
    } else if (!fence) {
      const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      const title = match?.[2] ? plainHeading(match[2]) : "";
      if (match?.[1] && title) {
        flush();
        const base = slugifyHeading(title);
        const count = (used.get(base) ?? 0) + 1;
        used.set(base, count);
        current = {
          section: {
            id: count === 1 ? base : `${base}-${count}`,
            title,
            level: match[1].length,
            text: "",
          },
          lines: [line],
        };
        continue;
      }
    }
    current?.lines.push(line);
  }
  flush();
  return sections;
}

type ManifestDiagram = PlanManifest["diagrams"][number];

/** Diagrams drawn under "Components and relationships" versus the general "Diagrams" list. */
export function groupDiagrams(diagrams: ManifestDiagram[]): {
  components: ManifestDiagram[];
  others: ManifestDiagram[];
} {
  return {
    components: diagrams.filter((d) => d.type === "components" || d.type === "architecture"),
    others: diagrams.filter((d) => d.type !== "components" && d.type !== "architecture"),
  };
}

/** Section id → the diagrams that illustrate it (for the back-links under the headings). */
export function diagramsBySection(diagrams: ManifestDiagram[]): Map<string, ManifestDiagram[]> {
  const map = new Map<string, ManifestDiagram[]>();
  for (const diagram of diagrams) {
    if (!diagram.section) continue;
    map.set(diagram.section, [...(map.get(diagram.section) ?? []), diagram]);
  }
  return map;
}

/** The "new" or "updated" badge of a diagram: only from the second revision on. */
export function diagramBadge(
  manifest: Pick<PlanManifest, "revision">,
  diagram: Pick<ManifestDiagram, "status">,
): "new" | "updated" | undefined {
  if (manifest.revision <= 1) return undefined;
  return diagram.status === "new" || diagram.status === "updated" ? diagram.status : undefined;
}

/** DOM ids of the cross-navigation targets (one namespace per kind, no clashes with the page). */
export const sectionDomId = (id: string): string => `plan-section-${id || "top"}`;
export const diagramDomId = (id: string): string => `plan-diagram-${id}`;
export const partDomId = (part: string): string => `plan-part-${part}`;

export interface DiagramLoad {
  source?: string;
  /** Why the diagram's file could not be read (the card shows it instead of the drawing). */
  error?: string;
}

export interface PlanBundle {
  /** Absent when `plan.json` is missing or unusable: the viewer shows the Markdown. */
  manifest?: PlanManifest;
  markdown: string;
  diagrams: Record<string, DiagramLoad>;
  /** Ids (and files) the viewer lists although the manifest did not (no manifest case). */
  fallbackDiagrams: ManifestDiagram[];
  issues: Array<"manifest-missing" | "manifest-invalid">;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Reads a plan folder: `plan.md` (required: a failure rejects), the manifest and every diagram
 * file. A missing or invalid manifest and a diagram that cannot be read are reported, never
 * fatal: the rest still shows. Without a manifest, the diagram files of the folder are listed.
 */
export async function loadPlanBundle(input: {
  files: Array<{ path: string }>;
  fetchText: (path: string) => Promise<string>;
}): Promise<PlanBundle> {
  const { files, fetchText } = input;
  const has = (path: string) => files.some((file) => file.path === path);
  const markdown = await fetchText(PLAN_ENTRY);
  const issues: PlanBundle["issues"] = [];
  let manifest: PlanManifest | undefined;
  if (!has(PLAN_MANIFEST)) issues.push("manifest-missing");
  else {
    try {
      manifest = parsePlanManifest(await fetchText(PLAN_MANIFEST));
    } catch {
      manifest = undefined;
    }
    if (!manifest) issues.push("manifest-invalid");
  }
  const fallbackDiagrams: ManifestDiagram[] = manifest
    ? []
    : files
        .map((file) => file.path)
        .filter((path) => DIAGRAM_FILE.test(path))
        .sort()
        .map((file) => {
          const id = file.slice("diagrams/".length, -".mmd".length);
          return {
            id,
            title: id.replace(/-/g, " "),
            explanation: "",
            type: "other" as const,
            syntax: "",
            file,
            hash: "",
            status: "unchanged" as const,
          };
        });
  const wanted = manifest ? manifest.diagrams : fallbackDiagrams;
  const diagrams: Record<string, DiagramLoad> = {};
  await Promise.all(
    wanted.map(async (diagram) => {
      if (!has(diagram.file)) {
        diagrams[diagram.id] = { error: `${diagram.file} is not in this plan folder` };
        return;
      }
      try {
        diagrams[diagram.id] = { source: await fetchText(diagram.file) };
      } catch (error) {
        diagrams[diagram.id] = { error: errorText(error) };
      }
    }),
  );
  return { ...(manifest ? { manifest } : {}), markdown, diagrams, fallbackDiagrams, issues };
}

/**
 * A loader that drops stale answers: only the result of the latest `load` call is returned,
 * so a slow response for a plan the user already left (or a revision they switched away from)
 * never replaces what is on screen. A superseded call resolves to `undefined`.
 */
export function createPlanLoader(
  run: (id: string) => Promise<PlanBundle>,
): (id: string) => Promise<PlanBundle | undefined> {
  let latest = 0;
  return async (id) => {
    const mine = ++latest;
    try {
      const bundle = await run(id);
      return mine === latest ? bundle : undefined;
    } catch (error) {
      if (mine !== latest) return undefined;
      throw error;
    }
  };
}
