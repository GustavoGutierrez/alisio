/**
 * What `catalog.search` and `catalog.describe` show a script (spec §6.2, D13): the tools the run
 * lets it call right now, found by name or description, never the whole prompt-sized catalog.
 * Pure over the tool definitions.
 */
import type { ToolDefinition } from "@alisio/sdk";
import { effectOf } from "../permissions/decide.ts";

export const CATALOG_DEFAULT_LIMIT = 10;
export const CATALOG_MAX_LIMIT = 25;
const SUMMARY_CHARS = 160;

export interface CatalogEntry {
  name: string;
  effect: string;
  summary: string;
}

export interface CatalogDetail {
  name: string;
  effect: string;
  description: string;
  inputSchema: unknown;
}

/** The first sentence of a description, bounded. */
export function summarize(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > SUMMARY_CHARS ? `${sentence.slice(0, SUMMARY_CHARS - 1)}…` : sentence;
}

const terms = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);

/** Tools whose name or description holds every term of the query (all of them for an empty query). */
export function searchCatalog(
  tools: readonly ToolDefinition[],
  query: string,
  limit: number = CATALOG_DEFAULT_LIMIT,
): CatalogEntry[] {
  const wanted = terms(query);
  const bounded = Math.max(1, Math.min(Math.floor(limit), CATALOG_MAX_LIMIT));
  return tools
    .filter((tool) => {
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      return wanted.every((term) => haystack.includes(term));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, bounded)
    .map((tool) => ({
      name: tool.name,
      effect: effectOf(tool),
      summary: summarize(tool.description),
    }));
}

export function describeTool(
  tools: readonly ToolDefinition[],
  name: string,
): CatalogDetail | undefined {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return undefined;
  return {
    name: tool.name,
    effect: effectOf(tool),
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
