import type { SemanticConfig, SemanticStatus } from "./service.ts";

const health = (h: { status: string; detail?: string } | undefined): string =>
  h ? `${h.status}${h.detail ? ` (${h.detail})` : ""}` : "not reported";

/** The `/semantic` report (spec 029 §6.1): read-only, no paths, no package names. */
export function formatSemanticReport(
  status: SemanticStatus,
  config: Pick<SemanticConfig, "embedTimeoutMs" | "queryTimeoutMs">,
): string {
  const { active, configured, registered } = status;
  const lines = ["**Semantic search**", ""];
  if (!status.enabled) lines.push("- Status: disabled (semantic.enabled is false)");
  else if (active.embedding && active.store) lines.push("- Status: enabled · available");
  else if (!configured.embedding && !configured.store)
    lines.push(
      "- Status: enabled · no provider configured (set semantic.embedding and semantic.store)",
    );
  else lines.push("- Status: enabled · not available (a configured provider is not registered)");
  lines.push(
    `- Embedding: ${
      active.embedding
        ? `${active.embedding.id} (${active.embedding.name}) · model ${active.embedding.modelId} · ${active.embedding.dimensions} dimensions · health: ${health(status.health.embedding)}`
        : configured.embedding
          ? `"${configured.embedding}" is not registered`
          : "none"
    }`,
    `- Store: ${
      active.store
        ? `${active.store.id} (${active.store.name}) · health: ${health(status.health.store)}`
        : configured.store
          ? `"${configured.store}" is not registered`
          : "none"
    }`,
    `- Timeouts: embed ${config.embedTimeoutMs} ms · query ${config.queryTimeoutMs} ms`,
    "",
    "Registered embedding providers:",
    ...(registered.embeddings.length
      ? registered.embeddings.map((p) => `- ${p.id} (${p.name}) · plugin ${p.owner}`)
      : ["- none"]),
    "",
    "Registered vector stores:",
    ...(registered.stores.length
      ? registered.stores.map((p) => `- ${p.id} (${p.name}) · plugin ${p.owner}`)
      : ["- none"]),
  );
  if (registered.embeddings.length === 0 && registered.stores.length === 0)
    lines.push(
      "",
      "No semantic provider is installed. Install a plugin that provides one, then choose it in your global configuration.",
    );
  return lines.join("\n");
}
