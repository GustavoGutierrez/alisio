/**
 * Pure state of the Agents window: the editor form, capability-driven fitting, dirty/valid
 * checks, the live "Agent config" request snippet (Alisio's own `POST /api/agents`), the
 * getting-started steps and the agent filter. No DOM or network here.
 */
import type {
  AgentDefinitionInfo,
  AgentDefinitionInput,
  AgentDraft,
  AgentInfo,
  AgentModelCapabilities,
  AgentModelOption,
  AgentReasoningSummary,
  AgentScope,
  AgentTemplateInfo,
  AgentTextFormatType,
  AgentVerbosity,
} from "@alisio/sdk";
import { readPref, writePref } from "./storage.ts";

export const SUMMARIES: AgentReasoningSummary[] = ["auto", "none", "concise", "detailed"];
export const VERBOSITIES: AgentVerbosity[] = ["low", "medium", "high"];
export const TEXT_FORMATS: AgentTextFormatType[] = ["text", "json_object", "json_schema"];
export const NAME_MAX = 80;

export interface AgentForm {
  scope: AgentScope;
  /** Set once saved. */
  id?: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  effort: string;
  summary: AgentReasoningSummary | "";
  verbosity: AgentVerbosity | "";
  format: AgentTextFormatType;
}

export function emptyForm(scope: AgentScope, model = ""): AgentForm {
  return {
    scope,
    name: "New agent",
    description: "",
    instructions: "",
    model,
    effort: "",
    summary: "",
    verbosity: "",
    format: "text",
  };
}

type Settings = Pick<AgentDefinitionInput, "reasoning" | "text">;
const settingsOf = (source: Settings) => ({
  effort: source.reasoning?.effort ?? "",
  summary: source.reasoning?.summary ?? ("" as const),
  verbosity: source.text?.verbosity ?? ("" as const),
  format: source.text?.format?.type ?? ("text" as const),
});

export function formFromTemplate(
  template: AgentTemplateInfo,
  scope: AgentScope,
  model: string,
): AgentForm {
  return {
    scope,
    name: template.name,
    description: template.description,
    instructions: template.instructions,
    model,
    ...settingsOf(template),
  };
}

export function formFromDefinition(definition: AgentDefinitionInfo): AgentForm {
  return {
    scope: definition.scope,
    id: definition.id,
    name: definition.name,
    description: definition.description,
    instructions: definition.instructions,
    model: definition.model,
    ...settingsOf(definition),
  };
}

/** A model draft applied to the form (scope, id and model stay). */
export function formFromDraft(form: AgentForm, draft: AgentDraft): AgentForm {
  return {
    ...form,
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    ...settingsOf(draft),
  };
}

/** Permissive capabilities used while the model list is loading or for unknown models. */
export const PERMISSIVE: AgentModelCapabilities = {
  known: false,
  reasoning: true,
  effortLevels: ["low", "medium", "high"],
  summary: true,
  verbosity: true,
  textFormats: [...TEXT_FORMATS],
};

export function capabilitiesFor(
  models: AgentModelOption[] | undefined,
  model: string,
): AgentModelCapabilities {
  return models?.find((m) => m.reference === model || m.id === model)?.capabilities ?? PERMISSIVE;
}

/** Drops or replaces settings the model does not support (mirrors the core rule). */
export function fitForm(form: AgentForm, caps: AgentModelCapabilities): AgentForm {
  const next = { ...form };
  if (!caps.reasoning) {
    next.effort = "";
    next.summary = "";
  } else if (next.effort && !caps.effortLevels.includes(next.effort))
    next.effort = caps.defaultEffort ?? "";
  if (!caps.summary) next.summary = "";
  if (!caps.textFormats.includes(next.format)) next.format = "text";
  if (!caps.verbosity) next.verbosity = "";
  return next;
}

/** The API body of a form (`POST /api/agents`, `PUT /api/agents/:id`). */
export function formToInput(form: AgentForm): AgentDefinitionInput {
  const reasoning = {
    ...(form.effort ? { effort: form.effort } : {}),
    ...(form.summary ? { summary: form.summary } : {}),
  };
  return {
    name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}),
    model: form.model.trim(),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    text: {
      format: { type: form.format },
      ...(form.verbosity ? { verbosity: form.verbosity } : {}),
    },
  };
}

/** Same comparison for "unsaved changes" whatever the field order. */
export const formKey = (form: AgentForm): string =>
  JSON.stringify({ ...formToInput(form), scope: form.scope });

export function nameError(name: string): "required" | "tooLong" | "noLetters" | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "required";
  if (trimmed.length > NAME_MAX) return "tooLong";
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return "noLetters";
  return undefined;
}

/** Save is enabled only for a valid, model-backed form with unsaved changes. */
export function canSave(form: AgentForm, saved: AgentForm | undefined): boolean {
  if (nameError(form.name)) return false;
  if (!form.model.trim()) return false;
  if (form.instructions.length > 24_000 || form.description.length > 300) return false;
  return !saved || formKey(form) !== formKey(saved);
}

