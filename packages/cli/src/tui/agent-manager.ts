/**
 * Pure logic of the TUI agent manager (`/agents`): argument parsing, the agent picker rows and
 * their filter, and the editor form with capability-driven options. Rendering and I/O live in
 * `app.ts`; agent files go through the core `AgentDefinitionService` shared with the web server.
 */
import type {
  AgentDefinitionInfo,
  AgentDefinitionInput,
  AgentDraft,
  AgentModelCapabilities,
  AgentReasoningSummary,
  AgentScope,
  AgentTemplateInfo,
} from "@alisio/core";
import {
  type ActiveAgent,
  AGENT_REASONING_SUMMARIES,
  AGENT_TEXT_FORMATS,
  AGENT_VERBOSITIES,
  DEFAULT_AGENT_ID,
  fitAgentSettings,
  validateAgentDefinitionInput,
} from "@alisio/core";

/** Verbs the TUI owns; any other `/agents <verb>` goes to the subagents plugin's command. */
export type AgentsCommand =
  | { kind: "picker" }
  | { kind: "new"; description?: string }
  | { kind: "templates" }
  | { kind: "manage" }
  | { kind: "edit"; id: string; scope?: AgentScope }
  | { kind: "delete"; id: string; scope?: AgentScope }
  | { kind: "plugin"; args: string };

/**
 * `/agents` → picker; `/agents new [description]` (assisted when a description is given),
 * `/agents templates`, `/agents manage`, `/agents edit|delete <id> [project|global]`. Anything
 * else (`list`, `defs`, `reload`, `open`, `cancel`…) belongs to the subagents plugin.
 */
export function parseAgentsArgs(args: string): AgentsCommand {
  const text = args.trim();
  if (!text) return { kind: "picker" };
  const [verb = "", ...rest] = text.split(/\s+/);
  const tail = text.slice(verb.length).trim();
  const scope = (value: string | undefined): AgentScope | undefined =>
    value === "project" || value === "global" ? value : undefined;
  switch (verb.toLowerCase()) {
    case "new":
    case "create":
      return tail ? { kind: "new", description: tail } : { kind: "new" };
    case "templates":
    case "template":
      return { kind: "templates" };
    case "manage":
      return { kind: "manage" };
    case "edit":
    case "delete":
    case "rm": {
      const [id, where] = rest;
      if (!id) return { kind: "manage" };
      const found = scope(where);
      return {
        kind: verb.toLowerCase() === "edit" ? "edit" : "delete",
        id,
        ...(found ? { scope: found } : {}),
      };
    }
    default:
      return { kind: "plugin", args: text };
  }
}

/** "Project" / "Global" for agent files, "Built-in" / "Plugin" / "User" otherwise. */
export function agentBadge(
  agent: Pick<ActiveAgent, "source"> & { path?: string },
  workspace: string,
  home: string,
): string {
  if (agent.source === "builtin") return "Built-in";
  if (agent.source === "plugin") return "Plugin";
  const path = agent.path ?? "";
  if (path.startsWith(`${workspace}/`) || path.startsWith(`${workspace}\\`)) return "Project";
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) return "Global";
  return "User";
}

export interface PickerRow {
  value: string;
  label: string;
  description?: string;
}

/** Action rows shown above the agents in the `/agents` picker. */
export const AGENT_PICKER_ACTIONS: PickerRow[] = [
  {
    value: "__agents:new",
    label: "+ Create agent…",
    description: "Blank, from a template or written by Alisio",
  },
  {
    value: "__agents:manage",
    label: "✎ Manage saved agents…",
    description: "Edit or delete project and global agents",
  },
];

