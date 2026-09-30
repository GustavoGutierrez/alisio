/**
 * Pure logic for the ACTIVE (main-session) agent: the built-in catalog, user/plugin
 * contributions, resolution and the per-run options an agent implies. No terminal or pi-tui
 * imports here — the Picker and status-line rendering live in each surface (e.g. the TUI shell).
 *
 * The active agent drives the MAIN session (its `instructions` are appended per run and an
 * agent-specific `model` is offered on selection). This is deliberately separate from the
 * delegated child-session agents of the subagents plugin: a subagent definition becomes a main
 * agent only when it is marked main-capable (`mode: primary|all`), which the subagents plugin
 * publishes for the host to read.
 */
export interface ActiveAgent {
  /** Stable id, also the persisted `agents.active` value. */
  id: string;
  name: string;
  description: string;
  /** System prompt appended to the main session's instructions on every run. */
  instructions?: string;
  /** Optional default model selector (`provider/model` or an unambiguous model id). */
  model?: string;
  /** Read-only agents run with write/process/external tools disabled and approvals off. */
  readOnly?: boolean;
  /** Product built-ins are shown as built-in and never shadowed by contributed definitions. */
  source: "builtin" | "user" | "plugin";
}

export const DEFAULT_AGENT_ID = "build";

const PLAN_INSTRUCTIONS = `You are the "plan" agent: a read-only planning assistant for this main session.

Your job is analysis and planning only. Investigate the repository with read-only tools
(list_files, search_text, read_file, git_status, git_diff) and return a concrete, ordered plan:
files to change, functions to touch, risks and verification steps. You may run context and
inspection tools that do not modify anything.

You never edit, write or delete files, and you never start processes that change the workspace
or the network. If a task requires changes, hand back a precise plan (and the exact commands)
instead of making them.`;

/** Product built-ins. `build` keeps the CURRENT behavior exactly: no added persona, full power. */
export const BUILTIN_AGENTS: ActiveAgent[] = [
  {
    id: DEFAULT_AGENT_ID,
    name: "build",
    description:
      "Default full-power agent: edits code and files, runs processes and verifies its work through the normal permission flow.",
    source: "builtin",
  },
  {
    id: "plan",
    name: "plan",
    description:
      "Read-only planning agent: analyzes the codebase and returns an implementation plan without modifying anything.",
    instructions: PLAN_INSTRUCTIONS,
    readOnly: true,
    source: "builtin",
  },
];

export interface MainCapableAgentRecord {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  readOnly?: boolean;
  source: string;
  path?: string;
}

/** Maps a main-capable definition published by the subagents plugin to an active agent. */
export function mainAgentFromRecord(record: MainCapableAgentRecord): ActiveAgent {
  const source = String(record.source ?? "");
  return {
    id: record.name,
    name: record.name,
    description: record.description,
    ...(record.prompt ? { instructions: record.prompt } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.readOnly ? { readOnly: true } : {}),
    ...(source.startsWith("plugin:")
      ? ({ source: "plugin" } as const)
      : ({ source: "user" } as const)),
  };
}

/** Builds the selectable catalog from the subagents plugin's published state (best-effort). */
export function agentCatalogFromState(untrusted: unknown): ActiveAgent[] {
  if (!Array.isArray(untrusted)) return activeAgentCatalog([]);
  const records = untrusted.filter(
    (entry): entry is MainCapableAgentRecord =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as MainCapableAgentRecord).name === "string" &&
      typeof (entry as MainCapableAgentRecord).description === "string" &&
      (entry as MainCapableAgentRecord).description.length > 0 &&
      typeof (entry as MainCapableAgentRecord).prompt === "string",
  );
  return activeAgentCatalog(records.map(mainAgentFromRecord));
}

/**
 * The full selectable catalog: built-ins first, then contributed main-capable definitions.
 * A contributed definition may never shadow a built-in id; later duplicates of a contributed id
 * are dropped (the subagents plugin already resolved precedence by its own discovery order).
 */
export function activeAgentCatalog(contributions: ActiveAgent[] = []): ActiveAgent[] {
  const seen = new Set<string>();
  const out: ActiveAgent[] = [];
  for (const agent of [...BUILTIN_AGENTS, ...contributions]) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    out.push(agent);
  }
  return out;
}

/** Resolves the persisted agent id; unknown ids fall back to the built-in default (`build`). */
export function resolveActiveAgent(agents: ActiveAgent[], id: string | undefined): ActiveAgent {
  const found = id ? agents.find((a) => a.id === id) : undefined;
  if (found) return found;
  return agents.find((a) => a.id === DEFAULT_AGENT_ID) ?? agents[0] ?? BUILTIN_AGENTS[0]!;
}

/** The run options an active agent implies. An undefined agent yields the current behavior. */
export function agentRunOptions(agent: ActiveAgent | undefined): {
  instructions?: string;
  policy?: { write: false; process: false; external: false };
  approvals?: false;
} {
  if (!agent) return {};
  return {
    ...(agent.instructions ? { instructions: agent.instructions } : {}),
    ...(agent.readOnly
      ? {
          policy: { write: false as const, process: false as const, external: false as const },
          approvals: false as const,
        }
      : {}),
  };
}

export interface AgentPickerItem {
  value: string;
  label: string;
  description: string;
}

/** Picker rows for `/agents`: name with (current), built-in/default and read-only markers. */
export function agentPickerItems(agents: ActiveAgent[], activeId: string): AgentPickerItem[] {
  return agents.map((agent) => ({
    value: agent.id,
    label: [
      agent.name,
      agent.id === activeId ? "(current)" : undefined,
      agent.id === DEFAULT_AGENT_ID ? "(default)" : undefined,
      agent.readOnly ? "read-only" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    description: [
      agent.description,
      agent.model ? `default model: ${agent.model}` : undefined,
      agent.instructions ? "injects its system prompt from the next prompt" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}
