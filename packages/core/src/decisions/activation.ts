import type {
  AskQuestionsRequest,
  AskQuestionsResult,
  DecisionActivationResult,
} from "@alisio/sdk";
import type { DecisionRegistry } from "./registry.ts";
import type { DecisionsConfig } from "./service.ts";

export interface DecisionActivationDeps {
  registry: DecisionRegistry;
  /** Live view of `config.decisions` (the global layer decides `provider`). */
  config: () => DecisionsConfig;
  /** Whether an interactive surface can ask the user. */
  interactive: () => boolean;
  ask: (request: AskQuestionsRequest) => Promise<AskQuestionsResult>;
  /** Saves `decisions.provider` globally and applies it live; throws on failure. */
  persist: (providerId: string) => Promise<void>;
}

const QUESTION_ID = "activate";

/**
 * A plugin asks the host to activate one of ITS providers. The host never overwrites a configured
 * provider, asks the user exactly once, and only then persists. Never throws.
 */
export async function requestDecisionActivation(
  owner: string,
  providerId: unknown,
  deps: DecisionActivationDeps,
): Promise<DecisionActivationResult> {
  if (typeof providerId !== "string" || deps.registry.get(providerId)?.owner !== owner)
    return {
      status: "unavailable",
      message: "That decision provider is not registered by this plugin.",
    };
  const config = deps.config();
  if (!config.enabled) return { status: "disabled" };
  if (config.provider === providerId) return { status: "already_active", active: providerId };
  if (config.provider) return { status: "other_provider_active", active: config.provider };
  if (!deps.interactive()) return { status: "needs_confirmation" };
  let answer: AskQuestionsResult;
  try {
    answer = await deps.ask({
      label: owner,
      questions: [
        {
          id: QUESTION_ID,
          header: "Decision provider",
          question: `Plugin ${owner} wants to become the decision provider. Dashboards will send your request goal and column names, never values, to it. Activate it?`,
          options: [
            { value: "yes", label: "Yes", description: "Save it in your global configuration." },
            {
              value: "no",
              label: "No",
              description: "Keep decisions unchanged.",
              recommended: true,
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
    await deps.persist(providerId);
  } catch {
    return { status: "unavailable", message: "The configuration could not be saved." };
  }
  return { status: "activated", active: providerId };
}
