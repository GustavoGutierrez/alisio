/**
 * Assisted skill creation: one tool-less call of the ACTIVE model turns a short description (and
 * optionally a previous draft plus feedback) into a draft skill that the user reviews before
 * saving. Nothing is persisted here and nothing is executed.
 */
import {
  type ModelProvider,
  SKILL_LIMITS,
  type SkillDraft,
  type SkillDraftFile,
  type SkillDraftRequest,
  skillFilePathProblem,
} from "@alisio/sdk";
import { skillBody } from "../agents/create-agent-skill.ts";
import { completeText } from "../core/compaction.ts";
import {
  SKILL_AUTHORING_GUIDANCE,
  SKILL_AUTHORING_SKILL_NAMES,
  SKILL_DRAFT_INSTRUCTIONS,
} from "./authoring-guidance.ts";

export const SKILL_IDEA_MAX = 4_000;
export const SKILL_FEEDBACK_MAX = 2_000;
const BODY_CAP = 200_000;

/** Where the authoring guidance came from: a discovered skill, or the bundled one. */
export interface SkillAuthoringGuidance {
  text: string;
  source: string;
}

/** The first effective skill named like `SKILL_AUTHORING_SKILL_NAMES`, else the bundled guidance. */
export async function skillAuthoringGuidance(skills?: {
  items: { has(name: string): boolean };
  load(name: string): Promise<string>;
}): Promise<SkillAuthoringGuidance> {
  for (const name of SKILL_AUTHORING_SKILL_NAMES) {
    if (!skills?.items.has(name)) continue;
    try {
      const text = skillBody(await skills.load(name));
      if (text) return { text, source: `skill:${name}` };
    } catch {
      /* fall back to the bundled guidance */
    }
  }
  return { text: SKILL_AUTHORING_GUIDANCE, source: "bundled:skill-authoring" };
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

const oneLine = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max)
    : "";

/** A valid skill name from free text: "  PDF Merger!! " becomes "pdf-merger". */
export function slugifySkillName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_LIMITS.name)
    .replace(/-+$/g, "");
}

function parseFiles(value: unknown): SkillDraftFile[] {
  if (!Array.isArray(value)) return [];
  const files: SkillDraftFile[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.path !== "string" || typeof item.content !== "string") continue;
    const path = item.path.trim().replace(/^\.\//, "");
    if (skillFilePathProblem(path)) continue;
    const purpose = oneLine(item.purpose, 200);
    files.push({ path, content: item.content, ...(purpose ? { purpose } : {}) });
    if (files.length >= SKILL_LIMITS.files) break;
  }
  return files;
}

/**
 * A safe draft from a model answer: the name is slugified, texts are clipped to the format's
 * limits, frontmatter inside the body is dropped and unusable files are discarded. Hard-rule
 * violations that remain (for example a missing referenced file) are left for validation to
 * report. Throws when the answer has no usable JSON object or no body.
 */
export function parseSkillDraft(
  answer: string,
  generatedBy: string,
  guidance = "bundled:skill-authoring",
): SkillDraft {
  const json = firstJsonObject(answer);
  if (!json) throw new Error("The model did not return a JSON skill draft; try again");
  const body =
    typeof json.body === "string"
      ? json.body
          .replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "")
          .trim()
          .slice(0, BODY_CAP)
      : "";
  if (!body) throw new Error("The model's draft has no instructions (empty body); try again");
  const description = oneLine(json.description, SKILL_LIMITS.description);
  const name = slugifySkillName(json.name) || "new-skill";
  const compatibility = oneLine(json.compatibility, SKILL_LIMITS.compatibility);
  return {
    name,
    description,
    ...(compatibility ? { compatibility } : {}),
    body,
    files: parseFiles(json.files),
    generatedBy,
    guidance,
  };
}

const INCLUDE_TEXT = {
  scripts: ["Scripts", "scripts/"],
  templates: ["Templates and assets", "assets/"],
  references: ["Reference documents", "references/"],
} as const;

/** The user turn: a fresh idea, or a previous draft to refine with optional feedback. */
export function skillDraftRequest(request: SkillDraftRequest): string {
  const lines: string[] = [];
  const idea = request.idea.trim();
  if (request.previous?.body?.trim()) {
    const previous = request.previous;
    lines.push(
      "Refine this existing skill draft. Keep what works, apply the requested changes and keep it valid.",
      "",
      `Idea: ${idea}`,
      `Name: ${previous.name}`,
      `Description: ${previous.description}`,
      "Body:",
      "<<<",
      previous.body.trim(),
      ">>>",
    );
    for (const file of previous.files ?? [])
      lines.push("", `File ${file.path}:`, "<<<", file.content.slice(0, 20_000), ">>>");
    lines.push(
      "",
      `Requested changes: ${request.feedback?.trim() || "none; improve it to the quality bar"}`,
    );
  } else {
    lines.push(`Write a new skill for this request:\n${idea}`);
  }
  if (request.when?.trim())
    lines.push("", `The skill should trigger on things like: ${request.when.trim()}`);
  const hints: string[] = [];
  for (const [key, [label, folder]] of Object.entries(INCLUDE_TEXT)) {
    const choice = request.include?.[key as keyof typeof INCLUDE_TEXT];
    if (choice === "yes") hints.push(`${label}: include at least one file under ${folder}.`);
    else if (choice === "no") hints.push(`${label}: do not include any file under ${folder}.`);
  }
  if (hints.length) lines.push("", ...hints);
  return lines.join("\n");
}

/** Drafts a skill with one tool-less call of `provider` (the ACTIVE model). */
export async function generateSkillDraft(
  provider: ModelProvider,
  request: SkillDraftRequest,
  options: { signal?: AbortSignal; maxTokens?: number; guidance?: SkillAuthoringGuidance } = {},
): Promise<SkillDraft> {
  const idea = (request.idea ?? "").trim();
  if (!idea) throw new Error("Describe what the skill should do first");
  if (idea.length > SKILL_IDEA_MAX)
    throw new Error(`Descriptions are limited to ${SKILL_IDEA_MAX} characters`);
  if ((request.feedback ?? "").length > SKILL_FEEDBACK_MAX)
    throw new Error(`Feedback is limited to ${SKILL_FEEDBACK_MAX} characters`);
  const guidance = options.guidance ?? (await skillAuthoringGuidance());
  const signal = AbortSignal.any([
    AbortSignal.timeout(180_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const text = await completeText(provider, {
    system: `${guidance.text}\n\n${SKILL_DRAFT_INSTRUCTIONS}`,
    messages: [{ role: "user", text: skillDraftRequest({ ...request, idea }) }],
    maxTokens: options.maxTokens ?? 8_000,
    signal,
  });
  return parseSkillDraft(text, provider.model, guidance.source);
}
