/**
 * Alisio's own category taxonomy for MCP servers (specs/030 §7). The registry publishes no
 * categories, so these ids are Alisio's: stable identifiers, translated labels. Bump
 * `TAXONOMY_VERSION` whenever ids or rules change so stored assignments are recomputed.
 */
export const TAXONOMY_VERSION = 1;

export const CATEGORY_IDS = [
  "development",
  "productivity",
  "files-documents",
  "data",
  "communication",
  "research",
  "design-media",
  "other",
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const CATEGORY_LABELS: Record<CategoryId, { en: string; es: string }> = {
  development: { en: "Development", es: "Desarrollo" },
  productivity: { en: "Productivity", es: "Productividad" },
  "files-documents": { en: "Files and documents", es: "Archivos y documentos" },
  data: { en: "Data", es: "Datos" },
  communication: { en: "Communication", es: "Comunicación" },
  research: { en: "Research", es: "Investigación" },
  "design-media": { en: "Design and media", es: "Diseño y multimedia" },
  other: { en: "Other", es: "Otros" },
};

export const isCategoryId = (value: string): value is CategoryId =>
  (CATEGORY_IDS as readonly string[]).includes(value);