/** The "Agent config" panel: how this definition maps to Alisio's own HTTP API. */
export function agentConfigSnippet(
  form: AgentForm,
  options: { origin: string; workspace?: string },
): string {
  const body: Record<string, unknown> = {
    ...(options.workspace && form.scope === "project" ? { workspace: options.workspace } : {}),
    scope: form.scope,
    ...formToInput(form),
  };
  const json = JSON.stringify(body, null, 2);
  const target = form.id
    ? `-X PUT ${options.origin}/api/agents/${encodeURIComponent(form.id)}`
    : `-X POST ${options.origin}/api/agents`;
  let port = "";
  try {
    const url = new URL(options.origin);
    port = url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    /* not a URL: leave the cookie name generic */
  }
  // Writes need the same-origin `Origin` and the session cookie (`alisio_session_<port>`).
  return [
    `curl ${target} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Origin: ${options.origin}" \\`,
    `  -H "Cookie: alisio_session_${port || "<port>"}=<session cookie>" \\`,
    `  -d '${json.replace(/'/g, "'\\''")}'`,
  ].join("\n");
}

export type TokenKind = "key" | "string" | "number" | "keyword" | "punct" | "command" | "plain";

/** Light syntax tokens for one snippet line (JSON keys/strings, numbers, curl words). */
export function tokenize(line: string): Array<{ kind: TokenKind; text: string }> {
  const out: Array<{ kind: TokenKind; text: string }> = [];
  const pattern =
    /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?\b)|\b(true|false|null)\b|(\bcurl\b|-X|-H|-d)\b|([{}[\],])/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "plain", text: line.slice(last, index) });
    if (match[1]) {
      out.push({ kind: match[2] ? "key" : "string", text: match[1] });
      if (match[2]) out.push({ kind: "punct", text: match[2] });
    } else if (match[3]) out.push({ kind: "number", text: match[3] });
    else if (match[4]) out.push({ kind: "keyword", text: match[4] });
    else if (match[5]) out.push({ kind: "command", text: match[5] });
    else if (match[6]) out.push({ kind: "punct", text: match[6] });
    last = index + match[0].length;
  }
  if (last < line.length) out.push({ kind: "plain", text: line.slice(last) });
  return out;
}

export interface StepState {
  id: "define" | "runtime" | "session" | "events";
  done: boolean;
}

/** Getting-started steps, each completed by real state. */
export function gettingStartedSteps(state: {
  saved: boolean;
  workspace: boolean;
  sessions: Array<{ title?: string }>;
}): StepState[] {
  return [
    { id: "define", done: state.saved },
    { id: "runtime", done: state.workspace },
    { id: "session", done: state.saved && state.sessions.length > 0 },
    // A session gets its title from its first user message: a prompt was exchanged.
    { id: "events", done: state.saved && state.sessions.some((s) => !!s.title) },
  ];
}

const DISMISS_KEY = "alisio.agents.gettingStarted";
export const gettingStartedDismissed = (): boolean => readPref(DISMISS_KEY) === "dismissed";
export const dismissGettingStarted = (): void => writePref(DISMISS_KEY, "dismissed");

/** Case-insensitive substring filter on id, name and description; every word must match. */
export function filterAgents<T extends Pick<AgentInfo, "id" | "name" | "description">>(
  agents: ReadonlyArray<T>,
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...agents];
  return agents.filter((agent) => {
    const haystack = `${agent.id} ${agent.name} ${agent.description}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Project / Global badge of an agent preset from its definition path. */
export function presetScope(
  agent: Pick<AgentInfo, "source" | "id">,
  definitions: AgentDefinitionInfo[],
): AgentScope | undefined {
  if (agent.source !== "user") return undefined;
  const matches = definitions.filter((d) => d.id === agent.id);
  return matches.find((d) => d.scope === "project")?.scope ?? matches[0]?.scope;
}

/**
 * A long path for narrow UI: the trailing segments behind a leading "…" (the end of a path is the
 * part that identifies it), within `max` characters. Short paths are returned unchanged.
 */
export function shortPath(path: string, max = 36): string {
  if (path.length <= max) return path;
  const separator = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(separator).filter(Boolean);
  let tail = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = tail ? `${parts[i]}${separator}${tail}` : (parts[i] as string);
    if (next.length + 2 > max) break;
    tail = next;
  }
  if (!tail) return `…${path.slice(-(max - 1))}`;
  return `…${separator}${tail}`;
}

/** Scope directory label: `~/.agents/agents` for global, the shortened project path otherwise. */
export function scopeDirLabel(scope: AgentScope, dir: string | undefined, max = 36): string {
  if (!dir) return "";
  if (scope === "global") {
    const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    return `~${separator}.agents${separator}agents`;
  }
  return shortPath(dir, max);
}
