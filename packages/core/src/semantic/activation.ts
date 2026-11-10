import type {
  AskQuestionsRequest,
  AskQuestionsResult,
  DecisionActivationOptions,
  SemanticActivationResult,
} from "@alisio/sdk";
import type { SemanticRegistry } from "./registry.ts";
import type { SemanticConfig } from "./service.ts";

export interface SemanticActivationDeps {
  registry: SemanticRegistry;
  /** Live view of `config.semantic` (the global layer decides `embedding` and `store`). */
  config: () => SemanticConfig;
  interactive: () => boolean;
  ask: (request: AskQuestionsRequest) => Promise<AskQuestionsResult>;
  /** Saves the ids globally and applies them live; throws on failure. */
  persist: (ids: { embedding?: string; store?: string }) => Promise<void>;
}

const QUESTION_ID = "activate";
type Ids = { embedding?: string; store?: string };

/**
 * A plugin asks the host to activate providers IT registered. The host never overwrites a
 * configured provider, asks the user exactly once, and only then persists. Never throws.
 */
export async function requestSemanticActivation(
  owner: string,
  ids: unknown,
  deps: SemanticActivationDeps,
  options?: DecisionActivationOptions,
): Promise<SemanticActivationResult> {
  const requested: Ids = {};
  const raw = typeof ids === "object" && ids !== null ? (ids as Record<string, unknown>) : {};
  if (raw.embedding !== undefined)
    if (
      typeof raw.embedding !== "string" ||
      deps.registry.getEmbedding(raw.embedding)?.owner !== owner
    )
      return unavailable();
    else requested.embedding = raw.embedding;
  if (raw.store !== undefined)
    if (typeof raw.store !== "string" || deps.registry.getStore(raw.store)?.owner !== owner)
      return unavailable();
    else requested.store = raw.store;
  if (!requested.embedding && !requested.store) return unavailable();
  const config = deps.config();
  if (!config.enabled) return { status: "disabled" };
  const configured: Ids = {};
  const pending: Ids = {};
  for (const kind of ["embedding", "store"] as const) {
    const want = requested[kind];
    if (!want) continue;
    const current = config[kind];
    if (current && current !== want)
      return { status: "other_provider_active", active: { [kind]: current } };
    if (current) configured[kind] = current;
    else pending[kind] = want;
  }
  if (!pending.embedding && !pending.store) return { status: "already_active", active: configured };
  if (!deps.interactive()) return { status: "needs_confirmation" };
  const recommendYes =
    typeof options === "object" &&
    options !== null &&
    (options as { recommend?: unknown }).recommend === true;
  let answer: AskQuestionsResult;
  try {
    answer = await deps.ask({
      label: owner,
      questions: [
        {
          id: QUESTION_ID,
          header: "Semantic search",
          question: `Plugin ${owner} wants to become your semantic search provider. Plugins that index text will send it to this provider to compute embeddings and store vectors. Activate it?`,
          options: [
            {
              value: "yes",
              label: "Yes",
              description: "Save it in your global configuration.",
              ...(recommendYes ? { recommended: true } : {}),
            },
            {
              value: "no",
              label: "No",
              description: "Keep semantic search unchanged.",
              ...(recommendYes ? {} : { recommended: true }),
            },
          ],
        },
      ],
    });
  } catch {
    return { status: "declined" };
  }
  if (answer[QUESTION_ID] !== "yes") return { status: "declined" };
  try {
    await deps.persist(pending);
  } catch {
    return { status: "unavailable", message: "The configuration could not be saved." };
  }
  return { status: "activated", active: { ...configured, ...pending } };
}

const unavailable = (): SemanticActivationResult => ({
  status: "unavailable",
  message: "That semantic provider is not registered by this plugin.",
});
