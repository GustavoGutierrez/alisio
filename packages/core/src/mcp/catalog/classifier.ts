/**
 * Category assignment strategy (D14/D15). `CategoryClassifier` is the seam: the v1 implementation
 * scores EN/ES keyword rules over the name, title and description, honours a curated map first and
 * treats the publisher's own hints as a weak signal. Everything unmatched is `other`. No model
 * call is ever needed to browse the catalog, and the method plus confidence stay visible.
 */
import { CATEGORY_IDS, type CategoryId, isCategoryId, TAXONOMY_VERSION } from "./categories.ts";
import type { CatalogEntry } from "./source.ts";

export interface CategoryAssignment {
  categoryId: CategoryId;
  method: "curated" | "rule" | "source";
  /** 0..1; 0 for the `other` fallback. */
  confidence: number;
}

export interface CategoryClassifier {
  readonly taxonomyVersion: number;
  classify(entry: CatalogEntry): CategoryAssignment;
}

/** Lowercase, accent-free text with single spaces (`hoja de cálculo` matches `hoja de calculo`). */
export const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Keyword stems per category, EN and ES. Matched at a word start so `repos` finds `repository`. */
const RULES: Record<Exclude<CategoryId, "other">, string[]> = {
  development: [
    "github",
    "gitlab",
    "git",
    "code",
    "codigo",
    "developer",
    "desarroll",
    "programm",
    "program",
    "repositor",
    "pull request",
    "debug",
    "compiler",
    "typescript",
    "javascript",
    "python",
    "docker",
    "kubernetes",
    "devops",
    "ci cd",
    "api",
    "sdk",
    "terminal",
    "shell",
    "lint",
    "sentry",
    "npm",
  ],
  productivity: [
    "calendar",
    "calendario",
    "task",
    "tarea",
    "todo",
    "notes",
    "notas",
    "notion",
    "reminder",
    "recordatorio",
    "project management",
    "kanban",
    "jira",
    "asana",
    "trello",
    "schedule",
    "agenda",
    "productiv",
    "workflow",
    "automation",
    "automatiz",
  ],
  "files-documents": [
    "file",
    "archivo",
    "filesystem",
    "folder",
    "carpeta",
    "pdf",
    "document",
    "docx",
    "word",
    "markdown",
    "drive",
    "dropbox",
    "onedrive",
    "presentation",
    "presentacion",
    "slides",
    "ocr",
  ],
  data: [
    "database",
    "base de datos",
    "sql",
    "postgres",
    "mysql",
    "sqlite",
    "mongodb",
    "redis",
    "spreadsheet",
    "hoja de calculo",
    "excel",
    "csv",
    "analytics",
    "analitica",
    "dataset",
    "datos",
    "data warehouse",
    "bigquery",
    "snowflake",
    "chart",
    "grafico",
    "dashboard",
  ],
  communication: [
    "email",
    "mail",
    "correo",
    "slack",
    "discord",
    "telegram",
    "whatsapp",
    "message",
    "mensaje",
    "chat",
    "sms",
    "teams",
    "meeting",
    "reunion",
    "zoom",
    "notification",
    "notificacion",
  ],
  research: [
    "search",
    "busqueda",
    "buscar",
    "web search",
    "research",
    "investigacion",
    "paper",
    "arxiv",
    "wikipedia",
    "scrap",
    "crawl",
    "browse",
    "news",
    "noticias",
    "academic",
    "academico",
    "knowledge",
    "citation",
  ],
  "design-media": [
    "image",
    "imagen",
    "video",
    "audio",
    "music",
    "musica",
    "design",
    "diseno",
    "figma",
    "photo",
    "foto",
    "svg",
    "illustration",
    "ilustracion",
    "3d",
    "animation",
    "animacion",
    "speech",
    "voz",
    "transcri",
    "canva",
  ],
};

const tokenPattern = (stem: string) => new RegExp(`(?:^| )${stem.replace(/ /g, " ")}`);
const COMPILED = Object.fromEntries(
  Object.entries(RULES).map(([id, stems]) => [id, stems.map(tokenPattern)]),
) as Record<Exclude<CategoryId, "other">, RegExp[]>;

export interface RuleClassifierOptions {
  /** Server name -> category id, applied before any rule (the owner's curation). */
  curated?: Readonly<Record<string, string>>;
}

export function createRuleClassifier(options: RuleClassifierOptions = {}): CategoryClassifier {
  const curated = options.curated ?? {};
  const hintCategory = (entry: CatalogEntry): CategoryId | undefined => {
    for (const hint of [
      ...(entry.publisherHints?.categories ?? []),
      ...(entry.publisherHints?.keywords ?? []),
    ]) {
      const folded = fold(hint).replace(/ /g, "-");
      if (isCategoryId(folded) && folded !== "other") return folded;
      const text = fold(hint);
      for (const id of CATEGORY_IDS) {
        if (id === "other") continue;
        if (COMPILED[id].some((re) => re.test(text))) return id;
      }
    }
    return undefined;
  };
  return {
    taxonomyVersion: TAXONOMY_VERSION,
    classify(entry) {
      const fixed = curated[entry.name];
      if (fixed && isCategoryId(fixed))
        return { categoryId: fixed, method: "curated", confidence: 1 };
      // The name is weighted by counting it twice; descriptions are untrusted but only ever scored.
      const text = fold(`${entry.name} ${entry.title ?? ""} ${entry.name} ${entry.description}`);
      let best: CategoryId = "other";
      let bestScore = 0;
      for (const id of CATEGORY_IDS) {
        if (id === "other") continue;
        const score = COMPILED[id].reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
        if (score > bestScore) {
          best = id;
          bestScore = score;
        }
      }
      if (bestScore > 0)
        return {
          categoryId: best,
          method: "rule",
          confidence: Math.min(0.9, 0.4 + 0.15 * bestScore),
        };
      const hinted = hintCategory(entry);
      if (hinted) return { categoryId: hinted, method: "source", confidence: 0.3 };
      return { categoryId: "other", method: "rule", confidence: 0 };
    },
  };
}
