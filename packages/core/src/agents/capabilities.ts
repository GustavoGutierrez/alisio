/**
 * Capability-driven agent settings: which reasoning, summary, verbosity and text-format options a
 * model supports, derived only from its catalog metadata (`ModelInfo.effort`, `inputModalities`,
 * `capabilities`). Providers that declare nothing (most OpenAI-compatible `GET /models` answers)
 * get a permissive default: every option is offered and `known` is false, so surfaces can say the
 * support is unverified. Explicit `false` metadata always hides an option.
 */
import type {
  AgentDefinitionInput,
  AgentModelCapabilities,
  AgentModelOption,
  AgentTextFormatType,
  AvailableProviderModel,
  ModelInfo,
} from "@alisio/sdk";

/** Levels offered when a reasoning model does not list its own. */
export const DEFAULT_EFFORT_LEVELS = ["low", "medium", "high"];

const flag = (
  capabilities: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined => {
  if (!capabilities) return undefined;
  for (const key of keys) {
    const value = capabilities[key];
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "supported") return true;
    if (value === "false" || value === "unsupported") return false;
  }
  return undefined;
};

/** What `model` supports for the agent editor (permissive when the catalog says nothing). */
export function agentModelCapabilities(model: ModelInfo | undefined): AgentModelCapabilities {
  const caps = model?.capabilities as Record<string, unknown> | undefined;
  const levels = model?.effort?.supportedLevels?.filter(Boolean) ?? [];
  const declaredReasoning = flag(caps, ["reasoning", "reasoning_effort", "thinking"]);
  const reasoning = levels.length > 0 || declaredReasoning !== false;
  const summary = reasoning && flag(caps, ["reasoning_summary", "reasoningSummary"]) !== false;
  const verbosity = flag(caps, ["verbosity", "text_verbosity"]) !== false;
  const json = flag(caps, ["json_mode", "json_object", "response_format"]);
  const schema = flag(caps, ["structured_outputs", "json_schema", "structuredOutputs"]);
  const textFormats: AgentTextFormatType[] = ["text"];
  if (json !== false) textFormats.push("json_object");
  if (schema !== false) textFormats.push("json_schema");
  const tools = flag(caps, ["tools", "tool_calling", "function_calling", "toolCalling"]);
  const vision =
    model?.inputModalities?.includes("image") ||
    model?.modalities?.includes("image") ||
    flag(caps, ["vision", "image_input"]) === true
      ? true
      : flag(caps, ["vision", "image_input"]);
  const known =
    !!levels.length ||
    !!model?.inputModalities?.length ||
    !!model?.modalities?.length ||
    !!(caps && Object.keys(caps).length);
  return {
    known,
    reasoning,
    effortLevels: reasoning ? (levels.length ? levels : DEFAULT_EFFORT_LEVELS) : [],
    ...(reasoning && model?.effort?.defaultLevel
      ? { defaultEffort: model.effort.defaultLevel }
      : {}),
    summary,
    verbosity,
    textFormats,
    ...(tools !== undefined ? { tools } : {}),
    ...(vision !== undefined ? { vision } : {}),
  };
}

/** Short labels such as "Reasoning · Tools · Vision", only for declared support. */
export function agentModelLabels(capabilities: AgentModelCapabilities): string[] {
  if (!capabilities.known) return [];
  return [
    capabilities.reasoning ? "Reasoning" : undefined,
    capabilities.tools ? "Tools" : undefined,
    capabilities.vision ? "Vision" : undefined,
    capabilities.textFormats.includes("json_schema") ? "Structured output" : undefined,
  ].filter((label): label is string => !!label);
}

/** The editor's model options from the configured catalogs; `active` marks the running model. */
export function agentModelOptions(
  available: AvailableProviderModel[],
  active?: { profile?: string; provider?: string; model: string },
): AgentModelOption[] {
  return available.map((entry) => {
    const capabilities = agentModelCapabilities(entry.model);
    return {
      reference: entry.reference,
      provider: entry.provider,
      profile: entry.profile,
      providerName: entry.providerName,
      id: entry.model.id,
      ...(entry.model.name ? { name: entry.model.name } : {}),
      active:
        !!active &&
        entry.model.id === active.model &&
        (active.profile ? entry.profile === active.profile : entry.provider === active.provider),
      capabilities,
      labels: agentModelLabels(capabilities),
    };
  });
}

/**
 * Drops or replaces settings `capabilities` does not support: unsupported reasoning settings are
 * removed, an unknown effort level falls back to the model default (or is removed), an unsupported
 * text format becomes `text`, unsupported verbosity is removed.
 */
export function fitAgentSettings<T extends Pick<AgentDefinitionInput, "reasoning" | "text">>(
  settings: T,
  capabilities: AgentModelCapabilities,
): T {
  const reasoning = { ...(settings.reasoning ?? {}) };
  if (!capabilities.reasoning) {
    delete reasoning.effort;
    delete reasoning.summary;
  } else if (reasoning.effort && !capabilities.effortLevels.includes(reasoning.effort)) {
    if (capabilities.defaultEffort) reasoning.effort = capabilities.defaultEffort;
    else delete reasoning.effort;
  }
  if (!capabilities.summary) delete reasoning.summary;
  const text = { ...(settings.text ?? {}) };
  if (text.format && !capabilities.textFormats.includes(text.format.type))
    text.format = { type: "text" };
  if (!capabilities.verbosity) delete text.verbosity;
  const out = { ...settings };
  if (Object.keys(reasoning).length) out.reasoning = reasoning;
  else delete out.reasoning;
  if (Object.keys(text).length) out.text = text;
  else delete out.text;
  return out;
}
