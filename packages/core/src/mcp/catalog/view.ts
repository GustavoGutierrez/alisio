/** Maps domain entries to the additive SDK DTOs of the catalog routes (no secrets, no raw JSON). */
import type { McpCatalogDetail, McpCatalogInputInfo, McpCatalogItem } from "@alisio/sdk";
import { assessEntry } from "./availability.ts";
import type { CategoryClassifier } from "./classifier.ts";
import type { CatalogEntry, CatalogInput } from "./source.ts";

const inputInfo = (input: CatalogInput): McpCatalogInputInfo => ({
  name: input.name,
  kind: input.kind,
  ...(input.description ? { description: input.description } : {}),
  isRequired: input.isRequired,
  isSecret: input.isSecret,
  ...(input.format ? { format: input.format } : {}),
  ...(input.choices ? { choices: input.choices } : {}),
  ...(input.default !== undefined && !input.isSecret ? { default: input.default } : {}),
});

/** Scheme and host only: a remote URL's path or query may carry a token. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function toDetail(entry: CatalogEntry, classifier: CategoryClassifier): McpCatalogDetail {
  const assessment = assessEntry(entry);
  const category = classifier.classify(entry);
  const item: McpCatalogItem = {
    sourceId: entry.sourceId,
    name: entry.name,
    ...(entry.title ? { title: entry.title } : {}),
    description: entry.description,
    version: entry.version,
    status: entry.status === "deprecated" ? "deprecated" : "active",
    execution: assessment.execution,
    methods: assessment.methods,
    category: { id: category.categoryId, method: category.method, confidence: category.confidence },
    ready: assessment.ready,
    ...(assessment.blocked ? { blocked: assessment.blocked } : {}),
    ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
  return {
    ...item,
    ...(entry.websiteUrl && /^https?:\/\//i.test(entry.websiteUrl)
      ? { websiteUrl: entry.websiteUrl }
      : {}),
    ...(entry.repositoryUrl && /^https?:\/\//i.test(entry.repositoryUrl)
      ? { repositoryUrl: entry.repositoryUrl }
      : {}),
    packages: entry.packages.map((p) => ({
      method: p.method,
      identifier: p.identifier,
      ...(p.version ? { version: p.version } : {}),
      transport: p.transport,
      inputs: p.inputs.map(inputInfo),
    })),
    remotes: entry.remotes.map((r) => ({
      transport: r.transport,
      origin: originOf(r.url),
      inputs: r.inputs.map(inputInfo),
    })),
  };
}