/** Picker rows: name, badge and markers in the label; description below. */
export function agentPickerRows(
  agents: Array<ActiveAgent & { path?: string }>,
  activeId: string,
  roots: { workspace: string; home: string },
): PickerRow[] {
  return agents.map((agent) => ({
    value: agent.id,
    label: [
      agent.name,
      `[${agentBadge(agent, roots.workspace, roots.home)}]`,
      agent.id === activeId ? "(current)" : undefined,
      agent.id === DEFAULT_AGENT_ID ? "(default)" : undefined,
      agent.readOnly ? "read-only" : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    description: [agent.description, agent.model ? `model: ${agent.model}` : undefined]
      .filter(Boolean)
      .join(" · "),
  }));
}

/** Case-insensitive substring match of every query word on the label and description. */
export function filterAgentRows<T extends { label: string; description?: string; value: string }>(
  rows: ReadonlyArray<T>,
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((row) => {
    const haystack = `${row.value} ${row.label} ${row.description ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The editable state of one agent in the TUI editor. */
export interface AgentForm {
  scope: AgentScope;
  /** Set when editing a saved agent. */
  id?: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  reasoning: { effort?: string; summary?: AgentReasoningSummary };
  text: { format?: "text" | "json_object" | "json_schema"; verbosity?: "low" | "medium" | "high" };
}

export function emptyAgentForm(scope: AgentScope, model: string): AgentForm {
  return {
    scope,
    name: "New agent",
    description: "",
    instructions: "",
    model,
    reasoning: {},
    text: {},
  };
}

type Settings = Pick<AgentTemplateInfo, "reasoning" | "text">;
const settingsOf = (source: Settings): Pick<AgentForm, "reasoning" | "text"> => ({
  reasoning: {
    ...(source.reasoning?.effort ? { effort: source.reasoning.effort } : {}),
    ...(source.reasoning?.summary ? { summary: source.reasoning.summary } : {}),
  },
  text: {
    ...(source.text?.format?.type ? { format: source.text.format.type } : {}),
    ...(source.text?.verbosity ? { verbosity: source.text.verbosity } : {}),
  },
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

/** Applies a model draft to the form (keeps scope, id and model). */
export function applyDraft(form: AgentForm, draft: AgentDraft): AgentForm {
  return {
    ...form,
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    ...settingsOf(draft),
  };
}

/** The API/service body of a form, fitted to the model's capabilities. */
export function formToInput(
  form: AgentForm,
  capabilities?: AgentModelCapabilities,
): AgentDefinitionInput {
  const input: AgentDefinitionInput = {
    name: form.name.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.instructions.trim() ? { instructions: form.instructions.trim() } : {}),
    model: form.model.trim(),
    ...(form.reasoning.effort || form.reasoning.summary
      ? {
          reasoning: {
            ...(form.reasoning.effort ? { effort: form.reasoning.effort } : {}),
            ...(form.reasoning.summary ? { summary: form.reasoning.summary } : {}),
          },
        }
      : {}),
    ...(form.text.format || form.text.verbosity
      ? {
          text: {
            ...(form.text.format ? { format: { type: form.text.format } } : {}),
            ...(form.text.verbosity ? { verbosity: form.text.verbosity } : {}),
          },
        }
      : {}),
  };
  return capabilities ? fitAgentSettings(input, capabilities) : input;
}

/** Validation errors of a form (empty when it can be saved). */
export function formErrors(form: AgentForm): string[] {
  const result = validateAgentDefinitionInput(formToInput(form));
  return result.ok ? [] : result.errors.map((e) => e.message);
}

/** One-line editing of multi-line text: newlines shown and typed as `\n`. */
export const encodeMultiline = (text: string): string =>
  text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
export const decodeMultiline = (text: string): string =>
  text.replace(/\\(\\|n)/g, (_, c: string) => (c === "n" ? "\n" : "\\"));

export type AgentField =
  | "scope"
  | "name"
  | "description"
  | "instructions"
  | "model"
  | "effort"
  | "summary"
  | "verbosity"
  | "format"
  | "refine"
  | "save"
  | "cancel";

const clip = (text: string, max = 60) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Editor rows. Settings the model does not support are shown as "not supported by this model"
 * (their value is ignored on save); `dirty` enables the Save row.
 */
export function agentEditorRows(
  form: AgentForm,
  capabilities: AgentModelCapabilities,
  options: { creating: boolean; scopes: AgentScope[]; dirty: boolean },
): Array<PickerRow & { value: AgentField }> {
  const unsupported = "not supported by this model";
  const rows: Array<PickerRow & { value: AgentField }> = [];
  if (options.creating && options.scopes.length > 1)
    rows.push({
      value: "scope",
      label: `Scope: ${form.scope === "project" ? "Project" : "Global"}`,
      description: "Project: .agents/agents in this workspace · Global: ~/.agents/agents",
    });
  rows.push(
    { value: "name", label: `Name: ${form.name || "(empty)"}` },
    {
      value: "description",
      label: `Description: ${clip(form.description) || "(derived from instructions)"}`,
    },
    {
      value: "instructions",
      label: `Instructions: ${clip(form.instructions) || "(empty)"}`,
      description: `${form.instructions.length} characters`,
    },
    { value: "model", label: `Model: ${form.model || "(choose one)"}` },
    {
      value: "effort",
      label: `Reasoning effort: ${capabilities.reasoning ? (form.reasoning.effort ?? "model default") : "—"}`,
      ...(capabilities.reasoning ? {} : { description: unsupported }),
    },
    {
      value: "summary",
      label: `Reasoning summary: ${capabilities.summary ? (form.reasoning.summary ?? "auto") : "—"}`,
      ...(capabilities.summary ? {} : { description: unsupported }),
    },
    {
      value: "verbosity",
      label: `Verbosity: ${capabilities.verbosity ? (form.text.verbosity ?? "default") : "—"}`,
      ...(capabilities.verbosity ? {} : { description: unsupported }),
    },
    { value: "format", label: `Text format: ${form.text.format ?? "text"}` },
    {
      value: "refine",
      label: "✦ Refine with Alisio…",
      description: "The active model rewrites the instructions to the authoring standards",
    },
  );
  const errors = formErrors(form);
  rows.push({
    value: "save",
    label:
      options.dirty && !errors.length
        ? "✓ Save agent definition"
        : "✓ Save agent definition (nothing to save)",
    ...(errors.length
      ? { description: errors.join("; ") }
      : options.dirty
        ? {}
        : { description: "No unsaved changes" }),
  });
  rows.push({ value: "cancel", label: "✗ Close editor" });
  return rows;
}

/** Choice rows of a select field, honoring the model capabilities. */
export function agentFieldChoices(
  field: "effort" | "summary" | "verbosity" | "format",
  capabilities: AgentModelCapabilities,
): PickerRow[] {
  const levels =
    field === "effort"
      ? capabilities.effortLevels
      : field === "summary"
        ? AGENT_REASONING_SUMMARIES
        : field === "verbosity"
          ? AGENT_VERBOSITIES
          : AGENT_TEXT_FORMATS.filter((format) => capabilities.textFormats.includes(format));
  return [
    ...levels.map((value) => ({
      value,
      label:
        field === "format"
          ? value === "json_object"
            ? "JSON"
            : value === "json_schema"
              ? "JSON Schema"
              : "Text"
          : value,
      ...(field === "effort" && value === capabilities.defaultEffort
        ? { description: "model default" }
        : {}),
    })),
    ...(field === "format" ? [] : [{ value: "!clear", label: "(use the default)" }]),
  ];
}

/** Whether a field can be edited for the model (unsupported settings are read-only). */
export function agentFieldSupported(
  field: "effort" | "summary" | "verbosity",
  capabilities: AgentModelCapabilities,
): boolean {
  return field === "effort"
    ? capabilities.reasoning
    : field === "summary"
      ? capabilities.summary
      : capabilities.verbosity;
}
