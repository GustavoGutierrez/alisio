/**
 * Pure memory helpers: observation format, topic keys, FTS queries, ranking, budgeted context
 * rendering and model-output parsing. No I/O here.
 */
import { z } from "zod";
import { MEMORY_TYPES, type MemoryHit, type MemoryScope, type MemoryType } from "./types.ts";

/** Same estimate as the core (~4 characters per token), kept local to stay decoupled. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface Observation {
  title: string;
  type: MemoryType;
  what: string;
  why?: string;
  where?: string;
  learned?: string;
  topicKey?: string;
  scope?: MemoryScope;
}
export function formatObservation(o: Observation): string {
  return (
    [
      ["What", o.what],
      ["Why", o.why],
      ["Where", o.where],
      ["Learned", o.learned],
    ] as const
  )
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `**${k}**: ${v?.trim()}`)
    .join("\n");
}

export const redactPrivate = (text: string) =>
  text.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");

const kebab = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
/** Lowercase kebab `family/description`, at most two levels (Engram convention). */
export function normalizeTopicKey(key: string): string | undefined {
  const parts = key.split("/").map(kebab).filter(Boolean);
  if (!parts.length) return undefined;
  const [family, ...rest] = parts;
  const description = rest.join("-").slice(0, 80);
  return description ? `${family}/${description}` : family;
}
const FAMILY: Record<MemoryType, string> = {
  architecture: "architecture",
  bugfix: "bug",
  decision: "decision",
  pattern: "pattern",
  config: "config",
  discovery: "discovery",
  learning: "learning",
  preference: "preference",
};
export const suggestTopicKey = (type: MemoryType, title: string) =>
  normalizeTopicKey(`${FAMILY[type]}/${title}`) ?? FAMILY[type];

/**
 * Quoted FTS5 terms (never raw user syntax). Terms need ≥3 characters because the index uses
 * the trigram tokenizer.
 */
export function ftsQuery(text: string, mode: "all" | "any" = "any"): string | undefined {
  const tokens = [
    ...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length >= 3)),
  ].slice(0, 16);
  return tokens.length
    ? tokens.map((t) => `"${t}"`).join(mode === "all" ? " AND " : " OR ")
    : undefined;
}

const DAY = 86_400_000;
/** BM25 (SQLite: lower is better) scaled by a 30-day recency decay and an access boost. */
export function rankScore(bm25: number, updatedAt: number, accessCount: number, now: number) {
  const relevance = Math.max(-bm25, 1e-9);
  const age = Math.max(0, now - updatedAt) / DAY;
  return relevance * (0.6 + 0.4 * Math.exp(-age / 30)) * (1 + 0.05 * Math.log1p(accessCount));
}

export const memoryLine = (m: MemoryHit, compact = false) =>
  `- #${m.id} [${m.type}] **${m.title}**${!compact && m.snippet ? `: ${m.snippet}` : ""}`;

function clipLines(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const marker = "\n[truncated]";
  const room = maxChars - marker.length;
  if (room <= 0) return "";
  let cut = body.slice(0, room);
  const newline = cut.lastIndexOf("\n");
  if (newline > room / 2) cut = cut.slice(0, newline);
  return `${cut}${marker}`;
}
/** Adds rows (full, else compact) while they fit in `room` characters. */
function rows(memories: MemoryHit[], room: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (const m of memories) {
    const full = memoryLine(m),
      compact = memoryLine(m, true);
    const line = used + full.length + 1 <= room ? full : compact;
    if (used + line.length + 1 > room) break;
    out.push(line);
    used += line.length + 1;
  }
  return out;
}

/** Heading + optional body + memory rows, never exceeding `budgetTokens`. */
export function renderInjection(input: {
  heading: string;
  body?: string;
  memories: MemoryHit[];
  budgetTokens: number;
}): string {
  const limit = input.budgetTokens * 4;
  const head = `[${input.heading}]\n`;
  const memHeader = "\n## Relevant memories (call memory_get with an id for details)\n";
  const reserve = input.memories.length ? Math.floor((limit - head.length) * 0.4) : 0;
  const body = input.body?.trim()
    ? clipLines(input.body.trim(), limit - head.length - reserve)
    : "";
  let out = `${head}${body}`;
  const room = limit - out.length - memHeader.length;
  const lines = room > 0 ? rows(input.memories, room) : [];
  if (lines.length) out += `${memHeader}${lines.join("\n")}`;
  return out.slice(0, limit);
}

