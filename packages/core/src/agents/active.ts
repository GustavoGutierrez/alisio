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
import type { CommandDescriptor } from "@alisio/sdk";
import { EXIT_PLAN_TOOL } from "../core/opt-in.ts";

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
  /** Default reasoning effort (`alisio.reasoning.effort`); an explicit session/user effort wins. */
  effort?: string;
  /** Definition file of a contributed agent (shows its Project/Global scope). */
  path?: string;
  /** Product built-ins are shown as built-in and never shadowed by contributed definitions. */
  source: "builtin" | "user" | "plugin";
}

export const DEFAULT_AGENT_ID = "build";
export const PLAN_AGENT_ID = "plan";

export interface PlanInstructionSettings {
  /** `plan.diagrams`. */
  diagrams: boolean;
  /** `plan.maxDiagrams`. */
  maxDiagrams: number;
}
export const DEFAULT_PLAN_SETTINGS: PlanInstructionSettings = { diagrams: true, maxDiagrams: 5 };

const PLAN_BASE = `You are the "plan" agent: a read-only planning assistant for this main session.

Your job is analysis and planning only. Investigate the repository with read-only tools
(list_files, search_text, read_file, git_status, git_diff) and return a concrete, ordered plan:
files to change, functions to touch, risks and verification steps. You may run context and
inspection tools that do not modify anything.

You never edit, write or delete files, and you never start processes that change the workspace
or the network. If a task requires changes, hand back a precise plan (and the exact commands)
instead of making them. You do not implement the plan yourself, even when the user approves it:
approval hands the plan to the build agent.

When the plan is complete, finish by calling \`exit_plan\` exactly once with the whole plan in
Markdown (and a short \`title\`). Do not paste the plan in your reply first: exit_plan shows it to
the user and asks for a decision. The plan must be fully understandable on its own, as text. Write
it with these sections, in this order:

# <Title>
## Goal
What will be true when this is done, in one or two sentences.
## Context
What you found in the repository that the plan relies on (files, functions, conventions).
## Steps
A numbered, ordered list. Each step names the files and functions to change and what changes.
## Decisions
Only when there were real choices: each decision and why, in one line.
## Risks
What could go wrong, what is uncertain, and what you did not verify.
## Verification
The exact commands and checks that prove the work is done.`;

const PLAN_DIAGRAMS = (max: number) => `

Diagrams (optional). exit_plan can also carry Mermaid diagrams in its \`diagrams\` argument, as
{id, title, explanation, section, type, mermaid}. Add one only when it explains the plan better than
the text does: a flow, the parts of a system and how they relate, a sequence between components, or
how data moves. Use 0 to ${max} per plan: a simple plan gets none. Never repeat what the text
already says and never add information that is not in the plan.
- One idea per diagram, about 40 nodes at most, labels of one to four plain words.
- id: kebab-case and stable (for example "request-flow"). title: a few words. explanation: one short
  sentence about what it shows. section: the plan heading it illustrates (for example "Steps").
  type: overview, flow, components, architecture, sequence, data, state or other.
- Mermaid types: flowchart (preferred; LR for flows, TD for layers), sequenceDiagram,
  stateDiagram-v2, erDiagram, classDiagram, gantt, mindmap, timeline, journey. No click, links, HTML
  tags or %%{init} directives.
- Style flowcharts with these classes by adding :::name to a node; Alisio defines their colors for
  light and dark, so do not set colors yourself: input (what comes in), process (a step or a part
  that does work), data (stored or exchanged data), system (a main part of the product), external
  (a third party or an outside system), decision (a choice or condition), risk (a risk or an
  uncertain part).
- Shapes with meaning: [rectangle] for steps, ([rounded]) for start and end, [(cylinder)] for stored
  data, {rhombus} for decisions. Group related nodes with: subgraph Name ... end.
  Example: flowchart LR; user([Request]):::input --> api[API]:::system --> db[(Store)]:::data
- When you revise a plan, send EVERY diagram that still applies, updated to match it (same id), and
  leave out the ones that no longer apply. The tool result lists the diagrams it accepted, dropped
  (with the reason) and removed: fix a dropped one in the next revision.`;

const PLAN_TAIL = `

Read the tool result: "approved" means the build agent will implement the plan, so reply with one
short sentence and stop. "skipped" means stay in plan mode and do not call exit_plan again unless
asked. "feedback" carries extra context from the user: revise the plan and call exit_plan again
with the complete updated plan.`;

/**
 * The plan agent's system prompt. The diagram style guide is part of it only while diagrams are on
 * (`plan.diagrams` with a `plan.maxDiagrams` above 0).
 */
export function planInstructions(
  settings: PlanInstructionSettings = DEFAULT_PLAN_SETTINGS,
): string {
  const diagrams = settings.diagrams && settings.maxDiagrams > 0;
  return `${PLAN_BASE}${diagrams ? PLAN_DIAGRAMS(settings.maxDiagrams) : ""}${PLAN_TAIL}`;
}

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
    id: PLAN_AGENT_ID,
    name: "plan",
    description:
      "Read-only planning agent: analyzes the codebase and returns an implementation plan without modifying anything.",
    instructions: planInstructions(),
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
  effort?: string;
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
    ...(typeof record.effort === "string" && record.effort ? { effort: record.effort } : {}),
    ...(typeof record.path === "string" && record.path ? { path: record.path } : {}),
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

