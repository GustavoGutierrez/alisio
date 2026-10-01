/**
 * User agent definitions as portable Markdown files, shared with other harnesses:
 *
 * - project scope: `<workspace>/.agents/agents/<id>.md`
 * - global scope: `~/.agents/agents/<id>.md`
 *
 * The file follows the common subagent convention (Claude Code / OpenCode): YAML frontmatter with
 * `name` (the id slug), `description`, `model` and optional keys such as `tools`, and the system
 * prompt as the Markdown body. Alisio-only settings live under one namespaced `alisio:` key that
 * other tools ignore. Edits go through the YAML document model, so every key (and comment) another
 * tool wrote round-trips unchanged; only the keys Alisio owns are set or removed.
 *
 * Pure file logic with portable `node:fs` only; no runtime-specific APIs.
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AgentDefinitionInfo,
  AgentDefinitionInput,
  AgentReasoningSummary,
  AgentScope,
  AgentTextFormatType,
  AgentVerbosity,
} from "@alisio/sdk";
import { Document, isMap, parseDocument } from "yaml";

export type { AgentDefinitionInfo, AgentDefinitionInput, AgentScope };

/** Same identifier rule as the subagents plugin (and Claude Code agent names). */
export const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID_LENGTH = 48;
/** Built-in agent names a user file must not shadow (main `build`/`plan`, subagents). */
export const RESERVED_AGENT_IDS = new Set(["build", "plan", "general", "explore"]);
export const AGENT_LIMITS = {
  name: 80,
  description: 300,
  instructions: 24_000,
  model: 300,
} as const;
export const AGENT_REASONING_SUMMARIES: AgentReasoningSummary[] = [
  "auto",
  "none",
  "concise",
  "detailed",
];
export const AGENT_VERBOSITIES: AgentVerbosity[] = ["low", "medium", "high"];
export const AGENT_TEXT_FORMATS: AgentTextFormatType[] = ["text", "json_object", "json_schema"];
const EFFORT = /^[a-z][a-z_-]{0,19}$/;
/** Frontmatter key of the Alisio-only settings (ignored by other harnesses). */
export const ALISIO_KEY = "alisio";

/** The directory of one scope. */
export function agentScopeDir(scope: AgentScope, roots: { workspace?: string; home: string }) {
  if (scope === "global") return join(roots.home, ".agents", "agents");
  if (!roots.workspace) throw new Error("The project scope needs an open workspace");
  return join(roots.workspace, ".agents", "agents");
}