/** Engram's mem_context layout (with ids for memory_get), budgeted; pinned rows always kept. */
export function renderMemoryContext(
  data: {
    project: string;
    session?: string;
    summary?: string;
    prompts: string[];
    pinned: MemoryHit[];
    recent: MemoryHit[];
  },
  budgetTokens: number,
): string {
  const limit = budgetTokens * 4;
  const header =
    "[Memory context from previous sessions (Alisio memory). Call memory_get with an id for details.]\n";
  const session = `### Session\nproject ${data.project}${data.session ? ` · session ${data.session.slice(0, 8)}` : ""}\n`;
  let remaining = limit - header.length - session.length;
  let pinned = "";
  if (data.pinned.length) {
    const title = "### Pinned\n";
    const lines = rows(data.pinned, Math.max(0, Math.floor(remaining * 0.4) - title.length));
    const compact = rows(
      data.pinned.map((m) => ({ ...m, snippet: "" })),
      Math.max(0, remaining - title.length),
    );
    const chosen = lines.length === data.pinned.length ? lines : compact;
    if (chosen.length) pinned = `${title}${chosen.join("\n")}\n`;
    remaining -= pinned.length;
  }
  const summary = data.summary?.trim()
    ? `${clipLines(`### Last Session Summary\n${data.summary.trim()}`, Math.floor(remaining * 0.45))}\n`
    : "";
  remaining -= summary.length;
  let prompts = "";
  if (data.prompts.length) {
    const room = Math.floor(remaining * 0.35);
    const lines: string[] = [];
    let used = "### Recent User Prompts\n".length;
    for (const p of data.prompts.slice(0, 5)) {
      const text = p.replace(/\s+/g, " ").trim();
      const line = `- ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
      if (used + line.length + 1 > room) continue;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length) prompts = `### Recent User Prompts\n${lines.join("\n")}\n`;
    remaining -= prompts.length;
  }
  let recent = "";
  const title = "### Recent Observations\n";
  const pinnedIds = new Set(data.pinned.map((m) => m.id));
  const lines = rows(
    data.recent.filter((m) => !pinnedIds.has(m.id)),
    remaining - title.length,
  );
  if (lines.length) recent = `${title}${lines.join("\n")}\n`;
  return `${header}${session}${summary}${prompts}${pinned}${recent}`.trimEnd().slice(0, limit);
}

const observationSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: z.enum(MEMORY_TYPES),
  what: z.string().trim().min(1).max(4_000),
  why: z.string().trim().max(2_000).optional(),
  where: z.string().trim().max(1_000).optional(),
  learned: z.string().trim().max(2_000).optional(),
  topic_key: z.string().trim().max(120).optional(),
  scope: z.enum(["project", "personal"]).optional(),
});
/** Validates model-extracted observations one by one; invalid items are dropped. */
export function parseObservations(value: unknown): Observation[] {
  if (!Array.isArray(value)) return [];
  const out: Observation[] = [];
  for (const item of value.slice(0, 20)) {
    const parsed = observationSchema.safeParse(item);
    if (!parsed.success) continue;
    const { topic_key, ...rest } = parsed.data;
    const topicKey = topic_key ? normalizeTopicKey(topic_key) : undefined;
    out.push(
      Object.fromEntries(
        Object.entries({ ...rest, ...(topicKey ? { topicKey } : {}) }).filter(
          ([, v]) => v !== undefined && v !== "",
        ),
      ) as unknown as Observation,
    );
  }
  return out;
}

export const OBSERVATIONS_FIELD = `array of durable observations worth remembering in future sessions:
 [{"title":"verb + what","type":"decision|bugfix|discovery|pattern|architecture|config|preference|learning","what":string,"why":string,"where":string,"learned":string,"topic_key":"family/description","scope":"project|personal"}] ([] when nothing is durable)`;
export const COMPACTION_GUIDANCE = `For "observations": include only durable knowledge (decisions, fixed bugs, non-obvious
discoveries, conventions, configuration, user preferences). Use lowercase kebab topic keys like
"decision/memory-location" so later updates replace earlier ones. Use scope "personal" only for
user preferences that apply across projects.`;

export const MEMORY_PROTOCOL = `## Persistent memory (Alisio memory plugin)
Memory tools write to Alisio's local memory store, never to the workspace.
Save with memory_save right after: a bugfix, a decision, a non-obvious discovery, a config change,
an established pattern or convention, or a learned user preference.
- title: verb + what (e.g. "Fixed lock leak in session store"); type; scope (project by default,
  personal for cross-project user preferences); topic_key "family/description" when the subject
  may evolve (reuse it to update instead of duplicating).
- content: what / why / where / learned.
Recall: call memory_context first, then memory_search with 1-2 keywords, then memory_get for full
details (memory_timeline shows neighbouring observations).
Memory operations are bookkeeping, never the user-facing answer: always finish with the complete
answer to the user.`;

const listSchema = z.array(z.string().trim().max(2_000)).max(40).default([]);
const sessionSummarySchema = z.object({
  summary: z.object({
    goal: z.string().trim().min(1).max(2_000),
    instructions: listSchema,
    discoveries: listSchema,
    accomplished: listSchema,
    nextSteps: listSchema,
    relevantFiles: listSchema,
  }),
  observations: z.array(z.unknown()).default([]),
});
export const SESSION_SUMMARY_SYSTEM = `You write the end-of-session summary for a coding-agent session and extract durable memories.
Reply with ONLY a JSON object:
{"summary":{"goal":string,"instructions":string[],"discoveries":string[],"accomplished":string[],"nextSteps":string[],"relevantFiles":string[]},
 "observations": ${OBSERVATIONS_FIELD}}
Keep paths, commands and identifiers exact. Do not invent facts. Be concise.
${COMPACTION_GUIDANCE}`;
const bullets = (items: string[]) =>
  items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)";
/** Engram session summary sections; falls back to the raw text when JSON is invalid. */
export function parseSessionSummary(raw: string): {
  structured: boolean;
  text: string;
  observations: Observation[];
} {
  try {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1];
    const value = JSON.parse(fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const parsed = sessionSummarySchema.safeParse(value);
    if (!parsed.success) throw parsed.error;
    const s = parsed.data.summary;
    return {
      structured: true,
      observations: parseObservations(parsed.data.observations),
      text: [
        `## Goal\n${s.goal}`,
        `## Instructions\n${bullets(s.instructions)}`,
        `## Discoveries\n${bullets(s.discoveries)}`,
        `## Accomplished\n${bullets(s.accomplished)}`,
        `## Next Steps\n${bullets(s.nextSteps)}`,
        `## Relevant Files\n${bullets(s.relevantFiles)}`,
      ].join("\n\n"),
    };
  } catch {
    return { structured: false, text: raw.trim(), observations: [] };
  }
}
