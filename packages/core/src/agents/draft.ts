/**
 * Assisted agent creation: one tool-less call of the ACTIVE model turns a short description into
 * a draft definition (name, description, instructions, suggested settings) that the user reviews
 * before saving. Nothing is persisted here.
 */
import type { AgentDefinitionInput, AgentDraft, ModelProvider } from "@alisio/sdk";
import { completeText } from "../core/compaction.ts";
import {
  AGENT_AUTHORING_SKILL_NAMES,
  CREATE_AGENT_SKILL,
  skillBody,
} from "./create-agent-skill.ts";
import {
  AGENT_LIMITS,
  AGENT_REASONING_SUMMARIES,
  AGENT_TEXT_FORMATS,
  AGENT_VERBOSITIES,
  defaultDescription,
} from "./definitions.ts";

export const AGENT_DRAFT_MAX_DESCRIPTION = 2_000;

/** The reply contract appended after the authoring guidance. */
export const AGENT_DRAFT_INSTRUCTIONS = [
  "You design agents that run inside Alisio, a coding-agent harness with tools for reading and",
  "editing files, searching code and running processes. Follow the authoring guidance above.",
  "Reply with ONE JSON object and nothing else, using keys:",
  '"name" (2-5 words, Title Case), "description" (one sentence, under 200 characters),',
  '"instructions" (the complete system prompt in Markdown, under 6000 characters),',
  '"reasoning" ({"effort": "low"|"medium"|"high", "summary": "auto"|"none"|"concise"|"detailed"})',
  'and "text" ({"format": {"type": "text"|"json_object"|"json_schema"}, "verbosity":',
  '"low"|"medium"|"high"}).',
].join(" ");

/** Where the authoring guidance came from: a discovered skill, or the bundled one. */
export interface AgentAuthoringGuidance {
  text: string;
  source: string;
}

/**
 * The authoring guidance: the first effective skill named like `AGENT_AUTHORING_SKILL_NAMES`
 * (project/user/plugin skills), else the bundled `create-agent` skill.
 */
export async function agentAuthoringGuidance(skills?: {
  items: { has(name: string): boolean };
  load(name: string): Promise<string>;
}): Promise<AgentAuthoringGuidance> {
  for (const name of AGENT_AUTHORING_SKILL_NAMES) {
    if (!skills?.items.has(name)) continue;
    try {
      const text = skillBody(await skills.load(name));
      if (text) return { text, source: `skill:${name}` };
    } catch {
      /* fall back to the bundled guidance */
    }
  }
  return { text: skillBody(CREATE_AGENT_SKILL), source: "bundled:create-agent" };
}

/** Extracts the first JSON object of a model answer (tolerating code fences and prose). */
function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [fenced, text]) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * A safe draft from a model answer: unknown settings are dropped, texts are clipped to the store
 * limits. Throws when the answer has no usable JSON object or no instructions.
 */
export function parseAgentDraft(
  answer: string,
  generatedBy: string,
  guidance = "bundled:create-agent",
): AgentDraft {
  const json = firstJsonObject(answer);
  if (!json) throw new Error("The model did not return a JSON agent draft; try again");
  const instructions = clip(json.instructions, AGENT_LIMITS.instructions);
  if (!instructions) throw new Error("The model's draft has no instructions; try again");
  const name = clip(json.name, AGENT_LIMITS.name) || "New agent";
  const description =
    clip(json.description, AGENT_LIMITS.description) || defaultDescription(name, instructions);
  const reasoningRaw = (
    json.reasoning && typeof json.reasoning === "object" ? json.reasoning : {}
  ) as Record<string, unknown>;
  const textRaw = (json.text && typeof json.text === "object" ? json.text : {}) as Record<
    string,
    unknown
  >;
  const reasoning: NonNullable<AgentDraft["reasoning"]> = {};
  if (["low", "medium", "high"].includes(reasoningRaw.effort as string))
    reasoning.effort = reasoningRaw.effort as string;
  if (AGENT_REASONING_SUMMARIES.includes(reasoningRaw.summary as never))
    reasoning.summary = reasoningRaw.summary as NonNullable<typeof reasoning.summary>;
  const text: NonNullable<AgentDraft["text"]> = {};
  const formatType = (textRaw.format as { type?: unknown } | undefined)?.type;
  if (AGENT_TEXT_FORMATS.includes(formatType as never))
    text.format = { type: formatType as NonNullable<typeof text.format>["type"] };
  if (AGENT_VERBOSITIES.includes(textRaw.verbosity as never))
    text.verbosity = textRaw.verbosity as NonNullable<typeof text.verbosity>;
  return {
    name,
    description,
    instructions,
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    ...(Object.keys(text).length ? { text } : {}),
    generatedBy,
    guidance,
  };
}

/** The user turn: a fresh description, or a definition to refine with optional changes. */
export function agentDraftRequest(
  description: string,
  base?: Partial<Pick<AgentDefinitionInput, "name" | "description" | "instructions">>,
): string {
  if (!base?.instructions?.trim())
    return `Write a new agent from this description:\n${description.trim()}`;
  return [
    "Refine this existing agent definition. Keep what works, apply the requested changes and",
    "complete any missing required section.",
    "",
    `Name: ${base.name ?? ""}`,
    `Description: ${base.description ?? ""}`,
    "Instructions:",
    "<<<",
    base.instructions.trim(),
    ">>>",
    "",
    `Requested changes: ${description.trim() || "none; improve it to the quality bar"}`,
  ].join("\n");
}

/**
 * Drafts an agent with one tool-less call of `provider` (the ACTIVE model): from `description`,
 * or by refining `base` (a template or the current form) with `description` as the changes.
 */
export async function generateAgentDraft(
  provider: ModelProvider,
  description: string,
  options: {
    signal?: AbortSignal;
    maxTokens?: number;
    guidance?: AgentAuthoringGuidance;
    base?: Partial<Pick<AgentDefinitionInput, "name" | "description" | "instructions">>;
  } = {},
): Promise<AgentDraft> {
  const text = description.trim();
  if (!text && !options.base?.instructions?.trim())
    throw new Error("Describe the agent you want first");
  if (text.length > AGENT_DRAFT_MAX_DESCRIPTION)
    throw new Error(`Descriptions are limited to ${AGENT_DRAFT_MAX_DESCRIPTION} characters`);
  const guidance = options.guidance ?? (await agentAuthoringGuidance());
  const signal = AbortSignal.any([
    AbortSignal.timeout(180_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const answer = await completeText(provider, {
    system: `${guidance.text}\n\n${AGENT_DRAFT_INSTRUCTIONS}`,
    messages: [{ role: "user", text: agentDraftRequest(text, options.base) }],
    maxTokens: options.maxTokens ?? 6_144,
    signal,
  });
  return parseAgentDraft(answer, provider.model, guidance.source);
}