export interface AgentFieldError {
  field: string;
  message: string;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Validates and normalizes an untrusted definition body (web API, TUI, drafts). Unknown keys are
 * dropped; strings are trimmed; empty optional settings are omitted.
 */
export function validateAgentDefinitionInput(
  raw: unknown,
): { ok: true; value: AgentDefinitionInput } | { ok: false; errors: AgentFieldError[] } {
  const errors: AgentFieldError[] = [];
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = str(body.name)?.trim() ?? "";
  if (!name) errors.push({ field: "name", message: "Name is required" });
  else if (name.length > AGENT_LIMITS.name)
    errors.push({ field: "name", message: `Name is limited to ${AGENT_LIMITS.name} characters` });
  else if (!slugify(name))
    errors.push({ field: "name", message: "Name needs at least one letter or digit" });
  const description = str(body.description)?.trim() ?? "";
  if (body.description !== undefined && typeof body.description !== "string")
    errors.push({ field: "description", message: "Description must be text" });
  if (description.length > AGENT_LIMITS.description)
    errors.push({
      field: "description",
      message: `Description is limited to ${AGENT_LIMITS.description} characters`,
    });
  const instructions = str(body.instructions)?.trim() ?? "";
  if (body.instructions !== undefined && typeof body.instructions !== "string")
    errors.push({ field: "instructions", message: "Instructions must be text" });
  if (instructions.length > AGENT_LIMITS.instructions)
    errors.push({
      field: "instructions",
      message: `Instructions are limited to ${AGENT_LIMITS.instructions} characters`,
    });
  const model = str(body.model)?.trim() ?? "";
  if (!model) errors.push({ field: "model", message: "Model is required" });
  else if (model.length > AGENT_LIMITS.model || /\s/.test(model))
    errors.push({ field: "model", message: "Model must be a provider/model selector" });

  const reasoningRaw = body.reasoning;
  const reasoning: NonNullable<AgentDefinitionInput["reasoning"]> = {};
  if (reasoningRaw !== undefined && reasoningRaw !== null) {
    if (typeof reasoningRaw !== "object")
      errors.push({ field: "reasoning", message: "Reasoning must be an object" });
    else {
      const { effort, summary } = reasoningRaw as Record<string, unknown>;
      if (effort !== undefined && effort !== null && effort !== "") {
        if (typeof effort !== "string" || !EFFORT.test(effort))
          errors.push({ field: "reasoning.effort", message: "Invalid reasoning effort level" });
        else reasoning.effort = effort;
      }
      if (summary !== undefined && summary !== null && summary !== "") {
        if (!AGENT_REASONING_SUMMARIES.includes(summary as AgentReasoningSummary))
          errors.push({
            field: "reasoning.summary",
            message: `Summary must be one of ${AGENT_REASONING_SUMMARIES.join(", ")}`,
          });
        else reasoning.summary = summary as AgentReasoningSummary;
      }
    }
  }
  const textRaw = body.text;
  const text: NonNullable<AgentDefinitionInput["text"]> = {};
  if (textRaw !== undefined && textRaw !== null) {
    if (typeof textRaw !== "object")
      errors.push({ field: "text", message: "Text must be an object" });
    else {
      const { format, verbosity } = textRaw as Record<string, unknown>;
      const type =
        format && typeof format === "object" ? (format as Record<string, unknown>).type : undefined;
      if (format !== undefined && format !== null) {
        if (!AGENT_TEXT_FORMATS.includes(type as AgentTextFormatType))
          errors.push({
            field: "text.format.type",
            message: `Text format must be one of ${AGENT_TEXT_FORMATS.join(", ")}`,
          });
        else text.format = { type: type as AgentTextFormatType };
      }
      if (verbosity !== undefined && verbosity !== null && verbosity !== "") {
        if (!AGENT_VERBOSITIES.includes(verbosity as AgentVerbosity))
          errors.push({
            field: "text.verbosity",
            message: `Verbosity must be one of ${AGENT_VERBOSITIES.join(", ")}`,
          });
        else text.verbosity = verbosity as AgentVerbosity;
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      ...(description ? { description } : {}),
      ...(instructions ? { instructions } : {}),
      model,
      ...(Object.keys(reasoning).length ? { reasoning } : {}),
      ...(Object.keys(text).length ? { text } : {}),
    },
  };
}

/** Lowercase ASCII slug of a display name (diacritics folded), possibly empty. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/g, "");
}

/** A fresh id for `name`: its slug, suffixed (`-2`, `-3`…) past reserved and `taken` ids. */
export function agentIdFromName(name: string, taken: Set<string>): string {
  const base = slugify(name) || "agent";
  const free = (id: string) => !taken.has(id) && !RESERVED_AGENT_IDS.has(id);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (free(id)) return id;
  }
}

/** The description written when none is given: the first sentence of the instructions. */
export function defaultDescription(name: string, instructions: string): string {
  const first = instructions
    .split(/\n\s*\n/)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  const sentence = first?.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? first ?? "";
  const text = sentence || `${name} agent`;
  return text.length > AGENT_LIMITS.description
    ? `${text.slice(0, AGENT_LIMITS.description - 1).trimEnd()}…`
    : text;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** Splits a Markdown agent file into its YAML document and body (no frontmatter: empty doc). */
export function parseAgentFile(text: string): { doc: Document; body: string } | undefined {
  const match = FRONTMATTER.exec(text);
  if (!match) return { doc: new Document({}), body: text.trim() };
  const doc = parseDocument(match[1] ?? "") as Document;
  if (doc.errors.length) return undefined;
  if (doc.contents !== null && !isMap(doc.contents)) return undefined;
  if (doc.contents === null) (doc as { contents: unknown }).contents = doc.createNode({});
  // Bounded alias expansion (a hostile file cannot blow up `toJS`).
  try {
    doc.toJS({ maxAliasCount: 20 });
  } catch {
    return undefined;
  }
  return { doc, body: (match[2] ?? "").trim() };
}

const iso = (ms: number) => new Date(ms).toISOString();
const time = (value: unknown): number | undefined => {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/** The definition a parsed file describes (`id`/`scope`/`path` come from its location). */
export function definitionFromFile(
  parsed: { doc: Document; body: string },
  meta: { id: string; scope: AgentScope; path: string; mtimeMs: number; birthtimeMs?: number },
): AgentDefinitionInfo {
  const front = (parsed.doc.toJS({ maxAliasCount: 20 }) ?? {}) as Record<string, unknown>;
  const own = (
    front[ALISIO_KEY] && typeof front[ALISIO_KEY] === "object" ? front[ALISIO_KEY] : {}
  ) as Record<string, unknown>;
  const reasoningRaw = (
    own.reasoning && typeof own.reasoning === "object" ? own.reasoning : {}
  ) as Record<string, unknown>;
  const textRaw = (own.text && typeof own.text === "object" ? own.text : {}) as Record<
    string,
    unknown
  >;
  const reasoning: NonNullable<AgentDefinitionInfo["reasoning"]> = {};
  if (typeof reasoningRaw.effort === "string" && EFFORT.test(reasoningRaw.effort))
    reasoning.effort = reasoningRaw.effort;
  if (AGENT_REASONING_SUMMARIES.includes(reasoningRaw.summary as AgentReasoningSummary))
    reasoning.summary = reasoningRaw.summary as AgentReasoningSummary;
  const text: NonNullable<AgentDefinitionInfo["text"]> = {};
  const format = (textRaw.format && typeof textRaw.format === "object" ? textRaw.format : {}) as {
    type?: unknown;
  };
  if (AGENT_TEXT_FORMATS.includes(format.type as AgentTextFormatType))
    text.format = { type: format.type as AgentTextFormatType };
  if (AGENT_VERBOSITIES.includes(textRaw.verbosity as AgentVerbosity))
    text.verbosity = textRaw.verbosity as AgentVerbosity;
  const displayName =
    (typeof own.displayName === "string" && own.displayName.trim()) ||
    (typeof front.name === "string" && front.name.trim()) ||
    meta.id;
  const updatedAt = time(own.updatedAt) ?? meta.mtimeMs;
  const createdAt = time(own.createdAt) ?? meta.birthtimeMs ?? updatedAt;
  return {
    id: meta.id,
    scope: meta.scope,
    name: displayName,
    description: typeof front.description === "string" ? front.description.trim() : "",
    instructions: parsed.body,
    model: typeof front.model === "string" ? front.model.trim() : "",
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    ...(Object.keys(text).length ? { text } : {}),
    path: meta.path,
    createdAt,
    updatedAt,
  };
}

/** Sets `path` to `value`, or removes it (and then-empty parent maps) when undefined. */
function put(doc: Document, path: string[], value: unknown): void {
  if (value !== undefined) {
    doc.setIn(path, value);
    return;
  }
  if (doc.hasIn(path)) doc.deleteIn(path);
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = doc.getIn(path.slice(0, depth), true);
    if (isMap(parent) && parent.items.length === 0) doc.deleteIn(path.slice(0, depth));
  }
}

/**
 * Serializes `input` into the file's YAML document (mutating it) and returns the file text.
 * Keys Alisio does not own are left exactly as they were.
 */
export function renderAgentFile(
  doc: Document,
  id: string,
  input: AgentDefinitionInput,
  times: { createdAt: number; updatedAt: number; created: boolean },
): string {
  const instructions = input.instructions?.trim() ?? "";
  doc.set("name", id);
  doc.set("description", input.description?.trim() || defaultDescription(input.name, instructions));
  doc.set("model", input.model);
  // Main-capable (OpenCode `mode: all`) so it can be the ACTIVE agent and a subagent; an existing
  // file keeps the mode its author chose.
  if (times.created && !doc.has("mode")) doc.set("mode", "all");
  put(doc, [ALISIO_KEY, "displayName"], input.name === id ? undefined : input.name);
  put(doc, [ALISIO_KEY, "reasoning", "effort"], input.reasoning?.effort);
  put(doc, [ALISIO_KEY, "reasoning", "summary"], input.reasoning?.summary);
  put(doc, [ALISIO_KEY, "text", "format", "type"], input.text?.format?.type);
  put(doc, [ALISIO_KEY, "text", "verbosity"], input.text?.verbosity);
  put(doc, [ALISIO_KEY, "createdAt"], iso(times.createdAt));
  put(doc, [ALISIO_KEY, "updatedAt"], iso(times.updatedAt));
  const front = doc.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${front}\n---\n${instructions ? `\n${instructions}\n` : ""}`;
}

export class AgentNotFoundError extends Error {
  constructor(scope: AgentScope, id: string) {
    super(`Agent ${id} not found in the ${scope} scope`);
  }
}

/** Reads and writes the agent files of one scope directory. */
export class AgentScopeStore {
  constructor(
    readonly scope: AgentScope,
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private pathOf(id: string): string {
    if (!AGENT_ID_PATTERN.test(id) || id.length > 64) throw new AgentNotFoundError(this.scope, id);
    return join(this.dir, `${id}.md`);
  }

  private async read(
    id: string,
  ): Promise<{ parsed: { doc: Document; body: string }; info: AgentDefinitionInfo } | undefined> {
    const path = this.pathOf(id);
    let text: string;
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      [text, stats] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    } catch {
      return undefined;
    }
    if (text.length > 64_000) return undefined;
    const parsed = parseAgentFile(text);
    if (!parsed) return undefined;
    return {
      parsed,
      info: definitionFromFile(parsed, {
        id,
        scope: this.scope,
        path,
        mtimeMs: stats.mtimeMs,
        ...(stats.birthtimeMs ? { birthtimeMs: stats.birthtimeMs } : {}),
      }),
    };
  }

  /** Every readable `<id>.md` of the scope (invalid names and unparseable files are skipped). */
  async list(): Promise<AgentDefinitionInfo[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".md")).sort();
    } catch {
      return [];
    }
    const out: AgentDefinitionInfo[] = [];
    for (const name of names.slice(0, 200)) {
      const id = basename(name, ".md");
      if (!AGENT_ID_PATTERN.test(id)) continue;
      const found = await this.read(id);
      if (found) out.push(found.info);
    }
    return out;
  }

  async get(id: string): Promise<AgentDefinitionInfo | undefined> {
    try {
      return (await this.read(id))?.info;
    } catch {
      return undefined;
    }
  }

  async create(input: AgentDefinitionInput, extraTaken: Iterable<string> = []) {
    const taken = new Set([...(await this.list()).map((a) => a.id), ...extraTaken]);
    const id = agentIdFromName(input.name, taken);
    const now = this.now();
    const text = renderAgentFile(new Document({}), id, input, {
      createdAt: now,
      updatedAt: now,
      created: true,
    });
    await this.write(id, text);
    return (await this.get(id)) as AgentDefinitionInfo;
  }

  async update(id: string, input: AgentDefinitionInput) {
    const found = await this.read(id);
    if (!found) throw new AgentNotFoundError(this.scope, id);
    const text = renderAgentFile(found.parsed.doc, id, input, {
      createdAt: found.info.createdAt,
      updatedAt: Math.max(this.now(), found.info.updatedAt + 1),
      created: false,
    });
    await this.write(id, text);
    return (await this.get(id)) as AgentDefinitionInfo;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await unlink(this.pathOf(id));
      return true;
    } catch {
      return false;
    }
  }

  private async write(id: string, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathOf(id);
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  }
}