/**
 * The agents Shift+Tab (and the web selector) cycles through, in a STABLE order: `build`, then
 * `plan`, then every other main-capable agent (`mode: primary|all`) by name. The catalog order of
 * contributed agents follows plugin discovery and is not stable across reloads, so cycling never
 * relies on it. Duplicated ids are dropped.
 */
export function cycleableAgents(agents: ActiveAgent[]): ActiveAgent[] {
  const builtinRank = new Map(BUILTIN_AGENTS.map((agent, index) => [agent.id, index]));
  const seen = new Set<string>();
  const unique = agents.filter((agent) => {
    if (seen.has(agent.id)) return false;
    seen.add(agent.id);
    return true;
  });
  const byName = (a: ActiveAgent, b: ActiveAgent) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
  return [
    ...unique
      .filter((agent) => builtinRank.has(agent.id))
      .sort((a, b) => (builtinRank.get(a.id) ?? 0) - (builtinRank.get(b.id) ?? 0)),
    ...unique.filter((agent) => !builtinRank.has(agent.id)).sort(byName),
  ];
}

/**
 * The agent after (`step` 1) or before (`step` -1) `currentId` in the cycle, wrapping around. An
 * unknown current id starts the cycle at its first agent (`build`). An empty list yields undefined.
 */
export function nextAgent(
  agents: ActiveAgent[],
  currentId: string | undefined,
  step: 1 | -1 = 1,
): ActiveAgent | undefined {
  const cycle = cycleableAgents(agents);
  if (!cycle.length) return undefined;
  const index = cycle.findIndex((agent) => agent.id === currentId);
  if (index < 0) return cycle[0];
  return cycle[(index + step + cycle.length) % cycle.length];
}

/** Resolves the persisted agent id; unknown ids fall back to the built-in default (`build`). */
export function resolveActiveAgent(agents: ActiveAgent[], id: string | undefined): ActiveAgent {
  const found = id ? agents.find((a) => a.id === id) : undefined;
  if (found) return found;
  return agents.find((a) => a.id === DEFAULT_AGENT_ID) ?? agents[0] ?? BUILTIN_AGENTS[0]!;
}

/** The run options an active agent implies. An undefined agent yields the current behavior. */
export function agentRunOptions(
  agent: ActiveAgent | undefined,
  settings?: { plan?: PlanInstructionSettings },
): {
  instructions?: string;
  policy?: { write: false; process: false; external: false };
  approvals?: false;
  reasoningEffort?: string;
  optInTools?: string[];
} {
  if (!agent) return {};
  const builtinPlan = agent.id === PLAN_AGENT_ID && agent.source === "builtin";
  // The built-in plan agent's prompt follows `plan.diagrams` / `plan.maxDiagrams` (read live).
  const instructions =
    builtinPlan && settings?.plan ? planInstructions(settings.plan) : agent.instructions;
  return {
    ...(instructions ? { instructions } : {}),
    // `exit_plan` exists for the built-in plan agent only (it is hidden from every other run).
    ...(builtinPlan ? { optInTools: [EXIT_PLAN_TOOL] } : {}),
    ...(agent.effort ? { reasoningEffort: agent.effort } : {}),
    ...(agent.readOnly
      ? {
          policy: { write: false as const, process: false as const, external: false as const },
          approvals: false as const,
        }
      : {}),
  };
}

/**
 * Every loaded agent is also a slash command `/agent:<id>` that activates it. The `agent:`
 * namespace keeps these commands from ever colliding with built-ins, plugin commands, prompt
 * templates or `skill:<id>` entries; when a higher-precedence source already owns the exact name
 * (e.g. a plugin with id `agent`), the agent command is skipped.
 */
export const AGENT_COMMAND_PREFIX = "agent:";
const COMMAND_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const agentCommandName = (id: string): string => `${AGENT_COMMAND_PREFIX}${id}`;

/** The agent id a `/agent:<id>` command names, or undefined for any other command. */
export function agentIdFromCommand(name: string): string | undefined {
  if (!name.startsWith(AGENT_COMMAND_PREFIX)) return undefined;
  const id = name.slice(AGENT_COMMAND_PREFIX.length);
  return COMMAND_SAFE_ID.test(id) ? id : undefined;
}

/** `/agent:<id>` descriptors for `agents`, skipping names already in `taken`. */
export function agentCommandDescriptors(
  agents: ActiveAgent[],
  taken: ReadonlySet<string> = new Set(),
): CommandDescriptor[] {
  const out: CommandDescriptor[] = [];
  const seen = new Set(taken);
  for (const agent of agents) {
    if (!COMMAND_SAFE_ID.test(agent.id)) continue;
    const name = agentCommandName(agent.id);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: `Activate the ${agent.name} agent${agent.id === DEFAULT_AGENT_ID ? " (default)" : ""}: ${agent.description}`,
      source: "agent",
      owner: agent.source,
      surfaces: ["tui", "web", "api"],
      execution: "surface",
    });
  }
  return out;
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
