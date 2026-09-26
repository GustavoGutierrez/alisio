import { type JsonSchema, type ToolDefinition, textResult } from "@alisio/sdk";
import { formatObservation, renderMemoryContext, suggestTopicKey } from "./format.ts";
import { MEMORY_TYPES, type MemoryScope, type MemoryStore, type MemoryType } from "./types.ts";

const schema = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const id = { type: "integer", minimum: 1 };
const json = (value: unknown) => textResult(JSON.stringify(value));

export interface MemoryToolDeps {
  store: MemoryStore;
  project: string;
  defaultScope: MemoryScope;
  budgetTokens: number;
  /** Called after a successful write so the plugin can refresh its status. */
  onWrite?: (action: string) => void;
}
export function memoryContextText(deps: MemoryToolDeps, session?: string): string | undefined {
  const { store, project } = deps;
  const summary = store.lastSummary(project);
  const pinned = store.pinned(project, 10);
  const recent = store.recent(project, 20);
  const prompts = store.recentPrompts(project, 5).map((p) => p.content);
  if (!summary && !pinned.length && !recent.length && !prompts.length) return undefined;
  return renderMemoryContext(
    {
      project,
      ...(session ? { session } : {}),
      ...(summary ? { summary: summary.content } : {}),
      prompts,
      pinned,
      recent,
    },
    deps.budgetTokens,
  );
}

/**
 * Memory tools use the `internal` effect: they write only to Alisio's memory store, so they
 * remain available under --read-only. Results follow progressive disclosure.
 */
export function memoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  const { store, project } = deps;
  return [
    {
      name: "memory_save",
      effect: "internal",
      description:
        "Save a durable observation (decision, bugfix, discovery, pattern, architecture, config, preference, learning). Reuse topic_key (family/description) to update instead of duplicating.",
      inputSchema: schema(
        {
          title: str(200),
          type: { type: "string", enum: [...MEMORY_TYPES] },
          what: str(20_000),
          why: { type: "string", maxLength: 10_000 },
          where: { type: "string", maxLength: 5_000 },
          learned: { type: "string", maxLength: 10_000 },
          topic_key: { type: "string", maxLength: 120 },
          scope: { type: "string", enum: ["project", "personal"] },
        },
        ["title", "type", "what"],
      ),
      async execute(input, context) {
        const type = input.type as MemoryType;
        const result = store.save({
          project,
          scope: (input.scope as MemoryScope | undefined) ?? deps.defaultScope,
          type,
          title: String(input.title),
          content: formatObservation({
            title: String(input.title),
            type,
            what: String(input.what),
            ...(typeof input.why === "string" ? { why: input.why } : {}),
            ...(typeof input.where === "string" ? { where: input.where } : {}),
            ...(typeof input.learned === "string" ? { learned: input.learned } : {}),
          }),
          ...(typeof input.topic_key === "string" && input.topic_key.trim()
            ? { topicKey: input.topic_key }
            : {}),
          ...(context.session ? { session: context.session } : {}),
          source: "memory_save",
        });
        deps.onWrite?.(result.action);
        return json(
          input.topic_key
            ? result
            : { ...result, suggested_topic_key: suggestTopicKey(type, String(input.title)) },
        );
      },
    },
    {
      name: "memory_search",
      effect: "internal",
      description:
        "Search memories (this project plus personal ones). Returns compact rows; use memory_get for full content. Use 1-2 keywords of 3+ characters.",
      inputSchema: schema(
        {
          query: str(500),
          type: { type: "string", enum: [...MEMORY_TYPES] },
          scope: { type: "string", enum: ["project", "personal"] },
          limit: { type: "integer", minimum: 1, maximum: 20 },
          match: { type: "string", enum: ["all", "any"] },
          all_projects: { type: "boolean" },
        },
        ["query"],
      ),
      async execute(input) {
        const options = {
          ...(input.type ? { type: input.type as MemoryType } : {}),
          ...(input.scope ? { scope: input.scope as MemoryScope } : {}),
          limit: Number(input.limit ?? 8),
          allProjects: input.all_projects === true,
        };
        let mode = (input.match as "all" | "any" | undefined) ?? "all";
        let results = store.search(project, String(input.query), { ...options, mode });
        if (!results.length && !input.match) {
          mode = "any";
          results = store.search(project, String(input.query), { ...options, mode });
        }
        return json({ mode, results });
      },
    },
    {
      name: "memory_get",
      effect: "internal",
      description: "Get the full content of one memory by id.",
      inputSchema: schema({ id }, ["id"]),
      async execute(input) {
        const record = store.get(Number(input.id), project);
        return record ? json(record) : textResult(`Memory ${String(input.id)} not found`, true);
      },
    },
    {
      name: "memory_context",
      effect: "internal",
      description:
        "Recent memories, pinned memories, recent prompts and the last session summary for this project (budgeted).",
      inputSchema: schema({}),
      async execute(_input, context) {
        return json({ context: memoryContextText(deps, context.session) ?? "No memories yet." });
      },
    },
    {
      name: "memory_timeline",
      effect: "internal",
      description: "Chronological neighbours of a memory within the same session.",
      inputSchema: schema(
        {
          id,
          before: { type: "integer", minimum: 0, maximum: 10 },
          after: { type: "integer", minimum: 0, maximum: 10 },
        },
        ["id"],
      ),
      async execute(input) {
        return json({
          timeline: store.timeline(
            Number(input.id),
            project,
            Number(input.before ?? 3),
            Number(input.after ?? 3),
          ),
        });
      },
    },
    {
      name: "memory_pin",
      effect: "internal",
      description: "Pin (or unpin) a memory so it is always included in memory context.",
      inputSchema: schema({ id, pinned: { type: "boolean" } }, ["id"]),
      async execute(input) {
        const ok = store.pin(Number(input.id), project, input.pinned !== false);
        if (ok) deps.onWrite?.("pinned");
        return json({ pinned: ok && input.pinned !== false, found: ok });
      },
    },
    {
      name: "memory_forget",
      effect: "internal",
      description: "Forget a memory (soft delete; hard=true removes it permanently).",
      inputSchema: schema({ id, hard: { type: "boolean" } }, ["id"]),
      async execute(input) {
        const forgotten = store.forget(Number(input.id), project, input.hard === true);
        if (forgotten) deps.onWrite?.("forgotten");
        return json({ forgotten });
      },
    },
  ];
}
